/**
 * Module 10 – Structured Logger
 * Pino-based, JSON output in production.
 */

import pino from 'pino';

const baseOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'module-10-orchestrator', version: process.env.npm_package_version },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * `pino-pretty` is an optional development dependency of this legacy package.
 * When it is not installed the pretty transport target cannot be resolved and
 * `pino()` throws at import time, which would fail every test that touches the
 * disconnected FSM. Fall back to structured JSON output instead.
 */
function buildLogger() {
  if (process.env.NODE_ENV === 'production') return pino(baseOptions);
  try {
    return pino({ ...baseOptions, transport: { target: 'pino-pretty', options: { colorize: true } } });
  } catch {
    return pino(baseOptions);
  }
}

export const logger = buildLogger();
