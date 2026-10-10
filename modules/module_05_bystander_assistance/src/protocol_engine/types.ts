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

// ---------------------------------------------------------------------------
// The authoritative decision surface
// ---------------------------------------------------------------------------

/**
 * A protocol-approved instruction, addressed by a stable identifier.
 *
 * `instructionId` is derived, not authored: it is `<protocol_id>@<version>:<step_id>`,
 * so it survives re-transcription of the wording. A localisation layer renders the
 * catalogue text into Malayalam (or any language) by looking this key up in a
 * reviewed translation table. The protocol engine itself never contains localised
 * text, which is what keeps it language-independent.
 */
export interface ProtocolInstruction {
  instructionId: string;
  stepId: string;
  stepType: StepType;
  orderIndex: number;
  /** Catalogue wording. Authoritative, persisted, never generated. */
  text: string;
}

/**
 * "What information is required next?", as structure rather than prose.
 *
 * Module 5 decides *which* fact is missing and *that* a question is due; it never
 * decides how to phrase it in a human language beyond the reviewed wording already
 * in the catalogue. Module 4 / the language layer turns `text` into Malayalam.
 */
export interface ProtocolQuestionRequirement {
  questionId: string;
  /** Fact keys the engine still needs before the step can be evaluated. */
  requiredFacts: string[];
  /** Reviewed catalogue wording for the question actually asked. */
  text: string;
  /** Protocol step the question belongs to. */
  protocolState: string;
  /** 1-based attempt number, for the conversation layer's retry budget. */
  attempt: number;
}

export type ProtocolDecisionType =
  /** The current step is still the one to follow; nothing changed. */
  | 'HELD'
  /** The step may be evaluated but does not progress; the protocol says repeat. */
  | 'LOOPED'
  /** A new step became current. */
  | 'ADVANCED'
  /** Missing information must be supplied before the step can be evaluated. */
  | 'QUESTION_REQUIRED'
  /** A protocol escalation rule or step demanded a human. */
  | 'ESCALATED'
  /** The protocol finished. */
  | 'COMPLETED';

export interface ProtocolDecisionEscalation {
  ruleId: string;
  reason: string;
  severity: 'ADVISORY' | 'URGENT' | 'CRITICAL';
  action: 'NOTIFY_OPERATOR' | 'CALL_EMERGENCY_SERVICES' | 'BOTH';
}

/**
 * The complete, self-describing outcome of one protocol turn.
 *
 * Everything the caller needs in order to render, speak, log or audit the turn is
 * here, and nothing in it originates from a language model.
 */
export interface ProtocolDecision {
  protocolId: string;
  protocolVersion: string;
  /** Where the protocol was before this turn. */
  currentState: string;
  /** Where the protocol is now. Equal to `currentState` when nothing moved. */
  nextState: string;
  decisionType: ProtocolDecisionType;
  /** Approved instruction to render/speak, when the protocol issued one. */
  instruction: ProtocolInstruction | null;
  /** Structured question, when information is required. */
  requiredQuestion: ProtocolQuestionRequirement | null;
  escalation: ProtocolDecisionEscalation | null;
  completed: boolean;
  /** Facts still missing for the step now current. */
  missingFacts: string[];
  /**
   * Deterministic identifier of the rule that produced this decision. For a
   * transition it is `<step_id>.transition[<index>]`; for a held step it is
   * `<step_id>.missing_facts` or `<step_id>.unmatched`; for an escalation it is the
   * escalation rule id. Derived from catalogue structure, never from prose.
   */
  ruleId: string;
  /** Human-readable justification, from the catalogue note or the engine's guard. */
  reason: string;
  audit: ProtocolDecisionAudit;
}

export interface ProtocolDecisionAudit {
  /** Protocol version this decision was made against. */
  protocolVersion: string;
  /** Citation of the guidance the catalogue content was transcribed from. */
  protocolSource: string;
  /** Clinical review state of that content; nothing here is clinician-approved yet. */
  reviewStatus: Protocol['source']['review_status'];
  /** Facts this turn contributed, after validation. */
  acceptedFacts: string[];
  /** Facts that arrived but were not usable, with the reason. */
  rejectedFacts: Array<{ fact: string; reason: string }>;
  /** Facts the protocol has no condition for; dropped rather than stored. */
  unsupportedFacts: string[];
  /**
   * False when the facts for this turn came from an untrusted source (a
   * low-confidence language model). An untrusted turn can never advance or
   * complete a protocol; it can only escalate or ask again.
   */
  factsTrusted: boolean;
  /** Wall-clock time of the turn, injected by the caller. */
  evaluatedAt: string;
}

/** Stable instruction identifier for a step, independent of its wording. */
export function instructionIdFor(protocol: Pick<Protocol, 'protocol_id' | 'version'>, stepId: string): string {
  return `${protocol.protocol_id}@${protocol.version}:${stepId}`;
}

/** Stable question identifier for one clarification attempt at one step. */
export function questionIdFor(protocol: Pick<Protocol, 'protocol_id' | 'version'>, stepId: string, attempt: number): string {
  return `${protocol.protocol_id}@${protocol.version}:${stepId}#q${attempt}`;
}
