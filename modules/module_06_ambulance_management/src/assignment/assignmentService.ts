import { AppError, ErrorCode, type Logger, noopLogger, estimateTravelMinutes } from '@resus/core';
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
  decidedByUserId?: string | null;
}

export interface AssignmentResult {
  ambulanceId: string;
  assignmentId: string;
  distanceKm: number;
  estimatedResponseTimeMin: number;
  score: number;
  consideredCandidates: number;
  matchingFactors: string[];
  offeredAt: string | null;
  expiresAt: string | null;
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
    await this.fleet.expireDueOffers();
    const existing = await this.fleet.getAssignmentsForEmergency(criteria.emergencyId);
    const currentOffer = existing.find((item) => item.status === 'OFFERED');
    if (currentOffer) return this.resultFromOffer(currentOffer);
    if (existing.some((item) => ['ASSIGNED', 'ACCEPTED', 'DISPATCHED'].includes(item.status))) {
      throw new AppError(ErrorCode.CONFLICT, 'This emergency already has an active ambulance assignment.', 409);
    }
    const previouslyDeclinedOrExpired = new Set(
      existing
        .filter((item) => ['DECLINED', 'EXPIRED', 'CANCELLED'].includes(item.status))
        .map((item) => item.ambulanceId),
    );
    const candidates = await this.fleet.findNearestAmbulances({
      latitude: criteria.latitude,
      longitude: criteria.longitude,
      statuses: ['AVAILABLE'],
      excludeIds: [...previouslyDeclinedOrExpired],
    });

    if (candidates.length === 0) {
      throw new AppError(ErrorCode.AMBULANCE_NOT_AVAILABLE, 'No eligible available ambulances found for this emergency.', 409);
    }

    let eligible = candidates;
    if (criteria.maxDistanceKm !== undefined && criteria.maxDistanceKm > 0) {
      eligible = candidates.filter((c) => c.distanceKm <= criteria.maxDistanceKm!);
    }

    if (eligible.length === 0) {
      throw new AppError(ErrorCode.AMBULANCE_NOT_AVAILABLE, 'No eligible ambulances are within the configured distance threshold.', 409);
    }

    const best = eligible[0];
    if (!best) {
      throw new AppError(ErrorCode.AMBULANCE_NOT_AVAILABLE, 'No eligible ambulance could be selected for this emergency.', 409);
    }
    const score = this.calculateScore(best, eligible.length);

    let assignment: Awaited<ReturnType<FleetService['assignAmbulance']>>;
    try {
      assignment = await this.fleet.assignAmbulance({
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
        decidedByUserId: criteria.decidedByUserId,
        offerTtlMs: this.config.assignment.offerTtlMs,
      });
    } catch (error) {
      // A duplicate operator request can race the first transaction. Reuse the
      // one committed offer when possible rather than creating another offer.
      if (error instanceof AppError && error.statusCode === 409) {
        const afterRace = await this.fleet.getAssignmentsForEmergency(criteria.emergencyId);
        const committedOffer = afterRace.find((item) => item.status === 'OFFERED');
        if (committedOffer) return this.resultFromOffer(committedOffer);
      }
      throw error;
    }

    return this.toResult(assignment);
  }

  private resultFromOffer(assignment: Awaited<ReturnType<FleetService['getAssignmentsForEmergency']>>[number]): AssignmentResult {
    return this.toResult(assignment);
  }

  private toResult(assignment: Awaited<ReturnType<FleetService['assignAmbulance']>>): AssignmentResult {
    return {
      ambulanceId: assignment.ambulanceId,
      assignmentId: assignment.id,
      distanceKm: assignment.distanceKm,
      estimatedResponseTimeMin: assignment.estimatedResponseTimeMin,
      score: assignment.score,
      consideredCandidates: assignment.consideredCandidates,
      matchingFactors: assignment.matchingFactors,
      offeredAt: assignment.offeredAt,
      expiresAt: assignment.expiresAt,
    };
  }

  private calculateScore(candidate: Candidate, total: number): number {
    const baseScore = 1.0 - Math.min(candidate.distanceKm / 50, 0.9);
    return Math.max(this.config.assignment.minConfidenceScore, baseScore);
  }
}
