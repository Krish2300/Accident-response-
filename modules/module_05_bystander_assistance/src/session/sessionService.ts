/**
 * Protocol session service (Module 5).
 *
 * This is the orchestrator between the three halves of Module 5:
 *
 *   LlmGateway  — turns a caller's words into schema-validated facts
 *   ProtocolEngine — decides what happens next, authoritatively
 *   ProtocolSessionPort — persists the decision and its events atomically
 *
 * The ordering below is the whole safety design, and it is not negotiable:
 *
 *   1. The LLM runs FIRST and may only ever produce *facts*. It is never asked
 *      what to do next, and it is never asked for medical instructions.
 *   2. The engine runs on those facts and produces the instruction, the
 *      question and the transition. The engine cannot be influenced by prose.
 *   3. The reply text is produced from the engine's instruction afterwards, and
 *      only paraphrases it. If the safety gate rejects the paraphrase, the
 *      protocol's own wording is spoken instead.
 *
 * Therefore a compromised, confused or hallucinating model can at worst fail to
 * understand the caller. It cannot invent a step, change a threshold, or talk a
 * bystander past an escalation.
 */
import {
  AppError,
  ErrorCode,
  createId,
  noopLogger,
  type Logger,
  type ProtocolSession,
  type ProtocolSessionPort,
  type ProtocolStepRecord,
} from '@resus/core';
import { ProtocolEngine, type EngineAction, type EngineState, type EngineTurnResult } from '../protocol_engine/engine.js';
import { UNKNOWN, type ProtocolFacts } from '../protocol_engine/types.js';
import type { LlmGateway } from '../llm/llmService.js';
import type { Entities, Extraction } from '../llm/contracts.js';
import { assertSafeRephrasing } from '../llm/safety.js';

export interface SessionTurn {
  session: ProtocolSession;
  steps: ProtocolStepRecord[];
  /** Protocol wording, always present, always authoritative. */
  instruction: string;
  /** Protocol question, when the engine asked one. */
  question: string | null;
  /** What should actually be spoken. Equals `instruction` when the model was unhelpful. */
  speech: string;
  tone: 'CALM' | 'URGENT' | 'REASSURING';
  action: EngineAction;
  status: ProtocolSession['status'];
  currentStepId: string;
  /** True when the engine refused to advance until the caller answers something. */
  requiresClarification: boolean;
  /** The protocol's own clarification question, when one was asked. */
  clarificationQuestion: string | null;
  /** True when the spoken text came from the model rather than the catalogue. */
  paraphrased: boolean;
  /** True when the LLM is unavailable and the heuristic fallback is in use. */
  degraded: boolean;
  escalationRequired: boolean;
  escalations: Array<{ ruleId: string; reason: string; severity: string; action: string }>;
  missingFacts: string[];
  progressPct: number;
  /** Populated when a model call failed but the turn still succeeded. */
  llmNotice: string | null;
}

export interface StartSessionInput {
  emergencyId: string;
  protocolId?: string;
  version?: string;
  /** Incident type used to auto-select a protocol when none is named. */
  incidentType?: string;
  facts?: ProtocolFacts;
  startedBy?: string;
  initiatedByUserId?: string | null;
}

export interface HandleUtteranceInput {
  sessionId: string;
  utterance: string;
  /** Overrides the engine's decision; reserved for human operators. */
  forceEscalationReason?: string | null;
}

export class ProtocolSessionService {
  private readonly logger: Logger;

  constructor(
    private readonly engine: ProtocolEngine,
    private readonly llm: LlmGateway,
    private readonly sessions: ProtocolSessionPort,
    logger: Logger = noopLogger,
  ) {
    this.logger = logger;
  }

  // -- lifecycle --------------------------------------------------------------

  async start(input: StartSessionInput): Promise<SessionTurn> {
    const resolved = this.resolveProtocol(input);
    const llmState = await this.probeLlm();

    const engineState = this.engine.start(resolved.protocolId, {
      version: input.version ?? resolved.version,
      facts: input.facts ?? {},
    });

    const session = await this.sessions.createSession({
      emergencyId: input.emergencyId,
      protocolId: resolved.protocolId,
      protocolVersion: engineState.protocolVersion,
      protocolSource: resolved.source,
      currentStep: engineState.currentStepId,
      startedBy: input.startedBy ?? 'SYSTEM',
      initiatedByUserId: input.initiatedByUserId ?? null,
      llmProvider: llmState.provider,
      llmModel: llmState.model,
      degraded: !llmState.available,
    });

    // Record the session id on the engine state so every event it emits carries
    // the real id, not a placeholder.
    const identified: EngineState = { ...engineState, sessionId: session.id };

    const presented = this.engine.presentStep(identified);
    const initialEscalations = this.engine.initialEscalations(identified);

    // Persist the first step as ACTIVE, and escalate immediately if the very
    // first look at the facts already demands it.
    const escalated = initialEscalations.length > 0;
    const { session: persisted, steps } = await this.sessions.applyTransition({
      sessionId: session.id,
      emergencyId: input.emergencyId,
      currentStep: identified.currentStepId,
      status: escalated ? 'ESCALATED' : 'ACTIVE',
      escalationRequired: escalated,
      escalationReason: escalated ? (initialEscalations[0]?.reason ?? null) : null,
      completedAt: null,
      collectedFacts: identified.facts as Record<string, unknown>,
      degraded: !llmState.available,
      steps: [
        {
          stepId: identified.currentStepId,
          orderIndex: presented.step.order,
          status: 'ACTIVE',
          presentedAt: new Date(),
          completedAt: null,
          result: null,
        },
      ],
      events: [
        {
          type: 'PROTOCOL_STEP_PRESENTED',
          payload: {
            protocolSessionId: session.id,
            stepId: identified.currentStepId,
            orderIndex: presented.step.order,
            instruction: presented.instruction,
          },
        },
        ...(escalated
          ? [
              {
                type: 'PROTOCOL_ESCALATED' as const,
                payload: {
                  protocolSessionId: session.id,
                  reason: initialEscalations[0]?.reason ?? 'Protocol requires professional help.',
                  rules: initialEscalations.map((e) => e.ruleId),
                },
              },
            ]
          : []),
      ],
    });

    const speech = await this.speak(presented.instruction, presented.question, null, llmState);

    return {
      session: presentSession(persisted),
      steps,
      instruction: presented.instruction,
      question: presented.question,
      speech: speech.speech,
      tone: speech.tone,
      action: escalated ? 'ESCALATED' : 'HELD',
      status: persisted.status,
      currentStepId: persisted.currentStep,
      requiresClarification: false,
      clarificationQuestion: null,
      paraphrased: speech.paraphrased,
      degraded: !llmState.available,
      escalationRequired: escalated,
      escalations: initialEscalations.map(compactEscalation),
      missingFacts: presented.missingFacts,
      progressPct: 0,
      llmNotice: speech.notice,
    };
  }

  /**
   * The main loop: caller speaks, engine decides, everything is persisted.
   */
  async handleUtterance(input: HandleUtteranceInput): Promise<SessionTurn> {
    const session = await this.requireSession(input.sessionId);
    this.assertOpen(session);
    const engineState = this.toEngineState(session);

    // 1. Facts, from the caller — before the engine is told anything.
    const extraction = await this.extract(session, engineState, input.utterance);

    // 2. The engine decides. Everything downstream is derived from its output.
    const now = new Date();
    const advance = this.engine.advance(engineState, {
      observedFacts: factsFrom(extraction),
      utterance: input.utterance,
      now,
      forceEscalationReason: input.forceEscalationReason ?? null,
    });
    const result = advance.result;

    // 3. Persist the decision and its events in one transaction.
    const { session: persisted, steps } = await this.sessions.applyTransition({
      sessionId: session.id,
      emergencyId: session.emergencyId,
      currentStep: result.currentStepId,
      status: result.status,
      completedAt: result.status === 'COMPLETED' ? now : null,
      escalationRequired: advance.nextState.escalationRequired,
      escalationReason: advance.nextState.escalationReason,
      clarificationCount: advance.nextState.clarificationCount,
      collectedFacts: withBookkeeping(advance.nextState.facts, {
        completedSteps: advance.nextState.completedStepIds,
        repeatCount: advance.nextState.repeatCount,
      }),
      degraded: extraction.degraded,
      steps: result.stepUpdates,
      events: result.events,
    });

    // 4. Only now may the wording be paraphrased for speech.
    const llmState: LlmState = {
      provider: extraction.provider,
      model: extraction.model,
      available: !extraction.degraded,
    };
    const speech = await this.speak(result.approvedInstruction, result.question, input.utterance, llmState);

    const tone =
      result.action === 'ESCALATED'
        ? 'URGENT'
        : result.status === 'ACTION_REQUIRED'
          ? 'URGENT'
          : 'CALM';

    return {
      session: presentSession(persisted),
      steps,
      instruction: result.approvedInstruction,
      question: result.question,
      speech: speech.speech,
      tone,
      action: result.action,
      status: persisted.status,
      currentStepId: persisted.currentStep,
      requiresClarification: result.requiresClarification,
      clarificationQuestion: result.clarificationQuestion,
      paraphrased: speech.paraphrased,
      degraded: extraction.degraded,
      escalationRequired: advance.nextState.escalationRequired,
      escalations: result.escalations.map(compactEscalation),
      missingFacts: result.missingFacts,
      progressPct: result.progressPct,
      llmNotice: extraction.notice ?? speech.notice,
    };
  }

  // -- operator actions -------------------------------------------------------

  /** Emergency services reached the scene: stop the protocol. */
  async cancel(sessionId: string, reason = 'Cancelled by operator.'): Promise<SessionTurn> {
    const session = await this.requireSession(sessionId);
    if (session.status === 'CANCELLED') return this.toTurn(session, await this.sessions.stepsForSession(sessionId));

    const now = new Date();
    const { session: persisted, steps } = await this.sessions.applyTransition({
      sessionId,
      emergencyId: session.emergencyId,
      currentStep: session.currentStep,
      status: 'CANCELLED',
      completedAt: now,
      collectedFacts: session.collectedFacts,
      events: [
        {
          type: 'PROTOCOL_CANCELLED',
          payload: { protocolSessionId: sessionId, reason },
        },
      ],
    });
    return this.toTurn(persisted, steps);
  }

  /** Operator override: hand the caller to a human immediately. */
  async escalate(sessionId: string, reason: string): Promise<SessionTurn> {
    const session = await this.requireSession(sessionId);
    if (session.status === 'ESCALATED' || session.status === 'COMPLETED') {
      return this.toTurn(session, await this.sessions.stepsForSession(sessionId));
    }

    const { session: persisted, steps } = await this.sessions.applyTransition({
      sessionId,
      emergencyId: session.emergencyId,
      currentStep: session.currentStep,
      status: 'ESCALATED',
      escalationRequired: true,
      escalationReason: reason,
      // Deliberately not terminal: an escalated session stays open so the
      // operator can still read the transcript and the collected facts.
      completedAt: null,
      collectedFacts: session.collectedFacts,
      events: [
        {
          type: 'PROTOCOL_ESCALATED',
          payload: { protocolSessionId: sessionId, reason, rules: ['operator_override'] },
        },
      ],
    });
    return this.toTurn(persisted, steps);
  }

  async get(sessionId: string): Promise<{ session: ProtocolSession; steps: ProtocolStepRecord[] }> {
    const found = await this.requireSession(sessionId);
    return {
      session: presentSession(found),
      steps: await this.sessions.stepsForSession(sessionId),
    };
  }

  async listForEmergency(emergencyId: string): Promise<ProtocolSession[]> {
    const rows = await this.sessions.listSessionsForEmergency(emergencyId);
    return rows.map(presentSession);
  }

  listProtocols(): ReturnType<ProtocolEngine['listProtocols']> {
    return this.engine.listProtocols();
  }

  protocolsForIncident(incidentType: string): ReturnType<ProtocolEngine['protocolsForIncident']> {
    return this.engine.protocolsForIncident(incidentType);
  }

  // -- internals --------------------------------------------------------------

  private resolveProtocol(input: StartSessionInput): {
    protocolId: string;
    version: string;
    source: string;
  } {
    if (input.protocolId) {
      const protocol = this.engine.getProtocol(input.protocolId, input.version);
      return { protocolId: protocol.protocol_id, version: protocol.version, source: describeSource(protocol.source) };
    }

    if (!input.incidentType) {
      throw AppError.validation(
        'Either protocolId or incidentType must be supplied so a protocol can be selected.',
      );
    }

    const match = this.engine.resolveForIncident(input.incidentType);
    if (!match) {
      // No silent fallback to an unrelated protocol: an unknown incident must be
      // visible, not silently treated as something else.
      const available = this.engine
        .protocolsForIncident(input.incidentType)
        .map((p) => `${p.protocolId}@${p.version}`)
        .join(', ');
      throw new AppError(
        ErrorCode.PROTOCOL_NOT_FOUND,
        `No protocol is registered for incident type '${input.incidentType}'.`,
        404,
        { incidentType: input.incidentType, available },
      );
    }
    return { protocolId: match.protocol_id, version: match.version, source: describeSource(match.source) };
  }

  private async probeLlm(): Promise<LlmState> {
    try {
      const resolved = await this.llm.resolve();
      return { provider: resolved.service.providerName, model: resolved.service.model, available: true };
    } catch (error) {
      this.logger.warn(
        { reason: (error as Error).message },
        'no LLM available at session start; protocol flow uses catalogue only',
      );
      return { provider: 'none', model: 'none', available: false };
    }
  }

  /**
   * Fact extraction only. Any failure is recorded and turned into UNKNOWN facts
   * so the engine asks the caller instead of guessing.
   */
  private async extract(
    session: ProtocolSession,
    engineState: EngineState,
    utterance: string,
  ): Promise<{
    facts: Entities | null;
    degraded: boolean;
    provider: string;
    model: string;
    notice: string | null;
  }> {
    try {
      const resolved = await this.llm.resolve();
      const extraction: Extraction = await resolved.service.extract(utterance, {
        knownFacts: (engineState.facts as Partial<Entities>) ?? {},
        currentStepQuestion: this.currentQuestion(engineState),
        protocolId: session.protocolId,
      });
      return {
        facts: extraction.entities,
        degraded: resolved.degraded,
        provider: resolved.service.providerName,
        model: resolved.service.model,
        notice: resolved.degraded
          ? `Language model unavailable; using the deterministic keyword fallback. Extraction is degraded.`
          : null,
      };
    } catch (error) {
      this.logger.warn(
        { sessionId: session.id, reason: (error as Error).message },
        'fact extraction failed; asking the caller rather than guessing',
      );
      return {
        facts: null,
        degraded: true,
        provider: 'none',
        model: 'none',
        notice: 'Could not understand that automatically, so the assistant will ask again.',
      };
    }
  }

  private async speak(
    instruction: string,
    question: string | null,
    callerUtterance: string | null,
    llm: LlmState,
  ): Promise<{ speech: string; tone: 'CALM' | 'URGENT' | 'REASSURING'; paraphrased: boolean; notice: string | null }> {
    const spoken = [instruction, question].filter(Boolean).join(' ');

    if (!llm.available) {
      return { speech: spoken, tone: 'CALM', paraphrased: false, notice: null };
    }

    try {
      const resolved = await this.llm.resolve();
      const response = await resolved.service.respond({
        instruction,
        question,
        callerUtterance,
        tone: 'CALM',
      });
      // The gate compares against the protocol text, not against the model's
      // own output, so a paraphrase cannot launder invented content.
      const verdict = assertSafeRephrasing(spoken, response.speech);
      if (!verdict.safe) {
        this.logger.warn(
          { reason: verdict.reason, inventedNumbers: verdict.inventedNumbers, droppedActions: verdict.droppedActions },
          'rejected LLM paraphrase; speaking the protocol wording verbatim',
        );
        return { speech: spoken, tone: 'CALM', paraphrased: false, notice: null };
      }
      return { speech: response.speech, tone: response.tone, paraphrased: true, notice: null };
    } catch (error) {
      this.logger.warn({ reason: (error as Error).message }, 'paraphrase failed; speaking the protocol wording');
      return { speech: spoken, tone: 'CALM', paraphrased: false, notice: null };
    }
  }

  private async requireSession(sessionId: string): Promise<ProtocolSession> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new AppError(ErrorCode.NOT_FOUND, `Protocol session '${sessionId}' was not found.`, 404, {
        sessionId,
      });
    }
    return session;
  }

  private assertOpen(session: ProtocolSession): void {
    if (session.status === 'COMPLETED') {
      throw new AppError(
        ErrorCode.PROTOCOL_ESCALATION_REQUIRED,
        `Protocol session '${session.id}' has already completed and cannot continue.`,
        409,
        { sessionId: session.id, status: session.status },
      );
    }
    if (session.status === 'CANCELLED') {
      throw new AppError(
        ErrorCode.PROTOCOL_ESCALATION_REQUIRED,
        `Protocol session '${session.id}' was cancelled and cannot continue.`,
        409,
        { sessionId: session.id, status: session.status },
      );
    }
  }

  /** Rebuilds engine state from the persisted row. */
  private toEngineState(session: ProtocolSession): EngineState {
    const stored = session.collectedFacts as Record<string, unknown>;
    return {
      sessionId: session.id,
      protocolId: session.protocolId,
      protocolVersion: session.protocolVersion,
      currentStepId: session.currentStep,
      status: session.status,
      facts: stripEngineFacts(session.collectedFacts as ProtocolFacts),
      completedStepIds: Array.isArray(stored.__completedSteps)
        ? (stored.__completedSteps as string[])
        : [],
      repeatCount: Number(stored.__repeatCount ?? 0),
      clarificationCount: session.clarificationCount,
      startedAt: new Date(session.startedAt),
      updatedAt: new Date(session.updatedAt),
      escalationRequired: session.escalationRequired,
      escalationReason: session.escalationReason,
      completedAt: session.completedAt ? new Date(session.completedAt) : null,
    };
  }

  private currentQuestion(state: EngineState): string | null {
    try {
      return this.engine.presentStep(state).question;
    } catch {
      return null;
    }
  }

  private toTurn(session: ProtocolSession, steps: ProtocolStepRecord[]): SessionTurn {
    return {
      session: presentSession(session),
      steps,
      instruction: '',
      question: null,
      speech: '',
      tone: session.status === 'ESCALATED' ? 'URGENT' : 'CALM',
      action: 'HELD',
      status: session.status,
      currentStepId: session.currentStep,
      requiresClarification: false,
      clarificationQuestion: null,
      paraphrased: false,
      degraded: false,
      escalationRequired: session.escalationRequired,
      escalations: session.escalationReason
        ? [{ ruleId: 'session', reason: session.escalationReason, severity: 'URGENT', action: 'NOTIFY_OPERATOR' }]
        : [],
      missingFacts: [],
      progressPct: 0,
      llmNotice: null,
    };
  }
}

interface LlmState {
  provider: string;
  model: string;
  available: boolean;
}

/**
 * Maps validated LLM entities onto protocol facts.
 *
 * Only values that are actually known are forwarded. `UNKNOWN` is dropped so
 * the engine asks, instead of evaluating a condition against a guess.
 */
export function factsFrom(extraction: { facts: Entities | null }): ProtocolFacts {
  if (!extraction.facts) return {};
  const facts: ProtocolFacts = {};
  for (const [key, value] of Object.entries(extraction.facts)) {
    if (value === null || value === undefined) continue;
    if (value === UNKNOWN) continue;
    facts[key] = value;
  }
  return facts;
}

function compactEscalation(e: {
  ruleId: string;
  reason: string;
  severity: string;
  action: string;
}): { ruleId: string; reason: string; severity: string; action: string } {
  return { ruleId: e.ruleId, reason: e.reason, severity: e.severity, action: e.action };
}

/**
 * Renders the catalogue citation stored on the session row.
 *
 * The review status travels with it: an `UNREVIEWED` protocol is recorded as
 * such wherever it is used, so no downstream reader can mistake it for
 * clinically approved guidance.
 */
function describeSource(source: {
  name: string;
  publisher: string;
  review_status: string;
}): string {
  return `${source.name} (${source.publisher}) [${source.review_status}]`;
}

/** Removes the engine's private bookkeeping keys before persisting facts. */
function stripEngineFacts(facts: ProtocolFacts): ProtocolFacts {
  const out: ProtocolFacts = {};
  for (const [key, value] of Object.entries(facts)) {
    if (key.startsWith('__')) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Hides the engine's bookkeeping keys before a session leaves the service.
 *
 * `__completedSteps` and `__repeatCount` are persisted alongside the clinical
 * facts so a resumed session does not repeat or skip work, but they are engine
 * internals and must not appear in API responses.
 */
function presentSession(session: ProtocolSession): ProtocolSession {
  const stored = session.collectedFacts as Record<string, unknown> | null;
  if (!stored) return session;
  const cleaned = stripEngineFacts(stored as ProtocolFacts) as Record<string, unknown>;
  if (Object.keys(cleaned).length === Object.keys(stored).length) return session;
  return { ...session, collectedFacts: cleaned };
}

/**
 * Persists the engine's step bookkeeping alongside the facts.
 *
 * Without this a session resumed from the database would forget which steps it
 * had already completed and could repeat or skip work on restart.
 */
function withBookkeeping(
  facts: ProtocolFacts,
  bookkeeping: { completedSteps: string[]; repeatCount: number },
): Record<string, unknown> {
  return {
    ...stripEngineFacts(facts),
    __completedSteps: bookkeeping.completedSteps,
    __repeatCount: bookkeeping.repeatCount,
  };
}

export { createId, type EngineTurnResult };
