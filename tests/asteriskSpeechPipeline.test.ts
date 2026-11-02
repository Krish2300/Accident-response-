import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  noopLogger,
  type CallSession,
  type Database,
  type EventPublisherPort,
  type SpeechProvider,
  type SystemEventEnvelope,
  type SystemEventRecord,
  type SynthesisRequest,
  type SynthesisResult,
  type TextToSpeechProvider,
  type Transcript,
  type TranscriptionRequest,
} from '@resus/core';
import { AudioBridge, type AudioBridgeConfig } from '../modules/module_01_emergency_call/src/telephony/asterisk/audioBridge.js';
import { writeFrame } from '../modules/module_01_emergency_call/src/telephony/asterisk/audioSocket.js';
import type { AsteriskCallRegistry } from '../modules/module_01_emergency_call/src/telephony/asteriskProvider.js';
import { Module2 } from '../modules/module_02_speech_processing/src/module.js';
import type { CallSessionStore } from '../modules/module_02_speech_processing/src/speechService.js';
import {
  AsteriskConversationController,
  type ConversationSessions,
  type ConversationTranscriptSink,
} from '../apps/server/src/asterisk/conversationController.js';

const UUID_BYTES = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const CALL_SESSION_ID = 'CALL-1';
const EMERGENCY_ID = 'EMG-1';
const FRAME_BYTES = 320;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function until(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met within the timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

function loudFrame(): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let offset = 0; offset < FRAME_BYTES; offset += 2) frame.writeInt16LE(12_000, offset);
  return frame;
}

class PipelineEvents implements EventPublisherPort {
  readonly recorded: SystemEventEnvelope[] = [];

  async record(event: SystemEventEnvelope): Promise<SystemEventRecord> {
    this.recorded.push(event);
    return { id: `EVT-${this.recorded.length}` } as SystemEventRecord;
  }

  async recordMany(events: SystemEventEnvelope[]): Promise<SystemEventRecord[]> {
    const records: SystemEventRecord[] = [];
    for (const event of events) records.push(await this.record(event));
    return records;
  }

  async recordInTransaction(_db: Database, event: SystemEventEnvelope): Promise<SystemEventRecord> {
    return this.record(event);
  }
}

class PipelineCalls implements CallSessionStore {
  readonly transcripts: Array<Record<string, unknown>> = [];
  private sequence = 0;
  readonly session: CallSession = {
    id: CALL_SESSION_ID,
    emergencyId: EMERGENCY_ID,
    channel: 'ASTERISK-SYNTHETIC',
    callerId: null,
    status: 'ACTIVE',
    language: 'en',
    startedAt: new Date().toISOString(),
    endedAt: null,
    isSimulation: true,
  };

  async sessionById(id: string): Promise<CallSession | null> {
    return id === CALL_SESSION_ID ? this.session : null;
  }

  async endSession(): Promise<CallSession | null> {
    return this.session;
  }

  async appendTranscript(input: {
    callSessionId: string;
    emergencyId: string;
    speaker: string;
    text: string;
    isFinal?: boolean;
    intent?: string | null;
    confidence?: number | null;
    isSimulation?: boolean;
  }): Promise<Transcript> {
    this.sequence += 1;
    this.transcripts.push(input);
    return { id: `TRN-${this.sequence}`, sequence: this.sequence, ...input } as unknown as Transcript;
  }
}

function createConversation(transcripts: ConversationTranscriptSink) {
  let started = false;
  const sessions: ConversationSessions = {
    async start() {
      started = true;
      return {
        session: { id: 'PROTO-1' },
        status: 'WAITING_FOR_RESPONSE',
        speech: 'Synthetic opening prompt.',
        tone: 'CALM',
        paraphrased: false,
      };
    },
    async handleUtterance(input) {
      return {
        session: { id: 'PROTO-1' },
        status: 'WAITING_FOR_RESPONSE',
        speech: `Synthetic reply to: ${input.utterance}`,
        tone: 'CALM',
        paraphrased: false,
      };
    },
  };
  const controller = new AsteriskConversationController({
    sessions,
    emergencies: { async findById() { return { incidentType: 'OTHER' }; } },
    transcripts,
  });
  return { controller, hasStarted: () => started };
}

describe('synthetic AudioSocket speech pipeline integration', () => {
  it('routes a caller frame through Module 2 and the conversation controller, then sends the reply on the same socket', async () => {
    const calls = new PipelineCalls();
    const events = new PipelineEvents();
    const transcriptionRequests: TranscriptionRequest[] = [];
    const synthesisRequests: SynthesisRequest[] = [];
    const recognizedText = 'I am at the main road.';
    const audio = Buffer.alloc(640, 0x01); // two 20 ms frames of synthetic S16LE audio

    const recognizer: SpeechProvider = {
      providerName: 'synthetic-recognizer',
      isLive: false,
      supportedLanguages: ['en'],
      async transcribe(request) {
        transcriptionRequests.push(request);
        return {
          text: recognizedText,
          language: 'en',
          confidence: 0.99,
          isFinal: true,
          providerName: 'synthetic-recognizer',
          isLive: false,
        };
      },
    };
    const synthesizer: TextToSpeechProvider = {
      providerName: 'synthetic-synthesizer',
      isLive: false,
      supportedLanguages: ['en'],
      async synthesize(request): Promise<SynthesisResult> {
        synthesisRequests.push(request);
        return {
          audio: new Uint8Array(audio),
          mimeType: 'audio/L16;rate=8000;channels=1',
          providerName: 'synthetic-synthesizer',
          isLive: false,
          voice: 'synthetic',
          durationMs: 40,
        };
      },
    };
    const module2 = new Module2({
      calls,
      events,
      config: {
        speech: {
          provider: 'loopback',
          synthesisProvider: 'loopback',
          minConfidence: 0.45,
          emitPartials: true,
          maxAudioBytes: 512_000,
          timeoutMs: 5_000,
          maxSynthesisChars: 2_000,
        },
      },
      speech: recognizer,
      synthesis: synthesizer,
      logger: noopLogger,
    });

    const callerTurns: Array<{ callSessionId: string; emergencyId: string; text: string }> = [];
    const forgotten: string[] = [];
    const conversation = createConversation(calls);
    // Wrap the controller so close cleanup is observable without bypassing its real behavior.
    const conversationPort = {
      onCallConnected: conversation.controller.onCallConnected.bind(conversation.controller),
      onCallerUtterance(input: { callSessionId: string; emergencyId: string; language: string; text: string }) {
        callerTurns.push(input);
        return conversation.controller.onCallerUtterance(input);
      },
      forget(callSessionId: string) {
        conversation.controller.forget(callSessionId);
        forgotten.push(callSessionId);
      },
    };

    const provider = {
      trackInbound: () => CALL_SESSION_ID,
      bindUuid: () => undefined,
      markHungUpByChannel: () => undefined,
      callSessionIdForUuid: () => CALL_SESSION_ID,
      callSessionIdForChannel: () => CALL_SESSION_ID,
    } as unknown as AsteriskCallRegistry;
    const config: AudioBridgeConfig = {
      greeting: 'Fallback greeting.',
      greetingTone: 'CALM',
      bindHost: '127.0.0.1',
      bindPort: 0,
      speechRmsThreshold: 100,
      hangoverMs: 40,
      minUtteranceMs: 20,
      maxUtteranceMs: 5_000,
      resolveTimeoutMs: 2_000,
    };
    const bridge = new AudioBridge({
      provider,
      calls,
      speech: {
        transcribe: (input) => module2.speech.transcribe(input),
        speak: (input) => module2.speech.speak(input),
      },
      conversation: conversationPort,
      config,
      logger: noopLogger,
    });
    cleanups.push(() => bridge.stop());
    const { port } = await bridge.start();
    const socket = await openSocket(port);

    let wire = Buffer.alloc(0);
    const outboundFrames: Buffer[] = [];
    socket.on('data', (chunk) => {
      wire = Buffer.concat([wire, chunk]);
      while (wire.length >= 3) {
        const length = wire.readUInt16BE(1);
        if (wire.length < length + 3) break;
        const kind = wire[0]!;
        const payload = Buffer.from(wire.subarray(3, 3 + length));
        wire = wire.subarray(3 + length);
        if (kind === 0x10) outboundFrames.push(payload);
      }
    });

    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => conversation.hasStarted() && synthesisRequests.length === 1 && outboundFrames.length === 2);
    expect(synthesisRequests[0]).toMatchObject({
      text: 'Synthetic opening prompt.',
      language: 'en',
      tone: 'CALM',
      verbatimProtocolText: true,
    });

    for (let index = 0; index < 6; index += 1) writeFrame(socket, 0x10, loudFrame());
    for (let index = 0; index < 2; index += 1) writeFrame(socket, 0x10, Buffer.alloc(FRAME_BYTES));
    await until(() => transcriptionRequests.length === 1 && synthesisRequests.length === 2 && outboundFrames.length === 4);

    expect(transcriptionRequests[0]).toMatchObject({
      callSessionId: CALL_SESSION_ID,
      emergencyId: EMERGENCY_ID,
      language: 'en',
      isFinal: true,
    });
    expect(transcriptionRequests[0]!.audio.length).toBeGreaterThan(0);
    expect(callerTurns).toEqual([
      { callSessionId: CALL_SESSION_ID, emergencyId: EMERGENCY_ID, language: 'en', text: recognizedText },
    ]);
    expect(synthesisRequests[1]).toMatchObject({
      text: `Synthetic reply to: ${recognizedText}`,
      language: 'en',
      tone: 'CALM',
      verbatimProtocolText: true,
    });
    expect(calls.transcripts.map((row) => `${row.speaker}: ${row.text}`)).toEqual([
      'SYSTEM: Synthetic opening prompt.',
      `CALLER: ${recognizedText}`,
      `SYSTEM: Synthetic reply to: ${recognizedText}`,
    ]);
    expect(events.recorded.map((event) => event.type)).toContain('SPEECH_SYNTHESIZED');
    expect(outboundFrames.every((frame) => frame.length === FRAME_BYTES)).toBe(true);
    expect(Buffer.concat(outboundFrames)).toEqual(Buffer.concat([audio, audio]));

    writeFrame(socket, 0x00, Buffer.alloc(0));
    await until(() => forgotten.includes(CALL_SESSION_ID));
    expect(forgotten).toEqual([CALL_SESSION_ID]);
  });
});
