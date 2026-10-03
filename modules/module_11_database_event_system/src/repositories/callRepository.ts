import type { PrismaClient } from '@prisma/client';
import { type Transcript, AppError, createId, defineEvent, isValidCoordinate } from '@resus/core';
import { guardDatabase, withTransaction } from '../db/client.js';
import type { EventService } from '../events/eventService.js';

export interface CallSessionRecord {
  id: string;
  emergencyId: string;
  channel: string;
  callerId: string | null;
  status: string;
  language: string;
  startedAt: string;
  endedAt: string | null;
  isSimulation: boolean;
}

export interface TranscriptRecord extends Transcript {
  id: string;
  callSessionId: string;
  emergencyId: string;
  sequence: number;
  recordedAt: string;
  isSimulation: boolean;
}

/**
 * Call sessions and transcripts.
 *
 * STT output is stored verbatim: the transcript is the primary record of what
 * the bystander actually said, and the LLM's interpretation of it is stored
 * alongside as structured facts rather than replacing it.
 */
export class CallRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly events: EventService,
  ) {}

  async startSession(input: {
    emergencyId: string;
    channel?: string;
    callerId?: string | null;
    language?: string;
    isSimulation?: boolean;
  }): Promise<CallSessionRecord> {
    const id = createId('CALL');
    const row = await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const created = await tx.callSession.create({
            data: {
              id,
              emergencyId: input.emergencyId,
              channel: input.channel ?? 'VOICE',
              callerId: input.callerId ?? null,
              language: input.language ?? 'en',
              isSimulation: input.isSimulation ?? false,
            },
          });
          await this.events.recordInTransaction(
            tx as never,
            defineEvent('CALL_STARTED', {
              emergencyId: input.emergencyId,
              entityType: 'call_session',
              entityId: id,
              payload: {
                callSessionId: id,
                channel: input.channel ?? 'VOICE',
                callerId: input.callerId ?? null,
              },
            }),
          );
          return created;
        }),
      'Failed to start call session',
    );
    return toCallSession(row as unknown as Record<string, unknown>);
  }

  async appendTranscript(input: {
    callSessionId: string;
    emergencyId: string;
    speaker: string;
    text: string;
    isFinal?: boolean;
    intent?: string | null;
    confidence?: number | null;
    isSimulation?: boolean;
  }): Promise<TranscriptRecord> {
    const id = createId('TRN');
    const row = await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const last = await tx.transcript.findFirst({
            where: { callSessionId: input.callSessionId },
            orderBy: { sequence: 'desc' },
            select: { sequence: true },
          });
          const sequence = (last?.sequence ?? 0) + 1;
          const created = await tx.transcript.create({
            data: {
              id,
              callSessionId: input.callSessionId,
              emergencyId: input.emergencyId,
              sequence,
              speaker: input.speaker,
              text: input.text,
              isFinal: input.isFinal ?? true,
              intent: input.intent ?? null,
              confidence: input.confidence ?? null,
              isSimulation: input.isSimulation ?? false,
            },
          });
          await this.events.recordInTransaction(
            tx as never,
            defineEvent('TRANSCRIPT_UPDATED', {
              emergencyId: input.emergencyId,
              entityType: 'transcript',
              entityId: id,
              payload: {
                transcriptId: id,
                speaker: input.speaker,
                text: input.text,
                isFinal: input.isFinal ?? true,
                sequence,
              },
            }),
          );
          return created;
        }),
      'Failed to append transcript',
    );
    return toTranscript(row as unknown as Record<string, unknown>);
  }

  async transcriptsFor(emergencyId: string): Promise<TranscriptRecord[]> {
    return guardDatabase(async () => {
      const rows = await this.db.transcript.findMany({
        where: { emergencyId },
        orderBy: { sequence: 'asc' },
      });
      return rows.map((row) => toTranscript(row as unknown as Record<string, unknown>));
    }, 'Failed to list transcripts');
  }

  async sessionById(id: string): Promise<CallSessionRecord | null> {
    return guardDatabase(async () => {
      const row = await this.db.callSession.findUnique({ where: { id } });
      return row ? toCallSession(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read call session');
  }

  async requireSessionFor(emergencyId: string): Promise<CallSessionRecord> {
    const row = await this.db.callSession.findFirst({
      where: { emergencyId },
      orderBy: { startedAt: 'desc' },
    });
    if (!row) throw AppError.notFound('Call session for emergency', emergencyId);
    return toCallSession(row as unknown as Record<string, unknown>);
  }

  async endSession(id: string): Promise<CallSessionRecord | null> {
    return guardDatabase(async () => {
      const row = await this.db.callSession.update({
        where: { id },
        data: { status: 'ENDED', endedAt: new Date() },
      });
      return toCallSession(row as unknown as Record<string, unknown>);
    }, 'Failed to end call session');
  }
}

function toCallSession(row: Record<string, unknown>): CallSessionRecord {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    channel: String(row.channel),
    callerId: (row.callerId as string) ?? null,
    status: String(row.status),
    language: String(row.language),
    startedAt: new Date(row.startedAt as string).toISOString(),
    endedAt: row.endedAt ? new Date(row.endedAt as string).toISOString() : null,
    isSimulation: Boolean(row.isSimulation),
  };
}

function toTranscript(row: Record<string, unknown>): TranscriptRecord {
  return {
    id: String(row.id),
    callSessionId: String(row.callSessionId),
    emergencyId: String(row.emergencyId),
    sequence: Number(row.sequence),
    speaker: String(row.speaker) as TranscriptRecord['speaker'],
    text: String(row.text),
    isFinal: Boolean(row.isFinal),
    intent: (row.intent as string) ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    recordedAt: new Date(row.recordedAt as string).toISOString(),
    isSimulation: Boolean(row.isSimulation),
  };
}

export interface RouteRecord {
  id: string;
  emergencyId: string;
  ambulanceId: string;
  hospitalId: string | null;
  originName: string;
  destinationName: string;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  distanceKm: number;
  polyline: Array<[number, number]>;
  progressPct: number;
  status: string;
  estimatedMinutes: number | null;
  isSimulation: boolean;
}

/** Planned routes and their progress trail, plus the emergency-corridor record. */
export class RouteRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly events: EventService,
  ) {}

  async createRoute(input: {
    emergencyId: string;
    ambulanceId: string;
    hospitalId?: string | null;
    originName?: string;
    destinationName: string;
    origin: { latitude: number; longitude: number };
    destination: { latitude: number; longitude: number };
    distanceKm: number;
    polyline?: Array<[number, number]>;
    estimatedMinutes?: number | null;
    isSimulation?: boolean;
  }): Promise<RouteRecord> {
    if (
      !isValidCoordinate(input.origin) ||
      !isValidCoordinate(input.destination)
    ) {
      throw AppError.validation('Route endpoints are out of range.');
    }
    const id = createId('RTE');
    const row = await guardDatabase(
      async () =>
        this.db.route.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            ambulanceId: input.ambulanceId,
            hospitalId: input.hospitalId ?? null,
            originName: input.originName ?? 'INCIDENT',
            destinationName: input.destinationName,
            originLat: input.origin.latitude,
            originLng: input.origin.longitude,
            destLat: input.destination.latitude,
            destLng: input.destination.longitude,
            distanceKm: input.distanceKm,
            polylineJson: JSON.stringify(input.polyline ?? []),
            estimatedMinutes: input.estimatedMinutes ?? null,
            isSimulation: input.isSimulation ?? false,
          },
        }),
      'Failed to create route',
    );
    return toRoute(row as unknown as Record<string, unknown>);
  }

  async updateProgress(input: {
    routeId: string;
    progressPct: number;
    positionLat?: number | null;
    positionLng?: number | null;
    remainingKm?: number | null;
    emergencyId: string;
    note?: string | null;
  }): Promise<RouteRecord> {
    const clamped = Math.max(0, Math.min(100, input.progressPct));
    const row = await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const route = await tx.route.update({
            where: { id: input.routeId },
            data: { progressPct: clamped, status: clamped >= 100 ? 'COMPLETED' : 'ACTIVE' },
          });
          await tx.routeUpdate.create({
            data: {
              id: createId('RTU'),
              routeId: input.routeId,
              progressPct: clamped,
              positionLat: input.positionLat ?? null,
              positionLng: input.positionLng ?? null,
              remainingKm: input.remainingKm ?? null,
              note: input.note ?? null,
            },
          });
          await this.events.recordInTransaction(
            tx as never,
            defineEvent('ROUTE_UPDATED', {
              emergencyId: input.emergencyId,
              entityType: 'route',
              entityId: input.routeId,
              payload: { routeId: input.routeId, emergencyId: input.emergencyId, progressPct: clamped },
            }),
          );
          return route;
        }),
      'Failed to update route progress',
    );
    return toRoute(row as unknown as Record<string, unknown>);
  }

  async routesForEmergency(emergencyId: string): Promise<RouteRecord[]> {
    return guardDatabase(async () => {
      const rows = await this.db.route.findMany({
        where: { emergencyId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => toRoute(row as unknown as Record<string, unknown>));
    }, 'Failed to list routes');
  }

  async activateCorridor(input: {
    emergencyId: string;
    ambulanceId: string;
    hospitalId: string;
    fromLabel: string;
    toLabel: string;
    estimatedMinutes: number;
    isSimulation?: boolean;
  }): Promise<{ id: string; isActive: boolean }> {
    const id = createId('COR');
    await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          await tx.corridor.upsert({
            where: { emergencyId: input.emergencyId },
            create: {
              id,
              emergencyId: input.emergencyId,
              ambulanceId: input.ambulanceId,
              hospitalId: input.hospitalId,
              fromLabel: input.fromLabel,
              toLabel: input.toLabel,
              estimatedMinutes: input.estimatedMinutes,
              isSimulation: input.isSimulation ?? false,
            },
            update: { isActive: true, releasedAt: null, activatedAt: new Date() },
          });
          await this.events.recordInTransaction(
            tx as never,
            defineEvent('CORRIDOR_ACTIVATED', {
              emergencyId: input.emergencyId,
              entityType: 'corridor',
              entityId: input.emergencyId,
              payload: {
                emergencyId: input.emergencyId,
                ambulanceId: input.ambulanceId,
                hospitalId: input.hospitalId,
                from: input.fromLabel,
                to: input.toLabel,
                estimatedMinutes: input.estimatedMinutes,
              },
            }),
          );
        }),
      'Failed to activate corridor',
    );
    return { id, isActive: true };
  }

  async releaseCorridor(emergencyId: string): Promise<void> {
    await guardDatabase(
      async () => {
        await this.db.corridor.updateMany({
          where: { emergencyId, isActive: true },
          data: { isActive: false, releasedAt: new Date() },
        });
      },
      'Failed to release corridor',
    );
  }

  async activeCorridorFor(emergencyId: string): Promise<{ id: string; estimatedMinutes: number } | null> {
    return guardDatabase(async () => {
      const row = await this.db.corridor.findUnique({ where: { emergencyId } });
      if (!row || !row.isActive) return null;
      return { id: row.id, estimatedMinutes: row.estimatedMinutes };
    }, 'Failed to read corridor');
  }
}

function toRoute(row: Record<string, unknown>): RouteRecord {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    ambulanceId: String(row.ambulanceId),
    hospitalId: (row.hospitalId as string) ?? null,
    originName: String(row.originName),
    destinationName: String(row.destinationName),
    originLat: Number(row.originLat),
    originLng: Number(row.originLng),
    destLat: Number(row.destLat),
    destLng: Number(row.destLng),
    distanceKm: Number(row.distanceKm),
    polyline: JSON.parse(String(row.polylineJson ?? '[]')) as Array<[number, number]>,
    progressPct: Number(row.progressPct),
    status: String(row.status),
    estimatedMinutes: row.estimatedMinutes == null ? null : Number(row.estimatedMinutes),
    isSimulation: Boolean(row.isSimulation),
  };
}
