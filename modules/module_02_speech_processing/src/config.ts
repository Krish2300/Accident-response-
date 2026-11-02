import 'dotenv/config';
import { readNumber, readEnum, readString, readOptionalString } from '@resus/core';
import { SUPPORTED_LANGUAGES, VOICE_CONFIDENCE } from '@resus/core';

/**
 * Speech providers this build can use.
 *
 * `loopback` is the development adapter and reports `isLive: false`. `whisper`
 * and `espeak` shell out to real speech engines (whisper.cpp and espeak-ng) and
 * report `isLive: true`, which is what makes live bidirectional audio over a
 * real SIP call possible without sending caller audio to a third party.
 */
export type SpeechProviderName = 'loopback' | 'whisper';
export type SynthesisProviderName = 'loopback' | 'espeak';

/** Locations of the real speech binaries, when a real provider is selected. */
export interface RealSpeechConfig {
  /** `ffmpeg` executable, used to reshape audio between WAV and signed-linear PCM. */
  ffmpeg: string;
  whisper: {
    binary: string;
    model: string;
    threads: number;
    /** Language code passed to whisper.cpp (`auto` lets it decide). */
    language: string;
  };
  espeak: {
    binary: string;
    /** Named voice, e.g. `en-gb` or `ml`. */
    voice: string;
    /** Approximate words per minute; reassuring speech may run slightly slower. */
    speedWpm: number;
  };
}

export interface Module2Config {
  speech: {
    /** Recognition provider. */
    provider: SpeechProviderName;
    synthesisProvider: SynthesisProviderName;
    /**
     * Below this confidence a transcription is discarded rather than stored.
     * Defaults to the shared threshold so Module 2 and Module 5 cannot disagree
     * about what counts as high confidence.
     */
    minConfidence: number;
    /** Interim results are published as events but never written to the transcript. */
    emitPartials: boolean;
    /** Audio longer than this is rejected: no call needs it, and accepting it invites abuse. */
    maxAudioBytes: number;
    /** Provider timeout in milliseconds. */
    timeoutMs: number;
    /**
     * Longest text synthesised in one request, in characters.
     *
     * Protocol guidance is split across steps, and the engine already asks for one
     * step at a time; this bound is the backstop that keeps a runaway caller
     * request from turning into a multi-megabyte audio job.
     */
    maxSynthesisChars: number;
    /**
     * Present whenever the build has a real provider configured, so a caller can
     * see the engine paths rather than having to infer them from behaviour.
     */
    real?: RealSpeechConfig;
  };
}

/**
 * Reads Module 2 configuration.
 *
 * `SPEECH_PROVIDER` and `SPEECH_SYNTHESIS_PROVIDER` are read through
 * `readEnum` so that selecting a provider this repository does not ship fails at
 * boot with a list of what it does ship. That is deliberate: a provider named in
 * configuration but absent at runtime would otherwise be a build that boots
 * cleanly and then transcribes nothing.
 */
export function loadModule2Config(): Module2Config {
  const provider = readEnum('SPEECH_PROVIDER', ['loopback', 'whisper'], 'loopback');
  const synthesisProvider = readEnum('SPEECH_SYNTHESIS_PROVIDER', ['loopback', 'espeak'], 'loopback');

  const minConfidence = readNumber('SPEECH_MIN_CONFIDENCE', VOICE_CONFIDENCE.DISCARD_BELOW);
  if (minConfidence < 0 || minConfidence > 1) {
    throw new Error(`SPEECH_MIN_CONFIDENCE must be between 0 and 1, received '${minConfidence}'.`);
  }

  const maxAudioBytes = readNumber('SPEECH_MAX_AUDIO_BYTES', 512_000);
  if (maxAudioBytes <= 0) {
    throw new Error(`SPEECH_MAX_AUDIO_BYTES must be positive, received '${maxAudioBytes}'.`);
  }

  const real = loadRealSpeechConfig(provider, synthesisProvider);

  return {
    speech: {
      provider,
      synthesisProvider,
      minConfidence,
      emitPartials: readString('SPEECH_EMIT_PARTIALS', 'true') !== 'false',
      maxAudioBytes,
      timeoutMs: readNumber('SPEECH_TIMEOUT_MS', 15_000),
      maxSynthesisChars: readNumber('SPEECH_MAX_SYNTHESIS_CHARS', 2000),
      ...(real ? { real } : {}),
    },
  };
}

/**
 * Resolves the real-engine binaries, but only when a real provider was chosen.
 *
 * The environment is checked here rather than inside the provider so a missing
 * model fails at boot, once, with the variable name — not at the first emergency
 * call, in the middle of an incident, where a missing engine looks like a silent
 * line.
 */
function loadRealSpeechConfig(
  provider: SpeechProviderName,
  synthesisProvider: SynthesisProviderName,
): RealSpeechConfig | undefined {
  const needsRealEngine = provider === 'whisper' || synthesisProvider === 'espeak';
  if (!needsRealEngine) return undefined;

  return {
    ffmpeg: readString('FFMPEG_BINARY', 'ffmpeg'),
    whisper:
      provider === 'whisper'
        ? {
            binary: readString('WHISPER_CPP_BINARY'),
            model: readString('WHISPER_CPP_MODEL'),
            threads: readNumber('WHISPER_CPP_THREADS', 4),
            language: readString('WHISPER_CPP_LANGUAGE', 'auto'),
          }
        : { binary: '', model: '', threads: 0, language: 'auto' },
    espeak:
      synthesisProvider === 'espeak'
        ? {
            binary: readString('ESPEAK_NG_BINARY', 'espeak-ng'),
            voice: readString('ESPEAK_NG_VOICE', 'en-gb'),
            speedWpm: readNumber('ESPEAK_NG_SPEED_WPM', 145),
          }
        : { binary: '', voice: '', speedWpm: 0 },
  };
}

/** The languages this build will attempt to transcribe or speak. */
export function configuredLanguages(): readonly string[] {
  return SUPPORTED_LANGUAGES;
}

/**
 * Endpoint the provider would use, when one is configured.
 *
 * Kept for parity with Module 1's carrier configuration so an operator can see
 * at a glance that no speech endpoint is set in this deployment.
 */
export function configuredEndpoint(): string | null {
  return readOptionalString('SPEECH_ENDPOINT') ?? null;
}
