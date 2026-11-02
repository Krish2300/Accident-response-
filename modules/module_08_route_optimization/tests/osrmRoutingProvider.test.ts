import { describe, expect, it, vi } from 'vitest';
import {
  OsrmRoutingProvider,
  OSRM_ROUTING_PROVIDER_NAME,
} from '../src/providers/osrmRoutingProvider.js';
import { RoutingProviderError } from '../src/providers/routingProviderError.js';

const request = {
  origin: { latitude: 12.97, longitude: 77.59 },
  destination: { latitude: 13.0, longitude: 77.65 },
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const okBody = {
  code: 'Ok',
  routes: [
    {
      distance: 12000,
      duration: 1500,
      geometry: {
        coordinates: [
          [77.59, 12.97],
          [77.62, 12.985],
          [77.65, 13.0],
        ],
      },
    },
  ],
};

function provider(fetchImpl: typeof fetch, timeoutMs = 8000): OsrmRoutingProvider {
  return new OsrmRoutingProvider({ baseUrl: 'http://osrm.test/', timeoutMs, fetchImpl });
}

describe('OsrmRoutingProvider', () => {
  it('returns valid geometry, distance and duration, converted to [lat,lng]', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody)) as unknown as typeof fetch;
    const result = await provider(fetchImpl).route(request);

    expect(OSRM_ROUTING_PROVIDER_NAME).toBe('osrm');
    expect(result.providerName).toBe('osrm');
    expect(result.isLiveTraffic).toBe(false);
    // OSRM returns metres/seconds; the system stores km/minutes.
    expect(result.selected.distanceKm).toBeCloseTo(12, 5);
    expect(result.selected.estimatedMinutes).toBeCloseTo(25, 5);
    // Coordinates are reordered from OSRM's [lng,lat] to the system's [lat,lng].
    expect(result.selected.geometry).toEqual([
      [12.97, 77.59],
      [12.985, 77.62],
      [13.0, 77.65],
    ]);
    const calledUrl = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain('/route/v1/driving/77.59,12.97;77.65,13');
  });

  it('raises a timeout error when the server does not answer in time', async () => {
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    await expect(provider(fetchImpl as unknown as typeof fetch, 20).route(request)).rejects.toMatchObject({
      name: 'RoutingProviderError',
      providerName: 'osrm',
    });
  });

  it('treats an unreachable service as a provider error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5000');
    });
    await expect(provider(fetchImpl as unknown as typeof fetch).route(request)).rejects.toBeInstanceOf(
      RoutingProviderError,
    );
    await expect(provider(fetchImpl as unknown as typeof fetch).route(request)).rejects.toThrow(
      /unreachable/i,
    );
  });

  it('rejects a non-OK HTTP status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    await expect(provider(fetchImpl as unknown as typeof fetch).route(request)).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('rejects a body that is not valid JSON', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) as unknown as Response);
    await expect(provider(fetchImpl as unknown as typeof fetch).route(request)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('rejects an OSRM error code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 'NoRoute', message: 'no route found' }),
    );
    await expect(provider(fetchImpl as unknown as typeof fetch).route(request)).rejects.toThrow(
      /NoRoute/,
    );
  });

  it('rejects a response with no routes', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 'Ok', routes: [] }));
    await expect(provider(fetchImpl as unknown as typeof fetch).route(request)).rejects.toThrow(
      /no route/i,
    );
  });

  it('rejects a route with unusable geometry', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 'Ok', routes: [{ distance: 1000, duration: 60, geometry: { coordinates: [[77.59, 12.97]] } }] }),
    );
    await expect(provider(fetchImpl as unknown as typeof fetch).route(request)).rejects.toThrow(
      /geometry/i,
    );
  });

  it('rejects a route with a malformed geometry position', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        code: 'Ok',
        routes: [{ distance: 1000, duration: 60, geometry: { coordinates: [[77.59, 12.97], ['x']] } }],
      }),
    );
    await expect(provider(fetchImpl as unknown as typeof fetch).route(request)).rejects.toThrow(
      /malformed position/i,
    );
  });

  it('rejects a route with no usable distance or duration', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        code: 'Ok',
        routes: [
          {
            geometry: {
              coordinates: [
                [77.59, 12.97],
                [77.65, 13.0],
              ],
            },
          },
        ],
      }),
    );
    await expect(provider(fetchImpl as unknown as typeof fetch).route(request)).rejects.toThrow(
      /distance or duration/i,
    );
  });
});
