/**
 * Runtime defaults: id generation, clock and a framework-agnostic logger.
 * Kept dependency-free so `packages/core` can be imported by the browser bundle.
 */
import type { Clock, Logger } from './ports.js';

let counter = 0;

/** Prefixed, sortable-ish identifier, e.g. `AMB-7F3A91C2B4`. */
export function createId(prefix: string): string {
  counter = (counter + 1) % 0xffff;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}-${rand.toUpperCase()}${counter.toString(16).toUpperCase().padStart(4, '0')}`;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

/** Controllable clock for deterministic tests. */
export class FixedClock implements Clock {
  constructor(private current: Date = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  nowIso(): string {
    return this.current.toISOString();
  }
  set(date: Date | string): void {
    this.current = typeof date === 'string' ? new Date(date) : date;
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Minimal structured logger; `apps/server` adapts it to Fastify/pino. */
export function createConsoleLogger(
  level: Level = 'info',
  scope = 'app',
): Logger {
  const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[level];
  const emit = (lvl: Level, obj: unknown, msg?: string) => {
    if (order[lvl] < threshold) return;
    const line = { scope, level: lvl, ...(msg ? { msg } : {}), ...(obj as object) };
    // eslint-disable-next-line no-console
    console[lvl === 'debug' ? 'log' : lvl](JSON.stringify(line));
  };
  return {
    debug: (o, m) => emit('debug', o, m),
    info: (o, m) => emit('info', o, m),
    warn: (o, m) => emit('warn', o, m),
    error: (o, m) => emit('error', o, m),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function minutesBetween(from: string | Date, to: string | Date): number {
  const a = typeof from === 'string' ? Date.parse(from) : from.getTime();
  const b = typeof to === 'string' ? Date.parse(to) : to.getTime();
  return (b - a) / 60000;
}

export function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}
