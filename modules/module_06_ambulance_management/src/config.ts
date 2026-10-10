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
}

export function loadModule6Config(): Module6Config {
  return {
    fleet: {
      maxStaleLocationMinutes: Number(process.env.MODULE6_MAX_STALE_LOCATION_MIN ?? 10),
      maxAmbulances: Number(process.env.MODULE6_MAX_AMBULANCES ?? 50),
      defaultAverageSpeedKmh: Number(process.env.MODULE6_DEFAULT_SPEED_KMH ?? 40),
      trafficFactor: Number(process.env.MODULE6_TRAFFIC_FACTOR ?? 1.25),
    },
    assignment: {
      timeoutMs: Number(process.env.MODULE6_ASSIGN_TIMEOUT_MS ?? 5000),
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
  };
}
