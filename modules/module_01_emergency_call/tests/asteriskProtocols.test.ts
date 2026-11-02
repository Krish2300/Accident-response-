import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, ErrorCode, noopLogger, type CallInvite, type Logger } from '@resus/core';
import {
  parseAmiBuffer,
  parseAmiMessage,
  serializeAmiAction,
  type AmiFields,
} from '../src/telephony/asterisk/amiMessage.js';
import { AmiClient, type AmiClientPort, type AmiEvent } from '../src/telephony/asterisk/amiClient.js';
import { AudioSocketServer, formatUuid, writeFrame } from '../src/telephony/asterisk/audioSocket.js';
import {
  AsteriskTelephonyProvider,
  type AsteriskProviderConfig,
} from '../src/telephony/asteriskProvider.js';
import { AsteriskCallIntake, type AsteriskIntakeConfig } from '../src/telephony/asteriskIntake.js';
import type { OpenCallInput, OpenCallResult } from '../src/callService.js';

/**
 * Offline protocol tests for the Asterisk integration.
 *
 * These exercise the two wire protocols this adapter implements â€” AMI's
 * `Key: Value` blocks and AudioSocket's length-prefixed frames â€” over real TCP
 * sockets against a scripted peer. They are not a claim that Asterisk works:
 * no PBX is involved here. What they do establish is that the framing, the
 * action/event correlation and the session bookkeeping behave exactly as the
 * protocols specify, so the remaining risk when a real PBX is attached is
 * configuration, not codec logic.
 */

// -- helpers -----------------------------------------------------------------

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met within the timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function audioFrame(kind: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(3);
  header[0] = kind;
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the promise to reject with an AppError');
}

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data: Record<string, unknown>;
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const push =
    (level: LogEntry['level']) =>
    (obj: unknown, msg?: string): void => {
      entries.push({
        level,
        message: msg ?? '',
        data: typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>) : {},
      });
    };
  return { logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }, entries };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

// -- AMI wire codec ----------------------------------------------------------

describe('AMI wire codec', () => {
  it('holds back a partial message until the blank-line terminator arrives', () => {
    const { messages, rest } = parseAmiBuffer('Event: VarSet\r\nChannel: PJSIP/1\r\n');
    expect(messages).toHaveLength(0);
    expect(rest).toBe('Event: VarSet\r\nChannel: PJSIP/1\r\n');
  });

  it('parses one complete message into headers plus its event and action id', () => {
    const { messages, rest } = parseAmiBuffer(
      'Event: OriginateResponse\r\nActionID: 42\r\nResponse: Success\r\n\r\n',
    );
    expect(rest).toBe('');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      event: 'OriginateResponse',
      response: 'Success',
      actionId: '42',
    });
    expect(messages[0]!.fields).toEqual({
      Event: 'OriginateResponse',
      ActionID: '42',
      Response: 'Success',
    });
  });

  it('splits several messages from one buffer and returns the trailing remainder', () => {
    const { messages, rest } = parseAmiBuffer(
      'Event: A\r\n\r\nEvent: B\r\n\r\nEvent: C\r\nName: o',
    );
    expect(messages.map((message) => message.event)).toEqual(['A', 'B']);
    expect(rest).toBe('Event: C\r\nName: o');
  });

  it('keeps the first value when a key repeats', () => {
    const message = parseAmiMessage('Event: VarSet\r\nValue: first\r\nValue: second\r\n');
    expect(message.fields.Value).toBe('first');
  });

  it('keeps colons that are part of the value', () => {
    const message = parseAmiMessage('Message: <13>Jul 4 12:00:00 daemon: restarted\r\n');
    expect(message.fields.Message).toBe('<13>Jul 4 12:00:00 daemon: restarted');
  });

  it('ignores the banner line that has no colon, so it cannot become a header', () => {
    const message = parseAmiMessage('Asterisk Call Manager/2.0.0\r\nResponse: Success\r\nActionID: 7\r\n');
    expect(message.fields).toEqual({ Response: 'Success', ActionID: '7' });
    expect(message.actionId).toBe('7');
  });

  it('renders an action with its verb, parameters and blank-line terminator', () => {
    const rendered = serializeAmiAction('Originate', { Channel: 'PJSIP/1001', Priority: 1 });
    expect(rendered).toBe('Action: Originate\r\nChannel: PJSIP/1001\r\nPriority: 1\r\n\r\n');
    // The terminator must be exactly right or the peer never sees a whole block.
    expect(rendered.endsWith('\r\n\r\n')).toBe(true);
    expect(rendered.startsWith('Action: ')).toBe(true);
  });

  it('omits parameters left undefined rather than sending "undefined"', () => {
    expect(serializeAmiAction('Hangup', { Channel: 'PJSIP/1', CallerID: undefined })).toBe(
      'Action: Hangup\r\nChannel: PJSIP/1\r\n\r\n',
    );
  });

  it('round-trips its own output', () => {
    const { messages } = parseAmiBuffer(serializeAmiAction('Ping', { ActionID: 'x' }));
    expect(messages[0]).toMatchObject({ fields: { Action: 'Ping', ActionID: 'x' } });
  });
});

// -- scripted AMI peer -------------------------------------------------------

interface AmiAction {
  verb: string;
  params: Record<string, string>;
}

/**
 * A real TCP listener that speaks AMI the way Asterisk does: banner on accept,
 * a `Response` reply echoing `ActionID` for every action, and an asynchronous
 * `OriginateResponse` after an `Originate`.
 */
class AmiServerDouble {
  readonly actions: AmiAction[] = [];
  /** Actions that receive no reply at all, to exercise timeouts. */
  readonly silent = new Set<string>();
  rejectLogin = false;
  /** Headers added to the `OriginateResponse` event. */
  originateEvent: AmiFields = { Response: 'Success', Channel: 'PJSIP/trunk-00000001' };
  connections = 0;

  private readonly sockets = new Set<net.Socket>();
  private server: net.Server | null = null;
  private port = 0;

  static async start(): Promise<AmiServerDouble> {
    const double = new AmiServerDouble();
    double.server = net.createServer((socket) => double.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      double.server!.once('error', reject);
      double.server!.listen(0, '127.0.0.1', () => {
        double.server!.off('error', reject);
        resolve();
      });
    });
    const address = double.server!.address();
    double.port = typeof address === 'object' && address ? address.port : 0;
    return double;
  }

  get address(): { host: string; port: number } {
    return { host: '127.0.0.1', port: this.port };
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  sendEvent(name: string, fields: AmiFields): void {
    let block = `Event: ${name}\r\n`;
    for (const [key, value] of Object.entries(fields)) block += `${key}: ${value}\r\n`;
    this.write(`${block}\r\n`);
  }

  private write(text: string): void {
    for (const socket of this.sockets) socket.write(text);
  }

  private onConnection(socket: net.Socket): void {
    this.connections += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    // Asterisk greets immediately on accept.
    socket.write('Asterisk Call Manager/2.0.0\r\n');

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const { messages, rest } = parseAmiBuffer(buffer);
      buffer = rest;
      for (const message of messages) this.reply(socket, message.fields);
    });
  }

  private reply(socket: net.Socket, params: Record<string, string>): void {
    const verb = params.Action ?? '';
    this.actions.push({ verb, params });
    if (this.silent.has(verb)) return;

    if (verb === 'Login') {
      const actionId = params.ActionID ?? '';
      socket.write(
        this.rejectLogin
          ? `Response: Error\r\nActionID: ${actionId}\r\nMessage: Secret does not match\r\n\r\n`
          : `Response: Success\r\nActionID: ${actionId}\r\n\r\n`,
      );
      return;
    }

    socket.write(`Response: Success\r\nActionID: ${params.ActionID ?? ''}\r\n\r\n`);

    if (verb !== 'Originate') return;
    let block = 'Event: OriginateResponse\r\n';
    block += `ActionID: ${params.ActionID ?? ''}\r\n`;
    for (const [key, value] of Object.entries(this.originateEvent)) block += `${key}: ${value}\r\n`;
    socket.write(`${block}\r\n`);
  }
}

describe('AmiClient', () => {
  async function connectedClient(double: AmiServerDouble): Promise<AmiClient> {
    const client = new AmiClient({
      ...double.address,
      username: 'resus',
      secret: 's3cret',
      logger: noopLogger,
      connectTimeoutMs: 2_000,
      actionTimeoutMs: 2_000,
    });
    cleanups.push(() => client.close());
    await client.connect();
    return client;
  }

  it('accepts the banner, logs in and enables events', async () => {
    const double = await AmiServerDouble.start();
    cleanups.push(() => double.stop());

    const client = await connectedClient(double);

    expect(client.connected).toBe(true);
    expect(double.actions.map((action) => action.verb)).toEqual(['Login', 'Events']);
    // The banner must not have corrupted the login reply's fields.
    expect(double.actions[0]!.params.Username).toBe('resus');
    expect(double.actions[0]!.params.Secret).toBe('s3cret');
  });

  it('surfaces a rejected login as PROVIDER_UNAVAILABLE rather than a silent client', async () => {
    const double = await AmiServerDouble.start();
    cleanups.push(() => double.stop());
    double.rejectLogin = true;

    const client = new AmiClient({ ...double.address, username: 'resus', secret: 'wrong', logger: noopLogger });
    const error = await rejection(client.connect());
    expect(error.code).toBe(ErrorCode.PROVIDER_UNAVAILABLE);
    expect(error.message).toMatch(/rejected the AMI login/);
    expect(error.message).toMatch(/Secret does not match/);
    expect(client.connected).toBe(false);
  });

  it('reports an unreachable listener as PROVIDER_UNAVAILABLE', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const client = new AmiClient({
      host: '127.0.0.1',
      port,
      username: 'resus',
      secret: 's3cret',
      logger: noopLogger,
      connectTimeoutMs: 2_000,
    });
    const error = await rejection(client.connect());
    expect(error.code).toBe(ErrorCode.PROVIDER_UNAVAILABLE);
    expect(error.message).toMatch(/Could not reach Asterisk AMI/);
  });

  it('correlates a reply with its action id and times out an action nobody answers', async () => {
    const double = await AmiServerDouble.start();
    cleanups.push(() => double.stop());
    double.silent.add('NeverAnswered');
    const client = await connectedClient(double);

    await client.ping();
    expect(double.actions.at(-1)?.verb).toBe('Ping');

    const error = await rejection(client.sendAction('NeverAnswered', {}, 150));
    expect(error.code).toBe(ErrorCode.PROVIDER_TIMEOUT);
    expect(error.message).toMatch(/did not answer the 'NeverAnswered' action/);
  });

  it('delivers asynchronous events to handlers and survives a handler that throws', async () => {
    const double = await AmiServerDouble.start();
    cleanups.push(() => double.stop());
    const client = await connectedClient(double);

    const seen: string[] = [];
    client.onEvent(() => {
      throw new Error('handler exploded');
    });
    client.onEvent((event) => seen.push(event.name));

    double.sendEvent('VarSet', { Channel: 'PJSIP/1', Variable: 'RESUS_INBOUND_UUID', Value: 'abc' });
    await until(() => seen.length > 0);
    expect(seen).toEqual(['VarSet']);

    const matches: AmiFields[] = [];
    client.onEvent((event) => {
      if (event.name === 'VarSet') matches.push(event.fields);
    });
    double.sendEvent('VarSet', { Channel: 'PJSIP/1', Variable: 'RESUS_INBOUND_UUID', Value: 'abc' });
    await until(() => matches.length > 0);
    expect(matches[0]).toMatchObject({ Value: 'abc' });
  });

  it('resolves waitForEvent with the first matching event and nothing earlier', async () => {
    const double = await AmiServerDouble.start();
    cleanups.push(() => double.stop());
    const client = await connectedClient(double);

    const pending = client.waitForEvent(
      (event) => event.name === 'Hangup' && event.fields.Cause === '16',
      2_000,
    );
    double.sendEvent('Newchannel', { Channel: 'PJSIP/1' });
    double.sendEvent('Hangup', { Channel: 'PJSIP/1', Cause: '17' });
    double.sendEvent('Hangup', { Channel: 'PJSIP/1', Cause: '16' });

    const event = await pending;
    expect(event.fields.Cause).toBe('16');
  });

  it('fails waitForEvent with PROVIDER_TIMEOUT when the event never arrives', async () => {
    const double = await AmiServerDouble.start();
    cleanups.push(() => double.stop());
    const client = await connectedClient(double);

    const error = await rejection(client.waitForEvent((event) => event.name === 'BridgeEnter', 150));
    expect(error.code).toBe(ErrorCode.PROVIDER_TIMEOUT);
  });

  it('refuses to send once closed instead of writing to a dead socket', async () => {
    const double = await AmiServerDouble.start();
    cleanups.push(() => double.stop());
    const client = await connectedClient(double);

    await client.close();
    expect(client.connected).toBe(false);
    const error = await rejection(client.sendAction('Ping'));
    expect(error.code).toBe(ErrorCode.PROVIDER_UNAVAILABLE);
    expect(error.message).toMatch(/not open/);
  });

  it('reconnects after an explicit close', async () => {
    const double = await AmiServerDouble.start();
    cleanups.push(() => double.stop());
    const client = await connectedClient(double);

    await client.close();
    await client.connect();
    expect(client.connected).toBe(true);
    expect(double.connections).toBe(2);
    await client.ping();
    expect(double.actions.at(-1)?.verb).toBe('Ping');
  });
});

// -- AudioSocket -------------------------------------------------------------

describe('AudioSocket server', () => {
  const UUID_BYTES = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const UUID = '00112233-4455-6677-8899-aabbccddeeff';

  interface Recording {
    connects: string[];
    sessions: Map<string, { uuid: string; sendAudio(pcm: Uint8Array): void; sendHangup(): void }>;
    audio: Array<{ uuid: string; sampleRate: number; pcm: Buffer }>;
    dtmf: Array<{ uuid: string; digit: string }>;
    closes: number;
  }

  async function startServer(): Promise<{ server: AudioSocketServer; port: number; recording: Recording }> {
    const recording: Recording = { connects: [], sessions: new Map(), audio: [], dtmf: [], closes: 0 };
    const server = new AudioSocketServer({
      host: '127.0.0.1',
      port: 0,
      logger: noopLogger,
      onConnect: (session) => {
        recording.connects.push(session.uuid);
        recording.sessions.set(session.uuid, session);
      },
      onAudio: (session, frame) =>
        recording.audio.push({ uuid: session.uuid, sampleRate: frame.sampleRate, pcm: frame.pcm }),
      onDtmf: (session, digit) => recording.dtmf.push({ uuid: session.uuid, digit }),
      onClose: () => {
        recording.closes += 1;
      },
    });
    cleanups.push(() => server.close());
    const address = await server.listen();
    return { server, port: address.port, recording };
  }

  async function openClient(port: number): Promise<net.Socket> {
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    cleanups.push(async () => {
      socket.destroy();
    });
    return socket;
  }

  it('renders 16 raw bytes as a canonical UUID string', () => {
    expect(formatUuid(UUID_BYTES)).toBe(UUID);
    expect(formatUuid(Buffer.alloc(16))).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('labels an incoming stream by its UUID frame and reports 8 kHz linear audio', async () => {
    const { server, port, recording } = await startServer();
    const socket = await openClient(port);

    writeFrame(socket, 0x01, UUID_BYTES);
    const pcm = Buffer.alloc(320, 0x10);
    writeFrame(socket, 0x10, pcm);
    await until(() => recording.audio.length === 1);

    expect(recording.connects).toEqual([UUID]);
    expect(recording.audio[0]).toMatchObject({ uuid: UUID, sampleRate: 8000 });
    expect(recording.audio[0]!.pcm).toEqual(pcm);
    expect(server.sessionCount).toBe(1);
  });

  it('keeps a frame split across TCP chunks intact', async () => {
    const { port, recording } = await startServer();
    const socket = await openClient(port);

    writeFrame(socket, 0x01, UUID_BYTES);
    const frame = audioFrame(0x10, Buffer.alloc(64, 1));
    socket.write(frame.subarray(0, 4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.write(frame.subarray(4));
    await until(() => recording.audio.length === 1);
    expect(recording.audio[0]!.pcm).toHaveLength(64);
  });

  it('drops audio that arrives before the UUID, because it cannot be filed anywhere', async () => {
    const { port, recording } = await startServer();
    const socket = await openClient(port);

    writeFrame(socket, 0x10, Buffer.alloc(16, 2));
    writeFrame(socket, 0x01, UUID_BYTES);
    writeFrame(socket, 0x10, Buffer.alloc(16, 3));
    await until(() => recording.audio.length === 1);

    expect(recording.audio).toHaveLength(1);
    expect(recording.audio[0]!.uuid).toBe(UUID);
    expect([...recording.audio[0]!.pcm.subarray(0, 4)]).toEqual([3, 3, 3, 3]);
  });

  it('reads a DTMF frame as the digit it carries', async () => {
    const { port, recording } = await startServer();
    const socket = await openClient(port);

    writeFrame(socket, 0x01, UUID_BYTES);
    writeFrame(socket, 0x03, Buffer.from('5', 'ascii'));
    await until(() => recording.dtmf.length === 1);
    expect(recording.dtmf[0]).toEqual({ uuid: UUID, digit: '5' });
  });

  it('writes server-to-voice frames as type | length | payload', async () => {
    const { port, recording } = await startServer();
    const socket = await openClient(port);
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));

    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => recording.connects.length === 1);

    const pcm = Buffer.from([0, 1, 2, 3, 250, 251]);
    const session = recording.sessions.get(UUID);
    expect(session).toBeDefined();
    session!.sendAudio(pcm);
    await until(() => received.reduce((total, chunk) => total + chunk.length, 0) >= 3 + pcm.length);

    const wire = Buffer.concat(received);
    expect(wire[0]).toBe(0x10);
    expect(wire.readUInt16BE(1)).toBe(pcm.length);
    expect(wire.subarray(3, 3 + pcm.length)).toEqual(pcm);
  });

  it('splits server-to-voice audio into 20 ms frames Asterisk will accept', async () => {
    const { port, recording } = await startServer();
    const socket = await openClient(port);
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));

    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => recording.connects.length === 1);

    // 700 ms of 8 kHz slin: longer than one frame, so it must be split.
    const pcm = Buffer.alloc(11_200, 0x2a);
    recording.sessions.get(UUID)!.sendAudio(pcm);
    await until(() => received.reduce((total, chunk) => total + chunk.length, 0) >= pcm.length + 3 * Math.ceil(pcm.length / 320));

    const wire = Buffer.concat(received);
    let offset = 0;
    let frames = 0;
    const reassembled = Buffer.alloc(pcm.length);
    let wrote = 0;
    while (offset < wire.length) {
      const kind = wire[offset]!;
      const length = wire.readUInt16BE(offset + 1);
      expect(kind).toBe(0x10);
      expect(length).toBeGreaterThan(0);
      expect(length).toBeLessThanOrEqual(320);
      wire.subarray(offset + 3, offset + 3 + length).copy(reassembled, wrote);
      wrote += length;
      offset += 3 + length;
      frames += 1;
    }
    expect(frames).toBeGreaterThan(1);
    expect(reassembled.subarray(0, wrote)).toEqual(pcm);
  });

  it('sends an AudioSocket terminator when asked to hang the leg up', async () => {
    const { port, recording } = await startServer();
    const socket = await openClient(port);
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));

    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => recording.connects.length === 1);

    recording.sessions.get(UUID)!.sendHangup();
    await until(() => received.reduce((total, chunk) => total + chunk.length, 0) >= 3);

    const wire = Buffer.concat(received);
    expect(wire[0]).toBe(0x00);
    expect(wire.readUInt16BE(1)).toBe(0);
  });

  it('sends a terminator and reports exactly one close', async () => {
    const { server, port, recording } = await startServer();
    const socket = await openClient(port);

    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => recording.connects.length === 1);
    expect(server.sessionCount).toBe(1);

    writeFrame(socket, 0x00, Buffer.alloc(0));
    await until(() => recording.closes === 1);
    await until(() => server.sessionCount === 0);
    // Give any second (duplicate) callback a chance to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recording.closes).toBe(1);
  });

  it('reports a close when the remote simply drops the connection', async () => {
    const { port, recording } = await startServer();
    const socket = await openClient(port);

    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => recording.connects.length === 1);

    socket.destroy();
    await until(() => recording.closes === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recording.closes).toBe(1);
  });

  it('ignores unknown frame types rather than tearing the stream down', async () => {
    const { port, recording } = await startServer();
    const socket = await openClient(port);

    writeFrame(socket, 0x01, UUID_BYTES);
    writeFrame(socket, 0x7a, Buffer.from('nonsense', 'ascii'));
    writeFrame(socket, 0x10, Buffer.alloc(8, 9));
    await until(() => recording.audio.length === 1);
    expect(recording.connects).toEqual([UUID]);
  });

  it('rejects a UUID frame that is not 16 bytes and keeps waiting for a valid one', async () => {
    const { port, recording } = await startServer();
    const socket = await openClient(port);

    writeFrame(socket, 0x01, Buffer.from('short', 'ascii'));
    writeFrame(socket, 0x10, Buffer.alloc(8));
    writeFrame(socket, 0x01, UUID_BYTES);
    writeFrame(socket, 0x10, Buffer.alloc(8, 4));
    await until(() => recording.audio.length === 1);

    expect(recording.connects).toEqual([UUID]);
    expect(recording.audio[0]!.uuid).toBe(UUID);
  });
});

// -- AMI action/event correlation used by originate ---------------------------

interface Waiter {
  predicate: (event: AmiEvent) => boolean;
  resolve: (event: AmiEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class FakeAmiClient implements AmiClientPort {
  connected = false;
  readonly sent: Array<{ verb: string; params: Record<string, string | number | undefined> }> = [];
  /** Reply returned instead of `Success`, keyed by verb. */
  readonly replies = new Map<string, AmiFields>();
  /** Runs while an action is in flight; used to inject asynchronous events. */
  onSend: ((verb: string, params: Record<string, string | number | undefined>) => void) | null = null;
  connectError: Error | null = null;
  pingError: Error | null = null;
  hangupError: Error | null = null;

  private sequence = 0;
  private readonly handlers = new Set<(event: AmiEvent) => void>();
  private readonly waiters = new Set<Waiter>();

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    for (const waiter of [...this.waiters]) this.drop(waiter, new Error('client closed'));
  }

  onEvent(handler: (event: AmiEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  newActionId(): string {
    this.sequence += 1;
    return `fake-${this.sequence}`;
  }

  async sendAction(
    verb: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<AmiFields> {
    if (verb === 'Hangup' && this.hangupError) throw this.hangupError;
    this.sent.push({ verb, params });
    const reply = this.replies.get(verb) ?? { Response: 'Success' };
    this.onSend?.(verb, params);
    return reply;
  }

  waitForEvent(predicate: (event: AmiEvent) => boolean, timeoutMs = 1_000): Promise<AmiEvent> {
    return new Promise<AmiEvent>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new AppError(ErrorCode.PROVIDER_TIMEOUT, 'No matching AMI event arrived.', 504));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async ping(): Promise<void> {
    if (this.pingError) throw this.pingError;
    if (!this.connected) await this.connect();
  }

  /** Test seam: fan an event out to handlers and to any matching waiter. */
  emit(event: AmiEvent): void {
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
    for (const handler of [...this.handlers]) handler(event);
  }

  private drop(waiter: Waiter, error: Error): void {
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter);
    waiter.reject(error);
  }

  actionsNamed(verb: string): number {
    return this.sent.filter((action) => action.verb === verb).length;
  }
}

function providerConfig(client: AmiClientPort): AsteriskProviderConfig {
  return {
    context: 'resus',
    exten: 's',
    priority: 1,
    defaultEndpoint: 'PJSIP/1001',
    audioSocketAddress: '127.0.0.1:9092',
    inboundChannelPrefix: 'PJSIP/',
    inboundExtension: '1000',
    ami: {
      host: '127.0.0.1',
      port: 5038,
      username: 'resus',
      secret: 'secret',
      actionTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    },
    logger: noopLogger,
    client,
  };
}

describe('AsteriskTelephonyProvider', () => {
  function succeedOriginate(ami: FakeAmiClient): void {
    ami.onSend = (verb, params) => {
      if (verb !== 'Originate') return;
      ami.emit({
        name: 'OriginateResponse',
        fields: {
          ActionID: String(params.ActionID),
          Response: 'Success',
          Channel: 'PJSIP/trunk-00000001',
        },
      });
    };
  }

  it('originates a leg and records the channel it produced', async () => {
    const ami = new FakeAmiClient();
    const provider = new AsteriskTelephonyProvider(providerConfig(ami));
    succeedOriginate(ami);

    const handle = await provider.originate({ callerId: '1001' } satisfies CallInvite);

    expect(handle.providerName).toBe('asterisk');
    expect(handle.isLive).toBe(true);
    expect(handle.transport).toBe('SIP');
    expect(handle.callSessionId).toBeTruthy();

    const originate = ami.sent.find((action) => action.verb === 'Originate');
    expect(originate).toBeDefined();
    expect(originate?.params).toMatchObject({
      Channel: 'PJSIP/1001',
      Context: 'resus',
      Exten: 's',
      Priority: 1,
      CallerID: '1001',
      Async: 'true',
    });
    expect(String(originate?.params.Variable)).toContain('RESUS_CALL_KEY=');
    expect(String(originate?.params.Variable)).toContain('RESUS_CALL_UUID=');
    // The channel Asterisk reported must be the one hangup can address.
    expect(provider.callSessionIdForChannel('PJSIP/trunk-00000001')).toBe(handle.callSessionId);
  });

  it('attaches to an already tracked inbound channel instead of dialling a new leg', async () => {
    const ami = new FakeAmiClient();
    const provider = new AsteriskTelephonyProvider(providerConfig(ami));
    const channel = 'PJSIP/2001-00000007';

    const inboundId = provider.trackInbound({ channel, uuid: 'u-1', callerId: '2001' });
    const handle = await provider.originate({ channel });

    expect(handle.callSessionId).toBe(inboundId);
    expect(ami.actionsNamed('Originate')).toBe(0);
    // One Asterisk call, one session id: this is the invariant live calls rest on.
    expect(provider.callSessionIdForChannel(channel)).toBe(inboundId);
    expect(provider.callSessionIdForUuid('u-1')).toBe(inboundId);
  });

  it('reports a refused Originate as PROVIDER_UNAVAILABLE with the reason', async () => {
    const ami = new FakeAmiClient();
    ami.replies.set('Originate', { Response: 'Error', Message: 'Channel unavailable' });
    const provider = new AsteriskTelephonyProvider(providerConfig(ami));

    const error = await rejection(provider.originate({}));
    expect(error.code).toBe(ErrorCode.PROVIDER_UNAVAILABLE);
    expect(error.message).toMatch(/refused to originate/);
    expect(error.message).toMatch(/Channel unavailable/);
  });

  it('reports a failed OriginateResponse as PROVIDER_UNAVAILABLE with Asterisk cause', async () => {
    const ami = new FakeAmiClient();
    ami.onSend = (verb, params) => {
      if (verb !== 'Originate') return;
      ami.emit({
        name: 'OriginateResponse',
        fields: { ActionID: String(params.ActionID), Response: 'Error', Reason: 'USER_BUSY' },
      });
    };
    const provider = new AsteriskTelephonyProvider(providerConfig(ami));

    const error = await rejection(provider.originate({}));
    expect(error.code).toBe(ErrorCode.PROVIDER_UNAVAILABLE);
    expect(error.message).toMatch(/could not establish the call/);
    expect(error.message).toMatch(/USER_BUSY/);
    // Nothing may be left tracked for a call that never existed.
    expect(provider.callSessionIdForChannel('PJSIP/trunk-00000001')).toBeNull();
  });

  it('treats hangup of an unknown call as already ended, not as an error', async () => {
    const ami = new FakeAmiClient();
    const provider = new AsteriskTelephonyProvider(providerConfig(ami));

    await provider.hangup('CALL-does-not-exist', 'operator closed it');
    expect(ami.actionsNamed('Hangup')).toBe(0);
  });

  it('sends Hangup once for a tracked leg and is idempotent afterwards', async () => {
    const ami = new FakeAmiClient();
    const provider = new AsteriskTelephonyProvider(providerConfig(ami));
    succeedOriginate(ami);
    const handle = await provider.originate({});

    await provider.hangup(handle.callSessionId, 'caller gone');
    await provider.hangup(handle.callSessionId, 'caller gone again');

    const hangups = ami.sent.filter((action) => action.verb === 'Hangup');
    expect(hangups).toHaveLength(1);
    expect(hangups[0]!.params).toMatchObject({ Channel: 'PJSIP/trunk-00000001' });
    expect(provider.callSessionIdForChannel('PJSIP/trunk-00000001')).toBeNull();
  });

  it('releases a leg AMI already reported hung up instead of leaving it tracked', async () => {
    const ami = new FakeAmiClient();
    const provider = new AsteriskTelephonyProvider(providerConfig(ami));
    succeedOriginate(ami);
    const handle = await provider.originate({});

    // The caller side tears the leg down first: AMI reports the hangup, then the
    // session close runs `hangup` against the already-dead channel.
    provider.markHungUpByChannel('PJSIP/trunk-00000001');
    await provider.hangup(handle.callSessionId, 'caller hung up');

    // Nothing to hang up any more, and nothing may stay behind in the maps —
    // otherwise the transport probe keeps reporting a leg that is long gone.
    expect(ami.actionsNamed('Hangup')).toBe(0);
    expect(provider.callSessionIdForChannel('PJSIP/trunk-00000001')).toBeNull();
    const probe = await provider.probe();
    expect(probe.reachable).toBe(true);
    expect(probe.detail).toMatch(/0 call leg\(s\) tracked/);
  });

  it('logs a rejected Hangup rather than throwing, because the leg is gone either way', async () => {
    const { logger, entries } = recordingLogger();
    const ami = new FakeAmiClient();
    ami.hangupError = new Error('socket closed');
    const provider = new AsteriskTelephonyProvider({ ...providerConfig(ami), logger });
    succeedOriginate(ami);
    const handle = await provider.originate({});

    await expect(provider.hangup(handle.callSessionId, 'operator')).resolves.toBeUndefined();
    expect(entries.some((entry) => entry.level === 'warn' && /Hangup action/.test(entry.message))).toBe(true);
  });

  it('probe reports a live AMI and a dead one without pretending', async () => {
    const ami = new FakeAmiClient();
    const provider = new AsteriskTelephonyProvider(providerConfig(ami));

    await expect(provider.probe()).resolves.toMatchObject({ reachable: true });

    ami.pingError = new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'AMI login rejected.', 503);
    await expect(provider.probe()).resolves.toMatchObject({ reachable: false });
    const failed = await provider.probe();
    expect(failed.detail).toMatch(/AMI login rejected/);
  });

  it('reports unreachable when the AMI client cannot connect', async () => {
    const ami = new FakeAmiClient();
    ami.connectError = new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'no route to host', 503);
    const provider = new AsteriskTelephonyProvider(providerConfig(ami));

    const failed = await provider.probe();
    expect(failed).toMatchObject({ reachable: false, detail: 'no route to host' });
    await expect(provider.originate({})).rejects.toBeInstanceOf(AppError);
  });
});

// -- inbound intake -----------------------------------------------------------

class FakeRegistry {
  readonly tracked: Array<{ channel: string; uuid: string | null; callerId: string | null }> = [];
  readonly hungUp: string[] = [];
  private readonly handlers = new Set<(event: AmiEvent) => void>();
  private readonly byChannel = new Map<string, string>();
  private sequence = 0;

  trackInbound(input: { channel: string; uuid?: string | null; callerId?: string | null }): string {
    const existing = this.byChannel.get(input.channel);
    if (existing) return existing;
    this.sequence += 1;
    const callSessionId = `CALL-IN-${this.sequence}`;
    this.byChannel.set(input.channel, callSessionId);
    this.tracked.push({
      channel: input.channel,
      uuid: input.uuid ?? null,
      callerId: input.callerId ?? null,
    });
    return callSessionId;
  }

  bindUuid(): void {
    /* not exercised by the intake */
  }

  markHungUpByChannel(channel: string): void {
    this.hungUp.push(channel);
  }

  callSessionIdForUuid(): string | null {
    return null;
  }

  callSessionIdForChannel(channel: string): string | null {
    return this.byChannel.get(channel) ?? null;
  }

  onAmiEvent(handler: (event: AmiEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: AmiEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }

  get subscribed(): number {
    return this.handlers.size;
  }
}

class FakeCalls {
  readonly opened: OpenCallInput[] = [];
  readonly closed: Array<{ callSessionId: string; reason: string | undefined }> = [];
  failOpen: Error | null = null;
  failClose: Error | null = null;
  /** When set, `open()` does not return until this settles — stands in for the commits `CallService.open()` performs. */
  openGate: Promise<void> | null = null;

  async open(input: OpenCallInput): Promise<OpenCallResult> {
    if (this.openGate) await this.openGate;
    if (this.failOpen) throw this.failOpen;
    this.opened.push(input);
    return {
      emergency: { id: 'EMG-1' },
      session: { id: 'CALL-STORED', language: input.language ?? 'en' },
      isLiveTransport: true,
      provider: 'asterisk',
      transport: 'SIP',
      reused: false,
    } as unknown as OpenCallResult;
  }

  async close(callSessionId: string, reason?: string): Promise<unknown> {
    if (this.failClose) throw this.failClose;
    this.closed.push({ callSessionId, reason });
    return { closed: true };
  }
}

function intakeConfig(overrides: Partial<AsteriskIntakeConfig> = {}): AsteriskIntakeConfig {
  return {
    inboundUuidVariable: 'RESUS_INBOUND_UUID',
    defaultCallerId: null,
    defaultLanguage: 'en',
    latitude: 10.5,
    longitude: 76.3,
    ...overrides,
  };
}

function varSet(fields: Record<string, string>): AmiEvent {
  return { name: 'VarSet', fields };
}

describe('AsteriskCallIntake', () => {
  it('opens exactly one session for the channel variable, using the configured coordinates', async () => {
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig() });
    intake.start();

    provider.emit(
      varSet({
        Channel: 'PJSIP/2001-00000007',
        Variable: 'RESUS_INBOUND_UUID',
        Value: '3f0a0000-0000-4000-8000-000000000001',
        CallerIDNum: '2001',
      }),
    );
    await until(() => calls.opened.length === 1);

    expect(calls.opened[0]).toMatchObject({
      latitude: 10.5,
      longitude: 76.3,
      channel: 'PJSIP/2001-00000007',
      callerId: '2001',
      language: 'en',
    });
    expect(calls.opened[0]!.description).toMatch(/service-area centroid/);
    expect(provider.tracked).toHaveLength(1);
    intake.stop();
  });

  it('ignores a repeat VarSet for a channel it has already opened', async () => {
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig() });
    intake.start();

    const event = varSet({
      Channel: 'PJSIP/2001-00000007',
      Variable: 'RESUS_INBOUND_UUID',
      Value: '3f0a0000-0000-4000-8000-000000000001',
    });
    provider.emit(event);
    await until(() => calls.opened.length === 1);
    provider.emit(event);
    provider.emit(event);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls.opened).toHaveLength(1);
    expect(provider.tracked).toHaveLength(1);
    intake.stop();
  });

  it('ignores a variable that is not the inbound marker', async () => {
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig() });
    intake.start();

    provider.emit(
      varSet({ Channel: 'PJSIP/1001-00000002', Variable: 'RESUS_CALL_UUID', Value: 'abc' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls.opened).toHaveLength(0);
    expect(provider.tracked).toHaveLength(0);
    intake.stop();
  });

  it('falls back to the configured caller id when the trunk reports none', async () => {
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    const intake = new AsteriskCallIntake({
      provider,
      calls,
      config: intakeConfig({ defaultCallerId: '112', defaultLanguage: 'ml' }),
    });
    intake.start();

    provider.emit(
      varSet({ Channel: 'PJSIP/9-1', Variable: 'RESUS_INBOUND_UUID', Value: 'u' }),
    );
    await until(() => calls.opened.length === 1);
    expect(calls.opened[0]).toMatchObject({ callerId: '112', language: 'ml' });
    intake.stop();
  });

  it('releases the channel when open fails so the next attempt is not silently skipped', async () => {
    const { logger, entries } = recordingLogger();
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    calls.failOpen = new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'database offline', 503);
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig(), logger });
    intake.start();

    const event = varSet({
      Channel: 'PJSIP/2001-00000007',
      Variable: 'RESUS_INBOUND_UUID',
      Value: 'u-1',
    });
    provider.emit(event);
    await until(() => entries.some((entry) => entry.level === 'error'));

    expect(entries.some((entry) => /failed to open a session/.test(entry.message))).toBe(true);
    expect(calls.opened).toHaveLength(0);

    calls.failOpen = null;
    provider.emit(event);
    await until(() => calls.opened.length === 1);
    intake.stop();
  });

  it('closes the session when AMI reports the channel hung up', async () => {
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig() });
    intake.start();

    provider.emit(
      varSet({
        Channel: 'PJSIP/2001-00000007',
        Variable: 'RESUS_INBOUND_UUID',
        Value: 'u-1',
        CallerIDNum: '2001',
      }),
    );
    await until(() => calls.opened.length === 1);

    provider.emit({ name: 'Hangup', fields: { Channel: 'PJSIP/2001-00000007', Cause: '16' } });
    await until(() => calls.closed.length === 1);

    expect(calls.closed[0]!.callSessionId).toBe('CALL-IN-1');
    expect(calls.closed[0]!.reason).toMatch(/Caller hung up \(16\)/);
    expect(provider.hungUp).toEqual(['PJSIP/2001-00000007']);
    intake.stop();
  });

  it('waits for an in-flight open to commit before closing, so an ended call is never left ACTIVE', async () => {
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    let releaseOpen!: () => void;
    calls.openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig() });
    intake.start();

    provider.emit(
      varSet({ Channel: 'PJSIP/2001-00000009', Variable: 'RESUS_INBOUND_UUID', Value: 'u-9' }),
    );
    // Asterisk reports the hangup before `CallService.open()` has written the row.
    provider.emit({ name: 'Hangup', fields: { Channel: 'PJSIP/2001-00000009', Cause: '16' } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls.opened).toHaveLength(0);
    expect(calls.closed).toHaveLength(0);

    releaseOpen();
    await until(() => calls.closed.length === 1);

    expect(calls.opened).toHaveLength(1);
    expect(calls.closed[0]!.callSessionId).toBe('CALL-IN-1');
    intake.stop();
  });

  it('does not close anything for a hangup it never saw open', async () => {
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig() });
    intake.start();

    provider.emit({ name: 'Hangup', fields: { Channel: 'PJSIP/stranger-1' } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls.closed).toHaveLength(0);
    intake.stop();
  });

  it('reports a failed close as a warning instead of dropping it silently', async () => {
    const { logger, entries } = recordingLogger();
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig(), logger });
    intake.start();

    provider.emit(
      varSet({ Channel: 'PJSIP/2001-1', Variable: 'RESUS_INBOUND_UUID', Value: 'u-1' }),
    );
    await until(() => calls.opened.length === 1);

    calls.failClose = new Error('store unavailable');
    provider.emit({ name: 'Hangup', fields: { Channel: 'PJSIP/2001-1' } });
    await until(() => entries.some((entry) => entry.level === 'warn'));
    expect(entries.some((entry) => /could not close the session/.test(entry.message))).toBe(true);
    intake.stop();
  });

  it('stops reacting to events after stop()', async () => {
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig() });
    intake.start();
    expect(provider.subscribed).toBe(1);

    intake.stop();
    expect(provider.subscribed).toBe(0);

    provider.emit(
      varSet({ Channel: 'PJSIP/2001-1', Variable: 'RESUS_INBOUND_UUID', Value: 'u-1' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.opened).toHaveLength(0);
  });

  it('is safe to start twice without double-subscribing', async () => {
    const provider = new FakeRegistry();
    const calls = new FakeCalls();
    const intake = new AsteriskCallIntake({ provider, calls, config: intakeConfig() });
    intake.start();
    intake.start();
    expect(provider.subscribed).toBe(1);
    intake.stop();
  });
});
