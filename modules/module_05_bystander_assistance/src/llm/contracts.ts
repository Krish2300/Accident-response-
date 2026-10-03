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
export const BREATHING_STATUSES = [
  'BREATHING',
  'NOT_BREATHING',
  'GASPNING_AGAINST',
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
