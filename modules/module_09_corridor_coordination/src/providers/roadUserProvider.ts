/**
 * Module 9 - simulated road users.
 *
 * There is no live traffic feed in this repository, so Module 9 cannot honestly
 * claim to detect real people. This provider returns a *deterministic* set of
 * simulated users placed along the corridor centre line: the same path and
 * radius always yields the same users, nothing is sampled from a live source,
 * and every user is explicitly flagged `simulated: true` and prefixed `SIM-RU`.
 *
 * A real deployment would replace this with a provider that subscribes to a
 * traffic feed and reports `isLive: true`; nothing else in Module 9 changes.
 */

import type { Coordinate, RoadUser, RoadUserProvider } from '@resus/core';
import {
  distancePointToPathM,
  METERS_PER_DEG_LAT,
  metersPerDegreeLongitude,
  pointAtFraction,
} from '../geometry.js';

export const MOCK_ROAD_USER_PROVIDER_NAME = 'mock-road-user';

/** A `RoadUser` that is explicitly labelled as simulated in every record. */
export type SimulatedRoadUser = RoadUser & { simulated: true };

export interface MockRoadUserProviderOptions {
  /** Maximum number of simulated users placed along a corridor. */
  maxUsers?: number;
}

/** Shifts a coordinate by a metre offset in the local east/north plane. */
function offsetCoordinate(origin: Coordinate, eastM: number, northM: number): Coordinate {
  const lngScale = metersPerDegreeLongitude(origin.latitude);
  return {
    latitude: origin.latitude + northM / METERS_PER_DEG_LAT,
    longitude: origin.longitude + (lngScale === 0 ? 0 : eastM / lngScale),
  };
}

const KINDS: RoadUser['kind'][] = ['VEHICLE', 'PEDESTRIAN', 'CYCLIST'];

export class MockRoadUserProvider implements RoadUserProvider {
  readonly providerName = MOCK_ROAD_USER_PROVIDER_NAME;
  /** Never a real feed. No consumer may present these as detected people. */
  readonly isLive = false;

  private readonly maxUsers: number;

  constructor(options: MockRoadUserProviderOptions = {}) {
    const max = options.maxUsers ?? 3;
    this.maxUsers = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  }

  async detectNear(
    path: Coordinate[],
    radiusM: number,
    _ambulancePosition: Coordinate | null,
  ): Promise<SimulatedRoadUser[]> {
    if (path.length === 0 || this.maxUsers === 0 || !(radiusM > 0)) return [];

    const users: SimulatedRoadUser[] = [];
    for (let i = 0; i < this.maxUsers; i += 1) {
      // Deterministic, evenly spaced fractions with a deterministic side offset.
      const fraction = (i + 1) / (this.maxUsers + 1);
      const anchor = pointAtFraction(path, fraction);
      const side = i % 2 === 0 ? 1 : -1;
      const position = offsetCoordinate(anchor, side * radiusM * 0.3, 0);
      const distance = distancePointToPathM(position, path);
      if (distance > radiusM) continue;

      users.push({
        id: `SIM-RU-${String(i + 1).padStart(4, '0')}`,
        kind: KINDS[i % KINDS.length]!,
        latitude: position.latitude,
        longitude: position.longitude,
        distanceToCorridorM: Number(distance.toFixed(1)),
        headingDeg: null,
        speedKmh: null,
        simulated: true,
      });
    }
    return users;
  }
}
