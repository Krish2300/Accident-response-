import { noopLogger, type Logger } from '@resus/core';
import type { AudioBridgeConversationPort, ConversationTurn } from '@resus/call';
import type {
  HandleUtteranceInput,
  ProtocolDecision,
  StartSessionInput,
} from '@resus/protocols';
import type { InstructionLocaliser } from '../conversation/localizer.js';

/**
 * Asterisk conversation controller.
 *
 * The bridge stays transport-only: it asks this controller what to say when a
 * call connects and after every final caller utterance, then speaks whatever
 * comes back over the same socket. This controller owns the protocol session and
 * the SYSTEM side of the transcript; it never touches the socket or the audio
 * format.
 *
 * It lives in the composition root because it is the one place where Module 5's
 * session service, the emergency record (for the incident type) and Module 11's
 * transcript store meet. The bridge reaches it through a structural port, so
 * Module 1 never takes a build dependency on Module 5.
 *
 * Safety: it never invents a step, never paraphrases, and never re-opens a
 * session once the protocol has reached a terminal result. `verbatimProtocolText`
 * is taken from whether Module 5 paraphrased, so only the catalogue's own
 * wording can be recorded as clinically-reviewed speech.
 */

/** The subset of Module 5's `SessionTurn` this controller reads. */
export interface ConversationTurnResult {
  session: { id: string; emergencyId?: string; collectedFacts?: Record<string, unknown> };
  status: string;
  speech: string;
  tone: 'CALM' | 'URGENT' | 'REASSURING';
  paraphrased: boolean;
  /** Reviewed catalogue wording of the instruction, when Module 5 issued one. */
  instruction?: string | null;
  /** Reviewed catalogue wording of the question, when Module 5 asked one. */
  question?: string | null;
  /**
   * Module 5's structured decision.
   *
   * Read only to find the stable `instructionId`/`questionId` for the language
   * layer; nothing in it is interpreted as clinical content here.
   */
  decision?: ProtocolDecision | null;
}

export interface ConversationSessions {
  start(input: StartSessionInput): Promise<ConversationTurnResult>;
  handleUtterance(input: HandleUtteranceInput): Promise<ConversationTurnResult>;
}

export interface ConversationEmergencySource {
  findById(id: string): Promise<{ incidentType: string } | null>;
}

export interface ConversationTranscriptSink {
  appendTranscript(input: {
    callSessionId: string;
    emergencyId: string;
    speaker: string;
    text: string;
    isFinal?: boolean;
    isSimulation?: boolean;
  }): Promise<unknown>;
}

export interface AsteriskConversationDeps {
  sessions: ConversationSessions;
  emergencies: ConversationEmergencySource;
  transcripts: ConversationTranscriptSink;
  logger?: Logger;
  /** Incident type used when the emergency has none of its own. */
  defaultIncidentType?: string;
  /**
   * Optional Module 4 language layer.
   *
   * When present, the protocol's reviewed wording is rendered into the call's
   * language before it is persisted and spoken, so the timeline records what the
   * caller actually heard. Absent means the protocol wording is spoken as-is.
   */
  localizer?: InstructionLocaliser;
  /** Best-effort, non-clinical capture of caller-stated location text. */
  captureCallerLocation?: (emergencyId: string, locationText: string) => Promise<void>;
}

const DEFAULT_INCIDENT_TYPE = 'OTHER';
const TERMINAL_STATUSES = new Set(['ESCALATED', 'COMPLETED', 'CANCELLED']);

interface CallState {
  sessionId: string;
  terminal: boolean;
}

export class AsteriskConversationController implements AudioBridgeConversationPort {
  private readonly logger: Logger;
  private readonly defaultIncidentType: string;
  private readonly byCall = new Map<string, CallState>();

  constructor(private readonly deps: AsteriskConversationDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.defaultIncidentType = deps.defaultIncidentType ?? DEFAULT_INCIDENT_TYPE;
  }

  /** Called once the media bridge has bound a live call to a `CallSession`. */
  async onCallConnected(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
  }): Promise<ConversationTurn | null> {
    // The media bridge binds a call once, but a duplicate connect (retransmitted
    // or replayed frame) must not start a second protocol on the same call.
    if (this.byCall.has(input.callSessionId)) {
      this.logger.warn(
        { callSessionId: input.callSessionId },
        'ignoring a second connect for a call that already has a protocol session',
      );
      return null;
    }

    const incidentType = await this.resolveIncidentType(input.emergencyId);

    let turn: ConversationTurnResult;
    try {
      turn = await this.deps.sessions.start({
        emergencyId: input.emergencyId,
        incidentType,
        startedBy: 'SYSTEM',
      });
    } catch (error) {
      // No protocol matches the incident, or the store refused. Returning null
      // makes the bridge fall back to the configured greeting; the gap is logged
      // because a live emergency call reaching no protocol is an operational
      // fault, not a routine miss.
      this.logger.error(
        {
          callSessionId: input.callSessionId,
          emergencyId: input.emergencyId,
          incidentType,
          reason: (error as Error).message,
        },
        'could not start a protocol session for the live call; using the configured greeting',
      );
      return null;
    }

    const terminal = TERMINAL_STATUSES.has(turn.status);
    this.byCall.set(input.callSessionId, { sessionId: turn.session.id, terminal });

    this.logger.info(
      {
        callSessionId: input.callSessionId,
        emergencyId: input.emergencyId,
        protocolSessionId: turn.session.id,
        incidentType,
        status: turn.status,
        terminal,
      },
      'started a protocol session for the live call',
    );

    // The instruction is persisted before it is spoken so the timeline shows what
    // the caller was told, immediately after the call connects. The persisted text
    // is the localised text, so the record and the audio agree.
    const speech = this.resolveSpeech(turn, input.language);
    await this.persistSystemTranscript(input.callSessionId, input.emergencyId, speech);

    return this.toTurn(turn, terminal, speech);
  }

  /** Called for each final, stored caller utterance. */
  async onCallerUtterance(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
    text: string;
  }): Promise<ConversationTurn | null> {
    const state = this.byCall.get(input.callSessionId);
    // No protocol session is running for this call (the start failed). Say
    // nothing rather than guess; the utterance is already on the transcript.
    if (!state) return null;
    // The protocol already finished: the caller may keep talking, but the system
    // does not prompt again. The call stays open for the operator.
    if (state.terminal) return null;

    let turn: ConversationTurnResult;
    try {
      turn = await this.deps.sessions.handleUtterance({
        sessionId: state.sessionId,
        utterance: input.text,
      });
    } catch (error) {
      // The session completed or was cancelled between turns and now rejects.
      // Stop prompting; the failure is logged so the silence is explainable.
      this.logger.warn(
        {
          callSessionId: input.callSessionId,
          emergencyId: input.emergencyId,
          sessionId: state.sessionId,
          reason: (error as Error).message,
        },
        'could not advance the protocol session; the caller will not be prompted again',
      );
      state.terminal = true;
      return null;
    }

    const callerLocation = turn.session.collectedFacts?.caller_location;
    if (typeof callerLocation === 'string' && turn.session.emergencyId) {
      try {
        await this.deps.captureCallerLocation?.(turn.session.emergencyId, callerLocation);
      } catch (error) {
        this.logger.warn({ emergencyId: turn.session.emergencyId, reason: (error as Error).message }, 'could not persist caller-stated location candidate');
      }
    }

    const terminal = TERMINAL_STATUSES.has(turn.status);
    if (terminal) state.terminal = true;

    // Written after Module 2 has already stored the CALLER line, so the caller
    // utterance and the system reply keep their speaking order on the timeline.
    const speech = this.resolveSpeech(turn, input.language);
    await this.persistSystemTranscript(input.callSessionId, input.emergencyId, speech);

    return this.toTurn(turn, terminal, speech);
  }

  /** Releases per-call bookkeeping when the stream ends. */
  forget(callSessionId: string): void {
    this.byCall.delete(callSessionId);
  }

  private toTurn(
    turn: ConversationTurnResult,
    terminal: boolean,
    speech: string,
  ): ConversationTurn {
    return {
      speech,
      tone: turn.tone,
      // Module 5 sets `paraphrased` from its safety gate; anything else is the
      // catalogue's own wording and may be recorded as such.
      verbatimProtocolText: !turn.paraphrased,
      terminal,
      // The stable question identifier lets the conversation-support layer name
      // the question in a timeout event without interpreting any clinical content.
      questionId: turn.decision?.requiredQuestion?.questionId ?? null,
    };
  }

  /**
   * Renders the protocol's reviewed wording into the call's language.
   *
   * Module 5 decides *what* is said and issues stable identifiers for it; this
   * method only looks those identifiers up in the reviewed translation table. When
   * there is no translation, or the text is an approved paraphrase with no key, the
   * protocol wording is spoken unchanged and the fallback is logged — never
   * machine-translated and never invented.
   */
  private resolveSpeech(turn: ConversationTurnResult, language: string): string {
    const localizer = this.deps.localizer;
    if (!localizer) return turn.speech;

    const instructionId = turn.decision?.instruction?.instructionId ?? null;
    const questionId = turn.decision?.requiredQuestion?.questionId ?? null;
    const result = localizer.localise({
      language,
      instructionId,
      instruction: turn.instruction ?? turn.decision?.instruction?.text ?? null,
      questionId,
      question: turn.question ?? turn.decision?.requiredQuestion?.text ?? null,
      fallbackSpeech: turn.speech,
      paraphrased: turn.paraphrased,
    });

    if (result.localised) {
      if (result.reason === 'PARTIALLY_LOCALISED') {
        this.logger.warn(
          { instructionId, questionId, language },
          'only part of the protocol turn had a reviewed translation; the rest is spoken in the protocol language',
        );
      } else {
        this.logger.debug(
          { instructionId, questionId, language },
          'rendered the protocol turn in the call language',
        );
      }
    } else if (result.reason === 'NO_TRANSLATION') {
      this.logger.debug(
        { instructionId, questionId, language },
        'no reviewed translation for this protocol turn; speaking the protocol wording unchanged',
      );
    }

    return result.speech;
  }

  private async resolveIncidentType(emergencyId: string): Promise<string> {
    try {
      const emergency = await this.deps.emergencies.findById(emergencyId);
      const incidentType = emergency?.incidentType?.trim();
      return incidentType && incidentType !== '' ? incidentType : this.defaultIncidentType;
    } catch (error) {
      this.logger.warn(
        { emergencyId, reason: (error as Error).message },
        'could not read the emergency incident type; using the default',
      );
      return this.defaultIncidentType;
    }
  }

  /**
   * Persists what the system said, best-effort.
   *
   * The words are already chosen and about to be spoken, so a write failure must
   * not swallow the prompt. The failure is logged so the resulting gap in the
   * timeline can be explained.
   */
  private async persistSystemTranscript(
    callSessionId: string,
    emergencyId: string,
    speech: string,
  ): Promise<void> {
    if (speech.trim() === '') return;
    try {
      await this.deps.transcripts.appendTranscript({
        callSessionId,
        emergencyId,
        speaker: 'SYSTEM',
        text: speech,
        isFinal: true,
      });
    } catch (error) {
      this.logger.error(
        { callSessionId, emergencyId, reason: (error as Error).message },
        'could not persist the SYSTEM transcript for a protocol instruction',
      );
    }
  }
}
