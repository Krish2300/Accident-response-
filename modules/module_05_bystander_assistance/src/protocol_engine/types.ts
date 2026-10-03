import { z } from 'zod';

/**
 * Protocol catalogue schema.
 *
 * Medical content lives in data, not code: JSON files under `protocols/`. Every
 * file carries its version and its authoritative source, and the loader refuses
 * to run a catalogue that fails validation. Nothing here is invented — the
 * instructions are transcriptions of published guidance and every file says so.
 */

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

const comparisonSchema = z.object({
  fact: z.string().min(1),
  op: z.enum(['eq', 'ne', 'in', 'not_in', 'exists', 'missing', 'gt', 'gte', 'lt', 'lte']),
  value: z.unknown().optional(),
});

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    comparisonSchema,
    z.object({ all: z.array(conditionSchema).min(1) }),
    z.object({ any: z.array(conditionSchema).min(1) }),
    z.object({ not: conditionSchema }),
    z.object({ always: z.literal(true) }),
  ]),
) as z.ZodType<Condition>;

export type Condition =
  | { fact: string; op: string; value?: unknown }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { always: true };

// ---------------------------------------------------------------------------
// Steps and transitions
// ---------------------------------------------------------------------------

export const STEP_TYPES = ['QUESTION', 'ACTION', 'DECISION', 'INFO', 'ESCALATE'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const TRANSITION_ACTIONS = ['ADVANCE', 'COMPLETE', 'ESCALATE', 'LOOP'] as const;
export type TransitionAction = (typeof TRANSITION_ACTIONS)[number];

export const transitionSchema = z.object({
  when: conditionSchema,
  /** Next step id, or null when the action terminates the flow. */
  to: z.string().min(1).nullable(),
  action: z.enum(TRANSITION_ACTIONS).default('ADVANCE'),
  note: z.string().max(300).nullish(),
});

export type Transition = z.infer<typeof transitionSchema>;

export const stepSchema = z
  .object({
    step_id: z.string().min(1),
    order: z.number().int().min(0),
    type: z.enum(STEP_TYPES),
    /** Protocol-approved wording. This text is authoritative and is persisted. */
    instruction: z.string().min(10).max(1200),
    /** What the assistant asks the bystander, verbatim protocol wording. */
    question: z.string().min(3).max(500).nullish(),
    /**
     * Per-fact follow-up wording, used when only some of this step's required
     * facts are still missing. Keeping these in the protocol file means
     * clarification wording is reviewed with the rest of the protocol rather
     * than generated in code.
     */
    fact_questions: z.record(z.string().min(3).max(500)).optional(),
    /** Entity keys that must be known before this step can be evaluated. */
    requires_facts: z.array(z.string()).default([]),
    /** Repeat cadence for time-based protocols (e.g. CPR cycles). */
    repeat_interval_minutes: z.number().positive().max(60).nullish(),
    /** Maximum repeats before escalation is forced. */
    max_repeats: z.number().int().min(1).max(200).nullish(),
    transitions: z.array(transitionSchema).min(1),
    completion_conditions: z.array(conditionSchema).default([]),
    on_completion: z.enum(TRANSITION_ACTIONS).default('ADVANCE'),
  })
  .superRefine((step, ctx) => {
    const dangling = step.transitions.filter((t) => t.to === null && t.action === 'ADVANCE');
    if (dangling.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Step '${step.step_id}' has an ADVANCE transition with no target; use COMPLETE, ESCALATE or LOOP.`,
      });
    }
  });

export type ProtocolStep = z.infer<typeof stepSchema>;

export const escalationRuleSchema = z.object({
  rule_id: z.string().min(1),
  when: conditionSchema,
  reason: z.string().min(5).max(500),
  action: z.enum(['NOTIFY_OPERATOR', 'CALL_EMERGENCY_SERVICES', 'BOTH']),
  severity: z.enum(['ADVISORY', 'URGENT', 'CRITICAL']).default('URGENT'),
  /**
   * Step whose instruction the caller should hear when this rule fires. Without
   * it the assistant re-reads whichever step happened to be active, which for a
   * scene-safety escalation means telling a bystander to go and check the
   * patient they were just told not to approach.
   */
  escalation_step: z.string().min(1).optional(),
});

export type EscalationRule = z.infer<typeof escalationRuleSchema>;

export const protocolSourceSchema = z.object({
  /** Human readable citation of the guidance this content came from. */
  name: z.string().min(5),
  publisher: z.string().min(2),
  url: z.string().url(),
  /** ISO date the content was transcribed. */
  accessed: z.string().min(4),
  /**
   * Clinical review state. Nothing in this repository has been reviewed by a
   * clinician, and the loader surfaces this state in the API.
   */
  review_status: z.enum(['UNREVIEWED', 'IN_REVIEW', 'CLINICALLY_REVIEWED']),
  reviewed_by: z.string().nullish(),
  reviewed_at: z.string().nullish(),
});

export const protocolSchema = z.object({
  protocol_id: z.string().min(2),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semantic, e.g. 1.0.0'),
  title: z.string().min(3),
  source: protocolSourceSchema,
  medical_disclaimer: z.string().min(20),
  applies_to: z.object({
    incident_types: z.array(z.string().min(2)).min(1),
    age_groups: z.array(z.string()).default([]),
  }),
  /** All must hold for the protocol to apply. */
  entry_conditions: z.array(conditionSchema).default([]),
  entry_step: z.string().min(1),
  steps: z.array(stepSchema).min(1),
  escalation_rules: z.array(escalationRuleSchema).default([]),
  completion_conditions: z.array(conditionSchema).default([]),
  /** Ordering hint for triage when several protocols match. */
  priority: z.number().int().min(0).max(100).default(50),
});

export type Protocol = z.infer<typeof protocolSchema>;

export type ProtocolSummary = {
  protocolId: string;
  version: string;
  title: string;
  source: Protocol['source'];
  priority: number;
  appliesTo: string[];
  stepCount: number;
  reviewStatus: Protocol['source']['review_status'];
};

/** Runtime facts the engine reads and writes. Values are always explicit. */
export type ProtocolFacts = Record<string, unknown>;

export const UNKNOWN = 'UNKNOWN';

export function isUnknown(value: unknown): boolean {
  return value === undefined || value === null || value === UNKNOWN || value === '';
}
