import {
  type Emergency,
  type EventPublisherPort,
  type HospitalWithResources,
  type Logger,
  type SystemEventType,
  defineEvent,
  isValidCoordinate,
  noopLogger,
} from '@resus/core';
import type { Module7Config } from './config.js';
import { scoreHospital, type ScoredHospital } from './suitability.js';

/**
 * The read side Module 7 needs from persistence: hospitals with their resources.
 *
 * Declared here rather than importing Module 11's repository type, so Module 7
 * depends on a shape, not on the persistence module.
 */
export interface HospitalCandidatePort {
  listWithResources(filter?: { includeSimulation?: boolean }): Promise<HospitalWithResources[]>;
}

/** The read/write side Module 7 needs to record the chosen hospital. */
export interface EmergencySelectionPort {
  findById(id: string): Promise<Emergency | null>;
  update(
    id: string,
    patch: { selectedHospitalId: string | null },
    event?: { type: SystemEventType; payload: Record<string, unknown> },
  ): Promise<Emergency>;
}

export interface HospitalSelectionDeps {
  hospitals: HospitalCandidatePort;
  emergencies: EmergencySelectionPort;
  events: EventPublisherPort;
  config: Module7Config;
  logger?: Logger;
}

export type HospitalSelectionOutcome =
  | 'SELECTED'
  | 'SKIPPED_NOT_FOUND'
  | 'SKIPPED_SIMULATION'
  | 'SKIPPED_ALREADY_SELECTED'
  | 'SKIPPED_STATUS'
  | 'SKIPPED_INVALID_LOCATION'
  | 'NO_CANDIDATE'
  | 'FAILED';

export interface HospitalSelectionResult {
  emergencyId: string;
  outcome: HospitalSelectionOutcome;
  hospitalId?: string;
  hospitalName?: string;
  distanceKm?: number;
  reason?: string;
  consideredCandidates?: number;
}

export interface RankingResult {
  selected: ScoredHospital | null;
  ranked: ScoredHospital[];
  rejected: ScoredHospital[];
  consideredCandidates: number;
}

/** Statuses after which a selecting hospital no longer makes sense. */
const TERMINAL_STATUSES = new Set<string>(['COMPLETED', 'CANCELLED']);

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Module 7's selection algorithm.
 *
 * `rank` is pure: given an incident it scores every seeded hospital and returns
 * the eligible hospitals ordered best-first plus the rejected ones. `selectFor`
 * applies that ranking to one emergency: it writes `selectedHospitalId` and the
 * `HOSPITAL_SELECTED` event in a single transaction, and records a
 * `HOSPITAL_REJECTED` event for each in-range hospital that was ruled out on
 * resource grounds. It never changes emergency status, protocols or ambulance
 * assignment.
 */
export class HospitalSelectionService {
  private readonly hospitals: HospitalCandidatePort;
  private readonly emergencies: EmergencySelectionPort;
  private readonly events: EventPublisherPort;
  private readonly config: Module7Config;
  private readonly logger: Logger;
  private readonly inFlight = new Map<string, Promise<HospitalSelectionResult>>();

  constructor(deps: HospitalSelectionDeps) {
    this.hospitals = deps.hospitals;
    this.emergencies = deps.emergencies;
    this.events = deps.events;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  async rank(incident: {
    incidentType: Emergency['incidentType'];
    latitude: number;
    longitude: number;
  }): Promise<RankingResult> {
    // Seeded hospitals are simulation-flagged, so candidates are always read
    // with simulation included; the incident's own simulation flag is what the
    // auto-select gate keys on.
    const hospitals = await this.hospitals.listWithResources({ includeSimulation: true });
    const scored = hospitals.map((hospital) => scoreHospital(hospital, incident, this.config));
    const eligible = scored.filter((candidate) => candidate.eligible);
    const rejected = scored.filter((candidate) => !candidate.eligible);

    eligible.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      return a.hospital.name.localeCompare(b.hospital.name);
    });

    return {
      selected: eligible[0] ?? null,
      ranked: eligible,
      rejected,
      consideredCandidates: scored.length,
    };
  }

  /** Ranks and, if a hospital qualifies, records the choice on the emergency. */
  async selectForEmergency(emergencyId: string): Promise<HospitalSelectionResult> {
    const existing = this.inFlight.get(emergencyId);
    if (existing) return existing;

    const selection = this.selectOnce(emergencyId);
    this.inFlight.set(emergencyId, selection);
    try {
      return await selection;
    } finally {
      if (this.inFlight.get(emergencyId) === selection) this.inFlight.delete(emergencyId);
    }
  }

  private async selectOnce(emergencyId: string): Promise<HospitalSelectionResult> {
    const emergency = await this.emergencies.findById(emergencyId);
    if (!emergency) {
      return { emergencyId, outcome: 'SKIPPED_NOT_FOUND', reason: 'emergency not found' };
    }
    if (emergency.isSimulation && !(this.config.autoSelect?.includeSimulation ?? false)) {
      return { emergencyId, outcome: 'SKIPPED_SIMULATION' };
    }
    if (emergency.selectedHospitalId) {
      return {
        emergencyId,
        outcome: 'SKIPPED_ALREADY_SELECTED',
        hospitalId: emergency.selectedHospitalId,
      };
    }
    if (TERMINAL_STATUSES.has(emergency.status)) {
      return { emergencyId, outcome: 'SKIPPED_STATUS', reason: `status ${emergency.status}` };
    }
    if (!isValidCoordinate({ latitude: emergency.latitude, longitude: emergency.longitude })) {
      return { emergencyId, outcome: 'SKIPPED_INVALID_LOCATION' };
    }

    try {
      const ranking = await this.rank({
        incidentType: emergency.incidentType,
        latitude: emergency.latitude,
        longitude: emergency.longitude,
      });

      const selected = ranking.selected;
      if (!selected) {
        this.logger.warn(
          { emergencyId, consideredCandidates: ranking.consideredCandidates },
          'auto hospital selection found no suitable candidate',
        );
        return {
          emergencyId,
          outcome: 'NO_CANDIDATE',
          consideredCandidates: ranking.consideredCandidates,
        };
      }

      const distanceKm = round2(selected.distanceKm);
      const reason = selected.matchingFactors.join(', ') || 'nearest suitable hospital';

      // Availability writes and the selection event commit together, so the
      // stored choice and its event can never disagree.
      await this.emergencies.update(
        emergencyId,
        { selectedHospitalId: selected.hospital.id },
        { type: 'HOSPITAL_SELECTED', payload: { hospitalId: selected.hospital.id, emergencyId, distanceKm, reason } },
      );

      await this.recordRejections(emergencyId, ranking.rejected);

      this.logger.info(
        {
          emergencyId,
          hospitalId: selected.hospital.id,
          hospitalName: selected.hospital.name,
          distanceKm,
          score: selected.score,
          consideredCandidates: ranking.consideredCandidates,
        },
        'auto hospital selection chose a hospital',
      );

      return {
        emergencyId,
        outcome: 'SELECTED',
        hospitalId: selected.hospital.id,
        hospitalName: selected.hospital.name,
        distanceKm,
        reason,
        consideredCandidates: ranking.consideredCandidates,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error({ emergencyId, error: reason }, 'auto hospital selection failed');
      return { emergencyId, outcome: 'FAILED', reason };
    }
  }

  /**
   * Records why in-range hospitals were ruled out.
   *
   * Only candidates within the distance limit are reported: an out-of-range
   * hospital is not a rejection, it is simply not in the search area, and
   * logging it would drown the signal.
   */
  private async recordRejections(emergencyId: string, rejected: ScoredHospital[]): Promise<void> {
    for (const candidate of rejected) {
      if (candidate.rejectReason === null) continue;
      if (candidate.distanceKm > this.config.maxDistanceKm) continue;
      try {
        await this.events.record(
          defineEvent('HOSPITAL_REJECTED', {
            emergencyId,
            entityType: 'hospital',
            entityId: candidate.hospital.id,
            payload: {
              emergencyId,
              hospitalId: candidate.hospital.id,
              reason: candidate.rejectReason,
            },
          }),
        );
      } catch (error) {
        // A rejection record is diagnostic; never let it fail a good selection.
        this.logger.warn(
          { emergencyId, hospitalId: candidate.hospital.id, error: error instanceof Error ? error.message : String(error) },
          'failed to record hospital rejection',
        );
      }
    }
  }
}
