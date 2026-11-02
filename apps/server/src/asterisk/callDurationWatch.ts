import type { Logger } from '@resus/core';

/** How often the runtime asks Module 1 to close calls that ran past the limit. */
export const DEFAULT_CALL_DURATION_SWEEP_MS = 60_000;

export interface CallDurationWatchDeps {
  /**
   * Module 1's `enforceMaxDuration`.
   *
   * `notBefore` is passed straight through: the guard against closing calls that
   * predate the watch lives inside that method, so it applies to every caller,
   * not just this scheduler.
   */
  enforce: (now: Date, notBefore?: Date) => Promise<unknown>;
  intervalMs?: number;
  logger: Logger;
  /** Injectable clock; the watermark and each tick's "now" come from it. */
  now?: () => Date;
}

export interface CallDurationWatch {
  /** The instant the watch began; sessions started before it are never touched. */
  readonly notBefore: Date;
  stop(): void;
}

/**
 * Schedules Module 1's maximum-call-duration enforcement.
 *
 * The watch captures the moment it started and passes it as `notBefore` on every
 * sweep, so a call that was already open when the process booted cannot be
 * closed by this scheduler. That is what keeps a restart from mass-ending the
 * long-lived ACTIVE rows a previous crash may have left behind — those are a
 * separate, deliberate reconciliation concern.
 *
 * A sweep that is still running when the next tick fires is skipped rather than
 * stacked, so a slow store cannot build a backlog of overlapping queries.
 */
export function startCallDurationWatch(deps: CallDurationWatchDeps): CallDurationWatch {
  const clock = deps.now ?? (() => new Date());
  const notBefore = clock();
  const intervalMs = deps.intervalMs ?? DEFAULT_CALL_DURATION_SWEEP_MS;

  let inFlight = false;
  let stopped = false;

  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    inFlight = true;
    void deps
      .enforce(clock(), notBefore)
      .catch((error: unknown) => {
        deps.logger.error(
          { reason: (error as Error).message },
          'maximum call duration sweep failed',
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  // A sweep must not keep the server alive on its own.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    notBefore,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
