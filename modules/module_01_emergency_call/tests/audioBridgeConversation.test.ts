import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger, type AudioSegmentDiagnostics, type CallSession } from '@resus/core';
import {
  AudioBridge,
  type AudioBridgeCallStore,
  type AudioBridgeConfig,
  type AudioBridgeConversationPort,
  type AudioBridgeSpeechPort,
  type ConversationTurn,
} from '../src/telephony/asterisk/audioBridge.js';
import { writeFrame } from '../src/telephony/asterisk/audioSocket.js';
import type { AsteriskCallRegistry } from '../src/telephony/asteriskProvider.js';

/**
 * AudioBridge conversation-seam tests.
 *
 * These drive a real AudioBridge over a real TCP AudioSocket connection against
 * a scripted speech port, a scripted conversation port and the real frame codec.
 * They do not claim a PBX is involved; what they establish is that the bridge
 * speaks the protocol's first instruction instead of the configured greeting,
 * routes a stored caller utterance to the conversation and speaks the reply, and
 * stays silent for a rejected transcription.
 */

const UUID_BYTES = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const GREETING = 'Emergency line. Tell me what happened.';

async function until(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met within the timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function loudFrame(): Buffer {
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(20_000, i);
  return pcm;
}

/** Counts server-to-voice (0x10) frames and payload bytes in a raw client buffer. */
function audioFrames(wire: Buffer): { count: number; bytes: number } {
  let offset = 0;
  let count = 0;
  let bytes = 0;
  while (offset + 3 <= wire.length) {
    const kind = wire[offset]!;
    const length = wire.readUInt16BE(offset + 1);
    if (offset + 3 + length > wire.length) break;
    if (kind === 0x10) {
      count += 1;
      bytes += length;
    }
    offset += 3 + length;
  }
  return { count, bytes };
}

function fakeProvider(): AsteriskCallRegistry {
  return {
    trackInbound: () => 'CALL-1',
    bindUuid: () => undefined,
    markHungUpByChannel: () => undefined,
    callSessionIdForUuid: () => 'CALL-1',
    callSessionIdForChannel: () => 'CALL-1',
  };
}

function activeCallStore(isSimulation = false): AudioBridgeCallStore {
  return {
    sessionById: async () =>
      ({
        id: 'CALL-1',
        emergencyId: 'EMG-1',
        channel: 'SIP',
        callerId: null,
        status: 'ACTIVE',
        language: 'en',
        startedAt: new Date().toISOString(),
        endedAt: null,
        isSimulation,
      }) as unknown as CallSession,
  };
}

interface ScriptedSpeech extends AudioBridgeSpeechPort {
  readonly speaks: Array<{ text: string; tone: string; verbatimProtocolText: boolean }>;
  readonly transcriptions: Array<{ text: string; accepted: boolean }>;
  readonly diagnosticScopes: Array<'synthetic-test' | undefined>;
  readonly segmentDiagnostics: Array<AudioSegmentDiagnostics | undefined>;
  accept: boolean;
  text: string;
  transcribeStarts: number;
  speakStarts: number;
  gateTranscribe: Deferred<void> | null;
  gateSpeak: Deferred<void> | null;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function scriptedSpeech(): ScriptedSpeech {
  const speaks: ScriptedSpeech['speaks'] = [];
  const transcriptions: ScriptedSpeech['transcriptions'] = [];
  const diagnosticScopes: ScriptedSpeech['diagnosticScopes'] = [];
  const segmentDiagnostics: ScriptedSpeech['segmentDiagnostics'] = [];
  return {
    speaks,
    transcriptions,
    diagnosticScopes,
    segmentDiagnostics,
    accept: true,
    text: 'he is not breathing',
    transcribeStarts: 0,
    speakStarts: 0,
    gateTranscribe: null,
    gateSpeak: null,
    async transcribe(input) {
      this.transcribeStarts += 1;
      if (this.gateTranscribe) await this.gateTranscribe.promise;
      diagnosticScopes.push(input.diagnosticScope);
      segmentDiagnostics.push(input.segmentDiagnostics);
      transcriptions.push({ text: this.text, accepted: this.accept });
      return { text: this.text, confidence: 0.9, accepted: this.accept, band: 'HIGH', persisted: {} };
    },
    async speak(input) {
      this.speakStarts += 1;
      if (this.gateSpeak) await this.gateSpeak.promise;
      speaks.push({ text: input.text, tone: input.tone, verbatimProtocolText: input.verbatimProtocolText });
      return {
        audio: Buffer.alloc(320, 0x3f),
        mimeType: 'audio/wav',
        provider: 'scripted',
        isAudible: true,
        voice: 'scripted',
        durationMs: 100,
      };
    },
  } as ScriptedSpeech;
}

interface ScriptedConversation extends AudioBridgeConversationPort {
  readonly connects: Array<{ callSessionId: string; emergencyId: string; language: string }>;
  readonly utterances: Array<{ callSessionId: string; emergencyId: string; text: string }>;
  readonly forgets: string[];
  opening: ConversationTurn | null;
  reply: ConversationTurn | null;
}

function scriptedConversation(): ScriptedConversation {
  return {
    connects: [],
    utterances: [],
    forgets: [],
    opening: { speech: 'Danger first. Is the scene safe?', tone: 'CALM', verbatimProtocolText: true, terminal: false },
    reply: { speech: 'Check if they respond.', tone: 'CALM', verbatimProtocolText: true, terminal: false },
    async onCallConnected(input) {
      this.connects.push(input);
      return this.opening;
    },
    async onCallerUtterance(input) {
      this.utterances.push(input);
      return this.reply;
    },
    forget(callSessionId) {
      this.forgets.push(callSessionId);
    },
  } as ScriptedConversation;
}

function config(): AudioBridgeConfig {
  return {
    greeting: GREETING,
    greetingTone: 'CALM',
    bindHost: '127.0.0.1',
    bindPort: 0,
    speechRmsThreshold: 100,
    hangoverMs: 40,
    minUtteranceMs: 20,
    maxUtteranceMs: 5_000,
    resolveTimeoutMs: 2_000,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function openSocket(port: number): Promise<net.Socket> {
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

describe('AudioBridge conversation seam', () => {
  it('records content-free audio metrics only for a synthetic test call', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const diagnostics: Array<{ fields: Record<string, unknown>; message: string | undefined }> = [];
    const logger = {
      ...noopLogger,
      info(fields: unknown, message?: string) {
        diagnostics.push({ fields: fields as Record<string, unknown>, message });
      },
    };
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(true),
      speech,
      conversation,
      config: config(),
      logger,
    });
    cleanups.push(() => bridge.stop());

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);

    for (let i = 0; i < 6; i += 1) writeFrame(socket, 0x10, loudFrame());
    for (let i = 0; i < 4; i += 1) writeFrame(socket, 0x10, Buffer.alloc(320, 0));

    await until(() => diagnostics.some((entry) => entry.message === 'synthetic test transcription diagnostics'));
    const ingress = diagnostics.find((entry) => entry.message === 'synthetic test audio ingress diagnostics');
    expect(ingress?.fields).toMatchObject({
      scope: 'synthetic-test',
      sampleRates: [8_000],
      channels: 1,
      sampleFormat: 'signed-int16-le',
      sampleCount: 1_280,
      payloadBytes: 2_560,
      durationMs: 160,
      frameCount: 8,
      minFrameBytes: 320,
      maxFrameBytes: 320,
      rms: 17_321,
      peak: 20_000,
      clippedSampleRatio: 0,
      segmentId: 'CALL-1:SEG-0001',
      boundaryReason: 'silence-hangover',
      transcriptionOutcome: 'submitted',
      trailingSilenceFrameCount: 2,
      frameRmsMin: 0,
      frameRmsMean: 15_000,
      frameRmsMax: 20_000,
      frameRmsAboveThreshold: 6,
      framePeakMin: 0,
      framePeakMean: 15_000,
      framePeakMax: 20_000,
    });
    expect(ingress?.fields).not.toHaveProperty('text');
    expect(speech.diagnosticScopes).toEqual(['synthetic-test']);
    expect(speech.segmentDiagnostics[0]).toMatchObject({
      segmentId: ingress?.fields.segmentId,
      startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      endedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      boundaryReason: 'silence-hangover',
    });
    expect(diagnostics.find((entry) => entry.message === 'synthetic test transcription diagnostics')?.fields)
      .toMatchObject({
        scope: 'synthetic-test',
        segmentId: ingress?.fields.segmentId,
        accepted: true,
        confidence: 0.9,
      });
  });

  it('assigns increasing segment IDs to multiple utterances on one call', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const diagnostics: Array<{ fields: Record<string, unknown>; message: string | undefined }> = [];
    const logger = {
      ...noopLogger,
      info(fields: unknown, message?: string) {
        diagnostics.push({ fields: fields as Record<string, unknown>, message });
      },
    };
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(true),
      speech,
      conversation,
      config: config(),
      logger,
    });
    cleanups.push(() => bridge.stop());
    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);

    for (let turn = 0; turn < 2; turn += 1) {
      for (let i = 0; i < 6; i += 1) writeFrame(socket, 0x10, loudFrame());
      for (let i = 0; i < 2; i += 1) writeFrame(socket, 0x10, Buffer.alloc(320));
      await until(() => conversation.utterances.length === turn + 1);
    }

    const ingressIds = diagnostics
      .filter((entry) => entry.message === 'synthetic test audio ingress diagnostics')
      .map((entry) => entry.fields.segmentId);
    expect(ingressIds).toEqual(['CALL-1:SEG-0001', 'CALL-1:SEG-0002']);
    expect(speech.segmentDiagnostics.map((entry) => entry?.segmentId)).toEqual(ingressIds);
  });

  it('does not create a segment from empty or quiet frames and reports short segments without invoking speech', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const diagnostics: Array<{ fields: Record<string, unknown>; message: string | undefined }> = [];
    const logger = {
      ...noopLogger,
      info(fields: unknown, message?: string) {
        diagnostics.push({ fields: fields as Record<string, unknown>, message });
      },
    };
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(true),
      speech,
      conversation,
      config: { ...config(), minUtteranceMs: 100 },
      logger,
    });
    cleanups.push(() => bridge.stop());
    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);

    writeFrame(socket, 0x10, Buffer.alloc(0));
    for (let i = 0; i < 2; i += 1) writeFrame(socket, 0x10, Buffer.alloc(320));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(diagnostics.some((entry) => entry.message === 'synthetic test audio ingress diagnostics')).toBe(false);

    writeFrame(socket, 0x10, loudFrame());
    for (let i = 0; i < 2; i += 1) writeFrame(socket, 0x10, Buffer.alloc(320));
    await until(() => diagnostics.some((entry) => entry.message === 'synthetic test audio ingress diagnostics'));
    const shortSegment = diagnostics.find((entry) => entry.message === 'synthetic test audio ingress diagnostics');
    expect(shortSegment?.fields).toMatchObject({
      segmentId: 'CALL-1:SEG-0001',
      transcriptionOutcome: 'dropped-too-short',
      durationMs: 60,
      sampleCount: 480,
      boundaryReason: 'silence-hangover',
    });
    expect(speech.transcribeStarts).toBe(0);
    expect(speech.segmentDiagnostics).toHaveLength(0);
  });

  it('continues the call if synthetic diagnostic logging throws', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const logger = {
      ...noopLogger,
      info(_fields: unknown, message?: string) {
        if (message === 'synthetic test audio ingress diagnostics') throw new Error('diagnostic sink unavailable');
      },
    };
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(true),
      speech,
      conversation,
      config: config(),
      logger,
    });
    cleanups.push(() => bridge.stop());
    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);
    for (let i = 0; i < 6; i += 1) writeFrame(socket, 0x10, loudFrame());
    for (let i = 0; i < 2; i += 1) writeFrame(socket, 0x10, Buffer.alloc(320));

    await until(() => conversation.utterances.length === 1);
    expect(speech.segmentDiagnostics[0]?.segmentId).toBe('CALL-1:SEG-0001');
  });

  it('caps synthetic segment diagnostics at 64 records per call', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const diagnostics: Array<{ fields: Record<string, unknown>; message: string | undefined }> = [];
    const logger = {
      ...noopLogger,
      info(fields: unknown, message?: string) {
        diagnostics.push({ fields: fields as Record<string, unknown>, message });
      },
    };
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(true),
      speech,
      conversation,
      config: config(),
      logger,
    });
    cleanups.push(() => bridge.stop());
    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);

    for (let segment = 0; segment < 65; segment += 1) {
      writeFrame(socket, 0x10, loudFrame());
      writeFrame(socket, 0x10, Buffer.alloc(320));
      writeFrame(socket, 0x10, Buffer.alloc(320));
    }
    await until(() => speech.transcribeStarts === 65);

    const ingressIds = diagnostics
      .filter((entry) => entry.message === 'synthetic test audio ingress diagnostics')
      .map((entry) => entry.fields.segmentId);
    expect(ingressIds).toHaveLength(64);
    expect(ingressIds.at(-1)).toBe('CALL-1:SEG-0064');
    expect(speech.segmentDiagnostics.at(-1)).toBeUndefined();
    expect(speech.diagnosticScopes.at(-1)).toBeUndefined();
  });

  it('records a max-duration boundary without changing the VAD cap behavior', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const diagnostics: Array<{ fields: Record<string, unknown>; message: string | undefined }> = [];
    const logger = {
      ...noopLogger,
      info(fields: unknown, message?: string) {
        diagnostics.push({ fields: fields as Record<string, unknown>, message });
      },
    };
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(true),
      speech,
      conversation,
      config: { ...config(), maxUtteranceMs: 100, hangoverMs: 1_000 },
      logger,
    });
    cleanups.push(() => bridge.stop());
    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);
    for (let i = 0; i < 5; i += 1) writeFrame(socket, 0x10, loudFrame());

    await until(() => diagnostics.some((entry) => entry.message === 'synthetic test audio ingress diagnostics'));
    const ingress = diagnostics.find((entry) => entry.message === 'synthetic test audio ingress diagnostics');
    expect(ingress?.fields).toMatchObject({ boundaryReason: 'max-duration', durationMs: 100, frameCount: 5 });
    expect(speech.transcribeStarts).toBe(1);
  });

  it('records an unfinished synthetic segment as call-ended without transcribing it', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const diagnostics: Array<{ fields: Record<string, unknown>; message: string | undefined }> = [];
    const logger = {
      ...noopLogger,
      info(fields: unknown, message?: string) {
        diagnostics.push({ fields: fields as Record<string, unknown>, message });
      },
    };
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(true),
      speech,
      conversation,
      config: config(),
      logger,
    });
    cleanups.push(() => bridge.stop());
    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);
    writeFrame(socket, 0x10, loudFrame());
    socket.destroy();

    await until(() => diagnostics.some((entry) => entry.message === 'synthetic test audio ingress diagnostics'));
    const ingress = diagnostics.find((entry) => entry.message === 'synthetic test audio ingress diagnostics');
    expect(ingress?.fields).toMatchObject({
      segmentId: 'CALL-1:SEG-0001',
      boundaryReason: 'call-ended',
      transcriptionOutcome: 'discarded-call-ended',
      sampleCount: 160,
    });
    expect(speech.transcribeStarts).toBe(0);
    await until(() => conversation.forgets.length === 1);
  });

  it('speaks the protocol opening instead of the greeting, then advances on a stored utterance', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(),
      speech,
      conversation,
      config: config(),
      logger: noopLogger,
    });
    cleanups.push(() => bridge.stop());

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));

    // Announce the stream's UUID so the bridge can bind it to the call session.
    writeFrame(socket, 0x01, UUID_BYTES);

    await until(() => conversation.connects.length === 1);
    expect(conversation.connects[0]).toMatchObject({ callSessionId: 'CALL-1', emergencyId: 'EMG-1' });

    await until(() => speech.speaks.length >= 1);
    // The protocol step is spoken, not the configured greeting, and it is flagged
    // as verbatim so Module 2 records it as reviewed wording.
    expect(speech.speaks[0]).toMatchObject({ text: 'Danger first. Is the scene safe?', verbatimProtocolText: true });
    expect(speech.speaks.some((call) => call.text === GREETING)).toBe(false);

    await until(() => audioFrames(Buffer.concat(received)).count >= 1);

    // A loud burst closed by silence is one utterance.
    for (let i = 0; i < 6; i += 1) writeFrame(socket, 0x10, loudFrame());
    for (let i = 0; i < 4; i += 1) writeFrame(socket, 0x10, Buffer.alloc(320, 0));

    await until(() => conversation.utterances.length === 1);
    expect(conversation.utterances[0]).toMatchObject({ callSessionId: 'CALL-1', text: 'he is not breathing' });

    await until(() => speech.speaks.some((call) => call.text === 'Check if they respond.'));
    // Both the opening and the reply reached the caller over the socket.
    await until(() => audioFrames(Buffer.concat(received)).count >= 2);
  });

  it('does not begin a transcription after the stream closes', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(),
      speech,
      conversation,
      config: config(),
      logger: noopLogger,
    });
    cleanups.push(() => bridge.stop());

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);

    // A loud burst with no following silence leaves an utterance open. The old
    // close handler flushed this into a transcription on a call that is ending.
    for (let i = 0; i < 3; i += 1) writeFrame(socket, 0x10, loudFrame());
    socket.destroy();

    await until(() => conversation.forgets.length === 1);
    // Give any erroneously started asynchronous work time to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(speech.transcribeStarts).toBe(0);
    expect(conversation.utterances).toHaveLength(0);
  });

  it('drops a transcription that completes after the call ended', async () => {
    const speech = scriptedSpeech();
    const gate = deferred<void>();
    speech.gateTranscribe = gate;
    const conversation = scriptedConversation();
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(),
      speech,
      conversation,
      config: config(),
      logger: noopLogger,
    });
    cleanups.push(() => bridge.stop());

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);

    for (let i = 0; i < 6; i += 1) writeFrame(socket, 0x10, loudFrame());
    for (let i = 0; i < 4; i += 1) writeFrame(socket, 0x10, Buffer.alloc(320, 0));
    await until(() => speech.transcribeStarts === 1);

    // Hang up while the recogniser is still running, then let it finish.
    socket.destroy();
    await until(() => conversation.forgets.length === 1);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The result arrived after the call ended: it must not advance the protocol
    // or produce a reply.
    expect(conversation.utterances).toHaveLength(0);
    expect(speech.speaks.some((call) => call.text === 'Check if they respond.')).toBe(false);
  });

  it('does not play speech synthesised after the stream closed', async () => {
    const speech = scriptedSpeech();
    const gate = deferred<void>();
    speech.gateSpeak = gate;
    const conversation = scriptedConversation();
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(),
      speech,
      conversation,
      config: config(),
      logger: noopLogger,
    });
    cleanups.push(() => bridge.stop());

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));

    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => speech.speakStarts === 1);

    // Hang up while the first instruction is being synthesised.
    socket.destroy();
    await until(() => conversation.forgets.length === 1);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Nothing audible reached the socket: the audio was discarded, not written.
    expect(audioFrames(Buffer.concat(received)).count).toBe(0);
  });

  it('leaves silent frames alone and releases the conversation on close', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(),
      speech,
      conversation,
      config: config(),
      logger: noopLogger,
    });
    cleanups.push(() => bridge.stop());

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);

    for (let i = 0; i < 10; i += 1) writeFrame(socket, 0x10, Buffer.alloc(320, 0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(speech.transcribeStarts).toBe(0);

    socket.destroy();
    await until(() => conversation.forgets.length === 1);
    expect(conversation.forgets[0]).toBe('CALL-1');
  });

  it('falls back to the configured greeting when the conversation has no opening turn', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation();
    conversation.opening = null;
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(),
      speech,
      conversation,
      config: config(),
      logger: noopLogger,
    });
    cleanups.push(() => bridge.stop());

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);

    await until(() => speech.speaks.length >= 1);
    expect(speech.speaks[0]!.text).toBe(GREETING);
  });

  it('never routes a rejected transcription to the conversation', async () => {
    const speech = scriptedSpeech();
    speech.accept = false;
    const conversation = scriptedConversation();
    const bridge = new AudioBridge({
      provider: fakeProvider(),
      calls: activeCallStore(),
      speech,
      conversation,
      config: config(),
      logger: noopLogger,
    });
    cleanups.push(() => bridge.stop());

    const { port } = await bridge.start();
    const socket = await openSocket(port);

    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.connects.length === 1);

    for (let i = 0; i < 6; i += 1) writeFrame(socket, 0x10, loudFrame());
    for (let i = 0; i < 4; i += 1) writeFrame(socket, 0x10, Buffer.alloc(320, 0));

    await until(() => speech.transcriptions.length === 1);
    // Give the bridge ample time to (incorrectly) advance the conversation.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(conversation.utterances).toHaveLength(0);
  });
});
