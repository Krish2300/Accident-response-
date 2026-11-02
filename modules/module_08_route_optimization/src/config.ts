/**
 * Module 8 - Route Optimization configuration.
 *
 * Every value has a conservative default so the module is safe to construct with
 * no environment at all (tests, the simulation harness). The default provider is
 * the deterministic `mock`, which never calls an external service and is labelled
 * `isLiveTraffic: false` everywhere a route is recorded.
 */

export type RoutingProviderKind = 'mock' | 'osrm' | 'google';

export interface Module8Config {
  /** Which routing provider plans routes. `osrm` falls back to `mock` when unreachable. */
  provider: RoutingProviderKind;
  /** Free-flow speed assumed by the deterministic provider (km/h). */
  averageSpeedKmh: number;
  osrm: {
    baseUrl: string;
    timeoutMs: number;
  };
  google: {
    /** Server-side Routes API key. Never expose this value in logs or clients. */
    apiKey: string | null;
    timeoutMs: number;
  };
  /**
   * Event-driven automatic route generation. When enabled *and* the composition
   * root injects the event bus, Module 8 reacts to explicit ambulance dispatch
   * and hospital selection and plans the corresponding leg. Additive: with no
   * bus injected nothing is subscribed.
   */
  generation: {
    enabled: boolean;
    /** Off by default; simulation emergencies are driven by the harness. */
    includeSimulation: boolean;
  };
}

export function loadModule8Config(env: NodeJS.ProcessEnv = process.env): Module8Config {
  const provider: RoutingProviderKind =
    env.MODULE8_PROVIDER === 'osrm' || env.MODULE8_PROVIDER === 'google'
      ? env.MODULE8_PROVIDER
      : 'mock';
  const googleApiKey = env.MODULE8_GOOGLE_API_KEY?.trim() || null;
  const configuredGoogleTimeout = Number(env.MODULE8_GOOGLE_TIMEOUT_MS ?? 8000);
  const googleTimeoutMs = Number.isFinite(configuredGoogleTimeout)
    ? configuredGoogleTimeout
    : 8000;
  if (provider === 'google' && !googleApiKey) {
    throw new Error('MODULE8_GOOGLE_API_KEY is required when MODULE8_PROVIDER=google.');
  }
  if (provider === 'google' && (!Number.isInteger(configuredGoogleTimeout) || googleTimeoutMs < 100 || googleTimeoutMs > 60_000)) {
    throw new Error('MODULE8_GOOGLE_TIMEOUT_MS must be between 100 and 60000 when Google routing is enabled.');
  }
  return {
    provider,
    averageSpeedKmh: Number(env.MODULE8_AVERAGE_SPEED_KMH ?? 60),
    osrm: {
      baseUrl: env.MODULE8_OSRM_BASE_URL ?? 'http://router.project-osrm.org',
      timeoutMs: Number(env.MODULE8_OSRM_TIMEOUT_MS ?? 8000),
    },
    google: { apiKey: googleApiKey, timeoutMs: googleTimeoutMs },
    generation: {
      // Automatic route generation is opt-in. Missing or malformed values fail closed.
      enabled: env.MODULE8_AUTO_ROUTE_ENABLED?.toLowerCase() === 'true',
      includeSimulation: Boolean(env.MODULE8_AUTO_ROUTE_SIMULATION === 'true'),
    },
  };
}
