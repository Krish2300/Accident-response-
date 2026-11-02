import net from 'node:net';
import { noopLogger, type Logger } from '@resus/core';

/**
 * Asterisk AudioSocket server.
 *
 * Protocol (docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket):
 * every packet is a one-byte type, a big-endian 16-bit payload length, then the
 * payload. Asterisk opens a TCP connection to this server (it is the client),
 * announces the stream with a UUID (type 0x01), then exchanges signed-linear
 * PCM (type 0x10 = 8 kHz) in both directions.
 *
 * This is transport only. It knows nothing about Module 1 sessions or speech:
 * it turns sockets into `uuid -> audio` plumbing, so the same server could feed
 * a recorder, a recogniser or nothing at all.
 */

const KIND_TERMINATE = 0x00;
const KIND_UUID = 0x01;
const KIND_DTMF = 0x03;
const KIND_ERROR = 0xff;

/** Payload type byte -> sample rate, for the signed-linear formats. */
const SLIN_SAMPLE_RATES: Record<number, number> = {
  0x10: 8000,
  0x11: 12000,
  0x12: 16000,
  0x13: 24000,
  0x14: 32000,
  0x15: 44100,
  0x16: 48000,
  0x17: 96000,
  0x18: 192000,
};

/**
 * Server-to-Asterisk audio is written one 20 ms frame at a time (8000 Hz * 2
 * bytes / 1000 * 20 = 320 bytes) and paced at 20 ms.
 *
 * Two separate Asterisk behaviours force both halves of this:
 *
 *   - An AudioSocket message longer than the driver's fixed read buffer is
 *     rejected with "Invalid message length received from AudioSocket server."
 *     and dropped, so a prompt has to be split into frames.
 *   - The channel consumes audio in real time. Writing a whole prompt as one
 *     burst overruns the channel's playout buffer and discards the tail, so the
 *     caller hears a fragment or nothing while the write itself succeeds.
 *
 * One frame per 20 ms is the cadence Asterisk's own AudioSocket server examples
 * use, and keeps every message inside the accepted size.
 */
const AUDIO_FRAME_BYTES = 320;
const AUDIO_FRAME_INTERVAL_MS = 20;

interface OutboundWriter {
  frames: Buffer[];
  next: number;
  timer: NodeJS.Timeout | null;
  completions: Array<{ afterFrame: number; callback: () => void }>;
}

/**
 * One paced writer per socket, so a second prompt on the same call queues behind
 * the first instead of interleaving its frames into noise.
 */
const outboundWriters = new WeakMap<net.Socket, OutboundWriter>();

export interface AudioFrame {
  /** Sample rate of this PCM payload, in Hz. */
  sampleRate: number;
  /** Signed 16-bit little-endian mono PCM. */
  pcm: Buffer;
  /** Monotonic receipt time, for measuring utterance gaps. */
  receivedAt: number;
}

export interface AudioSocketSession {
  readonly uuid: string;
  /** Remote socket address, for logs. */
  readonly remote: string;
  /** Writes signed 16-bit little-endian PCM to the channel. */
  sendAudio(pcm: Uint8Array, onDrained?: () => void): void;
  /** Asks Asterisk to tear the connection down (type 0x00). */
  sendHangup(): void;
  /** Closes the socket without an AudioSocket terminator. */
  close(): void;
}

export interface AudioSocketHandlers {
  onConnect?: (session: AudioSocketSession) => void;
  onAudio?: (session: AudioSocketSession, frame: AudioFrame) => void;
  onDtmf?: (session: AudioSocketSession, digit: string) => void;
  onError?: (session: AudioSocketSession, code: number) => void;
  onClose?: (session: AudioSocketSession) => void;
}

export interface AudioSocketServerOptions extends AudioSocketHandlers {
  host: string;
  port: number;
  logger?: Logger;
  /** Injectable for tests; defaults to `net.createServer`. */
  createServer?: (connectionListener: (socket: net.Socket) => void) => net.Server;
}

export class AudioSocketServer {
  private readonly logger: Logger;
  private readonly handlers: AudioSocketHandlers;
  private server: net.Server | null = null;
  private readonly active = new Map<string, AudioSocketSession>();

  constructor(private readonly options: AudioSocketServerOptions) {
    this.logger = options.logger ?? noopLogger;
    this.handlers = options;
  }

  get listening(): boolean {
    return this.server !== null;
  }

  /** UUIDs of connections currently open. */
  get sessionCount(): number {
    return this.active.size;
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) return { host: this.options.host, port: this.options.port };

    const create = this.options.createServer ?? ((listener) => net.createServer(listener));
    const server = create((socket) => this.handleConnection(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : this.options.port;
    this.logger.info({ host: this.options.host, port }, 'AudioSocket server listening');
    return { host: this.options.host, port };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const session of [...this.active.values()]) session.close();
    this.active.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    let session: AudioSocketSession | null = null;
    const remote = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;

    const finish = (): void => {
      if (session && this.active.get(session.uuid) === session) this.active.delete(session.uuid);
      socket.destroy();
    };

    socket.on('error', (error: Error) => {
      this.logger.warn({ remote, reason: error.message }, 'AudioSocket connection error');
      finish();
    });
    socket.on('close', () => {
      if (session) {
        this.active.delete(session.uuid);
        this.handlers.onClose?.(session);
      }
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // The UUID frame always arrives first; until then we cannot label audio.
      while (true) {
        if (buffer.length < 3) return;
        const kind = buffer[0] as number;
        const length = buffer.readUInt16BE(1);
        if (buffer.length < 3 + length) return;

        const payload = buffer.subarray(3, 3 + length);
        buffer = buffer.subarray(3 + length);

        if (kind === KIND_UUID) {
          if (payload.length !== 16) {
            this.logger.warn({ remote, bytes: payload.length }, 'AudioSocket UUID frame was not 16 bytes');
            continue;
          }
          session = this.createSession(socket, formatUuid(payload), remote);
          this.active.set(session.uuid, session);
          this.logger.info({ uuid: session.uuid, remote }, 'AudioSocket channel connected');
          this.handlers.onConnect?.(session);
          continue;
        }

        if (!session) {
          // Audio before the UUID is unusable: we would have nowhere to file it.
          this.logger.warn({ remote, kind }, 'AudioSocket frame before the UUID was ignored');
          continue;
        }

        const sampleRate = SLIN_SAMPLE_RATES[kind];
        if (sampleRate !== undefined) {
          this.handlers.onAudio?.(session, { sampleRate, pcm: Buffer.from(payload), receivedAt: Date.now() });
        } else if (kind === KIND_DTMF) {
          this.handlers.onDtmf?.(session, payload.toString('ascii'));
        } else if (kind === KIND_ERROR) {
          this.handlers.onError?.(session, payload.length > 0 ? payload[0]! : 0);
        } else if (kind === KIND_TERMINATE) {
          // Let the socket close normally: the `close` handler is the single
          // place that reports the end of a stream, so a terminator cannot
          // produce two `onClose` callbacks.
          finish();
          return;
        } else {
          this.logger.warn({ remote, kind }, 'unknown AudioSocket frame type ignored');
        }
      }
    });
  }

  private createSession(socket: net.Socket, uuid: string, remote: string): AudioSocketSession {
    return {
      uuid,
      remote,
      sendAudio: (pcm: Uint8Array, onDrained?: () => void) => writeAudio(socket, pcm, onDrained),
      sendHangup: () => {
        writeFrame(socket, KIND_TERMINATE, Buffer.alloc(0));
        socket.end();
      },
      close: () => socket.destroy(),
    };
  }
}

/**
 * Queues PCM on the socket's paced writer, splitting it into 20 ms frames.
 *
 * The frames leave one per {@link AUDIO_FRAME_INTERVAL_MS} so the channel's
 * real-time playout buffer never overruns; a single burst would be partly
 * discarded and the prompt would be cut short.
 */
export function writeAudio(socket: net.Socket, pcm: Uint8Array, onDrained?: () => void): void {
  const buffer = Buffer.from(pcm);
  if (buffer.length === 0) {
    safelyComplete(onDrained);
    return;
  }
  const writer = outboundWriters.get(socket) ?? { frames: [], next: 0, timer: null, completions: [] };
  outboundWriters.set(socket, writer);
  for (let offset = 0; offset < buffer.length; offset += AUDIO_FRAME_BYTES) {
    writer.frames.push(buffer.subarray(offset, offset + AUDIO_FRAME_BYTES));
  }
  if (onDrained) writer.completions.push({ afterFrame: writer.frames.length, callback: onDrained });
  if (!writer.timer) {
    writer.timer = setInterval(() => drainFrame(socket, writer), AUDIO_FRAME_INTERVAL_MS);
  }
}

/** Writes the next queued frame, stopping the timer once the queue is drained. */
function drainFrame(socket: net.Socket, writer: OutboundWriter): void {
  if (socket.destroyed) {
    if (writer.timer) clearInterval(writer.timer);
    writer.timer = null;
    outboundWriters.delete(socket);
    // A prompt interrupted by hangup did not drain; do not emit a false prompt-end.
    writer.completions.length = 0;
    return;
  }
  if (writer.next >= writer.frames.length) {
    if (writer.timer) clearInterval(writer.timer);
    writer.timer = null;
    outboundWriters.delete(socket);
    for (const completion of writer.completions.splice(0)) safelyComplete(completion.callback);
    return;
  }
  writeFrame(socket, 0x10, writer.frames[writer.next]!);
  writer.next += 1;
  while (writer.completions[0] && writer.completions[0].afterFrame <= writer.next) {
    safelyComplete(writer.completions.shift()?.callback);
  }
}

function safelyComplete(callback?: () => void): void {
  try {
    callback?.();
  } catch {
    // A diagnostic callback must never interrupt paced audio output.
  }
}

/** Writes `type | len | payload` in one call so frames cannot interleave. */
export function writeFrame(socket: net.Socket, kind: number, payload: Buffer): void {
  const header = Buffer.alloc(3);
  header[0] = kind;
  header.writeUInt16BE(payload.length, 1);
  socket.write(Buffer.concat([header, payload]));
}

/** 16 raw bytes -> canonical `8-4-4-4-12` UUID string. */
export function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
