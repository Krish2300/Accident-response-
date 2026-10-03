import type { Prisma, PrismaClient } from '@prisma/client';
import {
  type Database,
  type EventPublisherPort,
  type EventQueryPort,
  type Logger,
  type SystemEventEnvelope,
  type SystemEventRecord,
  type SystemEventType,
  AppError,
  ErrorCode,
  createId,
  isSystemEventType,
  noopLogger,
} from '@resus/core';
import { guardDatabase } from '../db/client.js';
import { bufferRecord, currentScope, registerCommitSink } from '../db/transactionScope.js';
import { mapSystemEvent } from '../models/mappers.js';
import { DomainEventBus } from './bus.js';

export interface EventServiceDeps {
  db: PrismaClient;
  bus: DomainEventBus;
  logger?: Logger;
  maxPageSize?: number;
}

export interface RecordContext {
  emergencyId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The append-only event log.
 *
 * Responsibilities, in one place so the whole system has a single event spine:
 *  1. persist an event (autoincrement `seq` gives total order),
 *  2. fan it out to in-process subscribers and to the real-time bus,
 *  3. serve replay / timeline queries.
 *
 * Write path invariant: a domain state change and the event describing it are
 * written inside the same transaction (`recordInTransaction`).
 */
export class EventService implements EventPublisherPort, EventQueryPort {
  private readonly db: PrismaClient;
  private readonly bus: DomainEventBus;
  private readonly logger: Logger;
  private readonly maxPageSize: number;

  constructor(deps: EventServiceDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.logger = deps.logger ?? noopLogger;
    this.maxPageSize = deps.maxPageSize ?? 500;
    // Transaction-scoped buffer drains through this service, so a committed
    // transaction broadcasts exactly the events it wrote.
    registerCommitSink((records) => this.publishCommitted(records));
  }

  // -- write ------------------------------------------------------------------

  async record(
    event: SystemEventEnvelope,
    context: RecordContext = {},
  ): Promise<SystemEventRecord> {
    return guardDatabase(async () => {
      const row = await this.db.systemEvent.create({ data: toCreateData(event, context) });
      const record = mapSystemEvent(row as unknown as Record<string, unknown>);
      this.afterCommit(record);
      return record;
    }, 'Failed to append system event');
  }

  async recordMany(
    events: SystemEventEnvelope[],
    context: RecordContext = {},
  ): Promise<SystemEventRecord[]> {
    if (events.length === 0) return [];
    return guardDatabase(async () => {
      // `createMany` cannot return rows on SQLite, so the batch is written inside
      // a single transaction to keep the sequence contiguous.
      const rows = await this.db.$transaction(
        events.map((event) => this.db.systemEvent.create({ data: toCreateData(event, context) })),
      );
      const records = rows.map((row) => mapSystemEvent(row as unknown as Record<string, unknown>));
      records.forEach((record) => this.afterCommit(record));
      return records;
    }, 'Failed to append system events');
  }

  /**
   * Joins the caller's transaction. Nothing is broadcast until the enclosing
   * `withTransaction` commits, so subscribers never observe an event for state
   * that was rolled back.
   *
   * When called outside a transaction the event is broadcast immediately, since
   * there is nothing to wait for.
   */
  async recordInTransaction(db: Database, event: SystemEventEnvelope): Promise<SystemEventRecord> {
    const client = db as unknown as PrismaClient;
    const row = await client.systemEvent.create({ data: toCreateData(event, {}) });
    const record = mapSystemEvent(row as unknown as Record<string, unknown>);
    if (currentScope()) {
      bufferRecord(record);
    } else {
      this.afterCommit(record);
    }
    return record;
  }

  /**
   * @deprecated Broadcasting is handled by the transaction scope. This is kept as
   * a no-op so existing call sites keep compiling; the buffer is drained and
   * broadcast by `withTransaction` on commit.
   */
  async flushPending(): Promise<void> {
    const scope = currentScope();
    // Only reachable when a repository flushes inside an open transaction, which
    // would publish before commit. Leave the records buffered; the scope drains
    // them once the transaction actually commits.
    if (scope && scope.records.length > 0) return;
  }

  /**
   * Broadcasts records that a committed transaction buffered. Registered as the
   * scope's commit sink, so it runs only after a successful commit.
   */
  async publishCommitted(records: SystemEventRecord[]): Promise<void> {
    for (const record of records) {
      this.afterCommit(record);
    }
  }

  // -- read -------------------------------------------------------------------

  async list(filter: {
    emergencyId?: string;
    types?: SystemEventType[];
    sinceSequence?: number;
    since?: string;
    until?: string;
    entityId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: SystemEventRecord[]; total: number; latestSequence: number }> {
    return guardDatabase(async () => {
      const where: Prisma.SystemEventWhereInput = {
        ...(filter.emergencyId ? { emergencyId: filter.emergencyId } : {}),
        ...(filter.types?.length ? { type: { in: filter.types } } : {}),
        ...(filter.entityId ? { entityId: filter.entityId } : {}),
        ...(filter.sinceSequence !== undefined ? { seq: { gt: filter.sinceSequence } } : {}),
        ...(filter.since || filter.until
          ? {
              recordedAt: {
                ...(filter.since ? { gte: new Date(filter.since) } : {}),
                ...(filter.until ? { lte: new Date(filter.until) } : {}),
              },
            }
          : {}),
      };
      const limit = Math.min(filter.limit ?? 100, this.maxPageSize);
      const offset = filter.offset ?? 0;

      const [rows, total, latest] = await Promise.all([
        this.db.systemEvent.findMany({ where, orderBy: { seq: 'asc' }, take: limit, skip: offset }),
        this.db.systemEvent.count({ where }),
        this.db.systemEvent.aggregate({ _max: { seq: true } }),
      ]);

      return {
        items: rows.map((row) => mapSystemEvent(row as unknown as Record<string, unknown>)),
        total,
        latestSequence: latest._max.seq ?? 0,
      };
    }, 'Failed to query system events');
  }

  async getById(id: string): Promise<SystemEventRecord | null> {
    return guardDatabase(async () => {
      const row = await this.db.systemEvent.findUnique({ where: { id } });
      return row ? mapSystemEvent(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read system event');
  }

  /** Full ordered timeline for one emergency. Never hand-written. */
  async timeline(emergencyId: string): Promise<SystemEventRecord[]> {
    const result = await this.list({ emergencyId, limit: this.maxPageSize });
    return result.items;
  }

  // -- internals --------------------------------------------------------------

  private afterCommit(record: SystemEventRecord): void {
    this.bus.publish(record);
  }
}

function toCreateData(event: SystemEventEnvelope, context: RecordContext) {
  if (!isSystemEventType(event.type)) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Unknown system event type '${String(event.type)}'.`,
      422,
    );
  }
  return {
    id: createId('EVT'),
    type: event.type,
    emergencyId: event.emergencyId ?? context.emergencyId ?? null,
    entityType: event.entityType ?? null,
    entityId: event.entityId ?? null,
    payloadJson: JSON.stringify(event.payload ?? {}),
    metadataJson: context.metadata ? JSON.stringify(context.metadata) : null,
    actorType: event.actorType ?? 'SYSTEM',
    actorId: event.actorId ?? null,
  };
}
