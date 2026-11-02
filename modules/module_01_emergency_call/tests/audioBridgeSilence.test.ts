import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger, type CallSession } from '@resus/core';
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
 * AudioBridge caller-silence tests.
 *
 * These drive a real bridge over a real TCP AudioSocket connection. They establish
 * that a caller who goes quiet is asked to answer again, that an active utterance
 * suppresses that prompt, that a hangup cancels it, and that the whole feature is
 * inert unless a positive timeout is configured. Module 4 owns the words; the
 * bridge only owns the timing, so the scripted conversation here replies with the
 * same turn, standing in for Module 4 replaying the protocol's instruction.
 */

const UUID_BYTES = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const OPENING = 'Check if they respond.';

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

function fakeProvider(): AsteriskCallRegistry {
  return {
    trackInbound: () => 'CALL-1',
    bindUuid: () => undefined,
    markHungUpByChannel: () => undefined,
    callSessionIdForUuid: () => 'CALL-1',
    callSessionIdForChannel: () => 'CALL-1',
  };
}

function activeCallStore(): AudioBridgeCallStore {
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
        isSimulation: false,
      }) as unknown as CallSession,
  };
}

function scriptedSpeech(): AudioBridgeSpeechPort & { readonly speaks: string[] } {
  const speaks: string[] = [];
  return {
    speaks,
    async transcribe() {
      return { text: 'yes', confidence: 0.9, accepted: true, band: 'HIGH', persisted: {} };
    },
    async speak(input) {
      speaks.push(input.text);
      return {
        audio: Buffer.alloc(320, 0x3f),
        mimeType: 'audio/wav',
        provider: 'scripted',
        isAudible: true,
        voice: 'scripted',
        durationMs: 50,
      };
    },
  } as AudioBridgeSpeechPort & { readonly speaks: string[] };
}

interface ScriptedConversation extends AudioBridgeConversationPort {
  readonly connects: number[];
  readonly silences: Array<{ callSessionId: string; emergencyId: string; language: string }>;
  readonly forgets: string[];
  /** Returned by `onCallerSilence`; null stops the re-prompt loop. */
  silenceReply: ConversationTurn | null;
}

function scriptedConversation(silenceReply: ConversationTurn | null): ScriptedConversation {
  return {
    connects: [],
    silences: [],
    forgets: [],
    silenceReply,
    async onCallConnected() {
      this.connects.push(1);
      return { speech: OPENING, tone: 'CALM', verbatimProtocolText: true, terminal: false };
    },
    async onCallerUtterance() {
      return { speech: 'Give two rescue breaths.', tone: 'CALM', verbatimProtocolText: true, terminal: false };
    },
    async onCallerSilence(input) {
      this.silences.push(input);
      return this.silenceReply;
    },
    forget(callSessionId) {
      this.forgets.push(callSessionId);
    },
  } as ScriptedConversation;
}

function config(silenceTimeoutMs: number): AudioBridgeConfig {
  return {
    greeting: 'Emergency line.',
    greetingTone: 'CALM',
    bindHost: '127.0.0.1',
    bindPort: 0,
    speechRmsThreshold: 100,
    hangoverMs: 40,
    minUtteranceMs: 20,
    maxUtteranceMs: 5_000,
    resolveTimeoutMs: 2_000,
    silenceTimeoutMs,
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

function buildBridge(
  conversation: ScriptedConversation,
  speech: AudioBridgeSpeechPort,
  silenceTimeoutMs: number,
): AudioBridge {
  const bridge = new AudioBridge({
    provider: fakeProvider(),
    calls: activeCallStore(),
    speech,
    conversation,
    config: config(silenceTimeoutMs),
    logger: noopLogger,
  });
  cleanups.push(() => bridge.stop());
  return bridge;
}

describe('AudioBridge caller silence', () => {
  it('replays the protocol instruction after the caller falls silent', async () => {
    const speech = scriptedSpeech();
    const repeat: ConversationTurn = {
      speech: OPENING,
      tone: 'CALM',
      verbatimProtocolText: true,
      terminal: false,
    };
    const conversation = scriptedConversation(repeat);
    const bridge = buildBridge(conversation, speech, 60);

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);

    await until(() => speech.speaks.length >= 1);
    expect(speech.speaks[0]).toBe(OPENING);

    // No caller audio at all: the bridge must ask the conversation what to repeat.
    await until(() => conversation.silences.length >= 1);
    expect(conversation.silences[0]).toMatchObject({
      callSessionId: 'CALL-1',
      emergencyId: 'EMG-1',
      language: 'en',
    });

    // Module 4's replay is spoken to the caller.
    await until(() => speech.speaks.length >= 2);
  });

  it('does not arm a silence timer when the timeout is disabled', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation(null);
    const bridge = buildBridge(conversation, speech, 0);

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);

    await until(() => conversation.connects.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(conversation.silences).toHaveLength(0);
  });

  it('suppresses the silence prompt while the caller is speaking', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation(null);
    const bridge = buildBridge(conversation, speech, 60);

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => speech.speaks.length >= 1);

    // Hold an utterance open: a continuous loud burst longer than the silence
    // timeout. The timer is cleared when speech starts and cannot fire while the
    // caller is still talking.
    for (let i = 0; i < 30; i += 1) {
      writeFrame(socket, 0x10, loudFrame());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(conversation.silences).toHaveLength(0);
  });

  it('cancels a pending silence prompt when the call ends', async () => {
    const speech = scriptedSpeech();
    const conversation = scriptedConversation(null);
    const bridge = buildBridge(conversation, speech, 60);

    const { port } = await bridge.start();
    const socket = await openSocket(port);
    writeFrame(socket, 0x01, UUID_BYTES);
    await until(() => speech.speaks.length >= 1);

    // Hang up well before the 60 ms silence window elapses.
    socket.destroy();
    await until(() => conversation.forgets.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The timer was cleared, so no prompt work ran for the ended call.
    expect(conversation.silences).toHaveLength(0);
    expect(speech.speaks).toHaveLength(1);
  });
});
