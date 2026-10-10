/**
 * Port interfaces.
 *
 * These are the seams between modules. A module never imports another module's
 * ORM models, HTTP handlers or internals — it receives a port implementation
 * from the composition root (`apps/server`).
 */
import type { SystemEventEnvelope, SystemEventRecord, SystemEventType } from './domain/events.js';
export type { SystemEventEnvelope, SystemEventRecord, SystemEventType } from './domain/events.js';
import type { ProtocolSession, ProtocolStepRecord } from './domain/models.js';
import type { ProtocolSessionStatus, ProtocolStepStatus } from './domain/enums.js';

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Clock {
  now(): Date;
  nowIso(): string;
}

/**
 * Transaction handle. Prisma's `PrismaClient` (or its transaction client)
 * satisfies this shape structurally, so repositories accept a `Database` and
 * never need to know whether they run inside a transaction.
 */
export interface Database {
  // Deliberately opaque: only Module 11 knows the concrete client type.
  readonly __database: unique symbol;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export type TransactionalDatabase = Database;

/**
 * Outbound event port implemented by Module 11.
 *
 * `record` must persist the event and broadcast it on the real-time bus.
 * `recordInTransaction` must join the caller's transaction so that a state
 * change and its event commit atomically (specification section 21).
 */
export interface EventPublisherPort {
  record(
    event: SystemEventEnvelope,
    context?: { emergencyId?: string | null; metadata?: Record<string, unknown> },
  ): Promise<SystemEventRecord>;
  recordMany(
    events: SystemEventEnvelope[],
    context?: { emergencyId?: string | null; metadata?: Record<string, unknown> },
  ): Promise<SystemEventRecord[]>;
  recordInTransaction(db: Database, event: SystemEventEnvelope): Promise<SystemEventRecord>;
}

/** Read access to the append-only log. */
export interface EventQueryPort {
  list(filter: {
    emergencyId?: string;
    types?: SystemEventType[];
    sinceSequence?: number;
    since?: string;
    until?: string;
    entityId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: SystemEventRecord[]; total: number; latestSequence: number }>;
  getById(id: string): Promise<SystemEventRecord | null>;
  timeline(emergencyId: string): Promise<SystemEventRecord[]>;
}

/**
 * Protocol-session persistence, as Module 5 needs it.
 *
 * Module 5 owns protocol *decisions*; Module 11 owns protocol *rows*. The
 * transition method takes the engine's own output, so neither side can be
 * adjusted independently: the session state, the step bookkeeping and the
 * events commit together, or none of them do.
 */
export interface ProtocolSessionPort {
  createSession(input: {
    emergencyId: string;
    protocolId: string;
    protocolVersion: string;
    protocolSource: string;
    currentStep: string;
    startedBy?: string;
    initiatedByUserId?: string | null;
    llmProvider?: string;
    llmModel?: string;
    degraded?: boolean;
  }): Promise<ProtocolSession>;
  getSession(id: string): Promise<ProtocolSession | null>;
  listSessionsForEmergency(emergencyId: string): Promise<ProtocolSession[]>;
  stepsForSession(protocolSessionId: string): Promise<ProtocolStepRecord[]>;
  /**
   * Atomically writes the new session state, the step rows and the events that
   * describe the transition. Implemented by Module 11 with a single transaction.
   */
  applyTransition(input: {
    sessionId: string;
    emergencyId: string;
    currentStep: string;
    status: ProtocolSessionStatus;
    completedAt?: Date | null;
    escalationRequired?: boolean;
    escalationReason?: string | null;
    clarificationCount?: number;
    collectedFacts?: Record<string, unknown>;
    degraded?: boolean;
    steps?: Array<{
      stepId: string;
      orderIndex: number;
      status: ProtocolStepStatus;
      presentedAt?: Date | null;
      completedAt?: Date | null;
      result?: Record<string, unknown> | null;
    }>;
    events: Array<{ type: SystemEventType; payload: Record<string, unknown> }>;
  }): Promise<{ session: ProtocolSession; steps: ProtocolStepRecord[] }>;
}

/**
 * Real-time fan-out port. Implemented by the WebSocket hub in `apps/server`.
 * Modules only ever *publish*; they never hold socket handles.
 */
export interface RealtimePublisherPort {
  publish(channel: RealtimeChannel, message: RealtimeMessage): void;
  subscriberCount(channel: RealtimeChannel): number;
}

export const REALTIME_CHANNELS = [
  'system',
  'emergencies',
  'ambulances',
  'protocols',
  'hospitals',
  'routes',
  'corridors',
  'events',
] as const;
export type RealtimeChannel = (typeof REALTIME_CHANNELS)[number];

export interface RealtimeMessage {
  kind: 'snapshot' | 'event' | 'patch' | 'heartbeat' | 'error';
  /** Event type when the message was produced by the event log. */
  eventType?: SystemEventType;
  channel: RealtimeChannel;
  payload: unknown;
  sequence?: number;
  timestamp: string;
  /** Present when the payload originates from the simulation harness. */
  isSimulation?: boolean;
}

/** In-process pub/sub used for cross-module reactions. */
export interface DomainEventBusPort {
  subscribe<T extends SystemEventType>(
    types: T[],
    handler: (event: SystemEventRecord) => void | Promise<void>,
  ): () => void;
  publish(event: SystemEventRecord): void;
}

/**
 * Read-only projection port for Module 12.
 *
 * Implemented by Module 11 as a set of query objects. Module 12 depends on this
 * interface, not on tables, and can never write through it.
 */
export interface AnalyticsReadPort {
  dashboardSummary(windowDays: number, includeSimulation: boolean): Promise<unknown>;
  emergencyDurations(windowDays: number, includeSimulation: boolean): Promise<unknown>;
  liveState(includeSimulation: boolean): Promise<unknown>;
  eventBreakdown(windowDays: number, includeSimulation: boolean): Promise<unknown>;
  learningSamples(options: { windowDays: number; includeSimulation: boolean }): Promise<unknown[]>;
  snapshotSeries(days: number): Promise<unknown[]>;
}


export interface RouteOptimizationPort {
  optimizeRoute(input: {
    from: { latitude: number; longitude: number };
    to: { latitude: number; longitude: number };
    ambulanceId?: string;
    emergencyId?: string;
    isSimulation?: boolean;
  }): Promise<{
    routeId: string;
    distanceKm: number;
    estimatedMinutes: number;
    polyline?: unknown[];
    provider: string;
    isLiveTraffic: boolean;
  }>;
}

export interface CorridorIntegrationPort {
  activateCorridor(input: {
    emergencyId: string;
    ambulanceId: string;
    hospitalId: string;
    from: string;
    to: string;
  }): Promise<{ ok: boolean }>;
}

