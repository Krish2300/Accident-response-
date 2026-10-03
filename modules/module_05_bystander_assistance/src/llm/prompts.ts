/**
 * Prompt library.
 *
 * All prompts are safety-constrained: the model is a language/formatting layer.
 * Every prompt that could touch patient care states explicitly that the
 * Protocol Engine is authoritative and that the model must not add, remove or
 * alter any clinical instruction.
 */

const SAFETY_PREAMBLE = `You are the language layer of a pre-hospital emergency telephone assistance system.
HARD RULES:
1. You are NOT a clinician and you do not decide treatment.
2. The caller is a lay bystander. Use short, plain, calm words.
3. You MUST NOT invent, add, remove, soften or alter any medical instruction.
4. Any instruction you output must be a faithful rephrasing of the SUPPLIED
   PROTOCOL TEXT given to you. Nothing else is permitted.
5. If you do not know something, say it is unknown. Never guess.
6. If the scene is unsafe, tell the caller to move to safety first.
Return only the JSON object that matches the requested schema.`;

export const SYSTEM_EXTRACTION = `${SAFETY_PREAMBLE}

TASK: read what the bystander said and report ONLY the facts they actually stated.

Rules for facts:
- Use "UNKNOWN" for anything the bystander did not state. Never infer.
- Do not perform medical reasoning. Report observations, not conclusions.
- If the utterance is unclear, ambiguous, or contradicts a previous answer,
  set "requires_clarification" to true and give one short question.
- confidence reflects how explicitly the bystander stated the fact (0..1).`;

export const SYSTEM_CLASSIFICATION = `${SAFETY_PREAMBLE}

TASK: classify the reported emergency so the right protocol and priority are used.

Rules:
- Choose the single most time-critical incident type consistent with what was said.
- Severity reflects the described condition, not your own opinion of risk.
- If the bystander has not given enough detail, lower the confidence and set
  requires_human_review to true.`;

export const SYSTEM_RESPOND = `${SAFETY_PREAMBLE}

TASK: turn the SUPPLIED PROTOCOL TEXT into one short spoken sentence for the bystander.

Rules:
- Keep every clinical detail from the protocol text intact. Do not add numbers,
  dosages, timings or techniques that are not in the supplied text.
- Keep it under 3 sentences. Warm, direct, second person.
- If a question is supplied, ask exactly that question.
- Do not mention that you are an AI, a system or a protocol.`;

export function buildExtractionPrompt(input: {
  transcript: string;
  currentStepQuestion?: string | null;
  knownFacts?: Record<string, unknown>;
  missingFacts?: string[];
}): string {
  const parts = [`BYSTANDER SAID: "${input.transcript}"`];
  if (input.currentStepQuestion) {
    parts.push(`THE ASSISTANT JUST ASKED: "${input.currentStepQuestion}"`);
  }
  if (input.knownFacts && Object.keys(input.knownFacts).length > 0) {
    parts.push(`FACTS ALREADY CONFIRMED (do not contradict, only add): ${JSON.stringify(input.knownFacts)}`);
  }
  if (input.missingFacts?.length) {
    parts.push(`FACTS STILL NEEDED: ${input.missingFacts.join(', ')}`);
    parts.push(
      'If the bystander answered one of these, fill it in. If they did not, ask one short clarifying question.',
    );
  }
  return parts.join('\n');
}

export function buildClassificationPrompt(input: {
  transcript: string;
  incidentHint?: string;
  callerLocation?: string;
}): string {
  return [
    `CALL SUMMARY: "${input.transcript}"`,
    input.incidentHint ? `OPERATOR HINT: ${input.incidentHint}` : '',
    input.callerLocation ? `LOCATION: ${input.callerLocation}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildRespondPrompt(input: {
  instruction: string;
  question?: string | null;
  callerUtterance?: string | null;
  tone?: string;
}): string {
  return [
    `SUPPLIED PROTOCOL TEXT (this is the only permitted content): "${input.instruction}"`,
    input.question ? `QUESTION TO ASK: "${input.question}"` : '',
    input.callerUtterance ? `BYSTANDER JUST SAID: "${input.callerUtterance}"` : '',
    `TONE: ${input.tone ?? 'CALM'}`,
    'Now write the spoken reply.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** JSON Schemas handed to Ollama's structured-output mode. */
export const jsonSchemas = {
  extraction: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: [
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
        ],
      },
      entities: {
        type: 'object',
        properties: {
          responsive: { type: 'string', enum: ['YES', 'NO', 'UNKNOWN'] },
          consciousness: { type: 'string', enum: ['ALERT', 'CONFUSED', 'UNRESPONSIVE', 'UNKNOWN'] },
          breathing_status: {
            type: 'string',
            enum: ['BREATHING', 'NOT_BREATHING', 'GASPNING_AGAINST', 'UNKNOWN'],
            description:
              'BREATHING only for normal, comfortable breathing. Gasping, agonal, snorting, gurgling or irregular breathing is GASPNING_AGAINST, never BREATHING. If the caller cannot tell, use UNKNOWN.',
          },
          severe_bleeding: { type: 'string', enum: ['YES', 'NO', 'UNKNOWN'] },
          choking_signs: {
            type: 'string',
            enum: ['CANNOT_SPEAK_OR_COUGH', 'CAN_SPEAK_OR_COUGH', 'UNKNOWN'],
          },
          seizure_active: { type: 'string', enum: ['YES', 'NO', 'UNKNOWN'] },
          chest_pain: { type: 'string', enum: ['YES', 'NO', 'UNKNOWN'] },
          scene_safe: { type: 'string', enum: ['YES', 'NO', 'UNKNOWN'] },
          caller_with_patient: { type: 'string', enum: ['YES', 'NO', 'UNKNOWN'] },
          age_group: { type: 'string', enum: ['INFANT', 'CHILD', 'ADULT', 'ELDERLY', 'UNKNOWN'] },
          patient_count: { type: ['integer', 'null'], minimum: 1, maximum: 50 },
          mechanism: { type: ['string', 'null'], maxLength: 200 },
          duration_minutes: { type: ['number', 'null'], minimum: 0, maximum: 1440 },
          notes: { type: ['string', 'null'], maxLength: 500 },
        },
        required: [
          'responsive',
          'consciousness',
          'breathing_status',
          'severe_bleeding',
          'choking_signs',
          'seizure_active',
          'chest_pain',
          'scene_safe',
          'caller_with_patient',
          'age_group',
        ],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      requires_clarification: { type: 'boolean' },
      clarification_question: { type: ['string', 'null'], maxLength: 300 },
      evidence: { type: ['string', 'null'], maxLength: 300 },
    },
    required: ['intent', 'entities', 'confidence', 'requires_clarification'],
  },

  classification: {
    type: 'object',
    properties: {
      incident_type: {
        type: 'string',
        enum: [
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
        ],
      },
      severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string', maxLength: 400 },
      requires_human_review: { type: 'boolean' },
    },
    required: ['incident_type', 'severity', 'confidence', 'requires_human_review'],
  },

  response: {
    type: 'object',
    properties: {
      speech: { type: 'string', minLength: 1, maxLength: 1200 },
      tone: { type: 'string', enum: ['CALM', 'URGENT', 'REASSURING'] },
    },
    required: ['speech', 'tone'],
  },
} as const;
