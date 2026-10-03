/**
 * Medical safety gate.
 *
 * The LLM is allowed to rephrase protocol-approved wording. It is not allowed to
 * introduce clinical content. This module checks its output against the source
 * instruction and rejects it when it does.
 *
 * Checks performed (deliberately simple, deliberately auditable):
 *  1. No numeric token in the output that is absent from the source. This
 *     blocks invented doses, ratios, counts, durations and compression rates.
 *  2. No dose-like or unit-like token absent from the source ("mg", "ml", "bpm").
 *  3. No source keyword dropped: if the source names an action the bystander
 *     must perform, the reply must still mention its stem.
 *
 * This is a guard rail, not a proof. The authoritative text is always retained
 * in the database alongside whatever is spoken.
 */

const NUMBER_PATTERN = /\d+(?:[.,]\d+)?/g;
const UNIT_PATTERN = /\b\d+\s*(?:mg|mcg|ml|l|kg|cm|mm|hz|bpm|per\s+min|seconds?|minutes?|%|beats?)\b/gi;
const ACTION_KEYWORDS = [
  'call',
  'press',
  'push',
  'breathe',
  'blow',
  'check',
  'turn',
  'place',
  'remove',
  'clear',
  'stop',
  'tilt',
  'lift',
  'listen',
  'look',
  'feel',
  'stir',
  'cough',
  'stay',
  'move',
  'wait',
  'keep',
  'open',
  'clot',
  'pressure',
  'siren',
  'unlock',
  'someone',
  'caller',
  'ambulance',
  'dispatcher',
  'operator',
];

export interface SafetyVerdict {
  safe: boolean;
  reason?: string;
  /** Numbers that appeared in the reply but not in the protocol text. */
  inventedNumbers?: string[];
  /** Protocol action words the reply appears to have dropped. */
  droppedActions?: string[];
}

export function normaliseForSafetyCheck(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Word-stem comparison: the reply only has to keep the stem of an action word,
 * so "pressing" still satisfies "press".
 */
function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

export function assertSafeRephrasing(source: string, candidate: string): SafetyVerdict {
  const normalisedSource = normaliseForSafetyCheck(source);
  const normalisedCandidate = normaliseForSafetyCheck(candidate);

  const sourceNumbers = new Set(normalisedSource.match(NUMBER_PATTERN) ?? []);
  const candidateNumbers = normaliseForSafetyCheck(candidate).match(NUMBER_PATTERN) ?? [];
  const inventedNumbers = [...new Set(candidateNumbers.filter((n) => !sourceNumbers.has(n)))];
  if (inventedNumbers.length > 0) {
    return { safe: false, reason: 'reply introduced numbers that are not in the protocol text', inventedNumbers };
  }

  const sourceUnits = new Set(normalisedSource.match(UNIT_PATTERN) ?? []);
  const candidateUnits = normalisedCandidate.match(UNIT_PATTERN) ?? [];
  const inventedUnits = [...new Set(candidateUnits.filter((u) => !sourceUnits.has(u)))];
  if (inventedUnits.length > 0) {
    return { safe: false, reason: 'reply introduced a clinical measurement not in the protocol text', inventedNumbers: inventedUnits };
  }

  const sourceStems = new Set(
    normalisedSource
      .split(' ')
      .map(stem)
      .filter((w) => ACTION_KEYWORDS.includes(w)),
  );
  const candidateStems = new Set(normalisedCandidate.split(' ').map(stem));
  const droppedActions = [...sourceStems].filter((w) => !candidateStems.has(w));
  if (droppedActions.length > 0) {
    return { safe: false, reason: 'reply dropped protocol action wording', droppedActions };
  }

  return { safe: true };
}
