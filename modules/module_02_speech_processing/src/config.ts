import 'dotenv/config';
import { readNumber, readEnum, readString, readOptionalString } from '@resus/core';
import { SUPPORTED_LANGUAGES, VOICE_CONFIDENCE } from '@resus/core';

export type SpeechProviderName = 'loopback';
export type SynthesisProviderName = 'loopback';

export interface Module2Config {
  speech: {
    /** Recognition provider. Only the development adapter ships in this repo. */
    provider: SpeechProviderName;
    synthesisProvider: SynthesisProviderName;
    /**
     * Below this confidence a transcription is discarded rather than stored.
     * Defaults to the shared threshold so Module 2 and Module 5 cannot disagree
     * about the same audio.
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
  const provider = readEnum('SPEECH_PROVIDER', ['loopback'], 'loopback');
  const synthesisProvider = readEnum('SPEECH_SYNTHESIS_PROVIDER', ['loopback'], 'loopback');

  const minConfidence = readNumber('SPEECH_MIN_CONFIDENCE', VOICE_CONFIDENCE.DISCARD_BELOW);
  if (minConfidence < 0 || minConfidence > 1) {
    throw new Error(`SPEECH_MIN_CONFIDENCE must be between 0 and 1, received '${minConfidence}'.`);
  }

  const maxAudioBytes = readNumber('SPEECH_MAX_AUDIO_BYTES', 512_000);
  if (maxAudioBytes <= 0) {
    throw new Error(`SPEECH_MAX_AUDIO_BYTES must be positive, received '${maxAudioBytes}'.`);
  }

  return {
    speech: {
      provider,
      synthesisProvider,
      minConfidence,
      emitPartials: readString('SPEECH_EMIT_PARTIALS', 'true') !== 'false',
      maxAudioBytes,
      timeoutMs: readNumber('SPEECH_TIMEOUT_MS', 15_000),
      maxSynthesisChars: readNumber('SPEECH_MAX_SYNTHESIS_CHARS', 2000),
    },
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