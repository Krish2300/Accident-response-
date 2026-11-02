/**
 * Module 9 - corridor geometry.
 *
 * The corridor is a *buffered polyline*: a centre line (the ambulance's planned
 * route) widened by a half-width in metres. A point is "inside the corridor"
 * when its distance to the nearest centre-line **segment** is within that
 * half-width. Using segment distance (rather than testing each route vertex
 * separately) means a multi-segment route has no gaps between its points, which
 * is exactly the failure mode a per-vertex bounding box has.
 *
 * All distances are computed in metres on a local tangent plane centred on the
 * segment under test. Because the plane is re-centred per segment, the metre
 * conversion stays correct at any latitude (a degree of longitude is much
 * shorter near the poles), which a fixed degrees-per-metre constant would get
 * wrong.
 */

import { haversineKm, isValidCoordinate, type Coordinate } from '@resus/core';

/** Mean Earth radius in metres (matches `haversineKm`'s 6371.0088 km). */
export const EARTH_RADIUS_M = 6371008.8;
/** Metres per degree of latitude (constant on a sphere). */
export const METERS_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS_M;
/** Default spacing used when resampling a centre line, in metres. */
export const DEFAULT_RESAMPLE_SPACING_M = 25;

export interface CorridorGeofence {
  /** Resampled centre line; consecutive points are no further apart than `spacingM`. */
  centreLine: Coordinate[];
  /** Corridor half-width in metres. */
  radiusM: number;
}

function isValidPath(path: readonly Coordinate[]): boolean {
  return path.length > 0 && path.every((point) => isValidCoordinate(point));
}

/**
 * Local planar projection (metres east/north of a reference point).
 *
 * Accurate for city-scale distances; the reference latitude controls how a
 * degree of longitude is scaled so the projection is correct at the segment's
 * latitude rather than only at the equator.
 */
function toLocalMetres(point: Coordinate, refLat: number, refLng: number): { x: number; y: number } {
  const lngScale = METERS_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  return {
    x: (point.longitude - refLng) * lngScale,
    y: (point.latitude - refLat) * METERS_PER_DEG_LAT,
  };
}

/** Metres per degree of longitude at the given latitude. Exposed for tests. */
export function metersPerDegreeLongitude(latitude: number): number {
  return METERS_PER_DEG_LAT * Math.cos((latitude * Math.PI) / 180);
}

/** Great-circle distance between two points, in metres. */
export function distanceM(a: Coordinate, b: Coordinate): number {
  return haversineKm(a, b) * 1000;
}

/**
 * Shortest distance from `point` to the line segment `a`-`b`, in metres.
 * Projects onto a local plane centred at `a`, clamps the projection parameter to
 * the segment, then measures the residual.
 */
export function distancePointToSegmentM(point: Coordinate, a: Coordinate, b: Coordinate): number {
  const p = toLocalMetres(point, a.latitude, a.longitude);
  const start = { x: 0, y: 0 };
  const end = toLocalMetres(b, a.latitude, a.longitude);

  const abx = end.x - start.x;
  const aby = end.y - start.y;
  const ab2 = abx * abx + aby * aby;

  let t = ab2 === 0 ? 0 : ((p.x - start.x) * abx + (p.y - start.y) * aby) / ab2;
  t = Math.max(0, Math.min(1, t));

  const closestX = start.x + t * abx;
  const closestY = start.y + t * aby;
  return Math.hypot(p.x - closestX, p.y - closestY);
}

/** Shortest distance from `point` to the whole polyline, in metres. */
export function distancePointToPathM(point: Coordinate, path: readonly Coordinate[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return distanceM(point, path[0]!);

  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < path.length - 1; i += 1) {
    const d = distancePointToSegmentM(point, path[i]!, path[i + 1]!);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Subdivides each segment so consecutive points are no further apart than
 * `spacingM`, interpolating linearly in lat/lng (adequate at city scale).
 *
 * This keeps the *stored* centre line dense enough that a naive, point-only
 * consumer also sees no gaps. Detection itself uses segment distance and does
 * not depend on the spacing.
 */
export function resamplePath(path: readonly Coordinate[], spacingM: number): Coordinate[] {
  if (!isValidPath(path)) {
    throw new Error('resamplePath requires a non-empty path of valid coordinates.');
  }
  if (path.length === 1) return [{ ...path[0]! }];

  const maxSpacing = spacingM > 0 ? spacingM : DEFAULT_RESAMPLE_SPACING_M;
  const out: Coordinate[] = [{ ...path[0]! }];

  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const segmentM = distanceM(a, b);
    const steps = Math.max(1, Math.ceil(segmentM / maxSpacing));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      out.push({
        latitude: a.latitude + (b.latitude - a.latitude) * t,
        longitude: a.longitude + (b.longitude - a.longitude) * t,
      });
    }
  }
  return out;
}

/**
 * Builds the corridor geofence from a planned route's polyline.
 *
 * @throws when the path is empty or contains out-of-range coordinates, so a
 * fabricated or malformed route can never silently produce a corridor.
 */
export function buildCorridorGeofence(path: readonly Coordinate[], radiusM: number): CorridorGeofence {
  if (!isValidPath(path)) {
    throw new Error('Cannot build a corridor from an empty or invalid route geometry.');
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new Error('Corridor radius must be a positive number of metres.');
  }
  const spacing = Math.min(radiusM, DEFAULT_RESAMPLE_SPACING_M) || DEFAULT_RESAMPLE_SPACING_M;
  return { centreLine: resamplePath(path, spacing), radiusM };
}

/** True when `point` lies within the corridor half-width of the centre line. */
export function isWithinCorridor(point: Coordinate, geofence: CorridorGeofence): boolean {
  return distancePointToPathM(point, geofence.centreLine) <= geofence.radiusM;
}

/** Total centre-line length in metres. */
export function pathLengthM(path: readonly Coordinate[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    total += distanceM(path[i]!, path[i + 1]!);
  }
  return total;
}

/**
 * Returns the point at `t` (0..1) of the polyline's length. Used to place
 * simulated road users deterministically along a corridor.
 */
export function pointAtFraction(path: readonly Coordinate[], t: number): Coordinate {
  if (path.length === 0) throw new Error('pointAtFraction requires a non-empty path.');
  if (path.length === 1) return { ...path[0]! };
  const clamped = Math.max(0, Math.min(1, t));
  const target = pathLengthM(path) * clamped;

  let travelled = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const segmentM = distanceM(a, b);
    if (travelled + segmentM >= target) {
      const local = segmentM === 0 ? 0 : (target - travelled) / segmentM;
      return {
        latitude: a.latitude + (b.latitude - a.latitude) * local,
        longitude: a.longitude + (b.longitude - a.longitude) * local,
      };
    }
    travelled += segmentM;
  }
  return { ...path[path.length - 1]! };
}
