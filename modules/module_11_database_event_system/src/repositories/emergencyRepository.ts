import type { Prisma, PrismaClient } from '@prisma/client';
import {
  type Emergency,
  type SystemEventEnvelope,
  type SystemEventType,
  AppError,
  createId,
  defineEvent,
  emergencySeveritySchema,
  emergencyStatusSchema,
  incidentTypeSchema,
  isValidCoordinate,
} from '@resus/core';
import { guardDatabase, withTransaction } from '../db/client.js';
import { mapEmergency } from '../models/mappers.js';
import type { EventService } from '../events/eventService.js';

export interface EventCarrier {
  type: SystemEventType;
  payload: Record<string, unknown>;
}

export interface ActorContext {
  actorType?: string;
  actorId?: string | null;
}

export class EmergencyRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly events: EventService,
  ) {}

  async create(input: {
    incidentType: string;
    severity: string;
    latitude: number;
    longitude: number;
    description?: string | null;
    callerId?: string | null;
    address?: string | null;
    isSimulation?: boolean;
    actor?: ActorContext;
  }): Promise<Emergency> {
    if (!isValidCoordinate({ latitude: input.latitude, longitude: input.longitude })) {
      throw AppError.validation('Emergency coordinates are out of range.', {
        latitude: input.latitude,
        longitude: input.longitude,
      });
    }
    const incidentType = incidentTypeSchema.parse(input.incidentType);
    const severity = emergencySeveritySchema.parse(input.severity);
    const id = createId('EMG');

    const row = await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const created = await tx.emergency.create({
            data: {
              id,
              incidentType,
              severity,
              status: 'CREATED',
              latitude: input.latitude,
              longitude: input.longitude,
              description: input.description ?? null,
              callerId: input.callerId ?? null,
              address: input.address ?? null,
              isSimulation: input.isSimulation ?? false,
            },
          });
          await this.events.recordInTransaction(
            tx as never,
            defineEvent('EMERGENCY_CREATED', {
              emergencyId: id,
              entityType: 'emergency',
              entityId: id,
              actorType: input.actor?.actorType ?? 'SYSTEM',
              actorId: input.actor?.actorId ?? null,
              payload: {
                incidentType,
                severity,
                latitude: input.latitude,
                longitude: input.longitude,
                description: input.description ?? null,
                isSimulation: input.isSimulation ?? false,
              },
            }),
          );
          return created;
        }),
      'Failed to create emergency',
    );
    return mapEmergency(row as unknown as Record<string, unknown>);
  }

  async findById(id: string): Promise<Emergency | null> {
    return guardDatabase(async () => {
      const row = await this.db.emergency.findUnique({ where: { id } });
      return row ? mapEmergency(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read emergency');
  }

  async requireById(id: string): Promise<Emergency> {
    const emergency = await this.findById(id);
    if (!emergency) throw AppError.notFound('Emergency', id);
    return emergency;
  }

  async list(filter: {
    statuses?: string[];
    includeSimulation?: boolean;
    limit?: number;
    offset?: number;
    since?: string;
  } = {}): Promise<Emergency[]> {
    return guardDatabase(async () => {
      const where: Prisma.EmergencyWhereInput = {
        ...(filter.statuses?.length ? { status: { in: filter.statuses } } : {}),
        ...(filter.includeSimulation ? {} : { isSimulation: false }),
        ...(filter.since ? { createdAt: { gte: new Date(filter.since) } } : {}),
      };
      const rows = await this.db.emergency.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(filter.limit ?? 100, 500),
        skip: filter.offset ?? 0,
      });
      return rows.map((row) => mapEmergency(row as unknown as Record<string, unknown>));
    }, 'Failed to list emergencies');
  }

  async active(includeSimulation = false): Promise<Emergency[]> {
    return this.list({
      statuses: [
        'CREATED',
        'CALL_ACTIVE',
        'CLASSIFIED',
        'PROTOCOL_ACTIVE',
        'AWAITING_AMBULANCE',
        'AMBULANCE_ASSIGNED',
        'EN_ROUTE',
        'ON_SCENE',
        'PATIENT_ONBOARD',
        'TRANSPORTING',
        'AT_HOSPITAL',
      ],
      includeSimulation,
      limit: 200,
    });
  }

  /** Field patch with optional co-committed event, inside one transaction. */
  async update(
    id: string,
    patch: Partial<{
      status: string;
      incidentType: string;
      severity: string;
      description: string | null;
      assignedAmbulanceId: string | null;
      selectedHospitalId: string | null;
      address: string | null;
    }>,
    event?: EventCarrier,
    actor: ActorContext = {},
  ): Promise<Emergency> {
    const data: Prisma.EmergencyUpdateInput = {};
    const relations: Record<string, unknown> = {};

    if (patch.status !== undefined) data.status = emergencyStatusSchema.parse(patch.status);
    if (patch.incidentType !== undefined) data.incidentType = incidentTypeSchema.parse(patch.incidentType);
    if (patch.severity !== undefined) data.severity = emergencySeveritySchema.parse(patch.severity);
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.address !== undefined) data.address = patch.address;
    if (patch.assignedAmbulanceId !== undefined) {
      relations.assignedAmbulance = patch.assignedAmbulanceId
        ? { connect: { id: patch.assignedAmbulanceId } }
        : { disconnect: true };
    }
    if (patch.selectedHospitalId !== undefined) {
      relations.selectedHospital = patch.selectedHospitalId
        ? { connect: { id: patch.selectedHospitalId } }
        : { disconnect: true };
    }

    return this.mutate(id, data, relations, event, actor);
  }

  async setStatus(
    id: string,
    status: string,
    event?: EventCarrier,
    actor: ActorContext = {},
  ): Promise<Emergency> {
    const parsed = emergencyStatusSchema.parse(status);
    return this.mutate(id, { status: parsed }, {}, event, actor);
  }

  private async mutate(
    id: string,
    data: Prisma.EmergencyUpdateInput,
    relations: Record<string, unknown>,
    event: EventCarrier | undefined,
    actor: ActorContext,
  ): Promise<Emergency> {
    const row = await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const updated = await tx.emergency.update({
            where: { id },
            data: { ...data, ...relations } as Prisma.EmergencyUpdateInput,
          });
          if (event) {
            await this.events.recordInTransaction(
              tx as never,
              this.toEnvelope(event, id, actor),
            );
          }
          return updated;
        }),
      'Failed to update emergency',
    );
    return mapEmergency(row as unknown as Record<string, unknown>);
  }

  private toEnvelope(event: EventCarrier, emergencyId: string, actor: ActorContext): SystemEventEnvelope {
    return defineEvent(event.type, {
      emergencyId,
      entityType: 'emergency',
      entityId: emergencyId,
      actorType: actor.actorType ?? 'SYSTEM',
      actorId: actor.actorId ?? null,
      payload: event.payload as never,
    });
  }

  async groupedCount(
    field: 'status' | 'severity' | 'incidentType',
    includeSimulation: boolean,
  ): Promise<Record<string, number>> {
    return guardDatabase(async () => {
      const grouped = await this.db.emergency.groupBy({
        by: [field],
        where: includeSimulation ? {} : { isSimulation: false },
        _count: { _all: true },
      });
      return Object.fromEntries(grouped.map((g) => [String(g[field]), g._count._all]));
    }, `Failed to count emergencies by ${field}`);
  }
}
