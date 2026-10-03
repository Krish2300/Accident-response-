import {
  AppError,
  ErrorCode,
  confidenceBand,
  defineEvent,
  normaliseLanguageCode,
  type CallSession,
  type EventPublisherPort,
  type Logger,
  type SpeechProvider,
  type TextToSpeechProvider,
  type Transcript,
  type TranscriptSpeaker,
  type TranscriptionResult,
  type SynthesisResult,
  noopLogger,
} from '@resus/core';
import type { Module2Config } from './config.js';

/**
 * Module 2 — speech processing.
 *
 * Responsibilities
 * ----------------
 *   - turn caller audio into text (`transcribe`) and text into audio (`speak`)
 *   - decide whether a transcription is reliable enough to keep
 *   - persist final transcriptions to the transcript record
 *   - publish interim results and every provider failure to the event log
 *
 * What this module deliberately does not do
 * -----------------------------------------
 * It does not interpret the words. It does not decide what the system asks next,
 * it does not choose protocol guidance, and it does not judge whether an answer
 * is medically correct. It produces text, records what was said, and refuses to
 * pretend it understood something it did not.
 *
 * Interim results are never persisted
 * -----------------------------------
 * A recogniser emits many guesses per utterance — "he is not", "he is not
 * breathing", "he is not breathing normally". Only the last is what the caller
 * said. Writing the intermediate ones to `transcripts` would corrupt the primary
 * record of the call, and would also consume `sequence` numbers that
 * `appendTranscript` derives from the highest existing row, interleaving guesses
 * with real utterances in the incident review. Interim results are therefore
 * published as `TRANSCRIPT_PARTIAL` events — useful for live captioning — and
 * never written.
 *
 * Reliability is decided before anything downstream sees the text
 * --------------------------------------------------------------
 * A transcription below the configured confidence is discarded, not stored and
 * not passed to interpretation. A low-confidence guess is more dangerous than an
 * admitted gap, because it can be acted on while appearing to be something the
 * caller actually said.
 */

// Module-local persistence shapes, declared structurally so Module 2 has no
// build-time dependency on Module 11. Module 11's `CallRepository` satisfies them.

export interface CallSessionStore {
  sessionById(id: string): Promise<CallSession | null>;
  endSession(id: string): Promise<CallSession | null>;
  appendTranscript(input: {
    callSessionId: string;
    emergencyId: string;
    speaker: string;
    text: string;
    isFinal?: boolean;
    intent?: string | null;
    confidence?: number | null;
    isSimulation?: boolean;
  }): Promise<Transcript>;
}

export interface TranscribeInput {
  callSessionId: string;
  emergencyId: string;
  audio: Uint8Array;
  /** Defaults to the session's own language. */
  language?: string;
  speaker?: TranscriptSpeaker;
  /** False for an interim result. Interim results are never persisted. */
  isFinal?: boolean;
  /** Supplied by Module 3 once it has interpreted the utterance. */
  intent?: string | null;
}

export interface TranscribeResult {
  text: string;
  language: string;
  confidence: number;
  /** HIGH | LOW | UNUSABLE. */
  band: string;
  isFinal: boolean;
  provider: string;
  isLive: boolean;
  /** Set only for a final, accepted transcription. */
  persisted: Transcript | null;
  /** False when the result fell below the confidence threshold. */
  accepted: boolean;
  /** Why an accepted result is still provisional. */
  notice: string | null;
}

export interface SpeakInput {
  text: string;
  language: string;
  tone: 'CALM' | 'URGENT' | 'REASSURING';
  /**
   * Whether `text` is the protocol catalogue's own wording.
   *
   * Deliberately required rather than defaulted: a false `true` writes a record
   * claiming the caller heard clinically reviewed text when they heard something
   * else. Callers must state which they are speaking.
   */
  verbatimProtocolText: boolean;
  emergencyId?: string | null;
  callSessionId?: string | null;
}

export interface SpeakResult {
  audio: Uint8Array;
  mimeType: string;
  provider: string;
  isLive: boolean;
  voice: string;
  durationMs: number | null;
  characterCount: number;
  /**
     * False when the provider returned no playable audio.
     *
     * The development adapter always reports false here, so a caller cannot
     * mistake "synthesis was requested" for "a voice was heard".
     */
  isAudible: boolean;
  verbatimProtocolText: boolean;
}

export interface Module2Deps {
  config: Module2Config;
  speech: SpeechProvider;
  synthesis: TextToSpeechProvider;
  calls: CallSessionStore;
  events: EventPublisherPort;
  logger?: Logger;
}

export class SpeechService {
  private readonly logger: Logger;

  /**
   * Latest interim text per session, so the service can tell a caller what it
   * currently thinks it heard. Deliberately in-memory: interim guesses are not
   * evidence, and a restart must not resurrect them.
   */
  private readonly interim = new Map<string, TranscriptionResult>();

  constructor(private readonly deps: Module2Deps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const { callSessionId, emergencyId } = input;
    const isFinal = input.isFinal ?? true;
    const speaker = input.speaker ?? 'CALLER';

    // The session is checked before the audio is, so a closed call reports that
    // it is closed rather than complaining about a request nobody will use.
    const session = await this.requireLiveSession(callSessionId, emergencyId);
    const language = await this.resolveLanguage(input.language ?? session.language, callSessionId, emergencyId);

    if (input.audio.length === 0) {
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: 'EMPTY_AUDIO',
        reason: 'No audio was supplied.',
      });
      throw new AppError(ErrorCode.SPEECH_TRANSCRIPTION_FAILED, 'No audio was supplied for transcription.', 422, {
        callSessionId,
      });
    }

    const maxBytes = this.deps.config.speech.maxAudioBytes;
    if (input.audio.length > maxBytes) {
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: 'INVALID_AUDIO',
        reason: `Audio is ${input.audio.length} bytes; the limit is ${maxBytes}.`,
      });
      throw new AppError(
        ErrorCode.SPEECH_TRANSCRIPTION_FAILED,
        `Audio is ${input.audio.length} bytes, which exceeds the ${maxBytes} byte limit.`,
        413,
        { callSessionId, bytes: input.audio.length, limitBytes: maxBytes },
      );
    }

    let result: TranscriptionResult;
    try {
      result = await this.deps.speech.transcribe({
        callSessionId,
        emergencyId,
        language,
        audio: input.audio,
        isFinal,
      });
    } catch (error) {
      const isLanguage = error instanceof AppError && error.code === ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED;
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: isLanguage ? 'UNSUPPORTED_LANGUAGE' : 'PROVIDER_ERROR',
        reason: (error as Error).message,
      });
      throw error;
    }

    // The configured floor is the real threshold, not documentation: a deployment
// that raises `minConfidence` must actually discard more audio. The shared
// policy still anchors the HIGH band, so Module 2 and Module 5 cannot disagree
// about what counts as high confidence.
const band = confidenceBand(result.confidence, this.deps.config.speech.minConfidence);
    const base: Omit<TranscribeResult, 'persisted' | 'accepted' | 'notice'> = {
      text: result.text,
      language: result.language,
      confidence: result.confidence,
      band,
      isFinal,
      provider: result.providerName,
      isLive: result.isLive,
    };

    // Unusable: not stored, not forwarded, and reported as a recorded failure so
    // the gap appears in the timeline rather than passing for silence.
    if (band === 'UNUSABLE') {
      this.interim.delete(this.interimKey(callSessionId, speaker));
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: 'LOW_CONFIDENCE',
        reason: `Confidence ${result.confidence.toFixed(2)} is below the ${this.deps.config.speech.minConfidence} threshold.`,
      });
      this.logger.warn(
        { callSessionId, emergencyId, confidence: result.confidence },
        'discarded a transcription below the confidence threshold',
      );
      return { ...base, text: '', persisted: null, accepted: false, notice: null };
    }

    // Interim: published for live captioning, never written.
    if (!isFinal) {
      if (this.deps.config.speech.emitPartials) {
        this.interim.set(this.interimKey(callSessionId, speaker), result);
        await this.deps.events.record(
          defineEvent('TRANSCRIPT_PARTIAL', {
            emergencyId,
            entityType: 'call_session',
            entityId: callSessionId,
            payload: {
              callSessionId,
              emergencyId,
              speaker,
              text: result.text,
              // Interim results have no sequence of their own: `sequence` belongs
              // to persisted utterances and a guess must not consume one.
              sequence: -1,
              provider: result.providerName,
            },
          }),
          { emergencyId },
        );
      }
      return {
        ...base,
        persisted: null,
        accepted: true,
        notice: band === 'LOW' ? 'Low confidence: ask the caller to confirm.' : null,
      };
    }

    // Final but empty: an utterance was detected and produced no words.
    if (result.text.trim() === '') {
      this.interim.delete(this.interimKey(callSessionId, speaker));
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: 'EMPTY_AUDIO',
        reason: 'The recogniser returned no text for a final result.',
      });
      return { ...base, text: '', persisted: null, accepted: false, notice: null };
    }

    // `appendTranscript` assigns `sequence` and emits TRANSCRIPT_UPDATED inside
    // its own transaction. Module 2 must not emit a second copy, and must not
    // write a row for anything but a final result.
    const persisted = await this.deps.calls.appendTranscript({
      callSessionId,
      emergencyId,
      speaker,
      text: result.text,
      isFinal: true,
      intent: input.intent ?? null,
      confidence: result.confidence,
      isSimulation: session.isSimulation,
    });
    this.interim.delete(this.interimKey(callSessionId, speaker));

    this.logger.info(
      { callSessionId, emergencyId, confidence: result.confidence, band, provider: result.providerName },
      'transcribed and stored a final utterance',
    );

    return {
      ...base,
      persisted,
      accepted: true,
      notice: band === 'LOW' ? 'Low confidence: ask the caller to confirm.' : null,
    };
  }

  async speak(input: SpeakInput): Promise<SpeakResult> {
    const text = input.text.trim();
    const language = normaliseLanguageCode(input.language);
    const maxChars = this.deps.config.speech.maxSynthesisChars;

    if (text === '') {
      await this.recordSynthesisFailure(
        input,
        'PROVIDER_ERROR',
        'Refused to synthesize empty text.',
      );
      throw new AppError(ErrorCode.SPEECH_SYNTHESIS_FAILED, 'Cannot synthesize empty text.', 422);
    }

    if (text.length > maxChars) {
      await this.recordSynthesisFailure(
        input,
        'PROVIDER_ERROR',
        `Text is ${text.length} characters; the limit is ${maxChars}.`,
      );
      throw new AppError(
        ErrorCode.SPEECH_SYNTHESIS_FAILED,
        `Text is ${text.length} characters, which exceeds the ${maxChars} character limit.`,
        413,
        { characters: text.length, limit: maxChars },
      );
    }

    if (!language) {
      await this.recordSynthesisFailure(
        input,
        'UNSUPPORTED_LANGUAGE',
        `'${input.language}' is not a language this build can speak.`,
      );
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `'${input.language}' is not a language this build can speak. Supported: en, ml.`,
        422,
        { language: input.language },
      );
    }

    // When a call is named, it must be live: speaking into an ended call is
    // either a bug or a caller who has already hung up.
    if (input.callSessionId) {
      await this.requireLiveSession(input.callSessionId, input.emergencyId ?? '');
    }

    let result: SynthesisResult;
    try {
      result = await this.deps.synthesis.synthesize({
        text,
        language,
        tone: input.tone,
        verbatimProtocolText: input.verbatimProtocolText,
      });
    } catch (error) {
      const isLanguage = error instanceof AppError && error.code === ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED;
      await this.recordSynthesisFailure(
        input,
        isLanguage ? 'UNSUPPORTED_LANGUAGE' : 'PROVIDER_ERROR',
        (error as Error).message,
      );
      throw error;
    }

    await this.deps.events.record(
      defineEvent('SPEECH_SYNTHESIZED', {
        emergencyId: input.emergencyId ?? null,
        entityType: 'call_session',
        entityId: input.callSessionId ?? null,
        payload: {
          callSessionId: input.callSessionId ?? '',
          emergencyId: input.emergencyId ?? '',
          provider: result.providerName,
          voice: result.voice,
          language,
          characterCount: text.length,
          // The record states whether the caller heard the catalogue's own words
          // or an approved paraphrase.
          verbatimProtocolText: input.verbatimProtocolText,
        },
      }),
      { emergencyId: input.emergencyId ?? null },
    );

    const isAudible = result.audio.length > 0;

    if (!isAudible) {
      // The request is recorded as SPEECH_SYNTHESIZED so the attempt is
      // auditable, then reported as not audible so no caller concludes a voice
      // was heard. The development adapter always takes this path.
      this.logger.warn(
        { provider: result.providerName, language, characters: text.length },
        'provider returned no playable audio',
      );
    }

    return {
      audio: result.audio,
      mimeType: result.mimeType,
      provider: result.providerName,
      isLive: result.isLive,
      voice: result.voice,
      durationMs: result.durationMs,
      characterCount: text.length,
      isAudible,
      verbatimProtocolText: input.verbatimProtocolText,
    };
  }

  /** Latest interim text for a session, or null when there is none. */
  pendingPartial(callSessionId: string, speaker: TranscriptSpeaker = 'CALLER'): string | null {
    return this.interim.get(this.interimKey(callSessionId, speaker))?.text ?? null;
  }

  /** Provider identity for the health endpoint. Never claims to be live. */
  status(): {
    speech: { provider: string; isLive: boolean; languages: readonly string[] };
    synthesis: { provider: string; isLive: boolean; languages: readonly string[] };
    minConfidence: number;
  } {
    return {
      speech: {
        provider: this.deps.speech.providerName,
        isLive: this.deps.speech.isLive,
        languages: this.deps.speech.supportedLanguages,
      },
      synthesis: {
        provider: this.deps.synthesis.providerName,
        isLive: this.deps.synthesis.isLive,
        languages: this.deps.synthesis.supportedLanguages,
      },
      minConfidence: this.deps.config.speech.minConfidence,
    };
  }

  // -- internals --------------------------------------------------------------

  private requireLiveSession(callSessionId: string, emergencyId: string): Promise<CallSession> {
    return this.deps.calls.sessionById(callSessionId).then((session) => {
      if (!session) {
        throw new AppError(ErrorCode.CALL_NOT_FOUND, `Call session '${callSessionId}' was not found.`, 404, {
          callSessionId,
        });
      }
      if (session.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.CONVERSATION_CLOSED,
          `Call session '${callSessionId}' has ended; its speech cannot be processed.`,
          409,
          { callSessionId, status: session.status },
        );
      }
      // Guards against attributing an utterance to the wrong incident, which
      // would corrupt both transcripts at once.
      if (emergencyId && session.emergencyId !== emergencyId) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `Call session '${callSessionId}' belongs to emergency '${session.emergencyId}', not '${emergencyId}'.`,
          409,
          { callSessionId, sessionEmergencyId: session.emergencyId, requestedEmergencyId: emergencyId },
        );
      }
      return session;
    });
  }

  /**
   * Normalises the requested language, recording a failure before rejecting it.
   *
   * This runs before the provider, so if it simply threw, an unsupported language
   * would leave no trace: every other transcription failure is on the timeline and
   * this one would not be. The gap would look like a client that never spoke.
   */
  private async resolveLanguage(
    language: string,
    callSessionId: string,
    emergencyId: string,
  ): Promise<string> {
    const normalised = normaliseLanguageCode(language);
    if (normalised) return normalised;

    await this.recordTranscriptionFailure({
      callSessionId,
      emergencyId,
      language,
      failureKind: 'UNSUPPORTED_LANGUAGE',
      reason: `'${language}' is not supported; expected en or ml.`,
    });
    throw new AppError(
      ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
      `'${language}' is not a language this build can transcribe. Supported: en, ml.`,
      422,
      { language },
    );
  }

  private interimKey(callSessionId: string, speaker: string): string {
    return `${callSessionId}:${speaker}`;
  }

  /**
   * Records a transcription failure.
   *
   * Best-effort by design: the caller is about to receive an error, and a failure
   * to write the timeline entry must not replace it with a confusing database
   * fault. The reason is logged when the record itself fails.
   */
  private async recordTranscriptionFailure(failure: {
    callSessionId: string;
    emergencyId: string;
    language: string;
    failureKind: 'PROVIDER_ERROR' | 'UNSUPPORTED_LANGUAGE' | 'LOW_CONFIDENCE' | 'EMPTY_AUDIO' | 'INVALID_AUDIO';
    reason: string;
  }): Promise<void> {
    await this.deps.events
      .record(
        defineEvent('SPEECH_TRANSCRIPTION_FAILED', {
          emergencyId: failure.emergencyId,
          entityType: 'call_session',
          entityId: failure.callSessionId,
          payload: {
            callSessionId: failure.callSessionId,
            emergencyId: failure.emergencyId,
            provider: this.deps.speech.providerName,
            language: failure.language,
            failureKind: failure.failureKind,
            reason: failure.reason,
          },
        }),
        { emergencyId: failure.emergencyId },
      )
      .catch((error: unknown) => {
        this.logger.error(
          {
            callSessionId: failure.callSessionId,
            emergencyId: failure.emergencyId,
            reason: (error as Error).message,
          },
          'could not record SPEECH_TRANSCRIPTION_FAILED',
        );
      });
  }

  private async recordSynthesisFailure(
    input: SpeakInput,
    failureKind: 'PROVIDER_ERROR' | 'UNSUPPORTED_LANGUAGE' | 'BLOCKED_BY_SAFETY_GATE',
    reason: string,
  ): Promise<void> {
    await this.deps.events
      .record(
        defineEvent('SPEECH_SYNTHESIS_FAILED', {
          emergencyId: input.emergencyId ?? null,
          entityType: 'call_session',
          entityId: input.callSessionId ?? null,
          payload: {
            callSessionId: input.callSessionId ?? null,
            emergencyId: input.emergencyId ?? null,
            provider: this.deps.synthesis.providerName,
            language: input.language,
            failureKind,
            reason,
            characterCount: input.text.trim().length,
          },
        }),
        { emergencyId: input.emergencyId ?? null },
      )
      .catch((error: unknown) => {
        this.logger.error(
          { reason: (error as Error).message },
          'could not record SPEECH_SYNTHESIS_FAILED',
        );
      });
  }
}