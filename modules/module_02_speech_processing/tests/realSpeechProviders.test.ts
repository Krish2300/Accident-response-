import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode, VOICE_CONFIDENCE, noopLogger } from '@resus/core';
import {
  decodeAudio,
  downmixToMono,
  durationMs,
  encodeWav,
  looksLikeWav,
  resampleMono16,
  toMonoSlin,
} from '../src/providers/audioFormat.js';
import { parseWhisperJson, readWhisperJson, WhisperSpeechProvider } from '../src/providers/whisperProvider.js';
import { runProcess } from '../src/providers/subprocess.js';
import { espeakDeliveryFor } from '../src/providers/espeakProvider.js';

/**
 * Tests for the real speech stack's audio handling.
 *
 * Provider unit tests isolate the child-process engines rather than silently
 * skipping when a binary is absent. The local WSL engines are exercised
 * separately by the acceptance sample run. These tests cover the audio contract
 * (including 8-to-16 kHz conversion) and confidence handling without treating a
 * mock as live integration evidence.
 */

// -- helpers -----------------------------------------------------------------

function int16Bytes(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    bytes[i * 2] = (samples[i]! & 0xff) as number;
    bytes[i * 2 + 1] = ((samples[i]! >> 8) & 0xff) as number;
  }
  return bytes;
}

function wavWith(sampleRate: number, channels: number, bitsPerSample: number, samples: number[]): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = (samples.length * bitsPerSample) / 8;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    if (bitsPerSample === 16) {
      bytes[44 + i * 2] = sample & 0xff;
      bytes[44 + i * 2 + 1] = (sample >> 8) & 0xff;
    } else {
      bytes[44 + i] = sample & 0xff;
    }
  }
  return bytes;
}

/** A well-formed header long enough to parse, but carrying no data chunk. */
function wavWithoutDataChunk(): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 40, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'fact');
  view.setUint32(40, 4, true);
  view.setUint32(44, 0, true);
  return bytes;
}

async function expectAppError(promise: Promise<unknown>, code: string, pattern: RegExp): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as AppError).message).toMatch(pattern);
    return error as AppError;
  }
  throw new Error(`expected rejection with ${code}`);
}

// -- audio format ------------------------------------------------------------

describe('eSpeak delivery pace', () => {
  it('uses the configured slow pace for calm and urgent prompts', () => {
    expect(espeakDeliveryFor(145, 'CALM').speedWpm).toBe(145);
    expect(espeakDeliveryFor(145, 'URGENT').speedWpm).toBe(145);
  });

  it('slows reassuring prompts slightly without going below the supported floor', () => {
    expect(espeakDeliveryFor(145, 'REASSURING').speedWpm).toBe(135);
    expect(espeakDeliveryFor(85, 'REASSURING').speedWpm).toBe(80);
  });
});

describe('audioFormat', () => {
  it('recognises a WAV header and does not mistake raw PCM for one', () => {
    expect(looksLikeWav(wavWith(16_000, 1, 16, [1, 2, 3]))).toBe(true);
    expect(looksLikeWav(int16Bytes([1, 2, 3]))).toBe(false);
    expect(looksLikeWav(new Uint8Array(4))).toBe(false);
  });

  it('reads raw AudioSocket PCM as mono signed-linear at the assumed rate', () => {
    const audio = decodeAudio(int16Bytes([0, 1000, -1000, 32_767]), 8_000);
    expect(audio).toMatchObject({ sampleRate: 8_000, channels: 1, bitsPerSample: 16 });
    expect([...audio.pcm]).toEqual([0, 1000, -1000, 32_767]);
  });

  it('round-trips PCM through encodeWav and decodeAudio without altering a sample', () => {
    const pcm = Int16Array.from([0, 1, -1, 12_345, -12_345, 32_767, -32_768, 7]);
    const decoded = decodeAudio(encodeWav(pcm, 16_000));
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.channels).toBe(1);
    expect(decoded.bitsPerSample).toBe(16);
    expect([...decoded.pcm]).toEqual([...pcm]);
  });

  it('reports the real sample rate written in the WAV header', () => {
    const decoded = decodeAudio(wavWith(22_050, 1, 16, [1, 2, 3, 4]));
    expect(decoded.sampleRate).toBe(22_050);
    expect(decoded.pcm).toHaveLength(4);
  });

  it('downmixes interleaved channels by averaging them', () => {
    const stereo = Int16Array.from([100, 300, 200, 400]);
    expect([...downmixToMono(stereo, 2)]).toEqual([200, 300]);
    // Averaging must clamp rather than wrap: two full-scale samples stay full-scale.
    expect([...downmixToMono(Int16Array.from([32_767, 32_767]), 2)]).toEqual([32_767]);
    expect([...downmixToMono(Int16Array.from([-32_768, -32_768]), 2)]).toEqual([-32_768]);
    expect(downmixToMono(Int16Array.from([5]), 1)).toBeInstanceOf(Int16Array);
  });

  it('decodes a stereo WAV down to mono', () => {
    const decoded = decodeAudio(wavWith(8_000, 2, 16, [100, 300, 200, 400]));
    expect(decoded.channels).toBe(2);
    expect([...decoded.pcm]).toEqual([200, 300]);
  });

  it('rejects a WAV that is not 16-bit rather than reinterpreting it as noise', () => {
    expect(() => decodeAudio(wavWith(8_000, 1, 8, [1, 2, 3]))).toThrow(/must be 16-bit/);
  });

  it('rejects a header that cannot contain a format or data chunk', () => {
    expect(() => decodeAudio(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toThrow(
      /shorter than a 44-byte header/,
    );
    expect(() => decodeAudio(wavWithoutDataChunk())).toThrow(/no data chunk/);
  });

  it('downsamples by averaging each output frame instead of dropping samples', () => {
    const input = Int16Array.from([100, 200, 300, 400, 500, 600, 700, 800]);
    const output = resampleMono16(input, 8_000, 4_000);
    expect(output).toHaveLength(4);
    expect([...output]).toEqual([150, 350, 550, 750]);
  });

  it('upsamples by interpolating between neighbours rather than repeating them', () => {
    const output = resampleMono16(Int16Array.from([0, 1000]), 4_000, 8_000);
    expect(output).toHaveLength(4);
    expect([...output]).toEqual([0, 500, 1000, 1000]);
  });

  it('preserves duration across a rate change', () => {
    const input = new Int16Array(8_000); // one second at 8 kHz
    expect(durationMs(input, 8_000)).toBe(1_000);
    const output = resampleMono16(input, 8_000, 16_000);
    expect(durationMs(output, 16_000)).toBe(1_000);
  });

  it('returns the same buffer when the rate already matches', () => {
    const input = Int16Array.from([1, 2, 3]);
    expect(resampleMono16(input, 8_000, 8_000)).toBe(input);
    // Empty input resamples to empty: padding it with one sample would invent a frame.
    expect(resampleMono16(new Int16Array(0), 8_000, 16_000)).toHaveLength(0);
  });

  it('rejects a non-positive sample rate instead of dividing by zero', () => {
    expect(() => resampleMono16(Int16Array.from([1]), 0, 8_000)).toThrow(/must be positive/);
    expect(() => resampleMono16(Int16Array.from([1]), 8_000, -1)).toThrow(/must be positive/);
  });

  it('resamples decoded audio to the rate the caller asked for', () => {
    const espeakShaped = decodeAudio(wavWith(22_050, 1, 16, new Array(22_050).fill(1_000)));
    const slin = toMonoSlin(espeakShaped, 8_000);
    expect(slin).toHaveLength(8_000);
    expect(durationMs(slin, 8_000)).toBe(1_000);
    // A constant signal must stay constant through the box filter — no ringing,
    // no edge samples collapsing to silence.
    expect(slin[0]).toBe(1_000);
    expect(slin[slin.length - 1]).toBe(1_000);
  });

  it('reports zero duration for empty or unusable input', () => {
    expect(durationMs(new Int16Array(0), 8_000)).toBe(0);
    expect(durationMs(new Int16Array(10), 0)).toBe(0);
  });
});

// -- whisper.cpp output parsing ----------------------------------------------

describe('parseWhisperJson', () => {
  it('reads the top-level transcript and scores it from token probabilities', () => {
    const raw = JSON.stringify({
      transcription: [
        {
          text: ' Help me ',
          segments: [{ text: ' Help me ', tokens: [{ p: 0.9 }, { p: 0.8 }], no_speech_prob: 0.01 }],
        },
      ],
    });
    const parsed = parseWhisperJson(raw);
    expect(parsed.text).toBe('Help me');
    // mean(0.9, 0.8) * (1 - 0.01) = 0.8415
    expect(parsed.confidence).toBeCloseTo(0.8415, 4);
    expect(parsed.confidence).toBeGreaterThanOrEqual(VOICE_CONFIDENCE.HIGH);
  });

  it('falls back to avg_logprob when the build reports no token scores', () => {
    const raw = JSON.stringify({
      transcription: [{ text: 'ambulance', segments: [{ text: 'ambulance', avg_logprob: -0.2 }] }],
    });
    expect(parseWhisperJson(raw).confidence).toBeCloseTo(Math.exp(-0.2), 5);
  });

  it('rejects an unscorable segment rather than accepting it at a fabricated confidence', () => {
    const raw = JSON.stringify({ transcription: [{ text: 'help', segments: [{ text: 'help' }] }] });
    const parsed = parseWhisperJson(raw);
    expect(parsed.text).toBe('help');
    // An unscored result has no evidence the audio contained speech, so it is
    // discarded below DISCARD_BELOW instead of being kept in the LOW band.
    expect(parsed.confidence).toBeLessThan(VOICE_CONFIDENCE.DISCARD_BELOW);
  });

  it('pulls the score down when the model itself suspects there was no speech', () => {
    const raw = JSON.stringify({
      transcription: [{ text: 'noise', segments: [{ text: 'noise', avg_logprob: -0.1, no_speech_prob: 0.95 }] }],
    });
    const parsed = parseWhisperJson(raw);
    expect(parsed.confidence).toBeLessThan(VOICE_CONFIDENCE.DISCARD_BELOW);
  });

  it('returns an empty result rather than a scored guess when there is no text', () => {
    expect(parseWhisperJson(JSON.stringify({ transcription: [] }))).toEqual({ text: '', confidence: 0 });
    expect(parseWhisperJson(JSON.stringify({}))).toEqual({ text: '', confidence: 0 });
    expect(parseWhisperJson(JSON.stringify({ transcription: [{ text: '   ' }] }))).toEqual({
      text: '',
      confidence: 0,
    });
  });

  it('joins segments when the recogniser gave no top-level transcript', () => {
    const raw = JSON.stringify({
      transcription: [{ segments: [{ text: 'the caller' }, { text: ' fainted' }] }],
    });
    expect(parseWhisperJson(raw).text).toBe('the caller fainted');
  });

  it('falls back to the segments when the top-level transcript is whitespace', () => {
    const raw = JSON.stringify({
      transcription: [{ text: '   ', segments: [{ text: ' ok', avg_logprob: 0 }] }],
    });
    const parsed = parseWhisperJson(raw);
    expect(parsed.text).toBe('ok');
    expect(parsed.confidence).toBe(1);
  });

  it('clamps an out-of-range score into 0..1', () => {
    const raw = JSON.stringify({
      transcription: [{ text: 'hi', segments: [{ text: 'hi', tokens: [{ p: 5 }] }] }],
    });
    expect(parseWhisperJson(raw).confidence).toBe(1);
  });

  it('treats a malformed segment shape as "no score" and rejects it instead of throwing', () => {
    const raw = JSON.stringify({ transcription: [{ text: 'hi', segments: 'not-an-array' }] });
    const parsed = parseWhisperJson(raw);
    expect(parsed.text).toBe('hi');
    expect(parsed.confidence).toBeLessThan(VOICE_CONFIDENCE.DISCARD_BELOW);
  });

  it('rejects a silence hallucination flagged non-speech by no_speech_prob alone', () => {
    // whisper.cpp over pure silence: model emits a hallucinated short token
    // ("you") but flags the segment as non-speech. No token scores, no
    // avg_logprob — only no_speech_prob. Must not be stored as a real utterance.
    const raw = JSON.stringify({
      transcription: [{ text: ' you', segments: [{ text: ' you', no_speech_prob: 0.95 }] }],
    });
    const parsed = parseWhisperJson(raw);
    expect(parsed.text).toBe('you');
    expect(parsed.confidence).toBeLessThan(VOICE_CONFIDENCE.DISCARD_BELOW);
  });

  it('rejects a white-noise hallucination flagged non-speech by no_speech_prob alone', () => {
    // The classic whisper hallucination over noise: "(audience applauding)".
    // Same signal shape as silence — no tokens, no avg_logprob, high
    // no_speech_prob. Must not be persisted as a caller utterance.
    const raw = JSON.stringify({
      transcription: [
        { text: ' (audience applauding)', segments: [{ text: ' (audience applauding)', no_speech_prob: 0.92 }] },
      ],
    });
    const parsed = parseWhisperJson(raw);
    expect(parsed.text).toBe('(audience applauding)');
    expect(parsed.confidence).toBeLessThan(VOICE_CONFIDENCE.DISCARD_BELOW);
  });

  it('keeps a legitimate short utterance when the model scored it as speech', () => {
    // A real short answer ("yes") with token probabilities and low
    // no_speech_prob must survive — the fix must not reject short transcripts.
    const raw = JSON.stringify({
      transcription: [
        { text: ' yes', segments: [{ text: ' yes', tokens: [{ p: 0.97 }], no_speech_prob: 0.02 }] },
      ],
    });
    const parsed = parseWhisperJson(raw);
    expect(parsed.text).toBe('yes');
    // 0.97 * (1 - 0.02) = 0.9506
    expect(parsed.confidence).toBeCloseTo(0.9506, 4);
    expect(parsed.confidence).toBeGreaterThanOrEqual(VOICE_CONFIDENCE.HIGH);
  });

  it('rejects when no_speech_prob is the only evidence and it is high', () => {
    // A hallucinated token with a moderate-confidence non-speech flag and no
    // other scores: the model itself says this is probably not speech.
    const raw = JSON.stringify({
      transcription: [{ text: ' thank you', segments: [{ text: ' thank you', no_speech_prob: 0.7 }] }],
    });
    const parsed = parseWhisperJson(raw);
    // 1 - 0.7 = 0.3, below the discard threshold.
    expect(parsed.confidence).toBeLessThan(VOICE_CONFIDENCE.DISCARD_BELOW);
  });

  it('keeps a segment when no_speech_prob is the only evidence and it is low', () => {
    // Speech with only a no_speech_prob score (a build that omitted token
    // probabilities and avg_logprob but still reported no_speech_prob).
    const raw = JSON.stringify({
      transcription: [{ text: ' help', segments: [{ text: ' help', no_speech_prob: 0.05 }] }],
    });
    const parsed = parseWhisperJson(raw);
    // 1 - 0.05 = 0.95
    expect(parsed.confidence).toBeCloseTo(0.95, 5);
    expect(parsed.confidence).toBeGreaterThanOrEqual(VOICE_CONFIDENCE.HIGH);
  });

  it('still applies no_speech_prob when token scores are present', () => {
    // Confident token scores over what the model flags as non-speech: the
    // speech weight multiplies down and the segment is discarded.
    const raw = JSON.stringify({
      transcription: [
        {
          text: ' (audience applauding)',
          segments: [{ text: ' (audience applauding)', tokens: [{ p: 0.99 }], no_speech_prob: 0.98 }],
        },
      ],
    });
    const parsed = parseWhisperJson(raw);
    // 0.99 * (1 - 0.98) = 0.0198
    expect(parsed.confidence).toBeLessThan(VOICE_CONFIDENCE.DISCARD_BELOW);
  });

  it('rejects a segment with no tokens, no avg_logprob, and no no_speech_prob', () => {
    // Genuinely unscorable: text exists but every scoring field is absent.
    // Must fall back to NO_SCORE_CONFIDENCE (below discard), not 0.7.
    const raw = JSON.stringify({ transcription: [{ text: ' hello', segments: [{ text: ' hello' }] }] });
    const parsed = parseWhisperJson(raw);
    expect(parsed.text).toBe('hello');
    expect(parsed.confidence).toBeLessThan(VOICE_CONFIDENCE.DISCARD_BELOW);
  });

  it('fails loudly when whisper.cpp wrote something that is not JSON', () => {
    expect.assertions(3);
    try {
      parseWhisperJson('not json at all');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.PROVIDER_UNAVAILABLE);
      expect((error as AppError).message).toMatch(/not valid JSON/);
    }
  });
});

describe('WhisperSpeechProvider guards', () => {
  const provider = new WhisperSpeechProvider({
    binary: 'whisper-cli',
    model: 'ggml-model.bin',
    threads: 2,
    language: 'auto',
    timeoutMs: 5_000,
  });

  it('declares itself live because it runs a genuine recogniser', () => {
    expect(provider.providerName).toBe('whisper');
    expect(provider.isLive).toBe(true);
    expect([...provider.supportedLanguages]).toEqual(['en', 'ml']);
  });

  it('refuses a language it cannot transcribe instead of returning empty text', async () => {
    await expectAppError(
      provider.transcribe({
        callSessionId: 'CALL-1',
        emergencyId: 'EMG-1',
        language: 'fr',
        audio: int16Bytes([1, 2, 3]),
        isFinal: true,
      }),
      ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
      /cannot transcribe 'fr'/,
    );
  });

  it('refuses an empty request rather than running the engine over silence', async () => {
    await expectAppError(
      provider.transcribe({
        callSessionId: 'CALL-1',
        emergencyId: 'EMG-1',
        language: 'en',
        audio: new Uint8Array(0),
        isFinal: true,
      }),
      ErrorCode.SPEECH_TRANSCRIPTION_FAILED,
      /No audio was supplied/,
    );
  });

  it('returns empty decoded input without requiring segment metadata or trusting a throwing diagnostic logger', async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const logger = {
      ...noopLogger,
      info(fields: unknown) {
        diagnostics.push(fields as Record<string, unknown>);
        throw new Error('diagnostic sink unavailable');
      },
    };
    const providerWithoutSegment = new WhisperSpeechProvider({
      binary: 'unused-whisper-binary',
      model: 'unused-whisper-model',
      threads: 1,
      language: 'auto',
      timeoutMs: 5_000,
      logger,
    });

    const result = await providerWithoutSegment.transcribe({
      callSessionId: 'CALL-1',
      emergencyId: 'EMG-1',
      language: 'en',
      audio: Uint8Array.of(0),
      isFinal: true,
      diagnosticScope: 'synthetic-test',
    });

    expect(result).toMatchObject({ text: '', confidence: 0, isFinal: true });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ preprocessingOutcome: 'empty-output', resampledSampleCount: 0 });
    expect(diagnostics[0]).not.toHaveProperty('segmentId');
  });

  it('preserves the empty-audio error when the diagnostic sink throws and segment metadata is absent', async () => {
    const logger = {
      ...noopLogger,
      info() {
        throw new Error('diagnostic sink unavailable');
      },
    };
    const providerWithThrowingLogger = new WhisperSpeechProvider({
      binary: 'unused-whisper-binary',
      model: 'unused-whisper-model',
      threads: 1,
      language: 'auto',
      timeoutMs: 5_000,
      logger,
    });

    await expect(
      providerWithThrowingLogger.transcribe({
        callSessionId: 'CALL-1',
        emergencyId: 'EMG-1',
        language: 'en',
        audio: new Uint8Array(0),
        isFinal: true,
        diagnosticScope: 'synthetic-test',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.SPEECH_TRANSCRIPTION_FAILED, statusCode: 422 });
  });
});

// -- whisper.cpp output file naming ------------------------------------------

describe('readWhisperJson', () => {
  it('reads the JSON named after the full input file, as whisper.cpp 1.9 writes it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resus-whisper-name-'));
    try {
      const wavPath = path.join(dir, 'audio.wav');
      await fs.writeFile(`${wavPath}.json`, '{"transcription":[{"text":" help"}]}');

      const raw = await readWhisperJson([`${wavPath}.json`, wavPath.replace(/\.wav$/, '.json')]);

      expect((JSON.parse(raw) as { transcription: Array<{ text: string }> }).transcription[0]!.text).toBe(' help');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('reads the JSON beside the input when a build replaces the extension instead', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resus-whisper-name-'));
    try {
      const wavPath = path.join(dir, 'audio.wav');
      await fs.writeFile(wavPath.replace(/\.wav$/, '.json'), '{"transcription":[{"text":" pain"}]}');

      const raw = await readWhisperJson([`${wavPath}.json`, wavPath.replace(/\.wav$/, '.json')]);

      expect((JSON.parse(raw) as { transcription: Array<{ text: string }> }).transcription[0]!.text).toBe(' pain');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

// -- engine subprocess -------------------------------------------------------

describe('runProcess', () => {
  const node = process.execPath;

  it('captures stdout from a healthy engine run', async () => {
    const result = await runProcess(node, ['-e', 'process.stdout.write("transcript")'], { timeoutMs: 5_000 });
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8')).toBe('transcript');
  });

  it('surfaces a non-zero exit with the engine\'s stderr in the message', async () => {
    await expectAppError(
      runProcess(node, ['-e', 'console.error("bad model"); process.exit(3)'], { timeoutMs: 5_000 }),
      ErrorCode.PROVIDER_UNAVAILABLE,
      /exited with code 3: bad model/,
    );
  });

  it('reports a missing executable as an unavailable engine, not as no speech', async () => {
    await expectAppError(
      runProcess('resus-definitely-not-installed-xyz', [], { timeoutMs: 5_000 }),
      ErrorCode.PROVIDER_UNAVAILABLE,
      /could not be run/,
    );
  });

  it('kills an engine that overruns its deadline instead of leaving a call open', async () => {
    await expectAppError(
      runProcess(node, ['-e', 'setInterval(function(){}, 1000)'], { timeoutMs: 300 }),
      ErrorCode.PROVIDER_UNAVAILABLE,
      /did not finish within 300 ms/,
    );
  });

  it('pipes stdin to an engine that reads its input that way', async () => {
    const result = await runProcess(
      node,
      ['-e', 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write(data.toUpperCase()));'],
      { timeoutMs: 5_000, stdin: 'hello' },
    );
    expect(result.stdout.toString('utf8')).toBe('HELLO');
  });
});
