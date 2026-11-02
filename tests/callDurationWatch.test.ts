import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@resus/core';
import {
  DEFAULT_CALL_DURATION_SWEEP_MS,
  startCallDurationWatch,
} from '../apps/server/src/asterisk/callDurationWatch.js';

/**
 * Maximum-call-duration scheduler tests.
 *
 * The watch is the only place a running server enforces the configured call cap.
 * These drive it with fake timers so the interval behaviour — the watermark it
 * passes, the overlap guard and shutdown — is provable without a real clock.
 */

describe('call duration watch', () => {
  it('sweeps on an interval and passes the watch start as the notBefore watermark', async () => {
    vi.useFakeTimers();
    try {
      const start = new Date('2026-01-01T00:00:00.000Z');
      const sweeps: Array<{ now: Date; notBefore?: Date }> = [];
      const watch = startCallDurationWatch({
        enforce: async (now, notBefore) => {
          sweeps.push({ now, notBefore });
        },
        intervalMs: 1_000,
        logger: noopLogger,
        now: () => start,
      });

      expect(watch.notBefore.getTime()).toBe(start.getTime());
      expect(sweeps).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweeps).toHaveLength(1);
      // The watermark is the instant the watch began, applied to every sweep.
      expect(sweeps[0]!.notBefore?.getTime()).toBe(start.getTime());
      expect(sweeps[0]!.now.getTime()).toBe(start.getTime());

      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops sweeping once stopped', async () => {
    vi.useFakeTimers();
    try {
      const enforce = vi.fn(async () => undefined);
      const watch = startCallDurationWatch({
        enforce,
        intervalMs: 1_000,
        logger: noopLogger,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(enforce).toHaveBeenCalledTimes(1);

      watch.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(enforce).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a tick while the previous sweep is still running', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const enforce = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const watch = startCallDurationWatch({
        enforce,
        intervalMs: 1_000,
        logger: noopLogger,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(enforce).toHaveBeenCalledTimes(1);

      // The first sweep has not resolved; the next tick must not stack on it.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(enforce).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(enforce).toHaveBeenCalledTimes(2);

      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a failing sweep and keeps sweeping', async () => {
    vi.useFakeTimers();
    try {
      const enforce = vi.fn(async () => {
        throw new Error('store unavailable');
      });
      const watch = startCallDurationWatch({
        enforce,
        intervalMs: 1_000,
        logger: noopLogger,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(enforce).toHaveBeenCalledTimes(2);

      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults the sweep interval to one minute', () => {
    expect(DEFAULT_CALL_DURATION_SWEEP_MS).toBe(60_000);
  });
});
