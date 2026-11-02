/**
 * Module 9 - Corridor coordination configuration.
 *
 * Every value has a conservative default so the module is safe to construct with
 * no environment at all (tests, the simulation harness). There is no real
 * traffic-signal, road-user feed or notification integration in this repository,
 * so the only `priorityMode` any configuration can select is `SIMULATED`.
 */

export interface Module9Config {
  /**
   * Event-driven corridor coordination. When enabled *and* the composition root
   * injects the event bus, Module 9 reacts to a hospital being selected and a
   * transport route being generated and activates the corridor automatically.
   * Additive: with no bus injected nothing is subscribed.
   */
  enabled: boolean;
  /** Corridor half-width in metres. The geofence used to find road users to warn. */
  radiusM: number;
  /** Off by default; simulation emergencies are driven by the harness. */
  includeSimulation: boolean;
  /**
   * How many simulated road users the deterministic provider places along a
   * corridor. Each is labelled as simulated in the persisted record.
   */
  maxSimulatedRoadUsers: number;
}

export function loadModule9Config(): Module9Config {
  return {
    // Automatic corridor coordination is opt-in. Missing or malformed values fail closed.
    enabled: process.env.MODULE9_CORRIDOR_ENABLED?.toLowerCase() === 'true',
    radiusM: Number(process.env.MODULE9_CORRIDOR_RADIUS_M ?? 150),
    includeSimulation: process.env.MODULE9_CORRIDOR_SIMULATION === 'true',
    maxSimulatedRoadUsers: Number(process.env.MODULE9_SIMULATED_ROAD_USERS ?? 3),
  };
}
