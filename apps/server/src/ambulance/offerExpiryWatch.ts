import type { Logger } from '@resus/core';

export const DEFAULT_AMBULANCE_OFFER_EXPIRY_SWEEP_MS = 5_000;

export interface AmbulanceOfferExpiryWatch {
  stop(): Promise<void>;
}

/**
 * Expires outstanding driver offers while the server is running. The repository
 * performs each expiry and its audit event transactionally. Ticks never overlap,
 * and shutdown waits for an in-flight sweep before the database is closed.
 */
export function startAmbulanceOfferExpiryWatch(deps: {
  expireDueOffers: () => Promise<unknown>;
  logger: Logger;
  intervalMs?: number;
}): AmbulanceOfferExpiryWatch {
  const intervalMs = deps.intervalMs ?? DEFAULT_AMBULANCE_OFFER_EXPIRY_SWEEP_MS;
  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = deps.expireDueOffers()
      .then(() => undefined)
      .catch(() => {
        // Avoid logging database/provider error details that might include
        // connection information. The repository operation remains retryable.
        deps.logger.error('ambulance offer expiry sweep failed');
      })
      .finally(() => { inFlight = undefined; });
  }, intervalMs);

  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await inFlight;
    },
  };
}
