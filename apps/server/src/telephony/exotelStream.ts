import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { noopLogger, type Logger, type TextToSpeechProvider } from '@resus/core';
import { decodeAudio, encodeWav, resampleMono16 } from '@resus/speech';
import type { WebCallService } from '../webcall/webCallService.js';

/**
 * Dedicated helpline number via Exotel (Indian cloud telephony).
 *
 * Exotel owns the phone number; an Exotel call flow with the "Voicebot" applet
 * opens a WebSocket to this server for each call and streams the caller's
 * audio (16-bit linear PCM, 8 kHz mono, base64 in JSON "media" events). We
 * segment the caller's speech, recognise it (Module 2: whisper.cpp), run the
 * same conversation pipeline as the web call, synthesise the reply (eSpeak
 * NG) and stream it back on the same socket. No Asterisk, no Linux.
 *
 * Message shapes follow Exotel's Voicebot / AgentStream WebSocket protocol
 * (events: connected, start, media, dtmf, mark, stop; outbound: media, mark,
 * clear). Verify field names against your Exotel account's current
 * documentation when the number is provisioned - they are isolated in
 * `parseInbound` / `mediaFrame` so a difference is a two-line change.
 *
 * Security: the stream URL configured in Exotel must carry `?token=<EXOTEL_STREAM_TOKEN>`
 * (a long random value); connections without it are closed immediately. Serve
 * the server over HTTPS (wss://) in production.
 */

export interface ExotelConfig {
  enabled: boolean;
  streamToken: string;
  sampleRate: number;
  rmsThreshold: number;
  hangoverMs: number;
  minUtteranceMs: number;
  maxUtteranceMs: number;
}

export function loadExotelConfig(env: NodeJS.ProcessEnv = process.env): ExotelConfig {
  const token = env.EXOTEL_STREAM_TOKEN?.trim() ?? '';
  return {
    enabled: env.EXOTEL_ENABLED === 'true' && token.length >= 24,
    streamToken: token,
    sampleRate: Number(env.EXOTEL_SAMPLE_RATE ?? 8000),
    rmsThreshold: Number(env.EXOTEL_SPEECH_RMS_THRESHOLD ?? 700),
    hangoverMs: Number(env.EXOTEL_HANGOVER_MS ?? 900),
    minUtteranceMs: Number(env.EXOTEL_MIN_UTTERANCE_MS ?? 400),
    maxUtteranceMs: Number(env.EXOTEL_MAX_UTTERANCE_MS ?? 20_000),
  };
}

type Inbound =
  | { kind: 'start'; streamSid: string; callSid: string; from: string | null }
  | { kind: 'media'; pcm: Int16Array }
  | { kind: 'dtmf'; digit: string }
  | { kind: 'mark'; name: string }
  | { kind: 'stop' }
  | { kind: 'other' };

export function parseInbound(raw: string): Inbound {
  let message: Record<string, any>;
  try {
    message = JSON.parse(raw) as Record<string, any>;
  } catch {
    return { kind: 'other' };
  }
  switch (message.event) {
    case 'start': {
      const start = (message.start ?? {}) as Record<string, any>;
      return {
        kind: 'start',
        streamSid: String(message.stream_sid ?? start.stream_sid ?? ''),
        callSid: String(start.call_sid ?? ''),
        from: typeof start.from === 'string' ? start.from : null,
      };
    }
    case 'media': {
      const payload = String(message.media?.payload ?? '');
      const bytes = Buffer.from(payload, 'base64');
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      return { kind: 'media', pcm: Int16Array.from(pcm) };
    }
    case 'dtmf':
      return { kind: 'dtmf', digit: String(message.dtmf?.digit ?? '') };
    case 'mark':
      return { kind: 'mark', name: String(message.mark?.name ?? '') };
    case 'stop':
      return { kind: 'stop' };
    default:
      return { kind: 'other' };
  }
}

export function mediaFrame(streamSid: string, pcm: Int16Array): string {
  return JSON.stringify({ event: 'media', stream_sid: streamSid, media: { payload: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') } });
}

function rms(pcm: Int16Array): number {
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  return pcm.length ? Math.sqrt(sum / pcm.length) : 0;
}

/** Energy-based utterance segmentation for one call (caller audio only). */
export class UtteranceSegmenter {
  private chunks: Int16Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private active = false;

  constructor(private readonly config: Pick<ExotelConfig, 'sampleRate' | 'rmsThreshold' | 'hangoverMs' | 'minUtteranceMs' | 'maxUtteranceMs'>) {}

  /** Feeds audio; returns a finished utterance (PCM) when the caller stops talking. */
  push(pcm: Int16Array): Int16Array | null {
    const ms = (pcm.length / this.config.sampleRate) * 1000;
    const loud = rms(pcm) >= this.config.rmsThreshold;
    if (!this.active) {
      if (!loud) return null;
      this.active = true;
      this.chunks = [];
      this.speechMs = 0;
      this.silenceMs = 0;
    }
    this.chunks.push(pcm);
    this.speechMs += ms;
    this.silenceMs = loud ? 0 : this.silenceMs + ms;
    if (this.silenceMs >= this.config.hangoverMs || this.speechMs >= this.config.maxUtteranceMs) {
      this.active = false;
      const voiced = this.speechMs - this.silenceMs;
      const total = this.chunks.reduce((n, c) => n + c.length, 0);
      const out = new Int16Array(total);
      let offset = 0;
      for (const chunk of this.chunks) { out.set(chunk, offset); offset += chunk.length; }
      this.chunks = [];
      return voiced >= this.config.minUtteranceMs ? out : null;
    }
    return null;
  }

  reset(): void {
    this.active = false;
    this.chunks = [];
  }
}

export function registerExotelStream(
  fastify: FastifyInstance,
  deps: { webCalls: WebCallService; synthesis: TextToSpeechProvider; config: ExotelConfig; logger?: Logger },
): void {
  const logger = deps.logger ?? noopLogger;
  const { config } = deps;
  if (!config.enabled) {
    logger.info({}, 'Exotel helpline disabled (set EXOTEL_ENABLED=true and EXOTEL_STREAM_TOKEN to a random value of 24+ characters)');
    return;
  }
  if (!deps.synthesis.isLive) {
    logger.warn({}, 'Exotel helpline enabled but SPEECH_SYNTHESIS_PROVIDER is not a real voice; callers will hear nothing. Set SPEECH_SYNTHESIS_PROVIDER=espeak.');
  }
  const expected = Buffer.from(config.streamToken);

  fastify.get('/telephony/exotel/stream', { websocket: true }, (socket, request) => {
    const supplied = Buffer.from(new URL(request.url, 'http://local').searchParams.get('token') ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      logger.warn({ ip: request.ip }, 'rejected Exotel stream with a bad token');
      socket.close(1008, 'unauthorised');
      return;
    }

    let streamSid = '';
    let call: { callId: string; token: string } | null = null;
    let speakingUntil = 0;
    let busy = Promise.resolve();
    const segmenter = new UtteranceSegmenter(config);

    const speak = async (text: string): Promise<void> => {
      if (!call || !streamSid) return;
      const audio = await deps.webCalls.synthesize(call.callId, call.token, text).catch(() => null);
      if (!audio) return;
      const decoded = decodeAudio(audio.audio);
      const pcm = resampleMono16(decoded.pcm, decoded.sampleRate, config.sampleRate);
      const chunk = Math.round(config.sampleRate / 10) * 4; // 400 ms, multiple of 320 bytes
      for (let offset = 0; offset < pcm.length; offset += chunk) {
        socket.send(mediaFrame(streamSid, pcm.subarray(offset, Math.min(pcm.length, offset + chunk))));
      }
      socket.send(JSON.stringify({ event: 'mark', stream_sid: streamSid, mark: { name: 'reply-end' } }));
      // Ignore the caller's line while our reply plays (no echo/self-trigger).
      speakingUntil = Date.now() + (pcm.length / config.sampleRate) * 1000 + 300;
    };

    const handleUtterance = async (pcm: Int16Array): Promise<void> => {
      if (!call) return;
      try {
        const turn = await deps.webCalls.audio(call.callId, call.token, encodeWav(pcm, config.sampleRate));
        await speak(turn.speech);
      } catch (error) {
        logger.error({ error: (error as Error).message }, 'Exotel turn failed');
        await speak('Sorry, please say that again.');
      }
    };

    socket.on('message', (raw: Buffer) => {
      const message = parseInbound(raw.toString());
      if (message.kind === 'start') {
        streamSid = message.streamSid;
        call = deps.webCalls.startPhone({ callerNumber: message.from, language: 'en' });
        logger.info({ callSid: message.callSid, streamSid }, 'Exotel helpline call connected');
        busy = busy.then(() => speak('Emergency line. Tell me what happened, and where you are.'));
      } else if (message.kind === 'media') {
        if (Date.now() < speakingUntil) { segmenter.reset(); return; }
        const utterance = segmenter.push(message.pcm);
        if (utterance) busy = busy.then(() => handleUtterance(utterance));
      } else if (message.kind === 'stop') {
        if (call) void deps.webCalls.hangup(call.callId, call.token).catch(() => undefined);
      }
    });
    socket.on('close', () => {
      if (call) void deps.webCalls.hangup(call.callId, call.token).catch(() => undefined);
    });
  });
  logger.info({ path: '/telephony/exotel/stream' }, 'Exotel helpline stream endpoint enabled');
}
