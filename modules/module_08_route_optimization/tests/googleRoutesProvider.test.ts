import { describe, expect, it, vi } from 'vitest';
import {
  GoogleRoutesProvider,
  GOOGLE_ROUTES_COMPUTE_ROUTES_URL,
  GOOGLE_ROUTES_PROVIDER_NAME,
} from '../src/providers/googleRoutesProvider.js';
import { RoutingProviderError } from '../src/providers/routingProviderError.js';

const request = {
  origin: { latitude: 12.97, longitude: 77.59 },
  destination: { latitude: 13, longitude: 77.65 },
};
const encodedPolyline = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function provider(fetchImpl: typeof fetch, timeoutMs = 8000): GoogleRoutesProvider {
  return new GoogleRoutesProvider({ apiKey: 'server-test-key', timeoutMs, fetchImpl });
}

const validRoute = {
  routes: [{
    distanceMeters: 12_000,
    duration: '1500s',
    staticDuration: '1200s',
    polyline: { encodedPolyline },
  }],
};

describe('GoogleRoutesProvider', () => {
  it('constructs an explicit traffic-aware driving request and parses route facts', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validRoute)) as unknown as typeof fetch;
    const result = await provider(fetchImpl).route(request);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;

    expect(url).toBe(GOOGLE_ROUTES_COMPUTE_ROUTES_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'X-Goog-Api-Key': 'server-test-key',
      'X-Goog-FieldMask': expect.stringContaining('routes.duration'),
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      origin: { location: { latLng: request.origin } },
      destination: { location: { latLng: request.destination } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      computeAlternativeRoutes: false,
    });
    expect(String(init.body)).not.toContain('server-test-key');
    expect(result).toMatchObject({
      providerName: GOOGLE_ROUTES_PROVIDER_NAME,
      isLiveTraffic: true,
      selected: {
        distanceKm: 12,
        estimatedMinutes: 25,
        geometry: [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]],
        trafficFactor: null,
      },
    });
  });

  it('uses the static duration and marks traffic false when the traffic ETA is unavailable', async () => {
    const result = await provider(vi.fn(async () => jsonResponse({
      routes: [{ distanceMeters: 1500, staticDuration: '300s', polyline: { encodedPolyline } }],
    })) as unknown as typeof fetch).route(request);
    expect(result.selected.estimatedMinutes).toBe(5);
    expect(result.isLiveTraffic).toBe(false);
  });

  it('does not claim traffic provenance when Google reports a computation fallback', async () => {
    const result = await provider(vi.fn(async () => jsonResponse({
      routes: [{ ...validRoute.routes[0], fallbackInfo: { reason: 'ROUTING_PREFERENCE_UNAVAILABLE' } }],
    })) as unknown as typeof fetch).route(request);
    expect(result.selected.estimatedMinutes).toBe(20);
    expect(result.isLiveTraffic).toBe(false);
  });

  it('rejects invalid coordinates before making an HTTP request', async () => {
    const fetchImpl = vi.fn();
    await expect(provider(fetchImpl as unknown as typeof fetch).route({
      origin: { latitude: 91, longitude: 0 },
      destination: request.destination,
    })).rejects.toThrow(/out of range/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handles no-route, malformed JSON and malformed route data', async () => {
    await expect(provider(vi.fn(async () => jsonResponse({ routes: [] })) as unknown as typeof fetch).route(request))
      .rejects.toThrow(/no route/i);
    await expect(provider(vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })) as unknown as typeof fetch).route(request))
      .rejects.toThrow(/not valid JSON/);
    await expect(provider(vi.fn(async () => jsonResponse({ routes: [{ distanceMeters: 'bad', duration: '10s', polyline: { encodedPolyline } }] })) as unknown as typeof fetch).route(request))
      .rejects.toThrow(/distance/);
    await expect(provider(vi.fn(async () => jsonResponse({ routes: [{ distanceMeters: 1, duration: '10s', polyline: { encodedPolyline: '!' } }] })) as unknown as typeof fetch).route(request))
      .rejects.toThrow(/geometry/i);
    await expect(provider(vi.fn(async () => jsonResponse({ routes: [null] })) as unknown as typeof fetch).route(request))
      .rejects.toThrow(/malformed route data/i);
    await expect(provider(vi.fn(async () => jsonResponse({
      routes: [{ distanceMeters: 1, polyline: { encodedPolyline } }],
    })) as unknown as typeof fetch).route(request)).rejects.toThrow(/duration/i);
  });

  it.each([[401, /HTTP 401/], [403, /HTTP 403/], [429, /rate limited/]])(
    'surfaces HTTP %s without returning the configured key', async (status, expected) => {
      const apiKey = 'private-test-key';
      const google = new GoogleRoutesProvider({ apiKey, fetchImpl: vi.fn(async () => jsonResponse({}, Number(status))) as unknown as typeof fetch });
      let error: unknown;
      try { await google.route(request); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(RoutingProviderError);
      expect((error as Error).message).toMatch(expected as RegExp);
      expect((error as Error).message).not.toContain(apiKey);
    },
  );

  it('times out and does not leak an API key from fetch errors', async () => {
    const apiKey = 'private-test-key';
    const timeoutFetch = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    await expect(provider(timeoutFetch as typeof fetch, 100).route(request)).rejects.toThrow(/timed out/);

    const failingFetch = vi.fn(async () => { throw new Error(`fetch exposed ${apiKey}`); });
    const google = new GoogleRoutesProvider({ apiKey, fetchImpl: failingFetch as unknown as typeof fetch });
    let error: unknown;
    try { await google.route(request); } catch (caught) { error = caught; }
    expect((error as Error).message).toMatch(/unreachable/);
    expect((error as Error).message).not.toContain(apiKey);
  });
});
