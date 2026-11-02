import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger, type CallSession, type Logger } from '@resus/core';
import { AudioBridge, type AudioBridgeCallStore, type AudioBridgeConfig, type AudioBridgeSpeechPort } from '../src/telephony/asterisk/audioBridge.js';
import { writeFrame } from '../src/telephony/asterisk/audioSocket.js';
import type { AsteriskCallRegistry } from '../src/telephony/asteriskProvider.js';

const uuids = [
  Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
  Buffer.from('10112233445566778899aabbccddeeff', 'hex'),
];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

const config: AudioBridgeConfig = {
  greeting: 'Synthetic test prompt', greetingTone: 'CALM', bindHost: '127.0.0.1', bindPort: 0,
  speechRmsThreshold: 100, hangoverMs: 40, minUtteranceMs: 20,
  maxUtteranceMs: 5_000, resolveTimeoutMs: 1_000,
};

function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timing diagnostic condition timed out'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function connect(port: number, uuid: Buffer): Promise<net.Socket> {
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  cleanup.push(async () => { socket.destroy(); });
  writeFrame(socket, 0x01, uuid);
  return socket;
}

function createBridge(options: { simulation?: boolean; logger?: Logger; now?: () => number; ids?: string[] } = {}) {
  const ids = options.ids ?? ['CALL-1', 'CALL-2'];
  const bindings = new Map(uuids.map((uuid, index) => [uuid.toString('hex'), ids[index] ?? ids[0]!]));
  const provider: AsteriskCallRegistry = {
    trackInbound: () => ids[0]!, bindUuid: () => undefined,
    markHungUpByChannel: () => undefined,
    callSessionIdForUuid: (uuid) => bindings.get(uuid.replaceAll('-', '')) ?? null,
    callSessionIdForChannel: () => null,
  };
  const calls: AudioBridgeCallStore = {
    sessionById: async (id) => ({
      id, emergencyId: `EMG-${id}`, channel: 'PJSIP/test', callerId: null, status: 'ACTIVE',
      language: 'en', startedAt: new Date().toISOString(), endedAt: null,
      isSimulation: options.simulation ?? true,
    }) as unknown as CallSession,
  };
  const speech: AudioBridgeSpeechPort = {
    async speak() {
      return { audio: Buffer.alloc(320, 1), mimeType: 'audio/pcm', provider: 'fake', isAudible: true, voice: 'fake', durationMs: 20 };
    },
    async transcribe() {
      return { text: '', confidence: 0, accepted: false, band: 'LOW', persisted: null };
    },
  };
  const bridge = new AudioBridge({ provider, calls, speech, config, logger: options.logger, monotonicNow: options.now });
  cleanup.push(() => bridge.stop());
  return bridge;
}

describe('synthetic call audio timing markers', () => {
  it('uses one monotonic call origin and orders prompt and operator markers', async () => {
    let now = 10_000;
    const rows: Array<{ fields: Record<string, unknown>; message?: string }> = [];
    const logger = { ...noopLogger, info(fields: Record<string, unknown>, message?: string) { rows.push({ fields, message }); } } as Logger;
    const bridge = createBridge({ logger, now: () => (now += 10) });
    const { port } = await bridge.start();
    await connect(port, uuids[0]!);
    await waitFor(() => rows.filter((row) => row.message === 'synthetic call audio timing marker').length >= 2);
    const start = bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-start');
    const end = bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-end');
    expect(start.accepted).toBe(true);
    expect(end.accepted).toBe(true);
    expect(start.callRelativeMs).toBeGreaterThan(0);
    expect(end.callRelativeMs).toBeGreaterThan(start.callRelativeMs!);
    const markerRows = rows.filter((row) => row.message === 'synthetic call audio timing marker');
    expect(markerRows.map((row) => row.fields.marker)).toEqual(['prompt-start', 'prompt-end', 'speech-start', 'speech-end']);
    expect(markerRows.every((row) => row.fields.callSessionId === 'CALL-1')).toBe(true);
    expect(markerRows.every((row) => !('audio' in row.fields) && !('text' in row.fields))).toBe(true);
  });

  it('isolates markers by call and rejects missing, out-of-order, and duplicate markers', async () => {
    const bridge = createBridge();
    const { port } = await bridge.start();
    expect(bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-end')).toMatchObject({ accepted: false, reason: 'no-active-audio-stream' });
    await connect(port, uuids[0]!);
    await connect(port, uuids[1]!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-end')).toMatchObject({ accepted: false, reason: 'invalid-order' });
    const firstStart = bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-start');
    expect(firstStart.accepted).toBe(true);
    expect(bridge.recordSyntheticSpeechMarker('CALL-2', 'speech-start').accepted).toBe(true);
    expect(bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-start')).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-end').accepted).toBe(true);
    expect(bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-end')).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(bridge.recordSyntheticSpeechMarker('CALL-2', 'speech-end').accepted).toBe(true);
  });

  it('keeps marker processing and playback alive when diagnostic logging throws', async () => {
    const logger = {
      ...noopLogger,
      info(fields: Record<string, unknown>, message?: string) {
        if (message === 'synthetic call audio timing marker') throw new Error('diagnostic sink unavailable');
        noopLogger.info(fields, message);
      },
    } as Logger;
    const bridge = createBridge({ logger });
    const { port } = await bridge.start();
    await connect(port, uuids[0]!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-start').accepted).toBe(true);
    expect(bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-end').accepted).toBe(true);
    expect(bridge.activeConnections).toBe(1);
  });

  it('does not enable speech markers for a non-synthetic call', async () => {
    const bridge = createBridge({ simulation: false });
    const { port } = await bridge.start();
    await connect(port, uuids[0]!);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(bridge.recordSyntheticSpeechMarker('CALL-1', 'speech-start')).toMatchObject({
      accepted: false,
      reason: 'no-active-audio-stream',
    });
  });
});
