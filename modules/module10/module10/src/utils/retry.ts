/**
 * Module 10 – Retry Utility
 */

import { logger } from './logger';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  module:      string;
  jitter?:     boolean;
}

/**
 * Exponential back-off with optional jitter.
 * Throws on exhaustion.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.maxAttempts) break;

      const delay = opts.baseDelayMs * Math.pow(2, attempt - 1)
        + (opts.jitter !== false ? Math.random() * opts.baseDelayMs : 0);

      logger.warn(
        `[Retry][${opts.module}] Attempt ${attempt}/${opts.maxAttempts} failed: ${err}. ` +
        `Retrying in ${Math.round(delay)}ms…`,
      );
      await sleep(delay);
    }
  }

  throw lastErr;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Logger stub – replace with winston / pino in production.
 */
export { logger } from './logger';
