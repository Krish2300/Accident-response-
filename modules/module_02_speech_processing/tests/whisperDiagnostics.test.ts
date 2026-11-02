import { promises as fs } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { noopLogger, type AudioSegmentDiagnostics } from '@resus/core';

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }));
vi.mock('../src/providers/subprocess.js', () => ({ runProcess: runProcessMock }));

import { WhisperSpeechProvider } from '../src/providers/whisperProvider.js';

const segmentDiagnostics: AudioSegmentDiagnostics = {
  segmentId: 'CALL-1:SEG-0001',
  callRelativeStartMs: 120,
  callRelativeEndMs: 280,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:00.160Z',
  durationMs: 160,
  sampleCount: 1_280,
  boundaryReason: 'silence-hangover',
  transcriptionOutcome: 'submitted',
  frameCount: 8,
  trailingSilenceFrameCount: 2,
  frameRmsMin: 0,
  frameRmsMean: 15_000,
  frameRmsMax: 20_000,
  frameRmsAboveThreshold: 6,
  framePeakMin: 0,
  framePeakMean: 15_000,
  framePeakMax: 20_000,
};

function provider(logger: ConstructorParameters<typeof WhisperSpeechProvider>[0]['logger']) {
  return new WhisperSpeechProvider({
    binary: 'test-whisper',
    model: 'test-model',
    threads: 1,
    language: 'auto',
    timeoutMs: 5_000,
    logger,
  });
}

function mockSuccessfulInference(): void {
  runProcessMock.mockImplementation(async (_binary: string, args: string[]) => {
    const inputIndex = args.indexOf('-f');
    const wavPath = args[inputIndex + 1];
    await fs.writeFile(
      `${wavPath}.json`,
      JSON.stringify({ transcription: [{ text: ' synthetic response', tokens: [{ text: ' synthetic', p: 0.9 }] }] }),
    );
    return { stdout: Buffer.alloc(0), stderr: '', code: 0 };
  });
}

describe('Whisper segment diagnostics', () => {
  it('correlates preprocessing and inference logs to the same segment without logging transcript text', async () => {
    const records: Array<{ fields: Record<string, unknown>; message: string | undefined }> = [];
    runProcessMock.mockReset();
    mockSuccessfulInference();

    const speech = provider({
      ...noopLogger,
      info(fields: unknown, message?: string) {
        records.push({ fields: fields as Record<string, unknown>, message });
      },
    });
    const result = await speech.transcribe({
      callSessionId: 'CALL-1',
      emergencyId: 'EMG-1',
      language: 'en',
      audio: Buffer.alloc(320, 1),
      isFinal: true,
      diagnosticScope: 'synthetic-test',
      segmentDiagnostics,
    });

    const preprocessing = records.find((entry) => entry.message === 'synthetic test Whisper preprocessing diagnostics');
    const inference = records.find((entry) => entry.message === 'synthetic test Whisper invocation diagnostics');
    expect(result.text).toBe('synthetic response');
    expect(preprocessing?.fields).toMatchObject({
      segmentId: segmentDiagnostics.segmentId,
      preprocessingOutcome: 'prepared',
      sourceSampleRate: 8_000,
      targetSampleRate: 16_000,
    });
    expect(inference?.fields).toMatchObject({
      segmentId: segmentDiagnostics.segmentId,
      inferenceOutcome: 'completed',
    });
    expect(inference?.fields).not.toHaveProperty('text');
    expect(typeof inference?.fields.whisperInvocationMs).toBe('number');
  });

  it('does not let a diagnostic sink failure break a successful inference', async () => {
    runProcessMock.mockReset();
    mockSuccessfulInference();
    const speech = provider({
      ...noopLogger,
      info() {
        throw new Error('diagnostic sink unavailable');
      },
    });

    const result = await speech.transcribe({
      callSessionId: 'CALL-1',
      emergencyId: 'EMG-1',
      language: 'en',
      audio: Buffer.alloc(320, 1),
      isFinal: true,
      diagnosticScope: 'synthetic-test',
      segmentDiagnostics,
    });

    expect(result.text).toBe('synthetic response');
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });
});
