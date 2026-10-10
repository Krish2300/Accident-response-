import {
  AppError,
  ErrorCode,
  type ProtocolSessionStatus,
  type SystemEventType,
  createConsoleLogger,
} from '@resus/core';
import { EscalationPolicy, withDerivedFacts, type Escalation } from './escalation.js';
import { ProtocolLoader } from './protocolLoader.js';
import {
  contradictedEntryConditions,
missingFactsFor,
  protocolFacts,
  selectTransition,
  validateObservedFacts,
  withEngineFacts,
  type EvaluationContext,
} from './stateMachine.js';
import {
  UNKNOWN,
  instructionIdFor,
  isUnknown,
  questionIdFor,
  type Protocol,
  type ProtocolDecision,
  type ProtocolDecisionEscalation,
  type ProtocolDecisionType,
  type ProtocolFacts,
  type ProtocolInstruction,
  type ProtocolQuestionRequirement,
  type ProtocolStep,
  type ProtocolSummary,
} from './types.js';

export type EngineAction = 'ADVANCED' | 'CLARIFY' | 'COMPLETED' | 'ESCALATED' | 'LOOPED' | 'HELD';

export interface EngineState {
  /** Set by the session service once the row exists; null before persistence. */
  sessionId?: string | null;
  protocolId: string;
  protocolVersion: string;
  currentStepId: string;
  status: ProtocolSessionStatus;
  facts: ProtocolFacts;
  completedStepIds: string[];
  repeatCount: number;
  clarificationCount: number;
  startedAt: Date;
  updatedAt: Date;
  escalationRequired: boolean;
  escalationReason: string | null;
  completedAt: Date | null;
}

export interface EngineTurnResult {
  action: EngineAction;
  status: ProtocolSessionStatus;
  currentStepId: string;
  previousStepId: string;
  instruction: string;
  question: string | null;
  /** Protocol wording; the language layer may rephrase but never replace it. */
  approvedInstruction: string;
  nextStepId: string | null;
  facts: ProtocolFacts;
  missingFacts: string[];
  escalations: Escalation[];
  requiresClarification: boolean;
  clarificationQuestion: string | null;
  stepUpdates: StepUpdate[];
  events: Array<{ type: SystemEventType; payload: Record<string, unknown> }>;
  progressPct: number;
  /**
   * The same decision, addressable by id.
   *
   * The flat fields above are kept for existing callers; `decision` is what a new
   * caller should read. It exists because "what did the protocol decide, and why"
   * otherwise has to be reconstructed by a caller from a status code and a string.
   */
  decision: ProtocolDecision;
}

/**
 * Per-turn facts the engine is told about but must not treat as established.
 *
 * The engine does not know where a fact came from; the caller does. It only needs
 * to know whether the source is strong enough to move a protocol forward.
 */
export interface TurnInput {
  observedFacts?: ProtocolFacts;
  utterance?: string | null;
  now?: Date;
  /** Forces an escalation regardless of rules (operator override). */
  forceEscalationReason?: string | null;
  /**
   * False when the facts came from a source that is not entitled to move the
   * protocol: a language model that reported low confidence, or a caller
   * submitting facts directly. Such a turn may still escalate and may still ask,
   * but it can never advance, complete or loop.
   *
* Defaults to true, because the engine's own tests and its trusted-caller path
   * pass facts it has already validated.
   */
  factsTrusted?: boolean;
  /**
   * Report what the current step requires without applying any transition.
   *
   * Used to answer "where is this session and what is it waiting for" — at
   * session start, and after an operator action. Without it, the same call that
   * reports a session's position would also compute the transition it is standing
   * one turn away from, and report a decision about a step the session has not
   * reached yet.
   */
  preview?: boolean;
}

export interface EngineAdvance {
  /** The transition that happened, exactly as `applyTurn` decided it. */
  result: EngineTurnResult;
  /** The session state to persist. Derived from the result, never from the LLM. */
  nextState: EngineState;
}

export interface StepUpdate {
  stepId: string;
  orderIndex: number;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'SKIPPED';
  presentedAt: Date | null;
  completedAt: Date | null;
  result: Record<string, unknown> | null;
}

/**
 * The deterministic protocol engine.
 *
 * Responsibilities, and nothing else:
 *  - decide which step is current,
 *  - decide whether the flow may advance, must clarify, must loop, or must stop,
 *  - emit the authoritative instruction and question,
 *  - emit the events that describe the transition.
 *
 * It never generates medical content: every instruction it returns is a verbatim
 * string from the versioned catalogue. It never calls an LLM.
 */
export class ProtocolEngine {
  private readonly escalation: EscalationPolicy;
  private readonly logger = createConsoleLogger('info', 'module_05.engine');
  /**
   * How many times the engine may ask for the same missing information before
   * escalating. 0 disables the limit. Bounded retries are deliberate: a session
   * that keeps asking the same unanswered question is not helping anyone.
   */
  private readonly clarificationLimit: number;

/**
   * Closed value sets for individual facts, used to reject values nobody can
   * vouch for. A fact that is absent is unbounded and accepted as given.
   *
   * Injected rather than imported: the engine must not depend on the language
   * layer, because the language layer is the untrusted side of this module. The
   * composition root supplies the vocabulary; the engine only enforces it.
   */
  private readonly closedFactValues: Map<string, ReadonlySet<string>>;

  constructor(
    private readonly loader: ProtocolLoader,
    escalation: EscalationPolicy = new EscalationPolicy(),
    clarificationLimit = 3,
    closedFactValues: Map<string, ReadonlySet<string>> = new Map(),
  ) {
    this.escalation = escalation;
    this.clarificationLimit = clarificationLimit;
    this.closedFactValues = closedFactValues;
  }

  // -- catalogue access -------------------------------------------------------

  listProtocols(): ProtocolSummary[] {
    return this.loader.list();
  }

  getProtocol(protocolId: string, version?: string): Protocol {
    return this.loader.get(protocolId, version);
  }

  protocolsForIncident(incidentType: string): ProtocolSummary[] {
    return this.loader.forIncidentType(incidentType).map((p) => ({
      protocolId: p.protocol_id,
      version: p.version,
      title: p.title,
      source: p.source,
      priority: p.priority,
      appliesTo: p.applies_to.incident_types,
      stepCount: p.steps.length,
      reviewStatus: p.source.review_status,
    }));
  }

  /** Best matching protocol for a classified incident, or null. */
  resolveForIncident(incidentType: string): Protocol | null {
    return this.loader.resolveForIncident(incidentType);
  }

  // -- lifecycle --------------------------------------------------------------

  start(
    protocolId: string,
    options: {
      version?: string;
      facts?: ProtocolFacts;
      now?: Date;
      clarificationLimit?: number;
    } = {},
  ): EngineState {
    const protocol = this.getProtocol(protocolId, options.version);
    const now = options.now ?? new Date();
    const facts = normaliseFacts(options.facts ?? {});

    // Entry is refused only when known facts *contradict* the entry conditions.
    // Facts nobody has reported yet are not a contradiction: the entry step of a
    // triage protocol usually exists to establish them.
    const contradicted = contradictedEntryConditions(protocol.entry_conditions, facts);
    if (contradicted.length > 0) {
      throw new AppError(
        ErrorCode.PROTOCOL_STEP_NOT_ACTIONABLE,
        `Known facts contradict the entry conditions of protocol '${protocol.protocol_id}'.`,
        409,
        {
          protocolId: protocol.protocol_id,
          contradicted,
          knownFacts: facts,
        },
      );
    }

    if (!protocol.steps.some((s) => s.step_id === protocol.entry_step)) {
      throw AppError.validation(
        `Protocol '${protocol.protocol_id}' has no entry step '${protocol.entry_step}'.`,
      );
    }

    return {
      protocolId: protocol.protocol_id,
      protocolVersion: protocol.version,
      currentStepId: protocol.entry_step,
      status: 'ACTIVE',
      facts,
      completedStepIds: [],
      repeatCount: 0,
      clarificationCount: 0,
      startedAt: now,
      updatedAt: now,
      escalationRequired: false,
      escalationReason: null,
      completedAt: null,
    };
  }

  /**
   * The only entry point a session should use.
   *
   * Returns both the transition and the exact state to persist, so the caller
   * cannot drift from the engine's decision.
   */
  advance(state: EngineState, input: TurnInput = {}): EngineAdvance {
    const result = this.applyTurn(state, input);
    const now = input.now ?? new Date();

    const nextState: EngineState = {
      ...state,
      currentStepId: result.currentStepId,
      status: result.status,
      facts: result.facts,
      completedStepIds: [
        ...state.completedStepIds,
        ...result.stepUpdates
          .filter((u) => u.status === 'COMPLETED' && !state.completedStepIds.includes(u.stepId))
          .map((u) => u.stepId),
      ],
      repeatCount:
        result.action === 'LOOPED'
          ? state.repeatCount + 1
          : result.action === 'ADVANCED'
            ? 0
            : state.repeatCount,
      clarificationCount:
        result.action === 'CLARIFY' ? state.clarificationCount + 1 : state.clarificationCount,
      updatedAt: now,
      escalationRequired: state.escalationRequired || result.action === 'ESCALATED',
      escalationReason:
        result.escalations.length > 0
          ? (result.escalations[0]?.reason ?? state.escalationReason)
          : state.escalationReason,
      // Only a transition that completes the protocol sets this. On every other
      // outcome the existing value is preserved: an escalated or looping session
      // that already has a completion timestamp must not have it cleared.
      completedAt: result.action === 'COMPLETED' ? now : state.completedAt,
    };

    // The engine emits events with a blank session id; the session service fills
    // in the persisted id so the event log and the session row always agree.
    return {
      result: {
        ...result,
        events: result.events.map((event) => ({
          ...event,
          payload: { ...event.payload, protocolSessionId: state.sessionId ?? null },
        })),
      },
      nextState,
    };
  }

  /**
   * Applies a turn to the session.
   *
   * `observedFacts` is what the caller (or the LLM, already schema-validated)
   * reported. The engine merges it, re-evaluates the current step and returns the
   * next authoritative instruction.
   */
  applyTurn(state: EngineState, input: TurnInput = {}): EngineTurnResult {
    const protocol = this.getProtocol(state.protocolId, state.protocolVersion);
    const now = input.now ?? new Date();
    const step = this.requireStep(protocol, state.currentStepId);
    const previousStepId = step.step_id;
    const factsTrusted = input.factsTrusted ?? true;

    // 0. Observed facts are checked against the catalogue before anything reads
    //    them. A value the protocol does not define cannot influence a transition,
    //    which matters most for `ne`/`not_in`, which are true for anything the
    //    protocol did not enumerate.
    const validation = validateObservedFacts(input.observedFacts ?? {}, this.closedFactValues);
    if (validation.rejected.length > 0) {
      this.logger.warn(
        { protocolId: protocol.protocol_id, rejected: validation.rejected },
        'rejected fact values outside the declared vocabulary',
      );
    }
    const unsupported = this.unsupportedFacts(protocol, validation.accepted);
    const acceptedFacts = Object.keys(validation.accepted);
    const audit: TurnAudit = {
      rejected: validation.rejected,
      unsupported,
      accepted: acceptedFacts,
    };

    // A terminal session is not a step to evaluate. Re-deriving a transition from
    // a session that has already ended is how a cancelled protocol ends up
    // delivering another instruction to a bystander after the ambulance arrived.
    if (state.status === 'COMPLETED' || state.status === 'CANCELLED') {
      // The facts are audited but deliberately not merged: a session that has
      // finished does not change what was established about it.
      return this.hold(
        protocol,
        state,
        step,
        {
          action: 'HELD',
          status: state.status,
          currentStepId: previousStepId,
          missingFacts: [],
          escalations: [],
          stepUpdates: [],
          events: [],
          decisionType: 'HELD',
          ruleId: `${previousStepId}.session_${state.status.toLowerCase()}`,
          reason: `Session is ${state.status}; no further protocol instruction is issued.`,
          nextStepId: null,
          question: null,
          requiresClarification: false,
        },
        now,
        factsTrusted,
        audit,
        state.facts,
        state.completedStepIds,
      );
    }

    // Two fact bags, and the difference between them is the point of this module.
    //
    // `facts` is what may be established and therefore persisted: the protocol
    // may act on it and a later turn inherits it.
    //
    // `factsForRules` is what the escalation rules may look at. It includes the
    // untrusted report, because an unsafe scene or an unresponsive patient must be
    // acted on the first time it is mentioned even when nobody vouches for it. It
    // is never persisted, so an unverified report cannot accumulate into a session
    // where a later, innocuous turn quietly completes a protocol on its evidence.
    const facts = factsTrusted ? mergeFacts(state.facts, validation.accepted) : state.facts;
    const factsForRules = factsTrusted ? facts : mergeFacts(state.facts, validation.accepted);
    const completedStepIds = [...state.completedStepIds];
    const stepUpdates: StepUpdate[] = [];
    const events: EngineTurnResult['events'] = [];
    const context = this.context(protocol, {
      facts: factsForRules,
      now,
      startedAt: state.startedAt,
      completedStepIds,
      repeatCount: state.repeatCount,
    });

    // 1. Escalation rules are evaluated first: a protocol that says "escalate"
    //    must never be talked past by a plausible-sounding answer.
    const escalation = this.escalation.evaluate(protocol, context);

    // 1a. A CRITICAL rule halts the session immediately, whatever the current
    //     step would otherwise have done. Without this, a protocol whose
    //     escalation rule says "no physical intervention may be directed" could
    //     still loop back to a clarification question and stay ACTIVE, and the
    //     escalation would be recorded but never acted upon.
    //
    //     This runs even when the facts are untrusted. The asymmetry is
    //     deliberate: escalating on a false positive costs an operator a look at
    //     the call, while failing to escalate on a real one costs a bystander.
    const critical = escalation.escalations.find((e) => e.severity === 'CRITICAL');
    if (critical) {
      events.push({
        type: 'PROTOCOL_ESCALATED',
        payload: {
          protocolSessionId: '',
          reason: critical.reason,
          rules: escalation.escalations.map((e) => e.ruleId),
          haltedByRule: critical.ruleId,
        },
      });
      // Speak the escalation step the rule names, when it has one. Re-reading the
      // active step here would tell a bystander told not to approach a patient to
      // go and check on them.
      const escalationStep = critical.escalationStepId
        ? this.stepIfPresent(protocol, critical.escalationStepId)
        : undefined;
      const haltInstruction = escalationStep?.instruction ?? step.instruction;
      const haltStepId = escalationStep?.step_id ?? previousStepId;

      return this.hold(
        protocol,
        state,
        step,
        {
          action: 'ESCALATED',
          status: 'ESCALATED',
          currentStepId: haltStepId,
          instruction: haltInstruction,
          question: null,
          nextStepId: null,
          missingFacts: [],
          escalations: escalation.escalations,
          stepUpdates,
          events,
          decisionType: 'ESCALATED',
          ruleId: critical.ruleId,
          reason: critical.reason,
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds,
      );

    }

    // 2. Facts that arrived from a source not entitled to move the protocol are
    //    not evaluated, whether or not they happen to fill in what the step needs.
    //    The check comes before the missing-facts check so the recorded reason is
    //    the real one: an unverified report is refused because it is unverified, not
    //    because it also turned out to be incomplete.
    //
    //    Why not just advance on a low-confidence value: every transition in this
    //    catalogue is written so that being wrong means physical harm — a wrong
    //    "responsive = NO" sends a bystander to chest compressions, a wrong
    //    "bleeding_controlled = YES" ends the protocol. The protocol decides
    //    *what is needed*; only a source that can back a claim gets to say the
    //    claim is made. Asking again is always safe, and the clarification limit
    //    bounds it.
    const missing = missingFactsFor(step, facts);
    if (!factsTrusted) {
      // What the caller has to confirm: the step's own requirements. Reading them
      // off the *established* facts keeps the question honest about what is still
      // outstanding, rather than the unverified report appearing to settle it.
      const outstanding = missingFactsFor(step, state.facts);
      const question = clarificationFor(step, outstanding);
      events.push({
        type: 'PROTOCOL_CLARIFICATION_REQUESTED',
        payload: {
          protocolSessionId: '',
          question,
          reason: `Facts for step '${step.step_id}' came from an untrusted source; the step was not evaluated.`,
        },
      });
      const limit = this.clarificationLimit;
      if (limit > 0 && state.clarificationCount + 1 > limit) {
        const rule: Escalation = {
          ruleId: 'untrusted_facts',
          reason: `The reported facts could not be verified after ${limit} attempts. Handing over to a human operator.`,
          action: 'BOTH',
          severity: 'URGENT',
          source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version },
        };
        events.push({
          type: 'PROTOCOL_ESCALATED',
          payload: { protocolSessionId: '', reason: rule.reason, rules: [rule.ruleId] },
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: 'ESCALATED',
            status: 'ESCALATED',
            currentStepId: previousStepId,
            question: null,
            nextStepId: null,
            missingFacts: outstanding,
            escalations: [...escalation.escalations, rule],
            stepUpdates,
            events,
            decisionType: 'ESCALATED',
            ruleId: rule.ruleId,
            reason: rule.reason,
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds,
        );
      }
      return this.hold(
        protocol,
        state,
        step,
        {
          action: input.preview ? 'HELD' : 'CLARIFY',
          status: input.preview ? state.status : 'WAITING_FOR_RESPONSE',
          currentStepId: previousStepId,
          question,
          nextStepId: step.step_id,
          missingFacts: outstanding,
          escalations: escalation.escalations,
          stepUpdates,
          events: input.preview ? [] : events,
          decisionType: 'QUESTION_REQUIRED',
          ruleId: `${step.step_id}.untrusted_facts`,
          reason: `Step '${step.step_id}' was not evaluated: the reported facts were not trusted.`,
          requiresClarification: true,
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds,
      );
    }

    // 3. The step may only be evaluated once its required facts are known.
    if (missing.length > 0 && step.type !== 'INFO') {
      // Ask about what is actually missing, not the whole bundled question. A
      // step that needs both "responsive" and "breathing_status" should not ask
      // a caller who already reported unresponsiveness whether the person is
      // unresponsive.
      const question = clarificationFor(step, missing);
      const limit = this.clarificationLimit;
      // Asking again is only useful for a bounded number of attempts. Past the
      // limit the caller is stuck — with an injured patient waiting — so the
      // session escalates rather than looping on the same question.
      if (limit > 0 && state.clarificationCount + 1 > limit) {
        const rule: Escalation = {
          ruleId: 'clarification_limit',
          reason: `The caller could not confirm the required information after ${limit} attempts. Handing over to a human operator.`,
          action: 'BOTH',
          severity: 'URGENT',
          source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version },
        };
        events.push({
          type: 'PROTOCOL_ESCALATED',
          payload: { protocolSessionId: '', reason: rule.reason, rules: [rule.ruleId] },
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: 'ESCALATED',
            status: 'ESCALATED',
            currentStepId: previousStepId,
            question: null,
            nextStepId: null,
            missingFacts: missing,
            escalations: [...escalation.escalations, rule],
            stepUpdates,
            events,
            decisionType: 'ESCALATED',
            ruleId: rule.ruleId,
            reason: rule.reason,
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds,
        );
      }
      return this.hold(
        protocol,
        state,
        step,
        {
          action: 'CLARIFY',
          status: 'WAITING_FOR_RESPONSE',
          currentStepId: previousStepId,
          question,
          nextStepId: step.step_id,
          missingFacts: missing,
          escalations: escalation.escalations,
          stepUpdates,
          events,
          decisionType: 'QUESTION_REQUIRED',
          ruleId: `${step.step_id}.missing_facts`,
          reason: `Step '${step.step_id}' still needs: ${missing.join(', ')}.`,
          requiresClarification: true,
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds,
      );

    }

    // 4. A preview reports where the session stands. It must stop here: selecting a
    //    transition would describe a step the session has not reached.
    if (input.preview) {
      const question = missing.length > 0 ? clarificationFor(step, missing) : (step.question ?? null);
      return this.hold(
        protocol,
        state,
        step,
        {
          action: 'HELD',
          status: state.status,
          currentStepId: previousStepId,
          question,
          nextStepId: step.step_id,
          missingFacts: missing,
          escalations: escalation.escalations,
          stepUpdates,
          events: [],
          decisionType: 'QUESTION_REQUIRED',
          ruleId: `${step.step_id}.awaiting_caller`,
          reason:
            missing.length > 0
              ? `Step '${step.step_id}' is waiting for: ${missing.join(', ')}.`
              : `Step '${step.step_id}' is waiting for the caller's next answer.`,
          requiresClarification: true,
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds,
      );
    }

    // 5. Select the transition.
    const selected = selectTransition(step, context);
    if (!selected) {
      const question = step.question ?? 'Can you confirm that again?';
      this.logger.warn(
        { protocolId: protocol.protocol_id, stepId: step.step_id },
        'no transition matched; holding for clarification',
      );
      // Same bounded-retry rule as above: an unmatchable step must not be asked
      // indefinitely.
      const limit = this.clarificationLimit;
      if (limit > 0 && state.clarificationCount + 1 > limit) {
        const rule: Escalation = {
          ruleId: 'unmatched_transition',
          reason: `Step '${step.step_id}' could not be resolved from what the caller reported, after ${limit} attempts. Handing over to a human operator.`,
          action: 'BOTH',
          severity: 'URGENT',
          source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version },
        };
        events.push({
          type: 'PROTOCOL_ESCALATED',
          payload: { protocolSessionId: '', reason: rule.reason, rules: [rule.ruleId] },
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: 'ESCALATED',
            status: 'ESCALATED',
            currentStepId: previousStepId,
            question: null,
            nextStepId: null,
            missingFacts: [],
            escalations: [...escalation.escalations, rule],
            stepUpdates,
            events,
            decisionType: 'ESCALATED',
            ruleId: rule.ruleId,
            reason: rule.reason,
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds,
        );
      }
      return this.hold(
        protocol,
        state,
        step,
        {
          action: 'CLARIFY',
          status: 'WAITING_FOR_RESPONSE',
          currentStepId: previousStepId,
          question,
          nextStepId: step.step_id,
          missingFacts: [],
          escalations: escalation.escalations,
          stepUpdates,
          events,
          decisionType: 'QUESTION_REQUIRED',
          ruleId: `${step.step_id}.unmatched`,
          reason: `No transition of step '${step.step_id}' matched the facts that are known.`,
          requiresClarification: true,
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds,
      );

    }

    const { transition, index } = selected;
    const transitionRuleId = `${step.step_id}.transition[${index}]`;
    const markComplete = (stepId: string, orderIndex: number): void => {
      if (!completedStepIds.includes(stepId)) completedStepIds.push(stepId);
      stepUpdates.push({
        stepId,
        orderIndex,
        status: 'COMPLETED',
        presentedAt: state.startedAt,
        completedAt: now,
        result: { transition: transition.action, note: transition.note ?? null },
      });
      events.push({
        type: 'PROTOCOL_STEP_COMPLETED',
        payload: {
          protocolSessionId: '',
          stepId,
          nextStepId: transition.to,
          durationMs: now.getTime() - state.updatedAt.getTime(),
        },
      });
    };

    // 6. Apply the action.
    switch (transition.action) {
      case 'COMPLETE': {
        markComplete(step.step_id, step.order);
        events.push({
          type: 'PROTOCOL_COMPLETED',
          payload: {
            protocolSessionId: '',
            stepsCompleted: completedStepIds.length,
            escalationRequired: escalation.escalations.length > 0 || state.escalationRequired,
          },
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: 'COMPLETED',
            status: 'COMPLETED',
            currentStepId: step.step_id,
            question: null,
            nextStepId: null,
            missingFacts: [],
            escalations: escalation.escalations,
            stepUpdates,
            events,
            progressPct: 100,
            decisionType: 'COMPLETED',
            ruleId: transitionRuleId,
            reason: transition.note ?? `Step '${step.step_id}' completed the protocol.`,
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds,
        );
      }

      case 'ESCALATE': {
        markComplete(step.step_id, step.order);
        const rule: Escalation = escalation.escalations[0] ?? {
          ruleId: 'protocol_step_escalate',
          reason: transition.note ?? `Step '${step.step_id}' requires professional help.`,
          action: 'BOTH',
          severity: 'CRITICAL',
          source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version },
        };
        events.push({
          type: 'PROTOCOL_ESCALATED',
          payload: {
            protocolSessionId: '',
            reason: rule.reason,
            rules: escalation.escalations.map((e) => e.ruleId),
          },
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: 'ESCALATED',
            status: 'ESCALATED',
            currentStepId: step.step_id,
            question: step.question ?? null,
            nextStepId: null,
            missingFacts: [],
            escalations: [...escalation.escalations, rule],
            stepUpdates,
            events,
            decisionType: 'ESCALATED',
            ruleId: rule.ruleId,
            reason: rule.reason,
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds,
        );
      }

      case 'LOOP': {
        const repeatCount = state.repeatCount + 1;
        const exceeded =
          step.max_repeats !== undefined && step.max_repeats !== null && repeatCount > step.max_repeats;
        if (exceeded) {
          const rule: Escalation = {
            ruleId: `${step.step_id}.max_repeats`,
            reason: `Step '${step.step_id}' repeated ${repeatCount - 1} times without resolution. Escalating to a human operator.`,
            action: 'BOTH',
            severity: 'URGENT',
            source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version },
          };
          markComplete(step.step_id, step.order);
          events.push({
            type: 'PROTOCOL_ESCALATED',
            payload: { protocolSessionId: '', reason: rule.reason, rules: [rule.ruleId] },
          });
          return this.hold(
            protocol,
            state,
            step,
            {
              action: 'ESCALATED',
              status: 'ESCALATED',
              currentStepId: step.step_id,
              question: null,
              nextStepId: null,
              missingFacts: [],
              escalations: [...escalation.escalations, rule],
              stepUpdates,
              events,
              decisionType: 'ESCALATED',
              ruleId: rule.ruleId,
              reason: rule.reason,
            },
            now,
            factsTrusted,
            audit,
            facts,
            completedStepIds,
          );

        }

        stepUpdates.push({
          stepId: step.step_id,
          orderIndex: step.order,
          status: 'ACTIVE',
          presentedAt: now,
          completedAt: null,
          result: { repeatCount },
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: 'LOOPED',
            status: 'ACTION_REQUIRED',
            currentStepId: step.step_id,
            question: step.question ?? null,
            nextStepId: step.step_id,
            missingFacts: [],
            escalations: escalation.escalations,
            stepUpdates,
            events,
            decisionType: 'LOOPED',
            ruleId: transitionRuleId,
            reason: transition.note ?? `Step '${step.step_id}' must be repeated.`,
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds,
        );
      }

      case 'ADVANCE':
      default: {
        markComplete(step.step_id, step.order);
        const nextStep = transition.to ? this.requireStep(protocol, transition.to) : null;
        if (!nextStep) {
          events.push({
            type: 'PROTOCOL_COMPLETED',
            payload: {
              protocolSessionId: '',
              stepsCompleted: completedStepIds.length,
              escalationRequired: escalation.escalations.length > 0,
            },
          });
          return this.hold(
            protocol,
            state,
            step,
            {
              action: 'COMPLETED',
              status: 'COMPLETED',
              currentStepId: step.step_id,
              question: null,
              nextStepId: null,
              missingFacts: [],
              escalations: escalation.escalations,
              stepUpdates,
              events,
              progressPct: 100,
              decisionType: 'COMPLETED',
              ruleId: transitionRuleId,
              reason: transition.note ?? `Step '${step.step_id}' completed the protocol.`,
            },
            now,
            factsTrusted,
            audit,
            facts,
            completedStepIds,
          );

        }

        const presentedAt = now;
        stepUpdates.push({
          stepId: nextStep.step_id,
          orderIndex: nextStep.order,
          status: 'ACTIVE',
          presentedAt,
          completedAt: null,
          result: null,
        });
        events.push({
          type: 'PROTOCOL_STEP_PRESENTED',
          payload: {
            protocolSessionId: '',
            stepId: nextStep.step_id,
            orderIndex: nextStep.order,
            instruction: nextStep.instruction,
          },
        });

        const forced = input.forceEscalationReason
          ? ([
              {
                ruleId: 'operator_override',
                reason: input.forceEscalationReason,
                action: 'NOTIFY_OPERATOR' as const,
                severity: 'URGENT' as const,
                source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version },
              },
            ] satisfies Escalation[])
          : [];

        return this.hold(
          protocol,
          state,
          step,
          {
            action: 'ADVANCED',
            status: nextStep.type === 'ACTION' ? 'ACTION_REQUIRED' : 'WAITING_FOR_RESPONSE',
            currentStepId: nextStep.step_id,
            instruction: nextStep.instruction,
            question: nextStep.question ?? null,
            nextStepId: nextStep.step_id,
            missingFacts: missingFactsFor(nextStep, facts),
            escalations: [...escalation.escalations, ...forced],
            stepUpdates,
            events,
            decisionType: 'ADVANCED',
            ruleId: transitionRuleId,
            reason:
              transition.note ??
              `Step '${step.step_id}' advanced to '${nextStep.step_id}' on the facts that are known.`,
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds,
        );
      }
    }
  }

  /**
   * What the current step is waiting for, with no state change and no events.
   *
   * This is what a caller shows before the first utterance, and what an operator
   * action reports afterwards. It goes through the same decision builder as
   * `applyTurn`, so a step presented here and the same step reached by a turn
   * produce identically shaped decisions — including the rule id and the audit
   * block, which a caller would otherwise have to reconstruct by hand.
   *
   * It is a preview, not a turn: it reports the step the session is on, never the
   * one it would move to next.
   */
  turnDecision(
    state: EngineState,
    input: { now?: Date; factsTrusted?: boolean; observedFacts?: ProtocolFacts } = {},
  ): EngineTurnResult {
    return this.applyTurn(state, {
      now: input.now,
      observedFacts: input.observedFacts,
      factsTrusted: input.factsTrusted ?? true,
      preview: true,
    });
  }

  /** Renders a step without changing state (used to present the first step). */
  presentStep(state: EngineState, now = new Date()): {
    step: ProtocolStep;
    instruction: string;
    question: string | null;
    missingFacts: string[];
  } {
    const protocol = this.getProtocol(state.protocolId, state.protocolVersion);
    const step = this.requireStep(protocol, state.currentStepId);
    return {
      step,
      instruction: step.instruction,
      question: step.question ?? null,
      missingFacts: missingFactsFor(step, state.facts),
    };
  }

  /** Escalation that a fresh state already triggers (e.g. unknown scene safety). */
  initialEscalations(state: EngineState): Escalation[] {
    const protocol = this.getProtocol(state.protocolId, state.protocolVersion);
    return this.escalation.evaluate(
      protocol,
      this.context(protocol, {
        facts: state.facts,
        now: state.startedAt,
        startedAt: state.startedAt,
        completedStepIds: state.completedStepIds,
        repeatCount: state.repeatCount,
      }),
    ).escalations;
  }

  // -- internals --------------------------------------------------------------

  /**
   * Builds the single shape `applyTurn` returns.
   *
   * Every exit path goes through here so the flat fields and the structured
   * decision can never disagree: the decision is derived from the same values
   * that produce the flat fields, not assembled separately by each branch.
   */
  private hold(
    protocol: Protocol,
    state: EngineState,
    step: ProtocolStep,
    spec: {
      action: EngineAction;
      status: ProtocolSessionStatus;
      currentStepId: string;
      nextStepId: string | null;
      /** Wording spoken this turn. Defaults to the step that was evaluated. */
      instruction?: string;
      question: string | null;
      requiresClarification?: boolean;
      missingFacts: string[];
      escalations: Escalation[];
      stepUpdates: StepUpdate[];
      events: EngineTurnResult['events'];
      progressPct?: number;
      decisionType: ProtocolDecisionType;
      ruleId: string;
      reason: string;
    },
    now: Date,
    factsTrusted: boolean,
    audit: TurnAudit,
    facts: ProtocolFacts,
    completedStepIds: string[],
  ): EngineTurnResult {
    const instruction = spec.instruction ?? step.instruction;
    const requiresClarification = spec.requiresClarification ?? false;

    const spokenStep = protocol.steps.find((s) => s.step_id === spec.currentStepId) ?? step;
    const presentedInstruction: ProtocolInstruction = {
      instructionId: instructionIdFor(protocol, spec.currentStepId),
      stepId: spec.currentStepId,
      stepType: spokenStep.type,
      orderIndex: spokenStep.order,
      text: instruction,
    };

    const requiredQuestion: ProtocolQuestionRequirement | null =
      requiresClarification && spec.question
        ? {
            questionId: questionIdFor(protocol, step.step_id, state.clarificationCount + 1),
            requiredFacts: spec.missingFacts,
            text: spec.question,
            protocolState: step.step_id,
            attempt: state.clarificationCount + 1,
          }
        : null;

    const firstEscalation = spec.escalations[0];
    const escalation: ProtocolDecisionEscalation | null = firstEscalation
      ? {
          ruleId: firstEscalation.ruleId,
          reason: firstEscalation.reason,
          severity: firstEscalation.severity,
          action: firstEscalation.action,
        }
      : null;

    const decision: ProtocolDecision = {
      protocolId: protocol.protocol_id,
      protocolVersion: protocol.version,
      currentState: step.step_id,
      nextState: spec.currentStepId,
      decisionType: spec.decisionType,
      instruction: presentedInstruction,
      requiredQuestion,
      escalation,
      completed: spec.status === 'COMPLETED',
      missingFacts: spec.missingFacts,
      ruleId: spec.ruleId,
      reason: spec.reason,
      audit: {
        protocolVersion: protocol.version,
        protocolSource: `${protocol.source.name} (${protocol.source.publisher})`,
        reviewStatus: protocol.source.review_status,
        acceptedFacts: audit.accepted,
        rejectedFacts: audit.rejected,
        unsupportedFacts: audit.unsupported,
        factsTrusted,
        evaluatedAt: now.toISOString(),
      },
    };

    return {
      action: spec.action,
      status: spec.status,
      currentStepId: spec.currentStepId,
      previousStepId: step.step_id,
      instruction,
      approvedInstruction: instruction,
      question: spec.question,
      nextStepId: spec.nextStepId,
      facts,
      missingFacts: spec.missingFacts,
      escalations: spec.escalations,
      requiresClarification,
      clarificationQuestion: requiresClarification ? spec.question : null,
      stepUpdates: spec.stepUpdates,
      events: spec.events,
      progressPct: spec.progressPct ?? this.progress(protocol, completedStepIds),
      decision,
    };
  }

  /**
   * Facts the protocol has no condition for.
   *
   * Recorded rather than dropped: `notes` and `mechanism` are collected for the
   * incident record and are referenced by no condition in any protocol. Flagging
   * them here means an added fact that *is* referenced cannot go unnoticed, while
   * the genuinely free-text ones stay harmless.
   */
private unsupportedFacts(protocol: Protocol, accepted: ProtocolFacts): string[] {
    const referenced = protocolFacts(protocol);
    return Object.keys(accepted).filter((fact) => !referenced.has(fact)).sort();
  }

  /**
   * Resolves a step without failing the turn.
 *
 * Used for escalation targets: a rule naming a missing step is a data error, but
 * throwing would drop the escalation the caller depends on, so the engine logs
 * it and falls back to the current step.
 */
private stepIfPresent(protocol: Protocol, stepId: string): ProtocolStep | undefined {
  const step = protocol.steps.find((s) => s.step_id === stepId);
  if (!step) {
    this.logger.error(
      { protocolId: protocol.protocol_id, stepId },
      'escalation rule names a step that does not exist; using the current step',
    );
  }
  return step;
}

private requireStep(protocol: Protocol, stepId: string): ProtocolStep {
    const step = protocol.steps.find((s) => s.step_id === stepId);
    if (!step) {
      throw new AppError(
        ErrorCode.PROTOCOL_INVALID_TRANSITION,
        `Protocol '${protocol.protocol_id}' has no step '${stepId}'.`,
        500,
        { protocolId: protocol.protocol_id, version: protocol.version, stepId },
      );
    }
    return step;
  }

  private context(
    protocol: Protocol,
    input: {
      facts: ProtocolFacts;
      now: Date;
      startedAt: Date;
      completedStepIds: string[];
      repeatCount: number;
    },
  ): EvaluationContext {
    return {
      facts: withEngineFacts(
        withDerivedFacts(input.facts, {
          completedSteps: input.completedStepIds.length,
          repeatCount: input.repeatCount,
          totalSteps: protocol.steps.length,
        }),
        input.now,
        input.startedAt,
      ),
      now: input.now,
      sessionStartedAt: input.startedAt,
      repeatCount: input.repeatCount,
    };
  }

  private progress(protocol: Protocol, completedStepIds: string[]): number {
    if (protocol.steps.length === 0) return 0;
    return Math.min(100, Math.round((completedStepIds.length / protocol.steps.length) * 100));
  }
}

/**
 * What one turn contributed, for the decision's audit block.
 *
 * Kept separate from `facts` because an audit record and the fact bag answer
 * different questions: the bag is what the protocol may act on, this is
 * everything that arrived and what happened to it.
 */
interface TurnAudit {
  accepted: string[];
  rejected: Array<{ fact: string; reason: string }>;
  unsupported: string[];
}

export function mergeFacts(current: ProtocolFacts, observed: ProtocolFacts): ProtocolFacts {
  const merged: ProtocolFacts = { ...current };
  for (const [key, value] of Object.entries(observed)) {
    // Never overwrite a known fact with an unknown one: absence of evidence is
    // not evidence of absence.
    if (isUnknown(value) && !isUnknown(merged[key])) continue;
    merged[key] = value;
  }
  return merged;
}

export function normaliseFacts(facts: ProtocolFacts): ProtocolFacts {
  const out: ProtocolFacts = {};
  for (const [key, value] of Object.entries(facts)) {
    out[key] = value === undefined || value === null ? UNKNOWN : value;
  }
  return out;
}

function defaultClarificationFor(missing: string[]): string {
  return `I still need to know: ${missing.slice(0, 2).join(' and ')}. Can you tell me?`;
}

/**
 * Builds the clarification question for the facts that are still missing.
 *
 * Preference order: per-fact protocol wording, the step's own question when it
 * covers exactly the missing facts, then a generic prompt. Nothing here invents
 * clinical content — every question comes from the protocol file.
 */
function clarificationFor(step: ProtocolStep, missing: string[]): string {
  const perFact = missing
    .map((fact) => step.fact_questions?.[fact])
    .filter((q): q is string => typeof q === 'string' && q.length > 0);

  if (perFact.length > 0) return perFact.join(' ');

  const allRequired = step.requires_facts ?? [];
  if (step.question && missing.length === allRequired.length) return step.question;

  return step.question ?? defaultClarificationFor(missing);
}
