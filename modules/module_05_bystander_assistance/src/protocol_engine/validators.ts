import { AppError, ErrorCode, isValidCoordinate } from '@resus/core';
import { entitiesSchema, type Entities } from '../llm/contracts.js';

/**
 * Input validation for everything entering the protocol engine.
 *
 * The engine is authoritative but it is not credulous: caller-supplied facts are
 * schema-checked, geometry is checked, and free text is length-bounded before it
 * can influence a transition.
 */

export interface ValidatedTurnInput {
  facts: Record<string, unknown>;
  utterance: string | null;
  isFinal: boolean;
}

const MAX_UTTERANCE = 4000;

export function validateTurnInput(input: {
  facts?: unknown;
  utterance?: unknown;
  isFinal?: unknown;
}): ValidatedTurnInput {
  const facts: Record<string, unknown> = {};

  if (input.facts !== undefined && input.facts !== null) {
    if (typeof input.facts !== 'object' || Array.isArray(input.facts)) {
      throw AppError.validation('`facts` must be an object of protocol fact values.');
    }
    for (const [key, value] of Object.entries(input.facts as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) {
        throw AppError.validation(`Fact key '${key}' is not a valid protocol fact name.`);
      }
      facts[key] = sanitiseValue(value);
    }
  }

  let utterance: string | null = null;
  if (input.utterance !== undefined && input.utterance !== null) {
    if (typeof input.utterance !== 'string') {
      throw AppError.validation('`utterance` must be a string of what the bystander said.');
    }
    if (input.utterance.length > MAX_UTTERANCE) {
      throw AppError.validation(`Utterance exceeds ${MAX_UTTERANCE} characters.`, { length: input.utterance.length });
    }
    utterance = input.utterance.trim() || null;
  }

  return {
    facts,
    utterance,
    isFinal: input.isFinal === undefined ? true : Boolean(input.isFinal),
  };
}

function sanitiseValue(value: unknown): unknown {
  if (value === null || value === undefined) return 'UNKNOWN';
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'UNKNOWN';
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitiseValue);
  return 'UNKNOWN';
}

/** Validates the LLM's entity block, dropping anything that fails the schema. */
export function validateEntities(input: unknown): Entities {
  const parsed = entitiesSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      ErrorCode.LLM_OUTPUT_SCHEMA_VIOLATION,
      'Extracted entities did not match the expected schema.',
      502,
      { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    );
  }
  return parsed.data;
}

export function validateEmergencyLocation(input: unknown): { latitude: number; longitude: number } {
  if (!isValidCoordinate(input)) {
    throw AppError.validation('Emergency latitude/longitude are required and must be in range.');
  }
  return { latitude: input.latitude, longitude: input.longitude };
}

/** Guards the clarification budget so a confused caller cannot loop forever. */
export function assertClarificationBudget(clarificationCount: number, max: number): void {
  if (clarificationCount >= max) {
    throw new AppError(
      ErrorCode.CLARIFICATION_LIMIT_REACHED,
      `The assistant has already asked ${clarificationCount} clarifying questions. Escalate to a human operator.`,
      409,
      { clarificationCount, max },
    );
  }
}
