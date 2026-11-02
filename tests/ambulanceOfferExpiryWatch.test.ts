import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@resus/core';
import {
  DEFAULT_AMBULANCE_OFFER_EXPIRY_SWEEP_MS,
  startAmbulanceOfferExpiryWatch,
} from '../apps/server/src/ambulance/offerExpiryWatch.js';

describe('ambulance offer expiry watch', () => {
  it('sweeps on its interval and uses the configured default', async () => {
    vi.useFakeTimers();
    try {
      const expireDueOffers = vi.fn(async () => 1);
      const watch = startAmbulanceOfferExpiryWatch({ expireDueOffers, logger: noopLogger, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(expireDueOffers).toHaveBeenCalledTimes(1);
      await watch.stop();
      expect(DEFAULT_AMBULANCE_OFFER_EXPIRY_SWEEP_MS).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overlap sweeps and waits for in-flight work on shutdown', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const expireDueOffers = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      const watch = startAmbulanceOfferExpiryWatch({ expireDueOffers, logger: noopLogger, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(expireDueOffers).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopping = watch.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a sanitized failure and retries on a later tick', async () => {
    vi.useFakeTimers();
    try {
      const logger = { ...noopLogger, error: vi.fn() };
      const expireDueOffers = vi.fn().mockRejectedValueOnce(new Error('database URL contains secret'))
        .mockResolvedValue(0);
      const watch = startAmbulanceOfferExpiryWatch({ expireDueOffers, logger, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(expireDueOffers).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith('ambulance offer expiry sweep failed');
      await watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
