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
  selectTransition,
  withEngineFacts,
  type EvaluationContext,
} from './stateMachine.js';
import {
  UNKNOWN,
  isUnknown,
  type Protocol,
  type ProtocolFacts,
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

  constructor(
    private readonly loader: ProtocolLoader,
    escalation: EscalationPolicy = new EscalationPolicy(),
    clarificationLimit = 3,
  ) {
    this.escalation = escalation;
    this.clarificationLimit = clarificationLimit;
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
  advance(
    state: EngineState,
    input: {
      observedFacts?: ProtocolFacts;
      utterance?: string | null;
      now?: Date;
      forceEscalationReason?: string | null;
    } = {},
  ): EngineAdvance {
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
      completedAt: result.action === 'COMPLETED' ? now : null,
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
  applyTurn(
    state: EngineState,
    input: {
      observedFacts?: ProtocolFacts;
      utterance?: string | null;
      now?: Date;
      /** Forces an escalation regardless of rules (operator override). */
      forceEscalationReason?: string | null;
    } = {},
  ): EngineTurnResult {
    const protocol = this.getProtocol(state.protocolId, state.protocolVersion);
    const now = input.now ?? new Date();
    const step = this.requireStep(protocol, state.currentStepId);
    const previousStepId = step.step_id;

    const facts = mergeFacts(state.facts, input.observedFacts ?? {});
    const completedStepIds = [...state.completedStepIds];
    const stepUpdates: StepUpdate[] = [];
    const events: EngineTurnResult['events'] = [];
    const context = this.context(protocol, {
      facts,
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

      return {
        action: 'ESCALATED',
        status: 'ESCALATED',
        currentStepId: haltStepId,
        previousStepId,
        instruction: haltInstruction,
        approvedInstruction: haltInstruction,
        question: null,
        nextStepId: null,
        facts,
        missingFacts: [],
        escalations: escalation.escalations,
        requiresClarification: false,
        clarificationQuestion: null,
        stepUpdates,
        events,
        progressPct: this.progress(protocol, completedStepIds),
      };
    }

    // 2. The step may only be evaluated once its required facts are known.
    const missing = missingFactsFor(step, facts);
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
        return {
          action: 'ESCALATED',
          status: 'ESCALATED',
          currentStepId: previousStepId,
          previousStepId,
          instruction: step.instruction,
          approvedInstruction: step.instruction,
          question: null,
          nextStepId: null,
          facts,
          missingFacts: missing,
          escalations: [...escalation.escalations, rule],
          requiresClarification: false,
          clarificationQuestion: null,
          stepUpdates,
          events,
          progressPct: this.progress(protocol, completedStepIds),
        };
      }
      return {
        action: 'CLARIFY',
        status: 'WAITING_FOR_RESPONSE',
        currentStepId: previousStepId,
        previousStepId,
        instruction: step.instruction,
        approvedInstruction: step.instruction,
        question,
        nextStepId: step.step_id,
        facts,
        missingFacts: missing,
        escalations: escalation.escalations,
        requiresClarification: true,
        clarificationQuestion: question,
        stepUpdates,
        events,
        progressPct: this.progress(protocol, completedStepIds),
      };
    }

    // 3. Select the transition.
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
        return {
          action: 'ESCALATED',
          status: 'ESCALATED',
          currentStepId: previousStepId,
          previousStepId,
          instruction: step.instruction,
          approvedInstruction: step.instruction,
          question: null,
          nextStepId: null,
          facts,
          missingFacts: [],
          escalations: [...escalation.escalations, rule],
          requiresClarification: false,
          clarificationQuestion: null,
          stepUpdates,
          events,
          progressPct: this.progress(protocol, completedStepIds),
        };
      }
      return {
        action: 'CLARIFY',
        status: 'WAITING_FOR_RESPONSE',
        currentStepId: previousStepId,
        previousStepId,
        instruction: step.instruction,
        approvedInstruction: step.instruction,
        question,
        nextStepId: step.step_id,
        facts,
        missingFacts: [],
        escalations: escalation.escalations,
        requiresClarification: true,
        clarificationQuestion: question,
        stepUpdates,
        events,
        progressPct: this.progress(protocol, completedStepIds),
      };
    }

    const { transition } = selected;
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

    // 4. Apply the action.
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
        return {
          action: 'COMPLETED',
          status: 'COMPLETED',
          currentStepId: step.step_id,
          previousStepId,
          instruction: step.instruction,
          approvedInstruction: step.instruction,
          question: null,
          nextStepId: null,
          facts,
          missingFacts: [],
          escalations: escalation.escalations,
          requiresClarification: false,
          clarificationQuestion: null,
          stepUpdates,
          events,
          progressPct: 100,
        };
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
        return {
          action: 'ESCALATED',
          status: 'ESCALATED',
          currentStepId: step.step_id,
          previousStepId,
          instruction: step.instruction,
          approvedInstruction: step.instruction,
          question: step.question ?? null,
          nextStepId: null,
          facts,
          missingFacts: [],
          escalations: [...escalation.escalations, rule],
          requiresClarification: false,
          clarificationQuestion: null,
          stepUpdates,
          events,
          progressPct: this.progress(protocol, completedStepIds),
        };
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
          return {
            action: 'ESCALATED',
            status: 'ESCALATED',
            currentStepId: step.step_id,
            previousStepId,
            instruction: step.instruction,
            approvedInstruction: step.instruction,
            question: null,
            nextStepId: null,
            facts,
            missingFacts: [],
            escalations: [...escalation.escalations, rule],
            requiresClarification: false,
            clarificationQuestion: null,
            stepUpdates,
            events,
            progressPct: this.progress(protocol, completedStepIds),
          }
        }

        stepUpdates.push({
          stepId: step.step_id,
          orderIndex: step.order,
          status: 'ACTIVE',
          presentedAt: now,
          completedAt: null,
          result: { repeatCount },
        });
        return {
          action: 'LOOPED',
          status: 'ACTION_REQUIRED',
          currentStepId: step.step_id,
          previousStepId,
          instruction: step.instruction,
          approvedInstruction: step.instruction,
          question: step.question ?? null,
          nextStepId: step.step_id,
          facts,
          missingFacts: [],
          escalations: escalation.escalations,
          requiresClarification: false,
          clarificationQuestion: null,
          stepUpdates,
          events,
          progressPct: this.progress(protocol, completedStepIds),
        };
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
          return {
            action: 'COMPLETED',
            status: 'COMPLETED',
            currentStepId: step.step_id,
            previousStepId,
            instruction: step.instruction,
            approvedInstruction: step.instruction,
            question: null,
            nextStepId: null,
            facts,
            missingFacts: [],
            escalations: escalation.escalations,
            requiresClarification: false,
            clarificationQuestion: null,
            stepUpdates,
            events,
            progressPct: 100,
          }
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

        return {
          action: 'ADVANCED',
          status: nextStep.type === 'ACTION' ? 'ACTION_REQUIRED' : 'WAITING_FOR_RESPONSE',
          currentStepId: nextStep.step_id,
          previousStepId,
          instruction: nextStep.instruction,
          approvedInstruction: nextStep.instruction,
          question: nextStep.question ?? null,
          nextStepId: nextStep.step_id,
          facts,
          missingFacts: missingFactsFor(nextStep, facts),
          escalations: [...escalation.escalations, ...forced],
          requiresClarification: false,
          clarificationQuestion: null,
          stepUpdates,
          events,
          progressPct: this.progress(protocol, completedStepIds),
        };
      }
    }
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
