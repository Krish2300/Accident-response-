import type {
  RouteCandidate,
  RouteRequest,
  RouteResult,
  RoutingProvider,
} from '@resus/core';
import { RoutingProviderError } from './routingProviderError.js';

export const OSRM_ROUTING_PROVIDER_NAME = 'osrm';

interface OsrmRoute {
  geometry?: { coordinates?: unknown };
  distance?: unknown;
  duration?: unknown;
}

interface OsrmResponse {
  code?: unknown;
  message?: unknown;
  routes?: unknown;
}

export interface OsrmRoutingProviderOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Routing provider backed by an OSRM HTTP server.
 *
 * OSRM returns real road geometry and travel durations, so `isLive` is true.
 * It is **not** traffic-aware: the public and stock OSRM profiles use static
 * speed profiles, so `isLiveTraffic` stays false and the recorded route is never
 * presented as traffic-aware (see Module 11 `Route.isLiveTraffic`).
 *
 * This provider is opt-in (`MODULE8_PROVIDER=osrm`). Every failure is raised as
 * a `RoutingProviderError` so the service can fall back to the deterministic
 * provider rather than record a route it could not compute.
 */
export class OsrmRoutingProvider implements RoutingProvider {
  readonly providerName = OSRM_ROUTING_PROVIDER_NAME;
  readonly isLive = true;
  readonly isLiveTraffic = false;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OsrmRoutingProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('OsrmRoutingProvider requires a fetch implementation.');
    }
  }

  async route(request: RouteRequest): Promise<RouteResult> {
    const { origin, destination } = request;
    const url =
      `${this.baseUrl}/route/v1/driving/` +
      `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}` +
      '?overview=full&geometries=geojson';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      const aborted = controller.signal.aborted || (error as Error)?.name === 'AbortError';
      throw new RoutingProviderError(
        aborted
          ? `OSRM did not respond within ${this.timeoutMs}ms.`
          : `OSRM is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        this.providerName,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new RoutingProviderError(`OSRM returned HTTP ${response.status}.`, this.providerName);
    }

    let body: OsrmResponse;
    try {
      body = (await response.json()) as OsrmResponse;
    } catch {
      throw new RoutingProviderError('OSRM response was not valid JSON.', this.providerName);
    }

    if (body.code !== 'Ok') {
      throw new RoutingProviderError(
        `OSRM routing failed: code=${String(body.code)}, message=${String(body.message ?? 'unknown')}`,
        this.providerName,
      );
    }

    const routes = Array.isArray(body.routes) ? (body.routes as OsrmRoute[]) : [];
    const route = routes[0];
    if (!route) {
      throw new RoutingProviderError('OSRM response contained no route.', this.providerName);
    }

    const coordinates = route.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new RoutingProviderError('OSRM route had no usable geometry.', this.providerName);
    }

    const geometry = coordinates.map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) {
        throw new RoutingProviderError('OSRM geometry contained a malformed position.', this.providerName);
      }
      const [lng, lat] = pair as [unknown, unknown];
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        throw new RoutingProviderError('OSRM geometry contained a non-numeric position.', this.providerName);
      }
      // OSRM emits [lng, lat]; the system stores [lat, lng].
      return [lat, lng] as [number, number];
    });

    const distanceKm = typeof route.distance === 'number' ? route.distance / 1000 : Number.NaN;
    const estimatedMinutes = typeof route.duration === 'number' ? route.duration / 60 : Number.NaN;
    if (!Number.isFinite(distanceKm) || !Number.isFinite(estimatedMinutes)) {
      throw new RoutingProviderError('OSRM route had no usable distance or duration.', this.providerName);
    }

    const candidate: RouteCandidate = {
      distanceKm,
      estimatedMinutes,
      geometry,
      trafficFactor: 1,
    };

    return {
      providerName: this.providerName,
      isLiveTraffic: false,
      selected: candidate,
      alternatives: [],
      selectionReason: 'Road route from OSRM (static speed profile; not traffic-aware).',
    };
  }
}
