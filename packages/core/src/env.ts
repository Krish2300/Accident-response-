/**
 * Minimal typed access to `process.env`.
 *
 * Every module reads configuration through these helpers so that defaults,
 * coercion and validation live in one place. `dotenv` is loaded exactly once by
 * the composition root (`apps/server/src/main.ts`) and by the vitest setup file.
 */

export function readString(key: string, fallback?: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return raw;
}

export function readOptionalString(key: string): string | undefined {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? undefined : raw;
}

export function readNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, received '${raw}'.`);
  }
  return parsed;
}

export function readBoolean(key: string, fallback = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const normalised = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
  throw new Error(`Environment variable ${key} must be a boolean, received '${raw}'.`);
}

export function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Environment variable ${key} must be one of ${allowed.join(', ')}.`);
  }
  return raw as T;
}
