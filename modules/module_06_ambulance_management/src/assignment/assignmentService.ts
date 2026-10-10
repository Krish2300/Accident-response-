import { type Logger, haversineKm, noopLogger, estimateTravelMinutes } from '@resus/core';
import type { FleetService, Candidate } from '../fleetService.js';
import type { Module6Config } from '../config.js';

export interface AssignmentServiceDeps {
  fleet: FleetService;
  config: Module6Config;
  logger?: Logger;
}

export interface AssignmentCriteria {
  emergencyId: string;
  latitude: number;
  longitude: number;
  requiredEquipment?: string[];
  requiredCapabilities?: string[];
  maxDistanceKm?: number;
}

export interface AssignmentResult {
  ambulanceId: string;
  assignmentId: string;
  distanceKm: number;
  estimatedResponseTimeMin: number;
  score: number;
  consideredCandidates: number;
  matchingFactors: string[];
}

export class AssignmentService {
  private readonly fleet: FleetService;
  private readonly config: Module6Config;
  private readonly logger: Logger;

  constructor(deps: AssignmentServiceDeps) {
    this.fleet = deps.fleet;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  async selectAndAssign(criteria: AssignmentCriteria): Promise<AssignmentResult> {
    const candidates = await this.fleet.findNearestAmbulances({
      latitude: criteria.latitude,
      longitude: criteria.longitude,
      statuses: ['AVAILABLE'],
    });

    if (candidates.length === 0) {
      throw new Error('No available ambulances found');
    }

    let eligible = candidates;
    if (criteria.maxDistanceKm !== undefined && criteria.maxDistanceKm > 0) {
      eligible = candidates.filter((c) => c.distanceKm <= criteria.maxDistanceKm!);
    }

    if (eligible.length === 0) {
      throw new Error('No ambulances within distance threshold');
    }

    const best = eligible[0];
    if (!best) {
      throw new Error('No suitable ambulance found');
    }
    const score = this.calculateScore(best, eligible.length);

    const assignment = await this.fleet.assignAmbulance({
      emergencyId: criteria.emergencyId,
      ambulanceId: best.ambulance.id,
      distanceKm: best.distanceKm,
      estimatedResponseTimeMin: estimateTravelMinutes(
        best.distanceKm,
        this.config.fleet.defaultAverageSpeedKmh,
        this.config.fleet.trafficFactor,
      ),
      score,
      matchingFactors: ['nearest', 'available'],
      rejectedReasons: {},
      source: 'AUTOMATIC',
      consideredCandidates: candidates.length,
    });

    return {
      ambulanceId: best.ambulance.id,
      assignmentId: assignment.id,
      distanceKm: best.distanceKm,
      estimatedResponseTimeMin: assignment.estimatedResponseTimeMin,
      score,
      consideredCandidates: candidates.length,
      matchingFactors: assignment.matchingFactors,
    };
  }

  private calculateScore(candidate: Candidate, total: number): number {
    const baseScore = 1.0 - Math.min(candidate.distanceKm / 50, 0.9);
    return Math.max(this.config.assignment.minConfidenceScore, baseScore);
  }
}
