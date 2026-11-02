import type { Prisma, PrismaClient } from '@prisma/client';
import {
  type Ambulance,
  type AmbulanceAssignment,
  type AmbulanceLocation,
  AppError,
  ErrorCode,
  createId,
  defineEvent,
  isValidCoordinate,
} from '@resus/core';
import { guardDatabase, withTransaction } from '../db/client.js';
import {
  mapAmbulance,
  mapAmbulanceLocation,
  mapAssignment,
  parseStringArray,
} from '../models/mappers.js';
import type { EventService } from '../events/eventService.js';

export interface AmbulanceCreateInput {
  vehicleNumber: string;
  latitude?: number | null;
  longitude?: number | null;
  equipment?: string[];
  stationName?: string | null;
  isSimulation?: boolean;
  status?: string;
  crew?: Array<{
    name: string;
    role: string;
    capabilities?: string[];
    isOnDuty?: boolean;
  }>;
}

export interface AmbulancePatch {
  status?: string;
  latitude?: number | null;
  longitude?: number | null;
  lastLocationUpdate?: Date | null;
  currentEmergencyId?: string | null;
  assignedAt?: Date | null;
  availableAt?: Date | null;
  equipment?: string[];
  stationName?: string | null;
}

export interface AmbulanceUtilization {
  ambulanceId: string;
  vehicleNumber: string;
  status: string;
  assignmentCount: number;
  isSimulation: boolean;
  minutesInField: number;
}

export class AmbulanceRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly events: EventService,
  ) {}

  async create(input: AmbulanceCreateInput): Promise<Ambulance> {
    const hasLat = input.latitude !== undefined && input.latitude !== null;
    const hasLng = input.longitude !== undefined && input.longitude !== null;
    if (hasLat !== hasLng) {
      throw AppError.validation('Both latitude and longitude must be supplied for an ambulance.');
    }
    if (hasLat && hasLng && !isValidCoordinate({ latitude: input.latitude!, longitude: input.longitude! })) {
      throw AppError.validation('Ambulance coordinates are out of range.');
    }

    const id = createId('AMB');
    const row = await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const created = await tx.ambulance.create({
            data: {
              id,
              vehicleNumber: input.vehicleNumber,
              status: input.status ?? 'AVAILABLE',
              latitude: input.latitude ?? null,
              longitude: input.longitude ?? null,
              lastLocationUpdate: hasLat ? new Date() : null,
              equipmentJson: JSON.stringify(input.equipment ?? []),
              stationName: input.stationName ?? null,
              isSimulation: input.isSimulation ?? false,
              crew: {
                create: (input.crew ?? []).map((member) => ({
                  id: createId('CRW'),
                  name: member.name,
                  role: member.role,
                  capabilitiesJson: JSON.stringify(member.capabilities ?? []),
                  isOnDuty: member.isOnDuty ?? true,
                })),
              },
            },
            include: { crew: true },
          });
          await this.events.recordInTransaction(
            tx as never,
            defineEvent('AMBULANCE_CREATED', {
              entityType: 'ambulance',
              entityId: id,
              payload: {
                ambulanceId: id,
                vehicleNumber: input.vehicleNumber,
                isSimulation: input.isSimulation ?? false,
              },
            }),
          );
          return created;
        }),
      'Failed to create ambulance',
    );
    return mapAmbulance(row as unknown as Record<string, unknown>, (row.crew ?? []) as never[]);
  }

  async list(filter: { includeSimulation?: boolean; statuses?: string[] } = {}): Promise<Ambulance[]> {
    return guardDatabase(async () => {
      const rows = await this.db.ambulance.findMany({
        where: {
          ...(filter.includeSimulation ? {} : { isSimulation: false }),
          ...(filter.statuses?.length ? { status: { in: filter.statuses } } : {}),
        },
        orderBy: { vehicleNumber: 'asc' },
        include: { crew: true },
      });
      return rows.map((row) => mapAmbulance(row as unknown as Record<string, unknown>, (row.crew ?? []) as never[]));
    }, 'Failed to list ambulances');
  }

  async findById(id: string): Promise<Ambulance | null> {
    return guardDatabase(async () => {
      const row = await this.db.ambulance.findUnique({ where: { id }, include: { crew: true } });
      return row ? mapAmbulance(row as unknown as Record<string, unknown>, (row.crew ?? []) as never[]) : null;
    }, 'Failed to read ambulance');
  }

  async requireById(id: string): Promise<Ambulance> {
    const ambulance = await this.findById(id);
    if (!ambulance) throw new AppError(ErrorCode.AMBULANCE_NOT_FOUND, `Ambulance '${id}' was not found.`, 404);
    return ambulance;
  }

  async findByAssignedDriverId(driverId: string): Promise<Ambulance | null> {
    return guardDatabase(async () => {
      const row = await this.db.ambulance.findFirst({
        where: { assignedDriverId: driverId },
        include: { crew: true },
      });
      return row ? mapAmbulance(row as unknown as Record<string, unknown>, (row.crew ?? []) as never[]) : null;
    }, 'Failed to read ambulance by driver');
  }

  async getAssignedAmbulanceForDriver(driverId: string): Promise<Ambulance | null> {
    return this.findByAssignedDriverId(driverId);
  }
  async update(id: string, patch: AmbulancePatch): Promise<Ambulance> {
    const data: Prisma.AmbulanceUpdateInput = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.latitude !== undefined) data.latitude = patch.latitude;
    if (patch.longitude !== undefined) data.longitude = patch.longitude;
    if (patch.lastLocationUpdate !== undefined) data.lastLocationUpdate = patch.lastLocationUpdate;
    if (patch.stationName !== undefined) data.stationName = patch.stationName;
    if (patch.equipment !== undefined) data.equipmentJson = JSON.stringify(patch.equipment);
    if (patch.assignedAt !== undefined) data.assignedAt = patch.assignedAt;
    if (patch.availableAt !== undefined) data.availableAt = patch.availableAt;
    if (patch.currentEmergencyId !== undefined) {
      data.currentEmergency = patch.currentEmergencyId
        ? { connect: { id: patch.currentEmergencyId } }
        : { disconnect: true };
    }

    const row = await guardDatabase(
      async () => this.db.ambulance.update({ where: { id }, data, include: { crew: true } }),
      'Failed to update ambulance',
    );
    return mapAmbulance(row as unknown as Record<string, unknown>, (row.crew ?? []) as never[]);
  }

  /**
   * Soft delete. Ambulances are never hard-deleted: the event log and the GPS
   * trail reference them, so a unit is retired to UNAVAILABLE instead.
   */
  async retire(id: string): Promise<Ambulance> {
    const row = await guardDatabase(
      async () =>
        this.db.ambulance.update({
          where: { id },
          data: { status: 'UNAVAILABLE', currentEmergency: { disconnect: true } },
          include: { crew: true },
        }),
      'Failed to retire ambulance',
    );
    return mapAmbulance(row as unknown as Record<string, unknown>, (row.crew ?? []) as never[]);
  }

  /** Appends to the GPS trail and updates the cached position in one write. */
  async appendLocation(input: {
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
      throw AppError.validation('Reported coordinates are out of range.', {
        latitude: input.latitude,
        longitude: input.longitude,
      });
    }
    const id = createId('LOC');
    const recordedAt = input.recordedAt ?? new Date();
    const isSimulation = input.isSimulation ?? false;

    await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          await tx.ambulanceLocation.create({
            data: {
              id,
              ambulanceId: input.ambulanceId,
              latitude: input.latitude,
              longitude: input.longitude,
              speedKmh: input.speedKmh ?? null,
              headingDeg: input.headingDeg ?? null,
              accuracyM: input.accuracyM ?? null,
              source: input.source ?? 'GPS',
              isSimulation,
              recordedAt,
            },
          });
          await tx.ambulance.update({
            where: { id: input.ambulanceId },
            data: { latitude: input.latitude, longitude: input.longitude, lastLocationUpdate: recordedAt },
          });
          if (!isSimulation) {
            // Production telemetry only: simulation must not pollute the real log.
            await this.events.recordInTransaction(
              tx as never,
              defineEvent('AMBULANCE_LOCATION_UPDATED', {
                entityType: 'ambulance',
                entityId: input.ambulanceId,
                payload: {
                  ambulanceId: input.ambulanceId,
                  latitude: input.latitude,
                  longitude: input.longitude,
                  speedKmh: input.speedKmh ?? null,
                  headingDeg: input.headingDeg ?? null,
                  recordedAt: recordedAt.toISOString(),
                  isSimulation: false,
                },
              }),
            );
          }
          return id;
        }),
      'Failed to record ambulance location',
    );

    return {
      id,
      ambulanceId: input.ambulanceId,
      latitude: input.latitude,
      longitude: input.longitude,
      speedKmh: input.speedKmh ?? null,
      headingDeg: input.headingDeg ?? null,
      accuracyM: input.accuracyM ?? null,
      recordedAt: recordedAt.toISOString(),
      source: input.source ?? 'GPS',
      isSimulation,
    };
  }

  async latestLocation(ambulanceId: string): Promise<AmbulanceLocation | null> {
    return guardDatabase(async () => {
      const row = await this.db.ambulanceLocation.findFirst({
        where: { ambulanceId },
        orderBy: { recordedAt: 'desc' },
      });
      return row ? mapAmbulanceLocation(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read latest location');
  }

  async locationTrail(ambulanceId: string, limit = 200): Promise<AmbulanceLocation[]> {
    return guardDatabase(async () => {
      const rows = await this.db.ambulanceLocation.findMany({
        where: { ambulanceId },
        orderBy: { recordedAt: 'desc' },
        take: Math.min(limit, 1000),
      });
      return rows.map((row) => mapAmbulanceLocation(row as unknown as Record<string, unknown>));
    }, 'Failed to read location trail');
  }

  async createAssignment(input: {
    emergencyId: string;
    ambulanceId: string;
    source: string;
    distanceKm: number;
    estimatedResponseTimeMin: number;
    score: number;
    matchingFactors: string[];
    rejectedReasons: Record<string, string>;
    overrideReason?: string | null;
    consideredCandidates: number;
    decidedByUserId?: string | null;
    offerTtlMs?: number;
  }): Promise<AmbulanceAssignment> {
    const id = createId('ASG');
    const offeredAt = new Date();
    const expiresAt = new Date(offeredAt.getTime() + Math.max(1, input.offerTtlMs ?? 60_000));
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const existingForEmergency = await tx.ambulanceAssignment.findFirst({
          where: { emergencyId: input.emergencyId, status: { in: ['OFFERED', 'ASSIGNED', 'ACCEPTED', 'DISPATCHED'] } },
        });
        if (existingForEmergency) {
          throw new AppError(ErrorCode.CONFLICT, `Emergency ${input.emergencyId} already has an active ambulance assignment`, 409);
        }
        const previouslyReleasedForEmergency = await tx.ambulanceAssignment.findFirst({
          where: {
            emergencyId: input.emergencyId,
            ambulanceId: input.ambulanceId,
            status: { in: ['DECLINED', 'EXPIRED', 'CANCELLED'] },
          },
        });
        if (previouslyReleasedForEmergency) {
          throw new AppError(ErrorCode.CONFLICT, 'This ambulance already declined or expired for this emergency and cannot be reassigned to it.', 409);
        }
        const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
        if (!ambulance) throw new AppError(ErrorCode.AMBULANCE_NOT_FOUND, `Ambulance '${input.ambulanceId}' was not found.`, 404);
        if (ambulance.status !== 'AVAILABLE' && input.source !== 'MANUAL_OVERRIDE') {
          throw new AppError(ErrorCode.AMBULANCE_NOT_AVAILABLE, `Ambulance ${input.ambulanceId} is not available`, 409);
        }
        const active = await tx.ambulanceAssignment.findFirst({
          where: { ambulanceId: input.ambulanceId, status: { in: ['OFFERED', 'ASSIGNED', 'ACCEPTED', 'DISPATCHED'] } },
        });
        if (active) throw new AppError(ErrorCode.CONFLICT, `Ambulance ${input.ambulanceId} already has active assignment`, 409);

        const created = await tx.ambulanceAssignment.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            ambulanceId: input.ambulanceId,
            status: 'OFFERED',
            source: input.source,
            distanceKm: input.distanceKm,
            estimatedResponseTimeMin: input.estimatedResponseTimeMin,
            score: input.score,
            matchingFactorsJson: JSON.stringify(input.matchingFactors),
            rejectedReasonsJson: JSON.stringify(input.rejectedReasons),
            overrideReason: input.overrideReason ?? null,
            consideredCandidates: input.consideredCandidates,
            decidedByUserId: input.decidedByUserId ?? null,
            offeredAt,
            expiresAt,
          },
        });
        await tx.ambulance.update({
          where: { id: input.ambulanceId },
          data: { status: 'ASSIGNED', currentEmergencyId: input.emergencyId, assignedAt: new Date() },
        });
        await tx.emergency.update({ where: { id: input.emergencyId }, data: { assignedAmbulanceId: input.ambulanceId } });
        const actorType = input.decidedByUserId ? 'OPERATOR' : 'MODULE';
        await this.events.recordInTransaction(tx as never, defineEvent('AMBULANCE_ASSIGNMENT_REQUESTED', {
          emergencyId: input.emergencyId,
          entityType: 'ambulance',
          entityId: input.ambulanceId,
          actorType,
          actorId: input.decidedByUserId ?? null,
          payload: {
            emergencyId: input.emergencyId,
            candidatesEvaluated: input.consideredCandidates,
            requiredEquipment: [],
            requiredCapabilities: [],
          },
        }));
        const emergency = await tx.emergency.findUniqueOrThrow({ where: { id: input.emergencyId }, select: { isSimulation: true } });
        await this.events.recordInTransaction(tx as never, defineEvent('AMBULANCE_ASSIGNMENT_OFFERED', {
          emergencyId: input.emergencyId,
          entityType: 'ambulance_assignment',
          entityId: id,
          actorType,
          actorId: input.decidedByUserId ?? null,
          payload: { ambulanceId: input.ambulanceId, assignmentId: id, emergencyId: input.emergencyId, offeredAt: offeredAt.toISOString(), expiresAt: expiresAt.toISOString(), isSimulation: emergency.isSimulation },
        }));
        await this.events.recordInTransaction(tx as never, defineEvent('AMBULANCE_ASSIGNED', {
          emergencyId: input.emergencyId,
          entityType: 'ambulance',
          entityId: input.ambulanceId,
          actorType,
          actorId: input.decidedByUserId ?? null,
          payload: {
            ambulanceId: input.ambulanceId,
            assignmentId: id,
            emergencyId: input.emergencyId,
            distanceKm: input.distanceKm,
            estimatedResponseTimeMin: input.estimatedResponseTimeMin,
            matchingFactors: input.matchingFactors,
            score: input.score,
            source: input.source as 'AUTOMATIC' | 'MANUAL_OVERRIDE',
            overrideReason: input.overrideReason ?? null,
            consideredCandidates: input.consideredCandidates,
          },
        }));
        return created;
      }),
      'Failed to persist ambulance assignment',
    );
    return mapAssignment(row as unknown as Record<string, unknown>);
  }

  async activeAssignmentForDriver(driverId: string): Promise<{ assignment: AmbulanceAssignment; ambulance: Ambulance } | null> {
    await this.expireDueOffers({ driverId });
    return guardDatabase(async () => {
      const row = await this.db.ambulanceAssignment.findFirst({
        where: {
          ambulance: { assignedDriverId: driverId },
          status: { in: ['OFFERED', 'ASSIGNED', 'ACCEPTED', 'DISPATCHED'] },
        },
        orderBy: { createdAt: 'desc' },
        include: { ambulance: { include: { crew: true } } },
      });
      if (!row) return null;
      return {
        assignment: mapAssignment(row as unknown as Record<string, unknown>),
        ambulance: mapAmbulance(row.ambulance as unknown as Record<string, unknown>, row.ambulance.crew as never[]),
      };
    }, 'Failed to read driver assignment');
  }

  async respondToAssignment(input: {
    assignmentId: string;
    driverId: string;
    decision: 'ACCEPT' | 'DECLINE';
    reason?: string | null;
  }): Promise<AmbulanceAssignment> {
    await this.expireDueOffers({ assignmentId: input.assignmentId });
    const decidedAt = new Date();
    let row: unknown;
    try {
      row = await guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const current = await tx.ambulanceAssignment.findUnique({
        where: { id: input.assignmentId },
        include: { ambulance: true },
      });
      if (!current) throw AppError.notFound('Assignment', input.assignmentId);
      if (current.ambulance.assignedDriverId !== input.driverId) {
        throw new AppError(ErrorCode.FORBIDDEN, 'This assignment does not belong to the authenticated driver.', 403);
      }
      if ((current.status === 'ACCEPTED' && input.decision === 'ACCEPT') ||
          (current.status === 'DECLINED' && input.decision === 'DECLINE')) {
        return current;
      }
      if (!['OFFERED', 'ASSIGNED'].includes(current.status) || current.ambulance.status !== 'ASSIGNED') {
        throw new AppError(ErrorCode.CONFLICT, 'Only a pending, undispatched assignment can be accepted or declined.', 409);
      }
      const nextStatus = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
      const changed = await tx.ambulanceAssignment.updateMany({
        where: { id: input.assignmentId, ambulanceId: current.ambulanceId, status: current.status,
          ...(current.status === 'OFFERED' ? { expiresAt: { gt: decidedAt } } : {}) },
        data: { status: nextStatus, ...(input.decision === 'DECLINE' ? { releasedAt: decidedAt } : {}) },
      });
      if (changed.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Assignment was already answered.', 409);

      if (input.decision === 'DECLINE') {
        await tx.ambulance.update({
          where: { id: current.ambulanceId },
          data: { status: 'AVAILABLE', currentEmergencyId: null, availableAt: decidedAt },
        });
        await tx.emergency.updateMany({
          where: { id: current.emergencyId, assignedAmbulanceId: current.ambulanceId },
          data: { assignedAmbulanceId: null },
        });
      }

      const event = input.decision === 'ACCEPT'
        ? defineEvent('AMBULANCE_ASSIGNMENT_ACCEPTED', {
            emergencyId: current.emergencyId,
            entityType: 'ambulance_assignment',
            entityId: current.id,
            actorType: 'AMBULANCE',
            actorId: input.driverId,
            payload: { assignmentId: current.id, ambulanceId: current.ambulanceId, emergencyId: current.emergencyId, acceptedAt: decidedAt.toISOString() },
          })
        : defineEvent('AMBULANCE_ASSIGNMENT_DECLINED', {
            emergencyId: current.emergencyId,
            entityType: 'ambulance_assignment',
            entityId: current.id,
            actorType: 'AMBULANCE',
            actorId: input.driverId,
            payload: { assignmentId: current.id, ambulanceId: current.ambulanceId, emergencyId: current.emergencyId, declinedAt: decidedAt.toISOString(), reason: input.reason ?? null },
          });
      await this.events.recordInTransaction(tx as never, event);
      return tx.ambulanceAssignment.findUniqueOrThrow({ where: { id: current.id } });
      }), 'Failed to record driver assignment response');
    } catch (error) {
      // Covers the small interval where the offer crosses its deadline after
      // the first expiry sweep but before the conditional acceptance update.
      await this.expireDueOffers({ assignmentId: input.assignmentId });
      throw error;
    }
    return mapAssignment(row as unknown as Record<string, unknown>);
  }

  async dispatchAssignment(input: { ambulanceId: string; emergencyId: string; dispatchedByUserId?: string | null }): Promise<void> {
    await this.expireDueOffers({ emergencyId: input.emergencyId, ambulanceId: input.ambulanceId });
    await guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
      if (!ambulance) throw new AppError(ErrorCode.AMBULANCE_NOT_FOUND, `Ambulance '${input.ambulanceId}' was not found.`, 404);
      const assignment = await tx.ambulanceAssignment.findFirst({
        where: { ambulanceId: input.ambulanceId, emergencyId: input.emergencyId, status: { in: ['ASSIGNED', 'ACCEPTED'] } },
      });
      if (!assignment) {
        const alreadyDispatched = await tx.ambulanceAssignment.findFirst({
          where: { ambulanceId: input.ambulanceId, emergencyId: input.emergencyId, status: 'DISPATCHED' },
        });
        if (alreadyDispatched && ambulance.status === 'EN_ROUTE') return;
        throw new AppError(ErrorCode.CONFLICT, 'A pending or accepted assignment is required before dispatch.', 409);
      }
      if (ambulance.status !== 'ASSIGNED') {
        throw new AppError(ErrorCode.CONFLICT, 'Ambulance is not in an assigned state and cannot be dispatched.', 409);
      }
      const changed = await tx.ambulanceAssignment.updateMany({
        where: { id: assignment.id, status: { in: ['ASSIGNED', 'ACCEPTED'] } },
        data: { status: 'DISPATCHED' },
      });
      if (changed.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Assignment changed before dispatch.', 409);
      await tx.ambulance.update({ where: { id: input.ambulanceId }, data: { status: 'EN_ROUTE' } });
      await this.events.recordInTransaction(tx as never, defineEvent('AMBULANCE_DISPATCHED', {
        emergencyId: input.emergencyId,
        entityType: 'ambulance',
        entityId: input.ambulanceId,
        actorType: 'OPERATOR',
        actorId: input.dispatchedByUserId ?? null,
        payload: { ambulanceId: input.ambulanceId, emergencyId: input.emergencyId },
      }));
      await this.events.recordInTransaction(tx as never, defineEvent('AMBULANCE_STATUS_CHANGED', {
        entityType: 'ambulance',
        entityId: input.ambulanceId,
        actorType: 'OPERATOR',
        actorId: input.dispatchedByUserId ?? null,
        payload: { ambulanceId: input.ambulanceId, from: ambulance.status as never, to: 'EN_ROUTE' },
      }));
    }), 'Failed to dispatch ambulance');
  }

  async assignmentsForEmergency(emergencyId: string): Promise<AmbulanceAssignment[]> {
    await this.expireDueOffers({ emergencyId });
    return guardDatabase(async () => {
      const rows = await this.db.ambulanceAssignment.findMany({
        where: { emergencyId },
        orderBy: { decidedAt: 'asc' },
      });
      return rows.map((row) => mapAssignment(row as unknown as Record<string, unknown>));
    }, 'Failed to read assignments');
  }

  async activeAssignmentFor(ambulanceId: string): Promise<AmbulanceAssignment | null> {
    await this.expireDueOffers({ ambulanceId });
    return guardDatabase(async () => {
      const row = await this.db.ambulanceAssignment.findFirst({
        where: { ambulanceId, status: { in: ['OFFERED', 'ASSIGNED', 'ACCEPTED', 'DISPATCHED'] } },
        orderBy: { decidedAt: 'desc' },
      });
      return row ? mapAssignment(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read active assignment');
  }

  /**
   * Expires due offers on the next relevant repository operation. No background
   * worker is introduced: a GET, assignment retry, or driver response performs
   * the state transition transactionally before exposing/using the offer.
   */
  async expireDueOffers(filter: { assignmentId?: string; emergencyId?: string; ambulanceId?: string; driverId?: string } = {}, now = new Date()): Promise<number> {
    const rows = await guardDatabase(() => this.db.ambulanceAssignment.findMany({
      where: {
        status: 'OFFERED',
        expiresAt: { lte: now },
        ...(filter.assignmentId ? { id: filter.assignmentId } : {}),
        ...(filter.emergencyId ? { emergencyId: filter.emergencyId } : {}),
        ...(filter.ambulanceId ? { ambulanceId: filter.ambulanceId } : {}),
        ...(filter.driverId ? { ambulance: { assignedDriverId: filter.driverId } } : {}),
      },
      select: { id: true },
    }), 'Failed to find expired ambulance offers');
    let expired = 0;
    for (const { id } of rows) {
      const changed = await guardDatabase(() => withTransaction(this.db, async (tx) => {
        const current = await tx.ambulanceAssignment.findUnique({ where: { id }, include: { ambulance: true, emergency: { select: { isSimulation: true } } } });
        if (!current || current.status !== 'OFFERED' || !current.expiresAt || current.expiresAt > now) return false;
        const update = await tx.ambulanceAssignment.updateMany({
          where: { id, status: 'OFFERED', expiresAt: { lte: now } },
          data: { status: 'EXPIRED', releasedAt: now },
        });
        if (update.count !== 1) return false;
        await tx.ambulance.updateMany({
          where: { id: current.ambulanceId, status: 'ASSIGNED', currentEmergencyId: current.emergencyId },
          data: { status: 'AVAILABLE', currentEmergencyId: null, availableAt: now },
        });
        await tx.emergency.updateMany({
          where: { id: current.emergencyId, assignedAmbulanceId: current.ambulanceId },
          data: { assignedAmbulanceId: null },
        });
        await this.events.recordInTransaction(tx as never, defineEvent('AMBULANCE_ASSIGNMENT_EXPIRED', {
          emergencyId: current.emergencyId,
          entityType: 'ambulance_assignment',
          entityId: current.id,
          actorType: 'SYSTEM',
          payload: { assignmentId: current.id, ambulanceId: current.ambulanceId, emergencyId: current.emergencyId, expiredAt: now.toISOString(), isSimulation: current.emergency.isSimulation },
        }));
        return true;
      }), 'Failed to expire ambulance offer');
      if (changed) expired += 1;
    }
    return expired;
  }

  async releaseAssignments(ambulanceId: string): Promise<number> {
    return guardDatabase(
      async () =>
        this.db.ambulanceAssignment.updateMany({
          where: { ambulanceId, status: { in: ['OFFERED', 'ASSIGNED', 'ACCEPTED', 'DISPATCHED'] } },
          data: { status: 'CANCELLED', releasedAt: new Date() },
        }).then((result) => result.count),
      'Failed to release assignments',
    );
  }

  /**
   * Fleet utilisation derived from real rows: how many assignments each unit
   * received and how long it has spent reporting position since the fleet was
   * populated. Never invented.
   */
  async utilization(includeSimulation: boolean): Promise<AmbulanceUtilization[]> {
    return guardDatabase(async () => {
      const rows = await this.db.ambulance.findMany({
        where: includeSimulation ? {} : { isSimulation: false },
        include: {
          assignments: { where: { status: { not: 'CANCELLED' } }, select: { id: true } },
          locations: { orderBy: { recordedAt: 'asc' }, select: { recordedAt: true } },
        },
      });
      return rows.map((a) => ({
        ambulanceId: a.id,
        vehicleNumber: a.vehicleNumber,
        status: a.status,
        assignmentCount: a.assignments.length,
        isSimulation: a.isSimulation,
        minutesInField:
          a.locations.length >= 2
            ? Math.round(
                (a.locations[a.locations.length - 1]!.recordedAt.getTime() -
                  a.locations[0]!.recordedAt.getTime()) /
                  60000,
              )
            : 0,
      }));
    }, 'Failed to compute ambulance utilisation');
  }

  async countByStatus(includeSimulation: boolean): Promise<Record<string, number>> {
    return guardDatabase(async () => {
      const grouped = await this.db.ambulance.groupBy({
        by: ['status'],
        where: includeSimulation ? {} : { isSimulation: false },
        _count: { _all: true },
      });
      return Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    }, 'Failed to count ambulances by status');
  }

  async equipmentCodes(): Promise<Array<{ ambulanceId: string; equipment: string[] }>> {
    const rows = await this.db.ambulance.findMany({ select: { id: true, equipmentJson: true } });
    return rows.map((r) => ({ ambulanceId: r.id, equipment: parseStringArray(r.equipmentJson) }));
  }
}
