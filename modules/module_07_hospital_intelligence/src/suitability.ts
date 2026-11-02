import {
  type HospitalCapability,
  type HospitalResourceType,
  type HospitalWithResources,
  type IncidentType,
  haversineKm,
} from '@resus/core';
import type { Module7Config } from './config.js';

/**
 * What a given incident needs from a receiving hospital.
 *
 * This table is a deterministic routing aid, not clinical advice. It maps the
 * system's own `IncidentType` vocabulary onto the `HospitalCapability` and
 * `HospitalResourceType` vocabularies that Module 11 seeds, and every choice is
 * explained in the returned `matchingFactors`. The `resourceType` is the hard
 * gate: the seed deliberately marks a closer hospital BUSY with no free ICU to
 * prove a hospital with no ICU capacity is unsuitable for a cardiac arrest
 * regardless of how close it is (see the Module 11 seed).
 */
export interface IncidentRequirement {
  capability: HospitalCapability;
  resourceType: HospitalResourceType;
}

const REQUIREMENTS: Record<IncidentType, IncidentRequirement> = {
  CARDIAC_ARREST: { capability: 'ED_CARDIAC', resourceType: 'ICU_BED' },
  CHEST_PAIN: { capability: 'ED_CARDIAC', resourceType: 'ICU_BED' },
  STROKE: { capability: 'NEUROSURGERY', resourceType: 'ICU_BED' },
  TRAUMA: { capability: 'ED_TRAUMA', resourceType: 'EMERGENCY_BED' },
  SEVERE_BLEEDING: { capability: 'ED_TRAUMA', resourceType: 'EMERGENCY_BED' },
  SEVERE_BREATHING_DIFFICULTY: { capability: 'RESPIRATORY', resourceType: 'EMERGENCY_BED' },
  OVERDOSE: { capability: 'POISON_CONTROL', resourceType: 'EMERGENCY_BED' },
  CHOKING: { capability: 'GENERAL', resourceType: 'EMERGENCY_BED' },
  UNCONSCIOUS: { capability: 'GENERAL', resourceType: 'EMERGENCY_BED' },
  SEIZURE: { capability: 'GENERAL', resourceType: 'EMERGENCY_BED' },
  ALLERGIC_REACTION: { capability: 'GENERAL', resourceType: 'EMERGENCY_BED' },
  UNSAFE_SCENE: { capability: 'GENERAL', resourceType: 'EMERGENCY_BED' },
  OTHER: { capability: 'GENERAL', resourceType: 'EMERGENCY_BED' },
};

export function requirementFor(incidentType: IncidentType): IncidentRequirement {
  return REQUIREMENTS[incidentType] ?? REQUIREMENTS.OTHER;
}

export interface ScoredHospital {
  hospital: HospitalWithResources;
  distanceKm: number;
  score: number;
  eligible: boolean;
  rejectReason: string | null;
  matchingFactors: string[];
}

function availableUnits(hospital: HospitalWithResources, resourceType: HospitalResourceType): number {
  let units = 0;
  for (const resource of hospital.resources) {
    if (resource.resourceType === resourceType && resource.available > 0) {
      units += resource.available;
    }
  }
  return units;
}

function distancePoints(distanceKm: number, config: Module7Config): number {
  for (const band of config.scoring.distanceBands) {
    if (distanceKm <= band.maxKm) return band.points;
  }
  return 0;
}

/**
 * Scores one hospital for one incident.
 *
 * Eligibility is a hard gate on data that already exists: the hospital must be
 * accepting emergencies, not CLOSED, within `maxDistanceKm`, and have at least
 * one free unit of the resource the incident requires. Capability and distance
 * then rank the eligible hospitals. Nothing here invents capability, bed
 * availability or travel time - it only reads what Module 11 holds.
 */
export function scoreHospital(
  hospital: HospitalWithResources,
  incident: { incidentType: IncidentType; latitude: number; longitude: number },
  config: Module7Config,
): ScoredHospital {
  const requirement = requirementFor(incident.incidentType);
  const distanceKm = haversineKm(
    { latitude: incident.latitude, longitude: incident.longitude },
    { latitude: hospital.latitude, longitude: hospital.longitude },
  );

  const matchingFactors: string[] = [];
  let rejectReason: string | null = null;

  if (hospital.status === 'CLOSED') {
    rejectReason = 'hospital is closed';
  } else if (!hospital.acceptingEmergencies) {
    rejectReason = 'hospital is not accepting emergencies';
  } else if (distanceKm > config.maxDistanceKm) {
    rejectReason = `beyond ${config.maxDistanceKm} km`;
  }

  const units = availableUnits(hospital, requirement.resourceType);
  if (!rejectReason && units <= 0) {
    rejectReason = `no ${requirement.resourceType} available`;
  }

  const eligible = rejectReason === null;

  let score = 0;
  if (eligible) {
    if (hospital.capabilities.includes(requirement.capability)) {
      score += config.scoring.capabilityMatch;
      matchingFactors.push(`has ${requirement.capability}`);
    }
    score += config.scoring.resourceAvailable;
    matchingFactors.push(`${requirement.resourceType} available`);
    score += config.scoring.acceptingEmergencies;
    matchingFactors.push('accepting emergencies');
    const band = distancePoints(distanceKm, config);
    if (band > 0) {
      score += band;
      matchingFactors.push(`within ${config.maxDistanceKm} km`);
    }
  }

  return {
    hospital,
    distanceKm,
    score,
    eligible,
    rejectReason,
    matchingFactors,
  };
}
