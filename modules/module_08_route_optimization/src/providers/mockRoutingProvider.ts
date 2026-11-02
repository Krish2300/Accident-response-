import {
  haversineKm,
  type RouteCandidate,
  type RouteRequest,
  type RouteResult,
  type RoutingProvider,
} from '@resus/core';

export const MOCK_ROUTING_PROVIDER_NAME = 'mock';

/**
 * Deterministic development routing provider.
 *
 * Distance is the great-circle (haversine) distance and travel time is that
 * distance at a fixed average speed. It deliberately does not pretend to be
 * traffic-aware: `isLive` and `isLiveTraffic` are both false, and the selection
 * reason says so in words a dispatcher can read. This is the provider behind
 * every route the system produces unless a real provider is explicitly enabled.
 */
export class MockRoutingProvider implements RoutingProvider {
  readonly providerName = MOCK_ROUTING_PROVIDER_NAME;
  readonly isLive = false;
  readonly isLiveTraffic = false;

  constructor(private readonly averageSpeedKmh: number) {}

  async route(request: RouteRequest): Promise<RouteResult> {
    const speedKmh = this.averageSpeedKmh > 0 ? this.averageSpeedKmh : 60;
    const distanceKm = haversineKm(request.origin, request.destination);
    const estimatedMinutes = (distanceKm / speedKmh) * 60;

    const candidate: RouteCandidate = {
      distanceKm,
      estimatedMinutes,
      // Core geometry is ordered [lat, lng] to match Module 11's stored polyline.
      geometry: [
        [request.origin.latitude, request.origin.longitude],
        [request.destination.latitude, request.destination.longitude],
      ],
      trafficFactor: 1,
    };

    return {
      providerName: this.providerName,
      isLiveTraffic: false,
      selected: candidate,
      alternatives: [],
      selectionReason:
        'Straight-line (great-circle) distance at a fixed average speed — a deterministic estimate, not a traffic-aware road route.',
    };
  }
}
