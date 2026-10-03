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
  }): Promise<AmbulanceAssignment> {
    const id = createId('ASG');
    const row = await guardDatabase(
      async () =>
        this.db.ambulanceAssignment.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            ambulanceId: input.ambulanceId,
            status: 'ASSIGNED',
            source: input.source,
            distanceKm: input.distanceKm,
            estimatedResponseTimeMin: input.estimatedResponseTimeMin,
            score: input.score,
            matchingFactorsJson: JSON.stringify(input.matchingFactors),
            rejectedReasonsJson: JSON.stringify(input.rejectedReasons),
            overrideReason: input.overrideReason ?? null,
            consideredCandidates: input.consideredCandidates,
            decidedByUserId: input.decidedByUserId ?? null,
          },
        }),
      'Failed to persist ambulance assignment',
    );
    return mapAssignment(row as unknown as Record<string, unknown>);
  }

  async assignmentsForEmergency(emergencyId: string): Promise<AmbulanceAssignment[]> {
    return guardDatabase(async () => {
      const rows = await this.db.ambulanceAssignment.findMany({
        where: { emergencyId },
        orderBy: { decidedAt: 'asc' },
      });
      return rows.map((row) => mapAssignment(row as unknown as Record<string, unknown>));
    }, 'Failed to read assignments');
  }

  async activeAssignmentFor(ambulanceId: string): Promise<AmbulanceAssignment | null> {
    return guardDatabase(async () => {
      const row = await this.db.ambulanceAssignment.findFirst({
        where: { ambulanceId, status: 'ASSIGNED' },
        orderBy: { decidedAt: 'desc' },
      });
      return row ? mapAssignment(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read active assignment');
  }

  async releaseAssignments(ambulanceId: string): Promise<number> {
    return guardDatabase(
      async () =>
        this.db.ambulanceAssignment.updateMany({
          where: { ambulanceId, status: 'ASSIGNED' },
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
