import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppError,
  ErrorCode,
  type Logger,
  type SpeechProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
  noopLogger,
} from '@resus/core';
import { decodeAudio, encodeWav, resampleMono16 } from './audioFormat.js';
import { runProcess } from './subprocess.js';

/**
 * Real speech recognition backed by whisper.cpp.
 *
 * This is a genuine acoustic recogniser: it runs the model over the caller's
 * samples and returns text derived from them. There is no scripted path, no
 * transcript smuggled in an audio buffer and no fixed confidence — a call in a
 * quiet room and the same words over a bad line score differently, and the
 * confidence below is computed from the model's own token probabilities so that
 * Module 2's threshold actually decides whether an utterance is kept.
 *
 * Audio contract
 * --------------
 * The bridge hands this provider signed-linear mono PCM (Asterisk's AudioSocket
 * format, 8 kHz). whisper.cpp requires 16 kHz WAV, so the samples are resampled
 * — a real interpolation of real samples, never zero-padding that would leave the
 * model listening to silence. A WAV of any 16-bit rate is accepted too, so the
 * same provider works for audio posted to `/speech/transcribe`.
 *
 * When confidence cannot be derived
 * ---------------------------------
 * whisper.cpp reports `avg_logprob` and `no_speech_prob` per segment. If a
 * build omits the token probabilities *and* `avg_logprob`, the per-segment
 * `no_speech_prob` is still used as the speech probability, so silence and
 * noise — which the model itself flags as non-speech — are discarded rather
 * than hallucinated into a transcript. Only when a segment carries *no*
 * scoring evidence at all does this provider report `NO_SCORE_CONFIDENCE`,
 * which sits below the discard threshold so an unscored transcription is
 * rejected rather than accepted. An unscored result has no evidence the audio
 * contained speech; accepting it at a fabricated confidence is how a whisper
 * hallucination ("(audience applauding)" over white noise) becomes a stored
 * caller utterance.
 */

/**
 * Score reported when the engine produced text but no probability of any kind.
 *
 * Deliberately below `VOICE_CONFIDENCE.DISCARD_BELOW` so an unscored
 * transcription is discarded, not stored and not passed downstream. A guess
 * with no scoring evidence is more dangerous than an admitted gap.
 */
const NO_SCORE_CONFIDENCE = 0.2;

const WHISPER_SAMPLE_RATE = 16_000;

export interface WhisperProviderOptions {
  binary: string;
  model: string;
  threads: number;
  /** `auto` lets whisper choose; any other code forces the language. */
  language: string;
  timeoutMs: number;
  logger?: Logger;
}

export class WhisperSpeechProvider implements SpeechProvider {
  readonly providerName = 'whisper';
  readonly isLive = true;
  readonly supportedLanguages = ['en', 'ml'] as const;

  private readonly logger: Logger;

  constructor(private readonly options: WhisperProviderOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!this.supportedLanguages.includes(request.language as 'en' | 'ml')) {
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `The '${this.providerName}' provider cannot transcribe '${request.language}'. Supported: ${this.supportedLanguages.join(', ')}.`,
        422,
        { provider: this.providerName, language: request.language },
      );
    }
    if (request.audio.length === 0) {
      safeDiagnosticInfo(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...(request.segmentDiagnostics ?? {}),
          inputBytes: 0,
          preprocessingOutcome: 'failed',
          failureKind: 'empty-audio',
          preprocessingDurationMs: 0,
        },
        request.diagnosticScope === 'synthetic-test' ? 'synthetic test Whisper preprocessing diagnostics' : '',
        request.diagnosticScope === 'synthetic-test',
      );
      throw new AppError(ErrorCode.SPEECH_TRANSCRIPTION_FAILED, 'No audio was supplied for transcription.', 422, {
        provider: this.providerName,
      });
    }

    const language = this.options.language === 'auto' ? request.language : this.options.language;
    const preprocessingStartedAt = Date.now();
    let audio: ReturnType<typeof decodeAudio>;
    let resampled: Int16Array;
    let wav: Uint8Array;
    try {
      audio = decodeAudio(request.audio);
      resampled = resampleMono16(audio.pcm, audio.sampleRate, WHISPER_SAMPLE_RATE);
      if (resampled.length === 0) {
        safeDiagnosticInfo(
          this.logger,
          {
            callSessionId: request.callSessionId,
            emergencyId: request.emergencyId,
            scope: request.diagnosticScope,
            ...(request.segmentDiagnostics ?? {}),
            inputBytes: request.audio.length,
            sourceSampleRate: audio.sampleRate,
            sourceChannels: audio.channels,
            sourceBitsPerSample: audio.bitsPerSample,
            decodedSampleCount: audio.pcm.length,
            targetSampleRate: WHISPER_SAMPLE_RATE,
            resampledSampleCount: 0,
            preprocessingOutcome: 'empty-output',
            preprocessingDurationMs: Date.now() - preprocessingStartedAt,
          },
          'synthetic test Whisper preprocessing diagnostics',
          request.diagnosticScope === 'synthetic-test',
        );
        return {
          text: '',
          language: request.language,
          confidence: 0,
          isFinal: request.isFinal,
          providerName: this.providerName,
          isLive: this.isLive,
          unclearSpans: [],
        };
      }
      wav = encodeWav(resampled, WHISPER_SAMPLE_RATE);
    } catch (error) {
      safeDiagnosticInfo(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...(request.segmentDiagnostics ?? {}),
          inputBytes: request.audio.length,
          preprocessingOutcome: 'failed',
          failureKind: 'invalid-or-unsupported-audio',
          preprocessingDurationMs: Date.now() - preprocessingStartedAt,
        },
        'synthetic test Whisper preprocessing diagnostics',
        request.diagnosticScope === 'synthetic-test',
      );
      throw error;
    }

    let workDir: string;
    try {
      workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resus-whisper-'));
    } catch (error) {
      safeDiagnosticInfo(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...(request.segmentDiagnostics ?? {}),
          inputBytes: request.audio.length,
          preprocessingOutcome: 'failed',
          failureKind: 'temporary-directory-create-failed',
          preprocessingDurationMs: Date.now() - preprocessingStartedAt,
        },
        'synthetic test Whisper preprocessing diagnostics',
        request.diagnosticScope === 'synthetic-test',
      );
      throw error;
    }
    try {
      const wavPath = path.join(workDir, 'audio.wav');
      try {
        await fs.writeFile(wavPath, wav);
      } catch (error) {
        safeDiagnosticInfo(
          this.logger,
          {
            callSessionId: request.callSessionId,
            emergencyId: request.emergencyId,
            scope: request.diagnosticScope,
            ...(request.segmentDiagnostics ?? {}),
            inputBytes: request.audio.length,
            sourceSampleRate: audio.sampleRate,
            sourceChannels: audio.channels,
            sourceBitsPerSample: audio.bitsPerSample,
            decodedSampleCount: audio.pcm.length,
            targetSampleRate: WHISPER_SAMPLE_RATE,
            resampledSampleCount: resampled.length,
            wavBytes: wav.length,
            preprocessingOutcome: 'failed',
            failureKind: 'temporary-wav-write-failed',
            preprocessingDurationMs: Date.now() - preprocessingStartedAt,
          },
          'synthetic test Whisper preprocessing diagnostics',
          request.diagnosticScope === 'synthetic-test',
        );
        throw error;
      }
      safeDiagnosticInfo(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...(request.segmentDiagnostics ?? {}),
          inputBytes: request.audio.length,
          sourceSampleRate: audio.sampleRate,
          sourceChannels: audio.channels,
          sourceBitsPerSample: audio.bitsPerSample,
          decodedSampleCount: audio.pcm.length,
          targetSampleRate: WHISPER_SAMPLE_RATE,
          resampledSampleCount: resampled.length,
          wavBytes: wav.length,
          format: 'mono-signed-int16-pcm-wav',
          preprocessingOutcome: 'prepared',
          preprocessingDurationMs: Date.now() - preprocessingStartedAt,
        },
        'synthetic test Whisper preprocessing diagnostics',
        request.diagnosticScope === 'synthetic-test',
      );

      // whisper.cpp builds disagree about which flag carries the recogniser's
      // scores. `-ojf` (`--output-json-full`) is the one that emits the
      // per-token probabilities `parseWhisperJson` needs to derive a real
      // confidence; plain `-oj` on the deployed build (1.9.5-dev) writes only
      // timestamps and text, which would leave every transcription unscored and
      // therefore discarded as `NO_SCORE_CONFIDENCE` — real caller speech could
      // never be accepted. Builds that predate `-ojf` exit non-zero printing
      // usage, so `-oj` is retried below: those still return text, it simply
      // arrives with no score to trust. The output filename varies too (1.9
      // appends `.json`, others replace the extension), so both candidates are
      // read below so a naming difference cannot turn an utterance into a
      // transcription failure.
      const argsWith = (jsonFlag: string): string[] => [
        '-m',
        this.options.model,
        '-f',
        wavPath,
        '-t',
        String(Math.max(1, this.options.threads)),
        '-l',
        language,
        jsonFlag,
        '-nt',
      ];
      const whisperStartedAt = Date.now();
      let parsed: ParsedWhisper;
      try {
        try {
          await runProcess(this.options.binary, argsWith('-ojf'), { timeoutMs: this.options.timeoutMs });
        } catch {
          await runProcess(this.options.binary, argsWith('-oj'), { timeoutMs: this.options.timeoutMs });
        }
        const raw = await readWhisperJson([`${wavPath}.json`, wavPath.replace(/\.wav$/, '.json')]);
        parsed = parseWhisperJson(raw);
      } catch (error) {
        safeDiagnosticInfo(
          this.logger,
          {
            callSessionId: request.callSessionId,
            emergencyId: request.emergencyId,
            scope: request.diagnosticScope,
            ...(request.segmentDiagnostics ?? {}),
            inferenceOutcome: 'failed',
            whisperInvocationMs: Date.now() - whisperStartedAt,
          },
          'synthetic test Whisper invocation diagnostics',
          request.diagnosticScope === 'synthetic-test',
        );
        throw error;
      }
      safeDiagnosticInfo(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...(request.segmentDiagnostics ?? {}),
          inferenceOutcome: 'completed',
          whisperInvocationMs: Date.now() - whisperStartedAt,
          transcriptCharacters: parsed.text.length,
          confidence: parsed.confidence,
        },
        'synthetic test Whisper invocation diagnostics',
        request.diagnosticScope === 'synthetic-test',
      );

      return {
        text: parsed.text,
        language: request.language,
        confidence: parsed.confidence,
        isFinal: request.isFinal,
        providerName: this.providerName,
        isLive: this.isLive,
        unclearSpans: [],
      };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function safeDiagnosticInfo(logger: Logger, fields: Record<string, unknown>, message: string, enabled: boolean): void {
  if (!enabled) return;
  try {
    logger.info(fields, message);
  } catch {
    // Diagnostic logging is best-effort and must not fail speech processing.
  }
}

interface ParsedWhisper {
  text: string;
  confidence: number;
}

/**
 * Reads the first JSON output file whisper.cpp actually wrote.
 *
 * The output base is the input path, so the same build that names the file
 * `audio.wav.json` when handed `audio.wav` may name it `audio.json` elsewhere.
 * Trying each candidate keeps the recogniser usable across builds instead of
 * failing a live utterance over a filename convention.
 */
export async function readWhisperJson(candidates: string[]): Promise<string> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Reads the transcript and a confidence score out of whisper.cpp's JSON.
 *
 * Structure is navigated defensively: the recogniser's text is useful on its own,
 * and an unexpected layout must degrade to "text with no score" rather than
 * throwing away a transcription the caller is waiting on. A genuinely missing
 * score is reported as `NO_SCORE_CONFIDENCE`, never as a fabricated high one.
 */
export function parseWhisperJson(raw: string): ParsedWhisper {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AppError(
      ErrorCode.PROVIDER_UNAVAILABLE,
      'whisper.cpp produced output that was not valid JSON; the transcript cannot be read.',
      503,
      { provider: 'whisper' },
    );
  }

  const root = (data ?? {}) as Record<string, unknown>;
  const segments: Array<Record<string, unknown>> = [];

  const transcription = Array.isArray(root.transcription) ? (root.transcription as Array<Record<string, unknown>>) : [];
  for (const entry of transcription) {
    if (typeof entry.text === 'string') segments.push(entry);
    const inner = Array.isArray(entry.segments) ? (entry.segments as Array<Record<string, unknown>>) : [];
    for (const segment of inner) segments.push(segment);
  }

  const text = transcriptText(transcription, segments);

  if (text.trim() === '') return { text: '', confidence: 0 };

  const scores = segments
    .map((segment) => scoreOf(segment))
    .filter((value): value is number => value !== null);
  if (scores.length === 0) {
    return { text: text.trim(), confidence: NO_SCORE_CONFIDENCE };
  }

  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return { text: text.trim(), confidence: Math.min(1, Math.max(0, average)) };
}

/**
 * Turns one whisper segment into a 0..1 score.
 *
 * Token probabilities are the most direct evidence, so they win; `avg_logprob`
 * (the mean log of the per-token probabilities) is the next fallback and is
 * exponentiated back into a probability. `no_speech_prob` pulls the score down
 * when the model itself suspects the segment contained no speech, because a
 * confident transcription of noise is exactly what the confidence threshold is
 * supposed to stop.
 *
 * When a build supplies neither token probabilities nor `avg_logprob`, the
 * segment's `no_speech_prob` is used directly as the score's complement. This
 * is what stops a silence/white-noise hallucination ("you", "(audience
 * applauding)") from being stored: the model already flagged the segment as
 * non-speech, so the score stays below the discard threshold even though the
 * text itself looks like real speech. A genuinely unscorable segment (no
 * tokens, no `avg_logprob`, and no `no_speech_prob`) returns `null` so the
 * caller falls back to `NO_SCORE_CONFIDENCE`.
 */
function scoreOf(segment: Record<string, unknown>): number | null {
  const tokens = Array.isArray(segment.tokens) ? (segment.tokens as Array<Record<string, unknown>>) : [];
  const tokenScores = tokens
    .map((token) => (typeof token.p === 'number' ? token.p : null))
    .filter((value): value is number => value !== null);

  const hasNoSpeechProb = typeof segment.no_speech_prob === 'number';
  const noSpeechProb = hasNoSpeechProb ? (segment.no_speech_prob as number) : 0;
  const speechWeight = Math.min(1, Math.max(0, 1 - noSpeechProb));

  if (tokenScores.length > 0) {
    const mean = tokenScores.reduce((sum, value) => sum + value, 0) / tokenScores.length;
    return clamp01(mean * speechWeight);
  }

  if (typeof segment.avg_logprob === 'number') {
    return clamp01(Math.exp(segment.avg_logprob) * speechWeight);
  }

  if (hasNoSpeechProb) {
    return clamp01(1 - noSpeechProb);
  }

  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Prefers the top-level transcript; falls back to joining the segments. */
function transcriptText(
  transcription: Array<Record<string, unknown>>,
  segments: Array<Record<string, unknown>>,
): string {
  const topLevel = transcription[0]?.text;
  if (typeof topLevel === 'string' && topLevel.trim() !== '') return topLevel;
  return segments
    .map((segment) => (typeof segment.text === 'string' ? segment.text : ''))
    .join('');
}
