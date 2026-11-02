import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppError, createId, defineEvent, ErrorCode } from '@resus/core';
import { guardDatabase, withTransaction } from '../db/client.js';
import type { EventService } from '../events/eventService.js';

export interface NotificationCreateInput {
  emergencyId: string;
  corridorId?: string | null;
  /** PUSH | SMS | VOICE | WEB | IN_APP */
  channel: string;
  /** Who was told, e.g. "NEARBY_ROAD_USERS". */
  audience: string;
  /** QUEUED | SENT | DELIVERED | FAILED | SUPPRESSED */
  status: string;
  provider: string;
  /** False unless a real provider confirmed delivery. */
  delivered: boolean;
  body: string;
  latitude?: number | null;
  longitude?: number | null;
  failureReason?: string | null;
}

export interface NotificationRecord {
  id: string;
  emergencyId: string;
  corridorId: string | null;
  channel: string;
  audience: string;
  status: string;
  provider: string;
  delivered: boolean;
  body: string;
  latitude: number | null;
  longitude: number | null;
  failureReason: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface PoliceRouteNotificationInput {
  createdByUserId: string;
  emergencyId: string;
  ambulanceId: string;
  routeId: string;
  provider: string;
  isLiveTraffic: boolean;
  routeIsSimulation: boolean;
  estimatedMinutes: number | null;
  geometry: Array<[number, number]>;
}

/**
 * Notification intents raised by a module (currently Module 9 corridors).
 *
 * A row records what was asked for and what happened: `delivered` is copied
 * verbatim from the provider, so a simulated provider that sends nothing always
 * leaves `delivered: false`. The write and its `NOTIFICATION_SENT` event share a
 * transaction, so a failed write cannot announce a notification that never was.
 */
export class NotificationRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly events: EventService,
  ) {}

  async create(input: NotificationCreateInput): Promise<NotificationRecord> {
    return guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const id = createId('NTF');
          const row = await tx.notification.create({
            data: {
              id,
              emergencyId: input.emergencyId,
              corridorId: input.corridorId ?? null,
              channel: input.channel,
              audience: input.audience,
              status: input.status,
              provider: input.provider,
              delivered: input.delivered,
              body: input.body,
              latitude: input.latitude ?? null,
              longitude: input.longitude ?? null,
              failureReason: input.failureReason ?? null,
            },
          });
          await this.events.recordInTransaction(
            tx as never,
            defineEvent('NOTIFICATION_SENT', {
              emergencyId: input.emergencyId,
              entityType: 'notification',
              entityId: id,
              payload: {
                notificationId: id,
                emergencyId: input.emergencyId,
                channel: input.channel,
                audience: input.audience,
                status: input.status,
                provider: input.provider,
                delivered: input.delivered,
              },
            }),
          );
          return toNotification(row as unknown as Record<string, unknown>);
        }),
      'Failed to record notification',
    );
  }

  async listForEmergency(emergencyId: string): Promise<NotificationRecord[]> {
    return guardDatabase(async () => {
      const rows = await this.db.notification.findMany({
        where: { emergencyId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => toNotification(row as unknown as Record<string, unknown>));
    }, 'Failed to list notifications');
  }

  /** Persists a local mock-control-room notice. No provider or network call is made. */
  async createPoliceRouteNotification(input: PoliceRouteNotificationInput): Promise<NotificationRecord> {
    const id = `NTF-${createHash('sha256').update(`${input.emergencyId}:${input.routeId}:MOCK_POLICE_CONTROL_ROOM`).digest('hex').slice(0, 24).toUpperCase()}`;
    try {
      return await guardDatabase(async () => withTransaction(this.db, async (tx) => {
        const existing = await tx.notification.findUnique({ where: { id } });
        if (existing) {
          const details = parsePoliceBody(existing.body);
          if (details?.routeId !== input.routeId || details?.simulation !== true || details?.recipient !== 'MOCK_POLICE_CONTROL_ROOM') {
            throw new AppError(ErrorCode.CONFLICT, 'A deterministic notification id is already associated with different route details.', 409);
          }
          return toNotification(existing as unknown as Record<string, unknown>);
        }

        const previous = await tx.notification.findMany({
          where: { emergencyId: input.emergencyId, audience: 'MOCK_POLICE_CONTROL_ROOM', provider: 'MOCK_POLICE_CONTROL_ROOM', status: 'SIMULATED_SENT' },
          orderBy: { createdAt: 'asc' },
        });
        const supersededAt = new Date();
        for (const candidate of previous) {
          const details = parsePoliceBody(candidate.body);
          if (details?.routeId === input.routeId) continue;
          const changed = await tx.notification.updateMany({
            where: { id: candidate.id, status: 'SIMULATED_SENT' },
            data: { status: 'SUPERSEDED' },
          });
          if (changed.count === 1) {
            await this.events.recordInTransaction(tx as never, defineEvent('SIMULATED_POLICE_NOTIFICATION_SUPERSEDED', {
              emergencyId: input.emergencyId,
              entityType: 'notification',
              entityId: candidate.id,
              actorType: 'MODULE',
              payload: {
                notificationId: candidate.id,
                emergencyId: input.emergencyId,
                supersededByNotificationId: id,
                supersededAt: supersededAt.toISOString(),
                simulation: true,
              },
            }));
          }
        }

        const createdAt = new Date();
        const body = JSON.stringify({
          version: 1,
          emergencyId: input.emergencyId,
          ambulanceId: input.ambulanceId,
          routeId: input.routeId,
          provider: input.provider,
          isLiveTraffic: input.isLiveTraffic,
          routeIsSimulation: input.routeIsSimulation,
          estimatedMinutes: input.estimatedMinutes,
          geometry: input.geometry,
          createdAt: createdAt.toISOString(),
          simulation: true,
          recipient: 'MOCK_POLICE_CONTROL_ROOM',
          delivered: false,
        });
        const row = await tx.notification.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            channel: 'IN_APP',
            audience: 'MOCK_POLICE_CONTROL_ROOM',
            status: 'SIMULATED_SENT',
            provider: 'MOCK_POLICE_CONTROL_ROOM',
            delivered: false,
            body,
            createdAt,
          },
        });
        await this.events.recordInTransaction(tx as never, defineEvent('SIMULATED_POLICE_NOTIFICATION_CREATED', {
          emergencyId: input.emergencyId,
          entityType: 'notification',
          entityId: id,
          actorType: 'OPERATOR',
          actorId: input.createdByUserId,
          payload: {
            notificationId: id,
            emergencyId: input.emergencyId,
            ambulanceId: input.ambulanceId,
            routeId: input.routeId,
            provider: 'MOCK_POLICE_CONTROL_ROOM',
            createdAt: createdAt.toISOString(),
            routeIsSimulation: input.routeIsSimulation,
            simulation: true,
            delivered: false,
          },
        }));
        return toNotification(row as unknown as Record<string, unknown>);
      }), 'Failed to persist simulated police notification');
    } catch (error) {
      // A concurrent duplicate can win the deterministic primary key. Return
      // the committed logical request and never append a second event.
      const existing = await this.findById(id);
      const details = existing ? parsePoliceBody(existing.body) : null;
      if (existing && details?.routeId === input.routeId && details.simulation === true && details.recipient === 'MOCK_POLICE_CONTROL_ROOM') return existing;
      throw error;
    }
  }

  async acknowledgePoliceRouteNotification(input: {
    emergencyId: string;
    notificationId: string;
    acknowledgedByUserId: string;
  }): Promise<NotificationRecord> {
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const current = await tx.notification.findUnique({ where: { id: input.notificationId } });
      if (!current || current.emergencyId !== input.emergencyId || current.audience !== 'MOCK_POLICE_CONTROL_ROOM' || current.provider !== 'MOCK_POLICE_CONTROL_ROOM') {
        throw AppError.notFound('Simulated police notification', input.notificationId);
      }
      if (current.status !== 'SIMULATED_SENT') {
        throw new AppError(ErrorCode.CONFLICT, 'Only a pending simulated notification can be acknowledged.', 409);
      }
      const details = parsePoliceBody(current.body);
      if (details?.simulation !== true || details.recipient !== 'MOCK_POLICE_CONTROL_ROOM' || typeof details.routeId !== 'string') {
        throw new AppError(ErrorCode.CONFLICT, 'Notification is not a recognized simulated control-room request.', 409);
      }
      const acknowledgedAt = new Date();
      const updated = await tx.notification.updateMany({
        where: { id: input.notificationId, status: 'SIMULATED_SENT' },
        data: { status: 'ACKNOWLEDGED_SIMULATED' },
      });
      if (updated.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Notification status changed before acknowledgement.', 409);
      await this.events.recordInTransaction(tx as never, defineEvent('SIMULATED_POLICE_NOTIFICATION_ACKNOWLEDGED', {
        emergencyId: input.emergencyId,
        entityType: 'notification',
        entityId: input.notificationId,
        actorType: 'OPERATOR',
        actorId: input.acknowledgedByUserId,
        payload: {
          notificationId: input.notificationId,
          emergencyId: input.emergencyId,
          routeId: details.routeId,
          acknowledgedByUserId: input.acknowledgedByUserId,
          acknowledgedAt: acknowledgedAt.toISOString(),
          simulation: true,
        },
      }));
      const row = await tx.notification.findUniqueOrThrow({ where: { id: input.notificationId } });
      return toNotification(row as unknown as Record<string, unknown>);
    }), 'Failed to acknowledge simulated police notification');
  }

  private async findById(id: string): Promise<NotificationRecord | null> {
    return guardDatabase(async () => {
      const row = await this.db.notification.findUnique({ where: { id } });
      return row ? toNotification(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read notification');
  }
}

export function parsePoliceBody(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toNotification(row: Record<string, unknown>): NotificationRecord {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    corridorId: (row.corridorId as string) ?? null,
    channel: String(row.channel),
    audience: String(row.audience),
    status: String(row.status),
    provider: String(row.provider),
    delivered: Boolean(row.delivered),
    body: String(row.body),
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    failureReason: (row.failureReason as string) ?? null,
    createdAt: new Date(row.createdAt as string).toISOString(),
    sentAt: row.sentAt == null ? null : new Date(row.sentAt as string).toISOString(),
  };
}
