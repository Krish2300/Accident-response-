/**
 * Module 7 - Hospital Intelligence configuration.
 *
 * Every value here has a conservative default so the module is safe to construct
 * without any environment at all (tests, the simulation harness).
 */

export interface Module7Config {
  /** Hospitals farther than this are not candidates, regardless of capability. */
  maxDistanceKm: number;
  /**
   * Event-driven automatic selection. When enabled *and* the composition root
   * injects the event bus and an emergency read/write port, Module 7 reacts to
   * `EMERGENCY_CLASSIFIED` by scoring the seeded hospitals and recording the
   * choice. Additive: with no bus injected nothing is subscribed.
   */
  autoSelect: {
    enabled: boolean;
    /** Off by default; simulation emergencies are driven by the harness. */
    includeSimulation: boolean;
  };
  scoring: {
    /** Hospital declares the capability the incident needs. */
    capabilityMatch: number;
    /** The resource the incident needs has at least one unit free. */
    resourceAvailable: number;
    /** Hospital is currently accepting emergencies. */
    acceptingEmergencies: number;
    /** Distance bands, highest first: [maxKm, points]. */
    distanceBands: Array<{ maxKm: number; points: number }>;
  };
}

export function loadModule7Config(): Module7Config {
  return {
    maxDistanceKm: Number(process.env.MODULE7_MAX_DISTANCE_KM ?? 30),
    autoSelect: {
      // Automatic selection is opt-in. Missing or malformed values fail closed.
      enabled: process.env.MODULE7_AUTO_SELECT_ENABLED?.toLowerCase() === 'true',
      includeSimulation: Boolean(process.env.MODULE7_AUTO_SELECT_SIMULATION === 'true'),
    },
    scoring: {
      capabilityMatch: Number(process.env.MODULE7_SCORE_CAPABILITY ?? 40),
      resourceAvailable: Number(process.env.MODULE7_SCORE_RESOURCE ?? 30),
      acceptingEmergencies: Number(process.env.MODULE7_SCORE_ACCEPTING ?? 30),
      distanceBands: [
        { maxKm: 5, points: 30 },
        { maxKm: 10, points: 20 },
        { maxKm: 20, points: 10 },
      ],
    },
  };
}
