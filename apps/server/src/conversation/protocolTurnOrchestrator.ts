import { noopLogger, type Logger } from '@resus/core';
import type { ProtocolTurnOrchestrator, SessionTurn } from '@resus/protocols';

/**
 * HTTP-utterance turn orchestrator.
 *
 * Module 5's engine is the sole clinical decision-maker: it decides what the
 * protocol does next and produces the authoritative instruction. This class
 * owns everything around that decision that Module 5 cannot do itself because
 * it holds no persistence or speech port:
 *
 *   1. The caller's words land in the call transcript (speaker CALLER), so the
 *      timeline shows what was actually said before the protocol answered.
 *   2. Module 5's decision is produced by calling `decide` exactly once and
 *      returning its result untouched.
 *   3. The spoken reply lands in the transcript (speaker SYSTEM) and is
 *      synthesised through Module 2, so an HTTP-driven turn is represented in
 *      the record the same way a live-call turn is.
 *
 * It is wired only into `POST /api/protocol-sessions/:id/utterance`. The live
 * AudioBridge path (`AsteriskConversationController.onCallerUtterance`) already
 * owns its own transcript persistence and TTS and calls `handleUtterance`
 * directly, so it is deliberately left untouched: double-wiring it would write
 * two transcript rows and speak twice per turn.
 *
 * Safety contract:
 *   - `decide` is called exactly once and its result is returned as-is. A
 *     failed clinical decision is a failed turn — never a turn this class
 *     invents or substitutes.
 *   - Transcript writes and TTS are best-effort: a failure is logged and
 *     swallowed so the caller still receives the protocol's decision, but the
 *     decision and the turn's fields are never changed by an orchestration
 *     failure.
 *   - When no live call session is bound to the emergency, transcript and TTS
 *     are skipped and the decision is still returned — a protocol-only HTTP
 *     session has no call to persist against and nothing to speak into.
 */
export class ProtocolTurnOrchestratorImpl implements ProtocolTurnOrchestrator {
  private readonly logger: Logger;

  constructor(
    private readonly deps: {
      /** Resolves the protocol session so the emergency id is known. */
      sessions: { get(sessionId: string): Promise<{ session: { emergencyId: string } }> };
      /** Module 11's call repository: finds the live call and appends transcripts. */
      calls: {
        requireSessionFor(emergencyId: string): Promise<{ id: string; status: string; language: string; isSimulation: boolean }>;
        appendTranscript(input: {
          callSessionId: string;
          emergencyId: string;
          speaker: string;
          text: string;
          isFinal?: boolean;
          isSimulation: boolean;
        }): Promise<unknown>;
      };
      /** Module 2's speech service: synthesises the spoken reply. */
      speech: {
        speak(input: {
          text: string;
          language: string;
          tone: 'CALM' | 'URGENT' | 'REASSURING';
          verbatimProtocolText: boolean;
          emergencyId: string;
          callSessionId: string;
        }): Promise<unknown>;
      };
      /** Records caller-stated location as a candidate; never writes coordinates. */
      captureCallerLocation?: (emergencyId: string, locationText: string) => Promise<void>;
      logger?: Logger;
    },
  ) {
    this.logger = deps.logger ?? noopLogger;
  }

  async orchestrateTurn(input: {
    sessionId: string;
    utterance: string;
    decide: () => Promise<SessionTurn>;
  }): Promise<SessionTurn> {
    // Resolve the emergency and the live call session, best-effort. A failure
    // here must not block the clinical decision: the turn still runs and the
    // gap is logged so the missing transcript is explainable.
    const bound = await this.resolveCall(input.sessionId);

    // 1. The caller's words go on the record before the protocol answers, so
    //    the timeline keeps speaking order.
    if (bound) {
      await this.appendTranscript(bound, 'CALLER', input.utterance);
    }

    // 2. Module 5 decides. Called exactly once; the result is returned as-is.
    //    Not wrapped in a catch: a rejected decision is a failed turn.
    const turn = await input.decide();

    const callerLocation = turn.session.collectedFacts?.caller_location;
    if (typeof callerLocation === 'string') {
      try {
        await this.deps.captureCallerLocation?.(turn.session.emergencyId, callerLocation);
      } catch (error) {
        this.logger.warn({ emergencyId: turn.session.emergencyId, reason: (error as Error).message }, 'could not persist caller-stated location candidate');
      }
    }

    // 3. The spoken reply goes on the record and is synthesised, best-effort.
    if (bound) {
      if (turn.speech.trim() !== '') {
        await this.appendTranscript(bound, 'SYSTEM', turn.speech);
        await this.synthesise(bound, turn);
      }
    }

    return turn;
  }

  /**
   * Finds the protocol session's emergency and the live call bound to it.
   *
   * Returns null when either lookup fails or the call is not ACTIVE, so the
   * turn still runs without transcript or TTS — the decision is never held
   * hostage to a missing call row.
   */
  private async resolveCall(
    sessionId: string,
  ): Promise<{ callSessionId: string; emergencyId: string; language: string; isSimulation: boolean } | null> {
    let emergencyId: string;
    try {
      const found = await this.deps.sessions.get(sessionId);
      emergencyId = found.session.emergencyId;
    } catch (error) {
      this.logger.warn(
        { sessionId, reason: (error as Error).message },
        'could not resolve the protocol session; running the turn without transcript or TTS',
      );
      return null;
    }

    try {
      const call = await this.deps.calls.requireSessionFor(emergencyId);
      if (call.status !== 'ACTIVE') {
        this.logger.debug(
          { emergencyId, callSessionId: call.id, status: call.status },
          'no live call bound to this emergency; running the turn without transcript or TTS',
        );
        return null;
      }
      return { callSessionId: call.id, emergencyId, language: call.language, isSimulation: call.isSimulation };
    } catch (error) {
      this.logger.debug(
        { emergencyId, reason: (error as Error).message },
        'no call session for this emergency; running the turn without transcript or TTS',
      );
      return null;
    }
  }

  /** Appends one transcript row, best-effort. */
  private async appendTranscript(
    bound: { callSessionId: string; emergencyId: string; isSimulation: boolean },
    speaker: 'CALLER' | 'SYSTEM',
    text: string,
  ): Promise<void> {
    try {
      await this.deps.calls.appendTranscript({
        callSessionId: bound.callSessionId,
        emergencyId: bound.emergencyId,
        speaker,
        text,
        isFinal: true,
        isSimulation: bound.isSimulation,
      });
    } catch (error) {
      this.logger.error(
        { callSessionId: bound.callSessionId, speaker, reason: (error as Error).message },
        'could not persist a transcript row for an HTTP-driven protocol turn',
      );
    }
  }

  /** Synthesises the spoken reply, best-effort. */
  private async synthesise(
    bound: { callSessionId: string; emergencyId: string; language: string },
    turn: SessionTurn,
  ): Promise<void> {
    try {
      await this.deps.speech.speak({
        text: turn.speech,
        language: bound.language,
        tone: turn.tone,
        // Module 5 sets `paraphrased` from its safety gate; only the
        // catalogue's own wording may be recorded as clinically-reviewed speech.
        verbatimProtocolText: !turn.paraphrased,
        emergencyId: bound.emergencyId,
        callSessionId: bound.callSessionId,
      });
    } catch (error) {
      // A synthesis failure must not fail the turn: the protocol's decision is
      // already made and returned; the audio just is not produced.
      this.logger.warn(
        { callSessionId: bound.callSessionId, reason: (error as Error).message },
        'could not synthesise the protocol reply for an HTTP-driven turn',
      );
    }
  }
}
