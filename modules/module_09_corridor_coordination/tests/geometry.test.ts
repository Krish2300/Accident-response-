import { describe, expect, it } from 'vitest';
import {
  buildCorridorGeofence,
  distanceM,
  distancePointToPathM,
  distancePointToSegmentM,
  isWithinCorridor,
  metersPerDegreeLongitude,
  pathLengthM,
  pointAtFraction,
  resamplePath,
} from '../src/geometry.js';

describe('Module 9 geometry — metre-based corridor buffer', () => {
  it('measures a straight segment in metres, not degrees', () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 0, longitude: 0.01 };

    // 0.01 degrees of longitude at the equator is ~1112 m, not 0.01 m.
    expect(distanceM(a, b)).toBeGreaterThan(1100);
    expect(distanceM(a, b)).toBeLessThan(1125);

    const onLine = { latitude: 0, longitude: 0.005 };
    expect(distancePointToSegmentM(onLine, a, b)).toBeCloseTo(0, 3);

    const offLine = { latitude: 0.001, longitude: 0.005 };
    // 0.001 degrees of latitude is ~111 m.
    expect(distancePointToSegmentM(offLine, a, b)).toBeGreaterThan(105);
    expect(distancePointToSegmentM(offLine, a, b)).toBeLessThan(115);
  });

  it('accounts for latitude when converting longitude to metres', () => {
    const equator = metersPerDegreeLongitude(0);
    const high = metersPerDegreeLongitude(60);
    // cos(60°) = 0.5, so a degree of longitude is half as wide at 60°.
    expect(high / equator).toBeCloseTo(0.5, 2);

    const a = { latitude: 60, longitude: 0 };
    const b = { latitude: 60, longitude: 0.01 };
    expect(distanceM(a, b)).toBeGreaterThan(550);
    expect(distanceM(a, b)).toBeLessThan(562);
  });

  it('has no gaps between multi-segment route points', () => {
    // An L-shaped route: east along the equator, then north.
    const path = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.01 },
      { latitude: 0.01, longitude: 0.01 },
    ];

    // A point on the second (north) segment, midway — a per-vertex box would
    // see a gap here, segment distance does not.
    const onNorthLeg = { latitude: 0.005, longitude: 0.01 };
    expect(distancePointToPathM(onNorthLeg, path)).toBeCloseTo(0, 2);

    // Near the inside corner, the closest feature is one of the legs.
    const nearCorner = { latitude: 0.005, longitude: 0.005 };
    // ~556 m from both legs (0.005° ≈ 556 m).
    expect(distancePointToPathM(nearCorner, path)).toBeGreaterThan(540);
    expect(distancePointToPathM(nearCorner, path)).toBeLessThan(570);

    // A geofence of 600 m captures it; 500 m does not.
    const wide = buildCorridorGeofence(path, 600);
    const narrow = buildCorridorGeofence(path, 500);
    expect(isWithinCorridor(nearCorner, wide)).toBe(true);
    expect(isWithinCorridor(nearCorner, narrow)).toBe(false);
  });

  it('clamps the projection to the segment, so points beyond an endpoint use it', () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 0, longitude: 0.01 };
    // A point far to the east measures to the endpoint b, not to its projection.
    const beyond = { latitude: 0, longitude: 0.02 };
    const toB = distanceM(beyond, b);
    expect(distancePointToSegmentM(beyond, a, b)).toBeCloseTo(toB, 3);
  });

  it('resamples a path so no two consecutive points are further apart than the spacing', () => {
    const path = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.02 },
    ];
    const spacing = 100; // metres
    const dense = resamplePath(path, spacing);
    expect(dense.length).toBeGreaterThan(2);
    for (let i = 0; i < dense.length - 1; i += 1) {
      expect(distanceM(dense[i]!, dense[i + 1]!)).toBeLessThanOrEqual(spacing + 1);
    }
    // Endpoints are preserved.
    expect(dense[0]).toEqual(path[0]);
    expect(dense[dense.length - 1]).toEqual(path[1]);
  });

  it('rejects an empty or invalid path rather than inventing geometry', () => {
    expect(() => buildCorridorGeofence([], 100)).toThrow();
    expect(() => buildCorridorGeofence([{ latitude: 999, longitude: 0 }], 100)).toThrow();
    expect(() => buildCorridorGeofence([{ latitude: 0, longitude: 0 }], 0)).toThrow();
  });

  it('measures path length and interpolates a point at a fraction of it', () => {
    const path = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.01 },
    ];
    const total = pathLengthM(path);
    expect(total).toBeGreaterThan(1100);

    const mid = pointAtFraction(path, 0.5);
    expect(mid.longitude).toBeCloseTo(0.005, 6);

    expect(pointAtFraction(path, 0).longitude).toBeCloseTo(0, 6);
    expect(pointAtFraction(path, 1).longitude).toBeCloseTo(0.01, 6);
    // Out-of-range fractions clamp.
    expect(pointAtFraction(path, 2).longitude).toBeCloseTo(0.01, 6);
  });
});
