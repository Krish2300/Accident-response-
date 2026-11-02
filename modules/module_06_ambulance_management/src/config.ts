/**
 * Module 6 - Ambulance Management configuration.
 */

export interface Module6Config {
  fleet: {
    maxStaleLocationMinutes: number;
    maxAmbulances: number;
    defaultAverageSpeedKmh: number;
    trafficFactor: number;
  };
  assignment: {
    timeoutMs: number;
    offerTtlMs: number;
    maxRetries: number;
    minConfidenceScore: number;
    enableManualOverride: boolean;
  };
  dispatch: {
    timeoutMs: number;
    requireValidLocation: boolean;
  };
  simulation: {
    enabled: boolean;
    updateIntervalMs: number;
  };
  /**
   * Event-driven automatic assignment (legacy config name retained).
   *
   * When enabled *and* the composition root injects the event bus and an
   * emergency read port, Module 6 reacts to `EMERGENCY_CREATED` /
   * `EMERGENCY_CLASSIFIED` by running its existing assignment engine. It does
   * not call the explicit dispatch operation. This is
   * additive: the manual `POST /api/ambulances/assign` endpoint is unchanged, and
   * with no bus injected (tests, the simulation harness) nothing is subscribed.
   */
  autoDispatch: {
    enabled: boolean;
    /**
     * Off by default. Simulation emergencies are driven by the simulation
     * harness, so automatic assignment must not race it unless explicitly asked.
     */
    includeSimulation: boolean;
  };
}

export function loadModule6Config(): Module6Config {
  const configuredOfferTtl = Number(process.env.MODULE6_OFFER_TTL_MS ?? 60_000);
  const offerTtlMs = Number.isFinite(configuredOfferTtl) && configuredOfferTtl > 0 ? configuredOfferTtl : 60_000;
  return {
    fleet: {
      maxStaleLocationMinutes: Number(process.env.MODULE6_MAX_STALE_LOCATION_MIN ?? 10),
      maxAmbulances: Number(process.env.MODULE6_MAX_AMBULANCES ?? 50),
      defaultAverageSpeedKmh: Number(process.env.MODULE6_DEFAULT_SPEED_KMH ?? 40),
      trafficFactor: Number(process.env.MODULE6_TRAFFIC_FACTOR ?? 1.25),
    },
    assignment: {
      timeoutMs: Number(process.env.MODULE6_ASSIGN_TIMEOUT_MS ?? 5000),
      offerTtlMs,
      maxRetries: Number(process.env.MODULE6_ASSIGN_MAX_RETRIES ?? 3),
      minConfidenceScore: Number(process.env.MODULE6_MIN_SCORE ?? 0.3),
      enableManualOverride: Boolean(process.env.MODULE6_ALLOW_MANUAL_OVERRIDE !== 'false'),
    },
    dispatch: {
      timeoutMs: Number(process.env.MODULE6_DISPATCH_TIMEOUT_MS ?? 5000),
      requireValidLocation: Boolean(process.env.MODULE6_REQUIRE_VALID_LOCATION !== 'false'),
    },
    simulation: {
      enabled: Boolean(process.env.MODULE6_SIMULATION_ENABLED === 'true'),
      updateIntervalMs: Number(process.env.MODULE6_SIMULATION_INTERVAL_MS ?? 2000),
    },
    autoDispatch: {
      // Automatic assignment is opt-in. Missing, malformed, or explicitly false
      // values all keep the event-driven subscriber disabled.
      enabled: process.env.MODULE6_AUTO_DISPATCH_ENABLED?.toLowerCase() === 'true',
      includeSimulation: Boolean(process.env.MODULE6_AUTO_DISPATCH_SIMULATION === 'true'),
    },
  };
}
