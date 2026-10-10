import {
  type Ambulance,
  type AmbulanceAssignment,
  type AmbulanceLocation,
  AppError,
  ErrorCode,
  type Logger,
  createId,
  defineEvent,
  haversineKm,
  isValidCoordinate,
  noopLogger,
} from '@resus/core';
import type { AmbulanceRepository, AmbulanceCreateInput, AmbulancePatch } from '@resus/module_11_database_event_system';
import type { EventPublisherPort } from '@resus/core';
import type { Module6Config } from './config.js';

export interface FleetServiceDeps {
  ambulances: AmbulanceRepository;
  events: EventPublisherPort;
  config: Module6Config;
  logger?: Logger;
}

export interface NearestAmbulanceOptions {
  latitude: number;
  longitude: number;
  excludeIds?: string[];
  statuses?: string[];
  maxResults?: number;
  includeStale?: boolean;
}

export interface Candidate {
  ambulance: Ambulance;
  distanceKm: number;
  location: AmbulanceLocation | null;
  isStale: boolean;
}

export interface AssignmentRequest {
  emergencyId: string;
  ambulanceId: string;
  distanceKm: number;
  estimatedResponseTimeMin: number;
  score: number;
  matchingFactors: string[];
  rejectedReasons: Record<string, string>;
  source?: 'AUTOMATIC' | 'MANUAL_OVERRIDE';
  overrideReason?: string | null;
  consideredCandidates: number;
  decidedByUserId?: string | null;
}

export class FleetService {
  private readonly ambulances: AmbulanceRepository;
  private readonly events: EventPublisherPort;
  private readonly config: Module6Config;
  private readonly logger: Logger;

  constructor(deps: FleetServiceDeps) {
    this.ambulances = deps.ambulances;
    this.events = deps.events;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  async registerAmbulance(input: AmbulanceCreateInput): Promise<Ambulance> {
    const ambulance = await this.ambulances.create(input);
    await this.events.record(
      defineEvent('AMBULANCE_CREATED', {
        entityType: 'ambulance',
        entityId: ambulance.id,
        payload: {
          ambulanceId: ambulance.id,
          vehicleNumber: ambulance.vehicleNumber,
          isSimulation: ambulance.isSimulation,
        },
      }),
    );
    return ambulance;
  }

  async listAmbulances(options: { includeSimulation?: boolean; statuses?: string[] } = {}): Promise<Ambulance[]> {
    return this.ambulances.list(options);
  }

  async getAmbulance(id: string): Promise<Ambulance> {
    return this.ambulances.requireById(id);
  }

  async updateAmbulance(id: string, patch: AmbulancePatch): Promise<Ambulance> {
    const previous = await this.ambulances.findById(id);
    const updated = await this.ambulances.update(id, patch);
    const changed: string[] = [];
    if (previous && patch.status !== undefined && previous.status !== patch.status) {
      changed.push(`status:${previous.status}->${patch.status}`);
      await this.events.record(
        defineEvent('AMBULANCE_STATUS_CHANGED', {
          entityType: 'ambulance',
          entityId: id,
          payload: {
            ambulanceId: id,
            from: previous.status as any,
            to: patch.status as any,
          },
        }),
      );
    }
    if (changed.length > 0) {
      await this.events.record(
        defineEvent('AMBULANCE_UPDATED', {
          entityType: 'ambulance',
          entityId: id,
          payload: {
            ambulanceId: id,
            changed,
          },
        }),
      );
    }
    return updated;
  }

  async recordLocation(input: {
    ambulanceId: string;
    latitude: number;
    longitude: number;
    speedKmh?: number | null;
    headingDeg?: number | null;
    accuracyM?: number | null;
    source?: string;
    isSimulation?: boolean;
    recordedAt?: Date;
  }): Promise<AmbulanceLocation> {
    if (!isValidCoordinate({ latitude: input.latitude, longitude: input.longitude })) {
      throw AppError.validation('Invalid coordinates for ambulance location update', {
        latitude: input.latitude,
        longitude: input.longitude,
      });
    }
    // `appendLocation` persists the trail row, the cached position and the
    // AMBULANCE_LOCATION_UPDATED event in one transaction, and only commits the
    // event if that transaction commits. Emitting a second event here would
    // publish an update that no longer corresponds to committed state, so a
    // single successful report produces exactly one event.
    return this.ambulances.appendLocation(input);
  }

  async findNearestAmbulances(options: NearestAmbulanceOptions): Promise<Candidate[]> {
    if (!isValidCoordinate({ latitude: options.latitude, longitude: options.longitude })) {
      throw AppError.validation('Invalid coordinates for nearest ambulance search');
    }
    const statuses = options.statuses ?? ['AVAILABLE'];
    const ambulances = await this.ambulances.list({ statuses, includeSimulation: true });

    const candidates: Candidate[] = [];
    for (const ambulance of ambulances) {
      if (options.excludeIds?.includes(ambulance.id)) continue;
      const location = await this.ambulances.latestLocation(ambulance.id);
      let isStale = false;
      if (location?.recordedAt) {
        const ageMin = (Date.now() - new Date(location.recordedAt).getTime()) / 60000;
        isStale = ageMin > this.config.fleet.maxStaleLocationMinutes;
      } else if (ambulance.lastLocationUpdate) {
        const ageMin = (Date.now() - new Date(ambulance.lastLocationUpdate).getTime()) / 60000;
        isStale = ageMin > this.config.fleet.maxStaleLocationMinutes;
      } else if (ambulance.latitude !== null && ambulance.longitude !== null) {
        isStale = true;
      } else {
        isStale = true;
      }
      if (isStale && !options.includeStale) continue;
      const lat = location?.latitude ?? ambulance.latitude;
      const lng = location?.longitude ?? ambulance.longitude;
      if (lat === null || lng === null) continue;
      const distanceKm = haversineKm({ latitude: options.latitude, longitude: options.longitude }, { latitude: lat, longitude: lng });
      candidates.push({ ambulance, distanceKm, location, isStale });
    }

    candidates.sort((a, b) => a.distanceKm - b.distanceKm);
    if (options.maxResults) {
      return candidates.slice(0, options.maxResults);
    }
    return candidates;
  }

  async findNearestAvailable(options: Omit<NearestAmbulanceOptions, 'statuses'>): Promise<Candidate | null> {
    const candidates = await this.findNearestAmbulances({ ...options, statuses: ['AVAILABLE'] });
    return candidates[0] ?? null;
  }

  async assignAmbulance(request: AssignmentRequest): Promise<AmbulanceAssignment> {
    const ambulance = await this.ambulances.requireById(request.ambulanceId);
    if (ambulance.status !== 'AVAILABLE' && request.source !== 'MANUAL_OVERRIDE') {
      throw new AppError(ErrorCode.AMBULANCE_NOT_AVAILABLE, `Ambulance ${request.ambulanceId} is not available`, 409);
    }

    const activeAssignment = await this.ambulances.activeAssignmentFor(request.ambulanceId);
    if (activeAssignment) {
      throw new AppError(ErrorCode.CONFLICT, `Ambulance ${request.ambulanceId} already has active assignment`, 409);
    }

    const assignment = await this.ambulances.createAssignment({
      emergencyId: request.emergencyId,
      ambulanceId: request.ambulanceId,
      source: request.source ?? 'AUTOMATIC',
      distanceKm: request.distanceKm,
      estimatedResponseTimeMin: request.estimatedResponseTimeMin,
      score: request.score,
      matchingFactors: request.matchingFactors,
      rejectedReasons: request.rejectedReasons,
      overrideReason: request.overrideReason ?? null,
      consideredCandidates: request.consideredCandidates,
      decidedByUserId: request.decidedByUserId,
    });

    await this.ambulances.update(request.ambulanceId, {
      status: 'DISPATCHED',
      currentEmergencyId: request.emergencyId,
      assignedAt: new Date(),
    });

    await this.events.record(
      defineEvent('AMBULANCE_ASSIGNMENT_REQUESTED', {
        emergencyId: request.emergencyId,
        entityType: 'ambulance',
        entityId: request.ambulanceId,
        payload: {
          emergencyId: request.emergencyId,
          candidatesEvaluated: request.consideredCandidates,
          requiredEquipment: [],
          requiredCapabilities: [],
        },
      }),
    );

    await this.events.record(
      defineEvent('AMBULANCE_ASSIGNED', {
        emergencyId: request.emergencyId,
        entityType: 'ambulance',
        entityId: request.ambulanceId,
        payload: {
          ambulanceId: request.ambulanceId,
          assignmentId: assignment.id,
          emergencyId: request.emergencyId,
          distanceKm: assignment.distanceKm,
          estimatedResponseTimeMin: assignment.estimatedResponseTimeMin,
          matchingFactors: assignment.matchingFactors,
          score: assignment.score,
          source: assignment.source as any,
          overrideReason: assignment.overrideReason,
          consideredCandidates: request.consideredCandidates,
        },
      }),
    );

    return assignment;
  }

  async dispatchAmbulance(ambulanceId: string, emergencyId: string): Promise<void> {
    const ambulance = await this.ambulances.requireById(ambulanceId);
    await this.ambulances.update(ambulanceId, {
      status: 'EN_ROUTE',
    });

    await this.events.record(
      defineEvent('AMBULANCE_DISPATCHED', {
        emergencyId,
        entityType: 'ambulance',
        entityId: ambulanceId,
        payload: {
          ambulanceId,
          emergencyId,
        },
      }),
    );

    await this.events.record(
      defineEvent('AMBULANCE_STATUS_CHANGED', {
        entityType: 'ambulance',
        entityId: ambulanceId,
        payload: {
          ambulanceId,
          from: ambulance.status as any,
          to: 'EN_ROUTE' as any,
        },
      }),
    );
  }

  async getLatestLocation(ambulanceId: string): Promise<AmbulanceLocation | null> {
    return this.ambulances.latestLocation(ambulanceId);
  }

  async getAssignedAmbulanceForDriver(driverId: string): Promise<Ambulance | null> {
    return this.ambulances.getAssignedAmbulanceForDriver(driverId);
  }
  async getAssignmentsForEmergency(emergencyId: string): Promise<AmbulanceAssignment[]> {
    return this.ambulances.assignmentsForEmergency(emergencyId);
  }
}
