import type { Protocol, ProtocolFacts } from './types.js';
import { evaluateCondition, type EvaluationContext } from './stateMachine.js';

export type EscalationAction = 'NOTIFY_OPERATOR' | 'CALL_EMERGENCY_SERVICES' | 'BOTH';
export type EscalationSeverity = 'ADVISORY' | 'URGENT' | 'CRITICAL';

export interface Escalation {
  ruleId: string;
  reason: string;
  action: EscalationAction;
  severity: EscalationSeverity;
  /** Protocol rule that fired, for the audit trail. */
  source: { protocolId: string; protocolVersion: string };
  /**
   * Protocol step the caller should be moved to, when the rule names one. Kept
   * on the escalation so the engine can present reviewed wording instead of
   * re-reading the step that happened to be active.
   */
  escalationStepId?: string;
}

export interface EscalationEvaluation {
  escalations: Escalation[];
  /** Highest severity among the fired rules, or null. */
  highest: EscalationSeverity | null;
  /** True when the flow must stop and hand over to a human. */
  mustEscalate: boolean;
}

/**
 * Escalation policy evaluation.
 *
 * Rules are data inside each protocol, so clinical reviewers can change who gets
 * called without touching engine code. Any fired rule is recorded on the session
 * and in the event log.
 */
export class EscalationPolicy {
  evaluate(protocol: Protocol, context: EvaluationContext): EscalationEvaluation {
    const escalations: Escalation[] = [];

    for (const rule of protocol.escalation_rules) {
      if (!evaluateCondition(rule.when, context)) continue;
      escalations.push({
        ruleId: rule.rule_id,
        reason: rule.reason,
        action: rule.action,
        severity: rule.severity,
        source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version },
        ...(rule.escalation_step ? { escalationStepId: rule.escalation_step } : {}),
      });
    }

    const highest = pickHighest(escalations.map((e) => e.severity));
    return {
      escalations,
      highest,
      mustEscalate: escalations.some((e) => e.action !== 'NOTIFY_OPERATOR'),
    };
  }
}

const SEVERITY_ORDER: Record<EscalationSeverity, number> = { ADVISORY: 1, URGENT: 2, CRITICAL: 3 };

function pickHighest(values: EscalationSeverity[]): EscalationSeverity | null {
  if (values.length === 0) return null;
  return values.reduce((best, current) =>
    SEVERITY_ORDER[current] > SEVERITY_ORDER[best] ? current : best,
  );
}

/** Facts the engine adds so rules can reason about effort and repetition. */
export function withDerivedFacts(
  facts: ProtocolFacts,
  derived: { completedSteps: number; repeatCount: number; totalSteps: number },
): ProtocolFacts {
  return {
    ...facts,
    completed_steps: derived.completedSteps,
    repeat_count: derived.repeatCount,
    total_steps: derived.totalSteps,
    progress_pct:
      derived.totalSteps > 0
        ? Math.round((derived.completedSteps / derived.totalSteps) * 100)
        : 0,
  };
}
