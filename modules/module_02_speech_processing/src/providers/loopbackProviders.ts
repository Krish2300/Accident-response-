import {
  AppError,
  ErrorCode,
  VOICE_CONFIDENCE,
  type SpeechProvider,
  type SynthesisRequest,
  type SynthesisResult,
  type TextToSpeechProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from '@resus/core';

/**
 * Development speech adapters.
 *
 * What these actually do
 * ----------------------
 * `LoopbackSpeechProvider` performs no acoustic recognition. It accepts a
 * transcript supplied by the caller alongside the audio and returns that text.
 * `LoopbackSynthesisProvider` returns no audio at all: it returns an empty buffer
 * and a null duration, because a fabricated waveform would let a caller, a test
 * or an operator believe a voice was produced when none was.
 *
 * Why that is useful rather than a gap
 * ------------------------------------
 * Every caller of these ports needs to make decisions from the *result*, not from
 * the audio: does the transcript clear the confidence threshold, is the language
 * supported, does a provider outage become a recorded event, is synthesis
 * refused for a language the system does not speak. All of that is exercised
 * faithfully here, so the whole platform can be built and demonstrated end to
 * end without a microphone, a speaker or a speech vendor.
 *
 * What it cannot do
 * -----------------
 * It cannot verify that anyone actually said the supplied words. That is the
 * honest limit of a development adapter, and `isLive: false` on both providers
 * means the fact travels with every result rather than living only in this file.
 */

/** UTF-8 encoding of the agreed script, used as a stand-in for an audio payload. */
const UTF8 = new TextEncoder();

export interface LoopbackSpeechOptions {
  /**
   * Transcript to return, keyed by `callSessionId`.
   *
   * This is the only override the provider has. A separate blanket `defaultText`
   * was removed as unreachable: the service rejects empty audio before the
   * provider is called, and any non-empty carrier decodes to non-empty text, so
   * such a fallback could never be reached.
   */
  scripted?: Record<string, string>;
  /** Overrides the reported confidence, for threshold tests. */
  confidence?: number;
  /** Set to make transcribe() throw, for failure-path tests. */
  failWith?: string;
}

export class LoopbackSpeechProvider implements SpeechProvider {
  readonly providerName = 'loopback';
  readonly isLive = false;
  readonly supportedLanguages = ['en', 'ml'] as const;

  constructor(private readonly options: LoopbackSpeechOptions = {}) {}

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    if (this.options.failWith) {
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, this.options.failWith, 503, {
        provider: this.providerName,
      });
    }

    // The requested language must be one this provider declares. Refusing is the
    // point: silently transcribing Malayalam speech with an English model
    // produces plausible nonsense, which is far more dangerous than a refusal.
    if (!this.supportedLanguages.includes(request.language as 'en' | 'ml')) {
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `The '${this.providerName}' provider cannot transcribe '${request.language}'. Supported: ${this.supportedLanguages.join(', ')}.`,
        422,
        { provider: this.providerName, language: request.language },
      );
    }

    // Precedence: an explicitly scripted session wins, then whatever the request's
    // carrier holds.
    //
    // The carrier stands in for what was actually said, so there is deliberately
    // no blanket default beneath it — one would make every utterance in a session
    // return the same fixed string.
    let text = this.options.scripted?.[request.callSessionId] ?? '';
    if (text === '') {
      try {
        text = readAudioCarrier(request.audio);
      } catch {
        // Undecodable carrier: an empty transcription, which the service turns
        // into a recorded EMPTY_AUDIO failure rather than an exception.
        text = '';
      }
    }

    return {
      text,
      language: request.language,
      // A development adapter has no acoustic evidence, so it reports the
      // configured default rather than a number implying measurement.
      confidence: this.options.confidence ?? VOICE_CONFIDENCE.HIGH,
      isFinal: request.isFinal,
      providerName: this.providerName,
      isLive: false,
      unclearSpans: [],
    };
  }
}

export interface LoopbackSynthesisOptions {
  /** Voice label recorded on SPEECH_SYNTHESIZED. */
  voice?: string;
  failWith?: string;
  /** Languages this build will not synthesize, for refusal tests. */
  unsupportedLanguages?: string[];
}

export class LoopbackSynthesisProvider implements TextToSpeechProvider {
  readonly providerName = 'loopback';
  readonly isLive = false;
  readonly supportedLanguages = ['en', 'ml'] as const;

  constructor(private readonly options: LoopbackSynthesisOptions = {}) {}

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    if (this.options.failWith) {
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, this.options.failWith, 503, {
        provider: this.providerName,
      });
    }

    if (
      (this.options.unsupportedLanguages ?? []).includes(request.language) ||
      !this.supportedLanguages.includes(request.language as 'en' | 'ml')
    ) {
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `The '${this.providerName}' provider cannot speak '${request.language}'. Supported: ${this.supportedLanguages.join(', ')}.`,
        422,
        { provider: this.providerName, language: request.language },
      );
    }

    return {
      // No audio. An empty buffer and a null duration say "nothing was played"
      // rather than "something was played that happens to be silent".
      audio: new Uint8Array(0),
      mimeType: 'application/octet-stream',
      providerName: this.providerName,
      isLive: false,
      voice: this.options.voice ?? 'loopback-none',
      durationMs: null,
    };
  }
}

/**
 * Audio-free carrier for a development exchange.
 *
 * Development has no microphone, so a transcript cannot be produced from audio.
 * This carries the agreed text in the `text` field of the audio buffer, which is
 * a convention and not an audio format. It is only accepted by the loopback
 * provider, so it cannot reach a real recognizer by accident.
 */
export function audioCarrier(text: string): Uint8Array {
  return UTF8.encode(text);
}

/** Reads text back out of a carrier produced by `audioCarrier`. */
export function readAudioCarrier(audio: Uint8Array): string {
  return new TextDecoder().decode(audio);
}