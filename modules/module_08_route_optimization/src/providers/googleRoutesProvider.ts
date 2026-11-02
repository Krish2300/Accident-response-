import { isValidCoordinate, type Coordinate, type RouteCandidate, type RouteRequest, type RouteResult, type RoutingProvider } from '@resus/core';
import { RoutingProviderError } from './routingProviderError.js';

export const GOOGLE_ROUTES_PROVIDER_NAME = 'google-routes';
export const GOOGLE_ROUTES_COMPUTE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline,routes.fallbackInfo';
const MAX_ENCODED_POLYLINE_LENGTH = 1_000_000;
const MAX_POLYLINE_POINTS = 50_000;

interface GoogleRoute {
  distanceMeters?: unknown;
  duration?: unknown;
  staticDuration?: unknown;
  polyline?: { encodedPolyline?: unknown };
  fallbackInfo?: unknown;
}

export interface GoogleRoutesProviderOptions {
  /** Google Routes API key; injected by server-side configuration only. */
  apiKey: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

function parseSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function decodePolyline(encoded: string): Array<[number, number]> {
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_POLYLINE_LENGTH) {
    throw new RoutingProviderError('Google route had no usable encoded geometry.', GOOGLE_ROUTES_PROVIDER_NAME);
  }
  const points: Array<[number, number]> = [];
  let index = 0;
  let latitudeE5 = 0;
  let longitudeE5 = 0;

  const readDelta = (): number => {
    let result = 0;
    let shift = 0;
    let chunk: number;
    do {
      if (index >= encoded.length || shift > 30) {
        throw new RoutingProviderError('Google route geometry was malformed.', GOOGLE_ROUTES_PROVIDER_NAME);
      }
      const code = encoded.charCodeAt(index++);
      chunk = code - 63;
      if (chunk < 0 || chunk > 63) {
        throw new RoutingProviderError('Google route geometry was malformed.', GOOGLE_ROUTES_PROVIDER_NAME);
      }
      result |= (chunk & 0x1f) << shift;
      shift += 5;
    } while (chunk >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    latitudeE5 += readDelta();
    longitudeE5 += readDelta();
    const point: Coordinate = { latitude: latitudeE5 / 1e5, longitude: longitudeE5 / 1e5 };
    if (!isValidCoordinate(point)) {
      throw new RoutingProviderError('Google route geometry contained an out-of-range coordinate.', GOOGLE_ROUTES_PROVIDER_NAME);
    }
    points.push([point.latitude, point.longitude]);
    if (points.length > MAX_POLYLINE_POINTS) {
      throw new RoutingProviderError('Google route geometry exceeded the point limit.', GOOGLE_ROUTES_PROVIDER_NAME);
    }
  }

  if (points.length < 2) {
    throw new RoutingProviderError('Google route geometry contained fewer than two points.', GOOGLE_ROUTES_PROVIDER_NAME);
  }
  return points;
}

/**
 * Server-side provider for Google Routes API Compute Routes.
 *
 * Traffic provenance is true only when the request asked Google for a
 * traffic-aware route and the response supplied a usable `duration` without
 * `fallbackInfo`. Otherwise a usable static duration is preferred and marked
 * non-live; no duration is inferred from a different source.
 */
export class GoogleRoutesProvider implements RoutingProvider {
  readonly providerName = GOOGLE_ROUTES_PROVIDER_NAME;
  readonly isLive = true;
  /** Capability flag only; each response's traffic provenance is per-route. */
  readonly isLiveTraffic = true;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleRoutesProviderOptions) {
    this.apiKey = options.apiKey.trim();
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!this.apiKey) throw new Error('GoogleRoutesProvider requires an API key.');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error('GoogleRoutesProvider timeout must be between 100 and 60000 milliseconds.');
    }
    if (typeof this.fetchImpl !== 'function') throw new Error('GoogleRoutesProvider requires fetch.');
  }

  async route(request: RouteRequest): Promise<RouteResult> {
    if (!isValidCoordinate(request.origin) || !isValidCoordinate(request.destination)) {
      throw new RoutingProviderError('Google route endpoints were out of range.', this.providerName);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_ROUTES_COMPUTE_ROUTES_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          origin: { location: { latLng: request.origin } },
          destination: { location: { latLng: request.destination } },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          computeAlternativeRoutes: false,
          polylineQuality: 'OVERVIEW',
          units: 'METRIC',
        }),
      });
    } catch (error) {
      const aborted = controller.signal.aborted || (error as Error)?.name === 'AbortError';
      throw new RoutingProviderError(
        aborted ? `Google Routes API timed out after ${this.timeoutMs}ms.` : 'Google Routes API is unreachable.',
        this.providerName,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const reason = response.status === 429 ? 'rate limited' : `HTTP ${response.status}`;
      throw new RoutingProviderError(`Google Routes API returned ${reason}.`, this.providerName);
    }

    let body: { routes?: unknown };
    try {
      body = await response.json() as { routes?: unknown };
    } catch {
      throw new RoutingProviderError('Google Routes API response was not valid JSON.', this.providerName);
    }
    const routes = Array.isArray(body?.routes) ? body.routes : [];
    const routeValue: unknown = routes[0];
    if (routeValue === undefined) {
      throw new RoutingProviderError('Google Routes API returned no route.', this.providerName);
    }
    if (typeof routeValue !== 'object' || routeValue === null || Array.isArray(routeValue)) {
      throw new RoutingProviderError('Google Routes API returned malformed route data.', this.providerName);
    }
    const route = routeValue as GoogleRoute;

    const distanceMeters = route.distanceMeters;
    if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters) || distanceMeters < 0) {
      throw new RoutingProviderError('Google route had no usable distance.', this.providerName);
    }
    if (typeof route.polyline?.encodedPolyline !== 'string') {
      throw new RoutingProviderError('Google route had no usable encoded geometry.', this.providerName);
    }
    const geometry = decodePolyline(route.polyline.encodedPolyline);

    const trafficSeconds = parseSeconds(route.duration);
    const staticSeconds = parseSeconds(route.staticDuration);
    const hasFallback = route.fallbackInfo !== undefined && route.fallbackInfo !== null;
    const isLiveTraffic = trafficSeconds !== null && !hasFallback;
    const selectedSeconds = isLiveTraffic ? trafficSeconds : (staticSeconds ?? trafficSeconds);
    if (selectedSeconds === null) {
      throw new RoutingProviderError('Google route had no usable duration.', this.providerName);
    }

    const selected: RouteCandidate = {
      distanceKm: distanceMeters / 1000,
      estimatedMinutes: selectedSeconds / 60,
      geometry,
      // Google does not expose this system's free-flow multiplier. Preserve it as unknown.
      trafficFactor: null,
    };
    return {
      providerName: this.providerName,
      isLiveTraffic,
      selected,
      alternatives: [],
      selectionReason: isLiveTraffic
        ? 'Google Routes API driving route; duration returned for a traffic-aware request.'
        : 'Google Routes API driving route; traffic-aware duration unavailable or provider fallback indicated.',
    };
  }
}
