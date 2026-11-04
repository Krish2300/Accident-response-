import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  type Emergency,
  type SystemEventRecord,
  type SystemEventEnvelope,
  type SystemEventType,
  AppError,
  ErrorCode,
  createId,
  defineEvent,
  emergencySeveritySchema,
  emergencyStatusSchema,
  incidentTypeSchema,
  isValidCoordinate,
} from '@resus/core';
import { guardDatabase, withTransaction } from '../db/client.js';
import { mapEmergency, mapSystemEvent } from '../models/mappers.js';
import type { EventService } from '../events/eventService.js';

export interface EventCarrier {
  type: SystemEventType;
  payload: Record<string, unknown>;
}

export interface ActorContext {
  actorType?: string;
  actorId?: string | null;
}

export type LifecycleMilestoneType =
  | 'AMBULANCE_ARRIVED_SCENE'
  | 'PATIENT_ONBOARD'
  | 'AMBULANCE_ARRIVED_HOSPITAL'
  | 'EMERGENCY_COMPLETED';

export interface RecordedLifecycleMilestone {
  event: SystemEventRecord;
  duplicate: boolean;
}

export interface CallerLocationCandidateInput {
  emergencyId: string;
  locationText: string;
  provider: string;
  outcome: 'CANDIDATE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE' | 'INVALID_RESULT';
  confidence: number | null;
  latitude: number | null;
  longitude: number | null;
  attempt?: number;
}

/**
 * Allots the next case number for the current year: `<PREFIX>-<YYYY>-<NNNNNN>`.
 * Runs inside the creating transaction (and transactions are serialised on
 * SQLite), and the column is UNIQUE, so two calls can never share a number.
 */
async function nextCaseNumber(tx: { emergency: { findFirst(args: unknown): Promise<{ caseNumber: string | null } | null> } }): Promise<string> {
  const prefix = (process.env.CASE_NUMBER_PREFIX ?? 'SBM').replace(/[^A-Z0-9]/gi, '').toUpperCase() || 'SBM';
  const year = new Date().getFullYear();
  const stem = `${prefix}-${year}-`;
  const last = await tx.emergency.findFirst({
    where: { caseNumber: { startsWith: stem } },
    orderBy: { caseNumber: 'desc' },
    select: { caseNumber: true },
  });
  const lastSeq = last?.caseNumber ? Number(last.caseNumber.slice(stem.length)) : 0;
  return `${stem}${String((Number.isFinite(lastSeq) ? lastSeq : 0) + 1).padStart(6, '0')}`;
}

export class EmergencyRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly events: EventService,
    private readonly nodeEnv?: string,
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
          const caseNumber = await nextCaseNumber(tx as never);
          const created = await tx.emergency.create({
            data: {
              id,
              caseNumber,
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

  async findByCaseNumber(caseNumber: string): Promise<Emergency | null> {
    return guardDatabase(async () => {
      const row = await this.db.emergency.findUnique({ where: { caseNumber: caseNumber.trim().toUpperCase() } });
      return row ? mapEmergency(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read emergency by case number');
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

  /** Persist caller-stated geocoding output as an append-only candidate. */
  async recordCallerLocationCandidate(input: CallerLocationCandidateInput): Promise<SystemEventRecord> {
    const emergency = await this.requireById(input.emergencyId);
    const normalized = input.locationText.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
    const attempt = Math.max(1, Math.floor(input.attempt ?? 1));
    const resolutionId = `LOC-${createHash('sha256').update(`${input.emergencyId}:${normalized}:${attempt}`).digest('hex')}`;
    if ((input.latitude === null) !== (input.longitude === null) ||
        (input.latitude !== null && !isValidCoordinate({ latitude: input.latitude, longitude: input.longitude! }))) {
      throw AppError.validation('The location provider returned invalid coordinates.');
    }
    const previous = await this.events.getById(resolutionId);
    if (previous) return previous;
    const event = defineEvent('EMERGENCY_LOCATION_CANDIDATE', {
      eventId: resolutionId,
      emergencyId: input.emergencyId,
      entityType: 'emergency_location_resolution',
      entityId: resolutionId,
      actorType: 'SYSTEM',
      payload: {
        resolutionId,
        callerLocationText: input.locationText.trim(),
        attempt,
        source: 'CALLER_STATED',
        provider: input.provider,
        outcome: input.outcome,
        confidence: input.confidence,
        candidateLatitude: input.latitude,
        candidateLongitude: input.longitude,
        isSimulation: emergency.isSimulation,
      },
    });
    try {
      return await this.events.record(event);
    } catch (error) {
      const duplicate = await this.events.getById(resolutionId);
      if (duplicate?.type === 'EMERGENCY_LOCATION_CANDIDATE' && duplicate.emergencyId === input.emergencyId) return duplicate;
      throw error;
    }
  }

  /** Operator-confirmed coordinates are applied atomically with their provenance event. */
  async confirmCallerLocation(input: {
    emergencyId: string;
    resolutionId: string;
    actorId: string;
    latitude?: number;
    longitude?: number;
  }): Promise<{ emergency: Emergency; event: SystemEventRecord; duplicate: boolean }> {
    const candidate = await this.events.getById(input.resolutionId);
    if (!candidate || candidate.type !== 'EMERGENCY_LOCATION_CANDIDATE' || candidate.emergencyId !== input.emergencyId) {
      throw AppError.notFound('Caller location candidate', input.resolutionId);
    }
    const payload = candidate.payload as Record<string, unknown>;
    const candidateLatitude = typeof payload.candidateLatitude === 'number' ? payload.candidateLatitude : null;
    const candidateLongitude = typeof payload.candidateLongitude === 'number' ? payload.candidateLongitude : null;
    const latitude = input.latitude ?? candidateLatitude;
    const longitude = input.longitude ?? candidateLongitude;
    if (latitude === undefined || longitude === undefined || latitude === null || longitude === null ||
        !isValidCoordinate({ latitude, longitude })) {
      throw AppError.validation('A valid latitude and longitude are required to confirm this caller-stated location.');
    }
    const confirmationId = `LOCCONF-${createHash('sha256').update(input.resolutionId).digest('hex')}`;
    const existing = await this.events.getById(confirmationId);
    if (existing) return { emergency: await this.requireById(input.emergencyId), event: existing, duplicate: true };
    try {
      return await guardDatabase(() => withTransaction(this.db, async (tx) => {
      const row = await tx.emergency.update({
        where: { id: input.emergencyId },
        data: { latitude, longitude, address: String(payload.callerLocationText ?? '') },
      });
      const isSimulation = Boolean(row.isSimulation);
      const event = await this.events.recordInTransaction(tx as never, defineEvent('EMERGENCY_LOCATION_CONFIRMED', {
        eventId: confirmationId,
        emergencyId: input.emergencyId,
        entityType: 'emergency',
        entityId: input.emergencyId,
        actorType: 'OPERATOR',
        actorId: input.actorId,
        payload: {
          resolutionId: input.resolutionId,
          callerLocationText: String(payload.callerLocationText ?? ''),
          source: latitude === candidateLatitude && longitude === candidateLongitude ? 'CALLER_STATED' : 'OPERATOR_SUPPLIED',
          provider: String(payload.provider ?? 'unknown'),
          confidence: typeof payload.confidence === 'number' ? payload.confidence : null,
          candidateLatitude,
          candidateLongitude,
          confirmedLatitude: latitude,
          confirmedLongitude: longitude,
          confirmedByUserId: input.actorId,
          confirmedAt: new Date().toISOString(),
          isSimulation,
        },
      }));
      return { emergency: mapEmergency(row as unknown as Record<string, unknown>), event, duplicate: false };
      }), 'Failed to confirm caller-stated location');
    } catch (error) {
      const duplicate = await this.events.getById(confirmationId);
      if (duplicate?.type === 'EMERGENCY_LOCATION_CONFIRMED' && duplicate.emergencyId === input.emergencyId) {
        return { emergency: await this.requireById(input.emergencyId), event: duplicate, duplicate: true };
      }
      throw error;
    }
  }

  /**
   * Records an explicit operator attestation in Module 11's append-only event
   * log. No emergency/ambulance status is changed and no operational action is
   * invoked. A stable event ID makes retries idempotent per emergency/milestone.
   */
  async recordLifecycleMilestone(input: {
    emergencyId: string;
    milestone: LifecycleMilestoneType;
    actorId: string;
    actorRole: string;
  }): Promise<RecordedLifecycleMilestone> {
    const eventId = `M10M-${createHash('sha256').update(`${input.emergencyId}:${input.milestone}`).digest('hex')}`;
    try {
      return await guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const existing = await tx.systemEvent.findUnique({ where: { id: eventId } });
      if (existing) {
        const record = mapSystemEvent(existing as unknown as Record<string, unknown>);
        if (record.emergencyId !== input.emergencyId || record.type !== input.milestone) {
          throw new AppError(ErrorCode.CONFLICT, 'The lifecycle milestone idempotency key is already in use.', 409);
        }
        return { event: record, duplicate: true };
      }

      const emergency = await tx.emergency.findUnique({ where: { id: input.emergencyId } });
      if (!emergency) throw AppError.notFound('Emergency', input.emergencyId);
      const related = await tx.systemEvent.findMany({
        where: {
          emergencyId: input.emergencyId,
          type: { in: [
            'AMBULANCE_DISPATCHED', 'AMBULANCE_ARRIVED_SCENE', 'PATIENT_ONBOARD',
            'HOSPITAL_SELECTED', 'AMBULANCE_ARRIVED_HOSPITAL',
          ] },
        },
        orderBy: { seq: 'asc' },
      });
      const records = related.map((row) => mapSystemEvent(row as unknown as Record<string, unknown>));
      const payloadOf = (record: SystemEventRecord) => record.payload as Record<string, unknown>;
      const ambulanceId = emergency.assignedAmbulanceId;
      if (!ambulanceId) throw new AppError(ErrorCode.CONFLICT, 'A currently assigned ambulance is required to record this milestone.', 409);
      const selectedHospitalId = emergency.selectedHospitalId;
      const dispatchRecord = records.find((record) => record.type === 'AMBULANCE_DISPATCHED' && payloadOf(record).ambulanceId === ambulanceId);
      const sceneRecord = records.find((record) => record.type === 'AMBULANCE_ARRIVED_SCENE' && payloadOf(record).ambulanceId === ambulanceId);
      const onboardRecord = records.find((record) => record.type === 'PATIENT_ONBOARD' && payloadOf(record).ambulanceId === ambulanceId);
      const selectedHospitalRecord = records.find((record) => record.type === 'HOSPITAL_SELECTED' && payloadOf(record).hospitalId === selectedHospitalId);
      const hospitalArrivalRecord = records.find((record) => record.type === 'AMBULANCE_ARRIVED_HOSPITAL' &&
        payloadOf(record).ambulanceId === ambulanceId && payloadOf(record).hospitalId === selectedHospitalId);

      switch (input.milestone) {
        case 'AMBULANCE_ARRIVED_SCENE':
          if (!dispatchRecord) throw new AppError(ErrorCode.CONFLICT, 'A persisted dispatch for the currently assigned ambulance is required before scene arrival can be recorded.', 409);
          break;
        case 'PATIENT_ONBOARD':
          if (!sceneRecord || !dispatchRecord || sceneRecord.sequence <= dispatchRecord.sequence) {
            throw new AppError(ErrorCode.CONFLICT, 'An operator-reported scene arrival after dispatch for the currently assigned ambulance is required before patient onboard can be recorded.', 409);
          }
          break;
        case 'AMBULANCE_ARRIVED_HOSPITAL':
          if (!onboardRecord || !sceneRecord || onboardRecord.sequence <= sceneRecord.sequence) {
            throw new AppError(ErrorCode.CONFLICT, 'An operator-reported patient onboard milestone after scene arrival is required before hospital arrival can be recorded.', 409);
          }
          if (!selectedHospitalId || !selectedHospitalRecord) throw new AppError(ErrorCode.CONFLICT, 'A persisted hospital selection event is required before hospital arrival can be recorded.', 409);
          break;
        case 'EMERGENCY_COMPLETED':
          if (!hospitalArrivalRecord || !onboardRecord || hospitalArrivalRecord.sequence <= onboardRecord.sequence) {
            throw new AppError(ErrorCode.CONFLICT, 'An operator-reported hospital arrival after patient onboard at the selected hospital is required before operational completion can be recorded.', 409);
          }
          break;
      }

      const observedAt = new Date();
      const observedAtIso = observedAt.toISOString();
      const dispatchMs = dispatchRecord ? Date.parse(dispatchRecord.timestamp) : Number.NaN;
      const responseTimeMin = Number.isFinite(dispatchMs)
        ? Math.max(0, Math.round(((observedAt.getTime() - dispatchMs) / 60_000) * 100) / 100)
        : 0;
      const totalDurationMin = Math.max(0, Math.round(((observedAt.getTime() - emergency.createdAt.getTime()) / 60_000) * 100) / 100);
      const dataClassification = emergency.isSimulation ? 'SIMULATION' as const : this.nodeEnv === 'test' ? 'TEST' as const : 'OPERATIONAL' as const;
      const payload = (() => {
        switch (input.milestone) {
          case 'AMBULANCE_ARRIVED_SCENE':
            return { ambulanceId, emergencyId: input.emergencyId, responseTimeMin, evidenceSource: 'OPERATOR_REPORTED' as const, observedAt: observedAtIso, dataClassification };
          case 'PATIENT_ONBOARD':
            return { ambulanceId, emergencyId: input.emergencyId, hospitalId: selectedHospitalId ?? null, evidenceSource: 'OPERATOR_REPORTED' as const, observedAt: observedAtIso, dataClassification };
          case 'AMBULANCE_ARRIVED_HOSPITAL':
            return { ambulanceId, emergencyId: input.emergencyId, hospitalId: selectedHospitalId!, evidenceSource: 'OPERATOR_REPORTED' as const, observedAt: observedAtIso, dataClassification };
          case 'EMERGENCY_COMPLETED':
            return { emergencyId: input.emergencyId, totalDurationMin, status: 'COMPLETED', isSimulation: emergency.isSimulation, evidenceSource: 'OPERATOR_REPORTED' as const, observedAt: observedAtIso, dataClassification };
        }
      })();
      const event = defineEvent(input.milestone, {
        eventId,
        emergencyId: input.emergencyId,
        entityType: 'emergency',
        entityId: input.emergencyId,
        actorType: input.actorRole,
        actorId: input.actorId,
        payload: payload as never,
      });
      const record = await this.events.recordInTransaction(tx as never, event);
      return { event: record, duplicate: false };
      }), 'Failed to record lifecycle milestone');
    } catch (error) {
      // The unique event ID is the concurrency boundary. If another request
      // committed the same milestone while this transaction was in flight,
      // return that persisted record instead of creating a duplicate.
      if (error instanceof AppError && error.statusCode === 409) {
        const existing = await this.events.getById(eventId);
        if (existing?.emergencyId === input.emergencyId && existing.type === input.milestone) {
          return { event: existing, duplicate: true };
        }
      }
      throw error;
    }
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
