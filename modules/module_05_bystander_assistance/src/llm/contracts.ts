/**
 * Module 5 LLM contract.
 *
 * The application never talks to Ollama directly: it talks to `LLMService`.
 * Every method returns schema-validated data, and every failure mode is an
 * explicit error code. The provider is a local, free, offline model by default.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Structured extraction
// ---------------------------------------------------------------------------

export const TRISTATE = ['YES', 'NO', 'UNKNOWN'] as const;
/**
 * Values of `breathing_status`.
 *
 * `AGHASTIC` is present because the protocol catalogue uses it: the ERC adult BLS
 * source transcribes agonal breathing as its own value, and `cardiac-arrest-adult`
 * and `active-seizure` both list it alongside `GASPNING_AGAINST` in the conditions
 * that mean "not breathing normally". Without it here, a caller describing agonal
 * gasps could never satisfy those conditions however they were extracted — the
 * catalogue entry would be unreachable and the enum would be silently narrower than
 * the authoritative content.
 *
 * Both values mean the same thing clinically and both are treated identically by
 * every condition that uses them. They are kept as separate tokens because the
 * catalogue does: a reviewer comparing the engine's behaviour against the
 * guidance should be able to see the guidance's own term.
 */
export const BREATHING_STATUSES = [
  'BREATHING',
  'NOT_BREATHING',
  'GASPNING_AGAINST',
  'AGHASTIC',
  'UNKNOWN',
] as const;
export const CONSCIOUSNESS = ['ALERT', 'CONFUSED', 'UNRESPONSIVE', 'UNKNOWN'] as const;
export const CHOKING_SIGNS = ['CANNOT_SPEAK_OR_COUGH', 'CAN_SPEAK_OR_COUGH', 'UNKNOWN'] as const;
export const AGE_GROUPS = ['INFANT', 'CHILD', 'ADULT', 'ELDERLY', 'UNKNOWN'] as const;

export const intents = [
  'PATIENT_UNRESPONSIVE',
  'PATIENT_NOT_BREATHING',
  'SEVERE_BLEEDING',
  'CHOKING',
  'ACTIVE_SEIZURE',
  'CHEST_PAIN',
  'OVERDOSE',
  'TRAUMA_INJURY',
  'MULTIPLE_CASUALTIES',
  'SCENE_UNSAFE',
  'ALLERGIC_REACTION',
  'CALLER_CONFIRMS_ACTION_DONE',
  'CALLER_NEEDS_REPEAT',
  'OTHER',
] as const;
export type Intent = (typeof intents)[number];

/**
 * Every observable fact a protocol condition may reference.
 *
 * `UNKNOWN` (never a guess) is a first-class value: the protocol engine treats
 * it as "not yet established" and asks again.
 */
export const entitiesSchema = z.object({
  responsive: z.enum(TRISTATE).default('UNKNOWN'),
  consciousness: z.enum(CONSCIOUSNESS).default('UNKNOWN'),
  breathing_status: z.enum(BREATHING_STATUSES).default('UNKNOWN'),
  severe_bleeding: z.enum(TRISTATE).default('UNKNOWN'),
  choking_signs: z.enum(CHOKING_SIGNS).default('UNKNOWN'),
  seizure_active: z.enum(TRISTATE).default('UNKNOWN'),
  chest_pain: z.enum(TRISTATE).default('UNKNOWN'),
  scene_safe: z.enum(TRISTATE).default('UNKNOWN'),
  caller_with_patient: z.enum(TRISTATE).default('UNKNOWN'),
  age_group: z.enum(AGE_GROUPS).default('UNKNOWN'),
  patient_count: z.number().int().min(1).max(50).nullable().default(null),
  mechanism: z.string().max(200).nullable().default(null),
  duration_minutes: z.number().min(0).max(1440).nullable().default(null),
  /** Free-form observations kept for the record; never used for decisions. */
  notes: z.string().max(500).nullable().default(null),
});
export type Entities = z.infer<typeof entitiesSchema>;

export const extractionSchema = z.object({
  intent: z.enum(intents),
  entities: entitiesSchema,
  confidence: z.number().min(0).max(1),
  requires_clarification: z.boolean(),
  /** Question the assistant should ask. Must be about missing information. */
  clarification_question: z.string().max(300).nullable().default(null),
  /** Verbatim fragment of the caller's words that drove the extraction. */
  evidence: z.string().max(300).nullable().default(null),
});
export type Extraction = z.infer<typeof extractionSchema>;

/**
 * The closed value sets this module declares for individual facts.
 *
 * This is the only place in Module 5 where a fact's full set of legal values is
 * known, so it is also the only sound source of an exhaustive vocabulary. The
 * protocol catalogue cannot supply one: it states which values a condition tests
 * against, not which values exist. `scene_safe ne YES` appears in four protocols
 * and does not mean "the only possible value is YES".
 *
 * The engine treats any fact absent from this map as unbounded and accepts
 * whatever it is given, which is how `caller_location` (a caller's own words) and
 * `cpr_started` keep working.
 */
export const CLOSED_FACT_VALUES: Readonly<Record<string, readonly string[]>> = {
  responsive: TRISTATE,
  consciousness: CONSCIOUSNESS,
  breathing_status: BREATHING_STATUSES,
  severe_bleeding: TRISTATE,
  choking_signs: CHOKING_SIGNS,
  seizure_active: TRISTATE,
  chest_pain: TRISTATE,
  scene_safe: TRISTATE,
  caller_with_patient: TRISTATE,
  age_group: AGE_GROUPS,
};

/** `CLOSED_FACT_VALUES` in the shape the engine's fact validation expects. */
export function closedFactValues(): Map<string, ReadonlySet<string>> {
  return new Map(
    Object.entries(CLOSED_FACT_VALUES).map(([fact, values]) => [
      fact,
      new Set(values.map((value) => value.toUpperCase())),
    ]),
  );
}

export const classificationSchema = z.object({
  incident_type: z.enum([
    'CARDIAC_ARREST',
    'CHOKING',
    'UNCONSCIOUS',
    'SEVERE_BREATHING_DIFFICULTY',
    'SEVERE_BLEEDING',
    'TRAUMA',
    'OVERDOSE',
    'SEIZURE',
    'ALLERGIC_REACTION',
    'STROKE',
    'CHEST_PAIN',
    'UNSAFE_SCENE',
    'OTHER',
  ]),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(400),
  /** Escalate to a human whenever confidence is low or the scene is unsafe. */
  requires_human_review: z.boolean(),
});
export type Classification = z.infer<typeof classificationSchema>;

export const responseSchema = z.object({
  speech: z.string().min(1).max(1200),
  tone: z.enum(['CALM', 'URGENT', 'REASSURING']).default('CALM'),
  /** Set by the safety gate, not by the model. */
  echo_of_source: z.boolean().default(true),
});
export type ProtocolResponse = z.infer<typeof responseSchema>;

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface LlmHealth {
  provider: string;
  model: string;
  available: boolean;
  baseUrl?: string;
  /** Populated when unavailable; surfaced in the health endpoint. */
  reason?: string;
  latencyMs?: number;
  /** True when the service has silently degraded to the heuristic provider. */
  degraded?: boolean;
  checkedAt: string;
}

export interface GenerateOptions {
  system?: string;
  prompt?: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  numCtx?: number;
  /** JSON Schema for structured output. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface GenerateResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  /** True when the model output was not schema-valid and had to be repaired. */
  repaired: boolean;
  degraded: boolean;
  raw?: unknown;
}

/**
 * The single LLM port used by the rest of Module 5.
 * Implementations: `OllamaProvider`, `HeuristicProvider`, and any future
 * provider registered through `LLMServiceRegistry`.
 */
export interface LLMService {
  readonly providerName: string;
  readonly model: string;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  extract(transcript: string, context?: ExtractContext): Promise<Extraction>;
  classify(
    transcript: string,
    context?: { incidentHint?: string; callerLocation?: string },
  ): Promise<Classification>;
  respond(request: RespondRequest): Promise<ProtocolResponse>;
  health(): Promise<LlmHealth>;
}

export interface ExtractContext {
  /** Facts already confirmed by the protocol engine. */
  knownFacts?: Partial<Entities>;
  currentStepQuestion?: string | null;
  protocolId?: string | null;
  /** Facts the current protocol step still needs. */
  missingFacts?: string[];
}

export interface RespondRequest {
  /** Protocol-approved wording. The model may only rephrase this. */
  instruction: string;
  /** Optional protocol question the model should put to the caller. */
  question?: string | null;
  tone?: 'CALM' | 'URGENT' | 'REASSURING';
  /** What the bystander just said, so the reply can acknowledge it. */
  callerUtterance?: string | null;
  language?: string;
}
