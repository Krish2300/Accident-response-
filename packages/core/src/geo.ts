/**
 * Geographical helpers.
 *
 * The prototype has no routing provider (no Google/Mapbox key, no paid API), so
 * travel times are *estimates* derived from great-circle distance and an average
 * speed. Every such value is labelled as an estimate at the API boundary.
 */

export interface Coordinate {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres (haversine). */
export function haversineKm(a: Coordinate, b: Coordinate): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidCoordinate(value: unknown): value is Coordinate {
  if (typeof value !== 'object' || value === null) return false;
  const { latitude, longitude } = value as Partial<Coordinate>;
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * Linear interpolation along the great-circle path between two points.
 * Adequate for city-scale incident response; not a substitute for routing.
 */
export function interpolate(a: Coordinate, b: Coordinate, t: number): Coordinate {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * clamped,
    longitude: a.longitude + (b.longitude - a.longitude) * clamped,
  };
}

/** Estimated road travel time in minutes. */
export function estimateTravelMinutes(
  distanceKm: number,
  averageSpeedKmh: number,
  trafficFactor = 1.25,
): number {
  if (averageSpeedKmh <= 0) return Number.POSITIVE_INFINITY;
  return (distanceKm / averageSpeedKmh) * 60 * trafficFactor;
}

/**
 * Bounding-box based pre-filter. Avoids haversine for the whole fleet when a
 * cheap index-like test is enough.
 */
export function withinRadiusKm(
  a: Coordinate,
  b: Coordinate,
  radiusKm: number,
): boolean {
  const latDelta = toRad(b.latitude - a.latitude);
  const lngDelta = toRad(b.longitude - a.longitude);
  const latKm = EARTH_RADIUS_KM * latDelta;
  const lngKm = EARTH_RADIUS_KM * lngDelta * Math.cos(toRad((a.latitude + b.latitude) / 2));
  return Math.sqrt(latKm ** 2 + lngKm ** 2) <= radiusKm;
}
