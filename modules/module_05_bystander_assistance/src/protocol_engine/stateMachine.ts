import {
  isUnknown,
  type Condition,
  type Protocol,
  type ProtocolFacts,
  type ProtocolStep,
  type Transition,
} from './types.js';

/**
 * Deterministic state machine.
 *
 * No LLM, no randomness, no clock reads outside the injected fact bag: given the
 * same protocol version, the same facts and the same current step, the engine
 * always produces the same transition. That is what makes the engine testable
 * and what makes it authoritative over the language layer.
 */

export interface EvaluationContext {
  facts: ProtocolFacts;
  /** Facts this step still needs before it can be evaluated. */
  now: Date;
  sessionStartedAt: Date;
  /** Repeat counter for the current step, used by LOOP actions. */
  repeatCount: number;
}

export function evaluateCondition(condition: Condition, context: EvaluationContext): boolean {
  if ('always' in condition) return true;
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, context));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, context));
  if ('not' in condition) return !evaluateCondition(condition.not, context);

  const actual = context.facts[condition.fact];
  switch (condition.op) {
    case 'exists':
      return !isUnknown(actual);
    case 'missing':
      return isUnknown(actual);
    case 'eq':
      return !isUnknown(actual) && isEqual(actual, condition.value);
    case 'ne':
      // `ne` means "established and different", never "not yet established".
      // Without this, an UNKNOWN scene would satisfy "scene_safe ne YES" and
      // trigger an escalation for a fact nobody has reported yet.
      return !isUnknown(actual) && !isEqual(actual, condition.value);
    case 'in':
      return (
        !isUnknown(actual) &&
        Array.isArray(condition.value) &&
        condition.value.some((v) => isEqual(actual, v))
      );
    case 'not_in':
      return (
        !isUnknown(actual) &&
        Array.isArray(condition.value) &&
        !condition.value.some((v) => isEqual(actual, v))
      );
    case 'gt':
      return numeric(actual) !== null && numeric(actual)! > numeric(condition.value)!;
    case 'gte':
      return numeric(actual) !== null && numeric(actual)! >= numeric(condition.value)!;
    case 'lt':
      return numeric(actual) !== null && numeric(actual)! < numeric(condition.value)!;
    case 'lte':
      return numeric(actual) !== null && numeric(actual)! <= numeric(condition.value)!;
    default:
      return false;
  }
}

function isEqual(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toUpperCase() === expected.toUpperCase();
  }
  return actual === expected;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Facts the current step is still missing. */
export function missingFactsFor(step: ProtocolStep, facts: ProtocolFacts): string[] {
  return (step.requires_facts ?? []).filter((key) => isUnknown(facts[key]));
}

/**
 * First matching transition wins. Returns null when no condition matches, which
 * the engine treats as "we are not allowed to progress yet" -> clarification.
 */
export function selectTransition(
  step: ProtocolStep,
  context: EvaluationContext,
): { transition: Transition; index: number } | null {
  for (let index = 0; index < step.transitions.length; index += 1) {
    const transition = step.transitions[index]!;
    if (evaluateCondition(transition.when, context)) {
      return { transition, index };
    }
  }
  return null;
}

export function conditionsMet(conditions: Condition[], context: EvaluationContext): boolean {
  return conditions.every((condition) => evaluateCondition(condition, context));
}

/** Facts a condition depends on, recursively. */
export function referencedFacts(condition: Condition): string[] {
  if ('always' in condition) return [];
  if ('all' in condition) return condition.all.flatMap(referencedFacts);
  if ('any' in condition) return condition.any.flatMap(referencedFacts);
  if ('not' in condition) return referencedFacts(condition.not);
  return [condition.fact];
}

/**
 * The complete set of facts a protocol's conditions mention.
 *
 * Used for reporting, not for validating values: a fact being *mentioned* says
 * nothing about which values it may hold.
 */
export function protocolFacts(protocol: Protocol): Set<string> {
  const facts = new Set<string>();
  const walk = (condition: Condition): void => {
    for (const fact of referencedFacts(condition)) facts.add(fact);
  };
  for (const condition of protocol.entry_conditions) walk(condition);
  for (const condition of protocol.completion_conditions) walk(condition);
  for (const rule of protocol.escalation_rules) walk(rule.when);
  for (const step of protocol.steps) {
    for (const transition of step.transitions) walk(transition.when);
    for (const condition of step.completion_conditions) walk(condition);
    for (const fact of step.requires_facts) facts.add(fact);
  }
  return facts;
}

export interface FactValidation {
  accepted: ProtocolFacts;
  rejected: Array<{ fact: string; reason: string }>;
}

/**
 * Rejects fact values outside a closed, authoritative enumeration.
 *
 * `closed` must come from a declared enumeration — the extraction contract's
 * enums are the only source in this system — and a fact absent from it is
 * unbounded and always accepted.
 *
 * Why not derive the vocabulary from the protocol's own condition values, which
 * is the obvious thing to try: it is unsound. `cpr_started eq YES` is the only
 * condition on `cpr_started` in the cardiac-arrest catalogue, so the protocol's
 * literals are `{YES}` — yet "NO" is a perfectly meaningful answer to "are you
 * pushing on the chest?", and rejecting it would strand the caller on a step whose
 * loop is capped at two repeats. Likewise `scene_safe ne YES` does not mean the
 * allowed values are `{YES}`. A protocol states which values it tests against, not
 * which values exist, so treating its literals as exhaustive would make the engine
 * assert clinical meaning it was never given. Only a declared enum is exhaustive.
 *
 * The failure this guards against is real, though: `ne` and `not_in` evaluate to
 * true for any *known* value the protocol did not enumerate, so a hallucinated
 * token ("YESSS", "GASPING_AGAINS") reads as an established fact and satisfies
 * `scene_safe ne YES` — firing the scene-safety escalation and halting the call on
 * nonsense.
 *
 * A rejected value is dropped rather than repaired. Dropping leaves the fact
 * unset, so the engine asks the caller again, which is the right outcome for a
 * value nobody can vouch for. Repairing it would mean guessing which value was
 * meant, and a repair table is exactly where invented clinical meaning creeps in.
 */
export function validateObservedFacts(
  observed: ProtocolFacts,
  closed: Map<string, ReadonlySet<string>>,
): FactValidation {
  const accepted: ProtocolFacts = {};
  const rejected: FactValidation['rejected'] = [];

  for (const [fact, value] of Object.entries(observed)) {
    if (isUnknown(value)) {
      // Not a rejection: "unknown" is a legitimate answer and already means "ask
      // again". Recording it as rejected would bury the real rejects in noise.
      continue;
    }
    const allowed = closed.get(fact);
    if (allowed === undefined || typeof value !== 'string') {
      accepted[fact] = value;
      continue;
    }
    if (allowed.has(value.toUpperCase())) {
      accepted[fact] = value;
      continue;
    }
    rejected.push({
      fact,
      reason: `'${value}' is not a declared value for '${fact}' (allowed: ${[...allowed].join(', ')})`,
    });
  }

  return { accepted, rejected };
}

/**
 * Three-valued question: is this condition *definitively* false, given only the
 * facts that are actually known?
 *
 * The distinction matters for protocol entry. A cardiac-arrest protocol
 * requires `breathing_status` and `responsive`, and its first step
 * (`confirm-arrest`) exists precisely to establish them. Treating "not yet
 * observed" as "entry refused" makes that step unreachable and blocks triage
 * exactly when a bystander has only just called. But a caller who *has*
 * reported that the patient is breathing and talking has genuinely
 * contradicted the entry condition, and that must still be refused.
 *
 * So: unknown -> not definitive. Known and false -> definitive.
 */
export function isDefinitivelyFalse(condition: Condition, facts: ProtocolFacts): boolean {
  if ('always' in condition) return false;
  if ('all' in condition) return condition.all.some((c) => isDefinitivelyFalse(c, facts));
  if ('any' in condition) return condition.any.every((c) => isDefinitivelyFalse(c, facts));
  if ('not' in condition) {
    // `not X` is false when X is definitively true.
    if (referencedFacts(condition.not).some((fact) => isUnknown(facts[fact]))) return false;
    return evaluateCondition(condition, {
      facts,
      now: new Date(0),
      sessionStartedAt: new Date(0),
      repeatCount: 0,
    });
  }
  if (isUnknown(facts[condition.fact])) return false;
  return !evaluateCondition(condition, {
    facts,
    now: new Date(0),
    sessionStartedAt: new Date(0),
    repeatCount: 0,
  });
}

/** Entry conditions that known facts actively contradict. */
export function contradictedEntryConditions(conditions: Condition[], facts: ProtocolFacts): Condition[] {
  return conditions.filter((condition) => isDefinitivelyFalse(condition, facts));
}

/** Engine-injected facts that protocols may reference but callers cannot set. */
export function withEngineFacts(facts: ProtocolFacts, now: Date, sessionStartedAt: Date): ProtocolFacts {
  return {
    ...facts,
    elapsed_minutes: Math.round(((now.getTime() - sessionStartedAt.getTime()) / 60000) * 10) / 10,
  };
}
