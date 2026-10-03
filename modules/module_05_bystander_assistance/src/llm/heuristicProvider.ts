import { createConsoleLogger } from '@resus/core';
import {
  classificationSchema,
  extractionSchema,
  responseSchema,
  type Classification,
  type Entities,
  type ExtractContext,
  type Extraction,
  type LLMService,
  type LlmHealth,
  type ProtocolResponse,
  type RespondRequest,
} from './contracts.js';

/**
 * Deterministic, non-LLM fallback.
 *
 * Used when Ollama cannot be reached and `LLM_ALLOW_HEURISTIC_FALLBACK=true`.
 *
 * This is NOT a language model and does not pretend to be one: every result it
 * returns is marked `degraded: true`, its confidence is capped low, and it
 * forces `requires_clarification` so that a human is always involved before any
 * protocol step is taken. It is a keyword matcher over a deliberately tiny
 * lexicon, included so the bystander flow degrades safely rather than silently.
 */
/**
 * Scene-safety lexicon.
 *
 * Reported hazards must produce `scene_safe = NO` even when they appear in the
 * middle of a message about something else, because the protocol's
 * scene-safety-first rule stops the caller from approaching the patient. False
 * positives here are cheap (the operator is asked to confirm); false negatives
 * send a bystander into a dangerous scene.
 *
 * The list deliberately describes danger *to the approaching bystander*, not
 * whatever happened to the patient. "He fell down the stairs" is a mechanism of
 * injury, not a scene hazard — treating it as one would wrongly halt an arrest
 * protocol, which is the more dangerous error of the two.
 */
const SCENE_HAZARD_WORDS = [
  'spark',
  'live wire',
  'electric',
  'electricity',
  'electrocution',
  'power line',
  'traffic',
  'moving car',
  'moving truck',
  'on the road',
  'in the road',
  'highway',
  'fire',
  'smoke',
  'flame',
  'burning',
  'gas leak',
  'leaking gas',
  'gas is leaking',
  'smell gas',
  'flood',
  'deep water',
  'broken glass',
  'unstable',
  'collapsing',
  'collapsed ceiling',
  'dangerous',
  'danger',
  'hazard',
  'chemical spill',
  'poison gas',
  'fighting',
  'attack',
  'armed',
  'lightning',
  'storm',
] as const;

/**
 * Breathing classification.
 *
 * Order matters, and the safety direction is one-way: gasping, agonal or
 * irregular breathing is *not* normal breathing. A bystander describing gasps
 * for an unresponsive person is describing cardiac arrest, and collapsing that
 * into "BREATHING" would send the flow down the reassurance branch and talk the
 * caller out of starting CPR.
 */
function breathingStatus(text: string, has: (...needles: string[]) => boolean): Entities['breathing_status'] {
  if (
    has('gasping', 'gasping and', 'agonal', 'occasional gasp', 'irregular breathing', 'gurgling', 'ineffective breathing') ||
    /gasping|snorting|irregular/.test(text)
  ) {
    return 'GASPNING_AGAINST';
  }
  if (has('not breathing', "isn't breathing", 'no breathing', 'stopped breathing', 'no pulse')) {
    return 'NOT_BREATHING';
  }
  if (has('breathing', 'puffing', 'breathes')) return 'BREATHING';
  return 'UNKNOWN';
}

/** Statements that a scene is *not* safe; checked before any reassurance. */
function sceneSafety(text: string, has: (...needles: string[]) => boolean): Entities['scene_safe'] {
  // Explicit statements that approach is impossible, e.g. "I can't reach him".
  const blocked = has(
    "can't get",
    'cannot get',
    'can not get',
    "can't reach",
    'cannot reach',
    'can not reach',
    'not safe',
    "isn't safe",
    'is not safe',
    'unsafe',
    "won't let me",
    'will not let me',
  );

  // Hazard words are scanned after reassurance phrases are masked out, so
  // "there is no danger" is not read as a hazard report because it contains
  // the word "danger".
  const claimsSafe = has('safe', 'no danger', 'not dangerous');
  const masked = claimsSafe
    ? text.replace(/no danger|not dangerous|safe/gi, ' ')
    : text;

  const hazard = SCENE_HAZARD_WORDS.some((word) => masked.includes(word));
  if (blocked || hazard) return 'NO';
  if (claimsSafe) return 'YES';
  return 'UNKNOWN';
}

export class HeuristicProvider implements LLMService {
  readonly providerName = 'heuristic-fallback';

  constructor(
    readonly model: string = 'rule-based',
    private readonly logger: ReturnType<typeof createConsoleLogger> = createConsoleLogger('warn', 'module_05.llm'),
  ) {}

  private get degradedNote(): string {
    return 'LLM unavailable; deterministic keyword matcher in use. Not a language model.';
  }

  async generate(): Promise<never> {
    throw new Error('HeuristicProvider does not support free-form generation.');
  }

  async extract(transcript: string, context: ExtractContext = {}): Promise<Extraction> {
    const text = transcript.toLowerCase();
    const has = (...needles: string[]) => needles.some((n) => text.includes(n));

    const entities: Entities = {
      responsive: has("not respond", 'not responding', 'unresponsive', "won't respond", 'unconscious', 'passed out')
        ? 'NO'
        : 'UNKNOWN',
      consciousness: has("not respond", 'not responding', 'unresponsive', 'unconscious', 'passed out')
        ? 'UNRESPONSIVE'
        : has('confused', 'drowsy', 'dazed')
          ? 'CONFUSED'
          : 'UNKNOWN',
      breathing_status: breathingStatus(text, has),
      severe_bleeding: has('bleeding', 'blood', 'choking blood') ? 'YES' : 'UNKNOWN',
      choking_signs: has("can't speak", 'cannot speak', "can't cough", 'choking') ? 'CANNOT_SPEAK_OR_COUGH' : 'UNKNOWN',
      seizure_active: has('seizure', 'fitting', 'convulsion', 'convulsing') ? 'YES' : 'UNKNOWN',
      chest_pain: has('chest pain', 'chest tight', 'chest pressure') ? 'YES' : 'UNKNOWN',
      // Hazard language wins over reassurance language. A caller who says
      // "it is safe here, but there are live wires" has reported an unsafe
      // scene, and the scene-safety-first rule must fire on that fact alone.
      scene_safe: sceneSafety(text, has),
      caller_with_patient: has("i'm with", 'i am with', 'im with', 'next to', 'beside') ? 'YES' : 'UNKNOWN',
      age_group: has('baby', 'infant') ? 'INFANT' : has('child', 'kid') ? 'CHILD' : 'UNKNOWN',
      patient_count: null,
      mechanism: null,
      duration_minutes: null,
      notes: transcript.slice(0, 300),
    };

    const intent: Extraction['intent'] =
      entities.breathing_status === 'NOT_BREATHING' || entities.breathing_status === 'GASPNING_AGAINST'
      ? 'PATIENT_NOT_BREATHING'
      : entities.responsive === 'NO'
        ? 'PATIENT_UNRESPONSIVE'
        : entities.choking_signs === 'CANNOT_SPEAK_OR_COUGH'
          ? 'CHOKING'
          : entities.seizure_active === 'YES'
            ? 'ACTIVE_SEIZURE'
            : entities.severe_bleeding === 'YES'
              ? 'SEVERE_BLEEDING'
              : entities.chest_pain === 'YES'
                ? 'CHEST_PAIN'
                : 'OTHER';

    // Confidence is deliberately low: this is a keyword match, not comprehension.
    const extraction: Extraction = {
      intent,
      entities,
      confidence: 0.35,
      requires_clarification: true,
      clarification_question:
        context.currentStepQuestion ??
        'I am running on a reduced safety net because the language model is offline. I need an operator to confirm your next steps. Can you stay on the line?',
      evidence: transcript.slice(0, 200),
    };
    this.logger.warn({ reason: this.degradedNote }, 'extraction produced by heuristic fallback');
    return extraction;
  }

  async classify(transcript: string): Promise<Classification> {
    const extraction = await this.extract(transcript);
    return {
      incident_type:
        extraction.intent === 'PATIENT_NOT_BREATHING' ? 'CARDIAC_ARREST' : 'OTHER',
      severity: 'HIGH',
      confidence: 0.2,
      rationale: 'Heuristic fallback only. A human operator must confirm classification.',
      requires_human_review: true,
    };
  }

  async respond(request: RespondRequest): Promise<ProtocolResponse> {
    const parsed = responseSchema.parse({
      speech: request.question ? `${request.instruction} ${request.question}` : request.instruction,
      tone: request.tone ?? 'CALM',
    });
    return { ...parsed, echo_of_source: true };
  }

  async health(): Promise<LlmHealth> {
    return {
      provider: this.providerName,
      model: this.model,
      available: true,
      degraded: true,
      reason: this.degradedNote,
      checkedAt: new Date().toISOString(),
    };
  }
}

export { extractionSchema, classificationSchema, responseSchema };
