import type { PrismaClient } from '@prisma/client';
import {
  type Coordinate,
  type Transcript,
  AppError,
  createId,
  defineEvent,
  isValidCoordinate,
  type SystemEventEnvelope,
} from '@resus/core';
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
    /**
     * Transport-assigned id, when the caller has one.
     *
     * A real telephony provider allocates the call-leg id before this row is
     * written and can only hang that leg up by the same id, so Module 1 passes
     * the provider's handle id through. Callers without a transport (the
     * loopback provider, direct repository tests) omit it and get a generated
     * one, exactly as before.
     */
    id?: string;
    emergencyId: string;
    channel?: string;
    callerId?: string | null;
    language?: string;
    isSimulation?: boolean;
  }): Promise<CallSessionRecord> {
    const id = input.id ?? createId('CALL');
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

  /**
   * Sessions still marked ACTIVE, oldest first.
   *
   * Scoped by status rather than by `endedAt` because a row can reach ACTIVE
   * without an end time when a process dies between the two writes; the status
   * column is the one that is always updated.
   */
  async activeSessions(): Promise<CallSessionRecord[]> {
    return guardDatabase(async () => {
      const rows = await this.db.callSession.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { startedAt: 'asc' },
      });
      return rows.map((row) => toCallSession(row as unknown as Record<string, unknown>));
    }, 'Failed to list active call sessions');
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
  /** Routing provider that produced the route (`mock`, `osrm`, …). */
  provider: string;
  /** False unless a provider with a live traffic feed produced the route. */
  isLiveTraffic: boolean;
  trafficFactor: number | null;
  /** Alternatives the provider considered but did not select. */
  alternatives: unknown[];
  /** Why the selected route won, as written by the provider. */
  selectionReason: Record<string, unknown> | null;
  recalculationCount: number;
}

export interface CreateRouteInput {
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
  provider?: string;
  isLiveTraffic?: boolean;
  trafficFactor?: number | null;
  alternatives?: unknown[];
  selectionReason?: Record<string, unknown> | null;
}

function routeCreateData(id: string, input: CreateRouteInput) {
  return {
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
    provider: input.provider ?? 'mock',
    isLiveTraffic: input.isLiveTraffic ?? false,
    trafficFactor: input.trafficFactor ?? null,
    alternativesJson: JSON.stringify(input.alternatives ?? []),
    selectionReasonJson: JSON.stringify(input.selectionReason ?? {}),
  };
}

export interface CorridorRecord {
  id: string;
  emergencyId: string;
  ambulanceId: string;
  hospitalId: string;
  fromLabel: string;
  toLabel: string;
  estimatedMinutes: number;
  isActive: boolean;
  activatedAt: string;
  releasedAt: string | null;
  isSimulation: boolean;
  status: string;
  priorityMode: string;
  radiusM: number;
  geofence: Array<[number, number]>;
  roadUsers: unknown[];
  signals: unknown[];
  renegotiationCount: number;
}

export interface CorridorActivationInput {
  emergencyId: string;
  ambulanceId: string;
  hospitalId: string;
  fromLabel: string;
  toLabel: string;
  estimatedMinutes: number;
  isSimulation?: boolean;
  /** `SIMULATED` | `NOTIFY_ONLY` | `INTEGRATED`. Defaults to `SIMULATED`. */
  priorityMode?: string;
  radiusM?: number;
  /** Corridor centre line; stored as a JSON array of `[lat,lng]` points. */
  geofence?: Coordinate[];
  /** Simulated road-user detections (stored as JSON verbatim). */
  roadUsers?: unknown;
  /** Junctions where priority was requested (stored as JSON verbatim). */
  signals?: unknown;
}

export interface CorridorActivationResult {
  id: string;
  status: string;
  isActive: boolean;
  /** False when an active corridor for this emergency already existed. */
  activated: boolean;
}

export interface CorridorReleaseResult {
  released: boolean;
}

/** Planned routes and their progress trail, plus the emergency-corridor record. */
export class RouteRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly events: EventService,
  ) {}

  async createRoute(input: CreateRouteInput): Promise<RouteRecord> {
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
          data: routeCreateData(id, input),
        }),
      'Failed to create route',
    );
    return toRoute(row as unknown as Record<string, unknown>);
  }

  /** Route row and its success event commit or roll back as one unit. */
  async createRouteWithEvent(
    input: CreateRouteInput,
    eventFor: (route: RouteRecord) => SystemEventEnvelope,
  ): Promise<RouteRecord> {
    if (!isValidCoordinate(input.origin) || !isValidCoordinate(input.destination)) {
      throw AppError.validation('Route endpoints are out of range.');
    }
    const id = createId('RTE');
    return guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const row = await tx.route.create({ data: routeCreateData(id, input) });
          const route = toRoute(row as unknown as Record<string, unknown>);
          await this.events.recordInTransaction(tx as never, eventFor(route));
          return route;
        }),
      'Failed to create route and event',
    );
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

  /**
   * Replaces an established route's geometry/ETA in place and records the
   * recalculation event in the same transaction. Route identity (id, emergency,
   * ambulance, hospital, leg labels) is preserved; only provider output fields
   * change and `recalculationCount` increments. The event commits only with
   * the replacement write.
   */
  async replaceRouteWithEvent(
    routeId: string,
    update: {
      distanceKm: number;
      polyline?: Array<[number, number]>;
      estimatedMinutes?: number | null;
      provider?: string;
      isLiveTraffic?: boolean;
      trafficFactor?: number | null;
      alternatives?: unknown[];
      selectionReason?: Record<string, unknown> | null;
    },
    eventFor: (
      route: RouteRecord,
      previous: { distanceKm: number; estimatedMinutes: number | null },
    ) => SystemEventEnvelope,
  ): Promise<RouteRecord> {
    return guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const current = await tx.route.findUnique({ where: { id: routeId } });
          if (!current) throw AppError.notFound('Route', routeId);
          const previous = {
            distanceKm: Number(current.distanceKm),
            estimatedMinutes:
              current.estimatedMinutes == null ? null : Number(current.estimatedMinutes),
          };
          const data: Record<string, unknown> = {
            distanceKm: update.distanceKm,
            recalculationCount: { increment: 1 },
          };
          if (update.polyline !== undefined) data.polylineJson = JSON.stringify(update.polyline);
          if (update.estimatedMinutes !== undefined) data.estimatedMinutes = update.estimatedMinutes;
          if (update.provider !== undefined) data.provider = update.provider;
          if (update.isLiveTraffic !== undefined) data.isLiveTraffic = update.isLiveTraffic;
          if (update.trafficFactor !== undefined) data.trafficFactor = update.trafficFactor;
          if (update.alternatives !== undefined) {
            data.alternativesJson = JSON.stringify(update.alternatives);
          }
          if (update.selectionReason !== undefined) {
            data.selectionReasonJson = JSON.stringify(update.selectionReason ?? {});
          }
          const updated = await tx.route.update({ where: { id: routeId }, data });
          const route = toRoute(updated as unknown as Record<string, unknown>);
          await this.events.recordInTransaction(
            tx as never,
            eventFor(route, previous),
          );
          return route;
        }),
      'Failed to replace route',
    );
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

  async findById(id: string): Promise<RouteRecord | null> {
    return guardDatabase(async () => {
      const row = await this.db.route.findUnique({ where: { id } });
      return row ? toRoute(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read route');
  }

  async requireById(id: string): Promise<RouteRecord> {
    const route = await this.findById(id);
    if (!route) throw AppError.notFound('Route', id);
    return route;
  }

  /**
   * Activates (or re-activates) the emergency corridor.
   *
   * Idempotent: when an `ACTIVE` corridor already exists for the emergency, no
   * write and **no event** occur, so a retried or duplicated activation cannot
   * append a second `CORRIDOR_ACTIVATED`. The row and its event are written in
   * one transaction, so a failed write can never emit a success event.
   */
  async activateCorridor(input: CorridorActivationInput): Promise<CorridorActivationResult> {
    const geofenceJson = JSON.stringify(
      (input.geofence ?? []).map((point) => [point.latitude, point.longitude]),
    );
    const roadUsersJson = JSON.stringify(input.roadUsers ?? []);
    const signalsJson = JSON.stringify(input.signals ?? []);
    const priorityMode = input.priorityMode ?? 'SIMULATED';
    const radiusM = input.radiusM ?? 150;

    return guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const existing = await tx.corridor.findUnique({
            where: { emergencyId: input.emergencyId },
          });
          if (existing && existing.isActive && existing.status === 'ACTIVE') {
            return { id: existing.id, status: existing.status, isActive: true, activated: false };
          }

          const now = new Date();
          const data = {
            ambulanceId: input.ambulanceId,
            hospitalId: input.hospitalId,
            fromLabel: input.fromLabel,
            toLabel: input.toLabel,
            estimatedMinutes: input.estimatedMinutes,
            isActive: true,
            status: 'ACTIVE',
            priorityMode,
            radiusM,
            geofenceJson,
            roadUsersJson,
            signalsJson,
            isSimulation: input.isSimulation ?? false,
            activatedAt: now,
            releasedAt: null,
          };
          const row = existing
            ? await tx.corridor.update({ where: { emergencyId: input.emergencyId }, data })
            : await tx.corridor.create({
                data: { id: createId('COR'), emergencyId: input.emergencyId, ...data },
              });

          await this.events.recordInTransaction(
            tx as never,
            defineEvent('CORRIDOR_ACTIVATED', {
              emergencyId: input.emergencyId,
              entityType: 'corridor',
              entityId: row.id,
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
          return { id: row.id, status: 'ACTIVE', isActive: true, activated: true };
        }),
      'Failed to activate corridor',
    );
  }

  /**
   * Releases the emergency corridor.
   *
   * Idempotent: releasing when no corridor is active is a no-op that emits no
   * event. The state change and its `CORRIDOR_RELEASED` event share a
   * transaction, so a rolled-back release cannot announce itself.
   */
  async releaseCorridor(emergencyId: string, reason = 'RELEASED'): Promise<CorridorReleaseResult> {
    return guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const existing = await tx.corridor.findUnique({ where: { emergencyId } });
          if (!existing || !existing.isActive) return { released: false };

          const now = new Date();
          const durationMs = Math.max(0, now.getTime() - existing.activatedAt.getTime());
          await tx.corridor.update({
            where: { emergencyId },
            data: { isActive: false, status: 'RELEASED', releasedAt: now },
          });
          await this.events.recordInTransaction(
            tx as never,
            defineEvent('CORRIDOR_RELEASED', {
              emergencyId,
              entityType: 'corridor',
              entityId: existing.id,
              payload: { corridorId: existing.id, emergencyId, durationMs, reason },
            }),
          );
          return { released: true };
        }),
      'Failed to release corridor',
    );
  }

  /** Full persisted corridor state for an emergency, or null. */
  async getCorridor(emergencyId: string): Promise<CorridorRecord | null> {
    return guardDatabase(async () => {
      const row = await this.db.corridor.findUnique({ where: { emergencyId } });
      return row ? toCorridor(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read corridor');
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
    provider: String(row.provider ?? 'mock'),
    isLiveTraffic: Boolean(row.isLiveTraffic),
    trafficFactor: row.trafficFactor == null ? null : Number(row.trafficFactor),
    alternatives: parseJsonArray(row.alternativesJson),
    selectionReason: parseJsonObject(row.selectionReasonJson),
    recalculationCount: Number(row.recalculationCount ?? 0),
  };
}

function toCorridor(row: Record<string, unknown>): CorridorRecord {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    ambulanceId: String(row.ambulanceId),
    hospitalId: String(row.hospitalId),
    fromLabel: String(row.fromLabel),
    toLabel: String(row.toLabel),
    estimatedMinutes: Number(row.estimatedMinutes),
    isActive: Boolean(row.isActive),
    activatedAt: new Date(row.activatedAt as string).toISOString(),
    releasedAt: row.releasedAt == null ? null : new Date(row.releasedAt as string).toISOString(),
    isSimulation: Boolean(row.isSimulation),
    status: String(row.status),
    priorityMode: String(row.priorityMode),
    radiusM: Number(row.radiusM),
    geofence: parseJsonArray(row.geofenceJson) as Array<[number, number]>,
    roadUsers: parseJsonArray(row.roadUsersJson),
    signals: parseJsonArray(row.signalsJson),
    renegotiationCount: Number(row.renegotiationCount ?? 0),
  };
}

function parseJsonArray(value: unknown): unknown[] {
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
