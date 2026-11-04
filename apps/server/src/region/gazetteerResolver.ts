import { findSabarimalaPlace } from '@resus/core';
import type { CallerLocationLookup, CallerLocationResolver } from '../conversation/callerLocationResolution.js';

/**
 * Offline caller-location resolver for the Sabarimala region.
 *
 * Matches landmark names (English transliterations and Malayalam script) from
 * the regional gazetteer. Results are recorded as location *candidates*; an
 * operator or police officer confirms them through the existing
 * location-resolution routes, so a mis-heard place name never silently moves
 * an emergency.
 */
export class SabarimalaGazetteerResolver implements CallerLocationResolver {
  readonly providerName = 'sabarimala-gazetteer';

  async resolve(locationText: string): Promise<CallerLocationLookup> {
    const match = findSabarimalaPlace(locationText);
    if (!match) return { outcome: 'NOT_FOUND' };
    return {
      outcome: 'CANDIDATE',
      latitude: match.place.latitude,
      longitude: match.place.longitude,
      confidence: match.confidence,
    };
  }
}
