import type { PrismaClient } from '@prisma/client';
import {
  type Decision,
  type Outcome,
  type ProtocolSession,
  type ProtocolStepRecord,
  type ProtocolSessionStatus,
  type ProtocolStepStatus,
  type SystemEventType,
  AppError,
  ErrorCode,
  createId,
  defineEvent,
  noopLogger,
  type Logger,
} from '@resus/core';
import { guardDatabase, withTransaction } from '../db/client.js';
import { mapDecision, mapOutcome, mapProtocolSession, mapProtocolStep } from '../models/mappers.js';
import type { EventService } from '../events/eventService.js';

export interface NewProtocolSessionInput {
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
}

export class ProtocolRepository {
  private readonly logger: Logger;

  constructor(
    private readonly db: PrismaClient,
    private readonly events: EventService,
    logger: Logger = noopLogger,
  ) {
    this.logger = logger;
  }

  async createSession(input: NewProtocolSessionInput): Promise<ProtocolSession> {
    const id = createId('PSE');
    const row = await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const created = await tx.protocolSession.create({
            data: {
              id,
              emergencyId: input.emergencyId,
              protocolId: input.protocolId,
              protocolVersion: input.protocolVersion,
              protocolSource: input.protocolSource,
              currentStep: input.currentStep,
              status: 'ACTIVE',
              collectedFactsJson: '{}',
              initiatedBy: input.startedBy ?? 'SYSTEM',
              initiatedByUserId: input.initiatedByUserId ?? null,
              llmProvider: input.llmProvider ?? 'ollama',
              llmModel: input.llmModel ?? 'qwen3:8b',
              degraded: input.degraded ?? false,
            },
          });
          await this.events.recordInTransaction(
            tx as never,
            defineEvent('PROTOCOL_STARTED', {
              emergencyId: input.emergencyId,
              entityType: 'protocol_session',
              entityId: id,
              payload: {
                protocolSessionId: id,
                protocolId: input.protocolId,
                protocolVersion: input.protocolVersion,
                source: input.protocolSource,
              },
            }),
          );
          return created;
        }),
      'Failed to start protocol session',
    );
    return mapProtocolSession(row as unknown as Record<string, unknown>);
  }

  async findSessionById(id: string): Promise<ProtocolSession | null> {
    return guardDatabase(async () => {
      const row = await this.db.protocolSession.findUnique({ where: { id } });
      return row ? mapProtocolSession(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read protocol session');
  }

  /** `ProtocolSessionPort` name for `findSessionById`. */
  async getSession(id: string): Promise<ProtocolSession | null> {
    return this.findSessionById(id);
  }

  /** `ProtocolSessionPort` name for `sessionForEmergency`. */
  async listSessionsForEmergency(emergencyId: string): Promise<ProtocolSession[]> {
    return this.sessionForEmergency(emergencyId);
  }

  async requireSession(id: string): Promise<ProtocolSession> {
    const session = await this.findSessionById(id);
    if (!session) throw new AppError(ErrorCode.NOT_FOUND, `Protocol session '${id}' was not found.`, 404);
    return session;
  }

  async sessionForEmergency(emergencyId: string): Promise<ProtocolSession[]> {
    return guardDatabase(async () => {
      const rows = await this.db.protocolSession.findMany({
        where: { emergencyId },
        orderBy: { startedAt: 'desc' },
      });
      return rows.map((row) => mapProtocolSession(row as unknown as Record<string, unknown>));
    }, 'Failed to list protocol sessions');
  }

  /**
   * Applies a state transition and the event describing it atomically.
   * `steps` carries the step bookkeeping produced by the protocol engine.
   */
  async applyTransition(input: {
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
  }): Promise<{ session: ProtocolSession; steps: ProtocolStepRecord[] }> {
    const result = await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const session = await tx.protocolSession.update({
            where: { id: input.sessionId },
            data: {
              currentStep: input.currentStep,
              status: input.status,
              completedAt: input.completedAt ?? undefined,
              escalationRequired: input.escalationRequired,
              escalationReason: input.escalationReason,
              clarificationCount: input.clarificationCount,
              collectedFactsJson: input.collectedFacts
                ? JSON.stringify(input.collectedFacts)
                : undefined,
              degraded: input.degraded,
            },
          });

          for (const step of input.steps ?? []) {
            await tx.protocolStep.upsert({
              where: { protocolSessionId_stepId: { protocolSessionId: input.sessionId, stepId: step.stepId } },
              create: {
                id: createId('PST'),
                protocolSessionId: input.sessionId,
                stepId: step.stepId,
                orderIndex: step.orderIndex,
                status: step.status,
                presentedAt: step.presentedAt ?? null,
                completedAt: step.completedAt ?? null,
                resultJson: step.result ? JSON.stringify(step.result) : null,
              },
              update: {
                status: step.status,
                orderIndex: step.orderIndex,
                presentedAt: step.presentedAt ?? undefined,
                completedAt: step.completedAt ?? undefined,
                resultJson: step.result ? JSON.stringify(step.result) : undefined,
              },
            });
          }

          for (const event of input.events) {
            await this.events.recordInTransaction(
              tx as never,
              defineEvent(event.type, {
                emergencyId: input.emergencyId,
                entityType: 'protocol_session',
                entityId: input.sessionId,
                payload: event.payload as never,
              }),
            );
          }
          return session;
        }),
      'Failed to apply protocol transition',
    );

    const steps = await this.stepsForSession(input.sessionId);
    return { session: mapProtocolSession(result as unknown as Record<string, unknown>), steps };
  }

  async stepsForSession(protocolSessionId: string): Promise<ProtocolStepRecord[]> {
    return guardDatabase(async () => {
      const rows = await this.db.protocolStep.findMany({
        where: { protocolSessionId },
        orderBy: { orderIndex: 'asc' },
      });
      return rows.map((row) => mapProtocolStep(row as unknown as Record<string, unknown>));
    }, 'Failed to read protocol steps');
  }

  async protocolStats(includeSimulation: boolean): Promise<{
    total: number;
    completed: number;
    escalated: number;
    cancelled: number;
  }> {
    return guardDatabase(async () => {
      const emergencyFilter = includeSimulation ? {} : { emergency: { isSimulation: false } };
      const rows = await this.db.protocolSession.findMany({
        where: emergencyFilter,
        select: { status: true, escalationRequired: true },
      });
      return {
        total: rows.length,
        completed: rows.filter((r) => r.status === 'COMPLETED').length,
        escalated: rows.filter((r) => r.status === 'ESCALATED' || r.escalationRequired).length,
        cancelled: rows.filter((r) => r.status === 'CANCELLED').length,
      };
    }, 'Failed to compute protocol statistics');
  }
}

export class DecisionRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(input: {
    emergencyId: string;
    decisionType: string;
    ambulanceId?: string | null;
    hospitalId?: string | null;
    optionsConsidered: unknown[];
    chosen: string;
    reasoning: string;
    confidence: number;
    actorType?: string;
    actorId?: string | null;
  }): Promise<Decision> {
    const id = createId('DEC');
    const row = await guardDatabase(
      async () =>
        this.db.decision.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            decisionType: input.decisionType,
            ambulanceId: input.ambulanceId ?? null,
            hospitalId: input.hospitalId ?? null,
            optionsConsideredJson: JSON.stringify(input.optionsConsidered ?? []),
            chosen: input.chosen,
            reasoning: input.reasoning,
            confidence: input.confidence,
            actorType: input.actorType ?? 'SYSTEM',
            actorId: input.actorId ?? null,
          },
        }),
      'Failed to persist decision',
    );
    return mapDecision(row as unknown as Record<string, unknown>);
  }

  async forEmergency(emergencyId: string): Promise<Decision[]> {
    return guardDatabase(async () => {
      const rows = await this.db.decision.findMany({
        where: { emergencyId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => mapDecision(row as unknown as Record<string, unknown>));
    }, 'Failed to list decisions');
  }
}

export class OutcomeRepository {
  constructor(private readonly db: PrismaClient) {}

  async upsert(input: {
    emergencyId: string;
    status: string;
    provenance: string;
    survivalToDischarge?: boolean | null;
    notes?: string | null;
    recordedByUserId?: string | null;
  }): Promise<Outcome> {
    const row = await guardDatabase(
      async () =>
        this.db.outcome.upsert({
          where: { emergencyId: input.emergencyId },
          create: {
            id: createId('OUT'),
            emergencyId: input.emergencyId,
            status: input.status,
            provenance: input.provenance,
            survivalToDischarge: input.survivalToDischarge ?? null,
            notes: input.notes ?? null,
            recordedByUserId: input.recordedByUserId ?? null,
          },
          update: {
            status: input.status,
            provenance: input.provenance,
            survivalToDischarge: input.survivalToDischarge ?? undefined,
            notes: input.notes ?? undefined,
            recordedByUserId: input.recordedByUserId ?? undefined,
            recordedAt: new Date(),
          },
        }),
      'Failed to persist outcome',
    );
    return mapOutcome(row as unknown as Record<string, unknown>);
  }

  async forEmergency(emergencyId: string): Promise<Outcome | null> {
    return guardDatabase(async () => {
      const row = await this.db.outcome.findUnique({ where: { emergencyId } });
      return row ? mapOutcome(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read outcome');
  }

  async list(filter: { since?: string; includeSimulation?: boolean } = {}): Promise<Outcome[]> {
    return guardDatabase(async () => {
      const rows = await this.db.outcome.findMany({
        where: {
          ...(filter.since ? { recordedAt: { gte: new Date(filter.since) } } : {}),
          ...(filter.includeSimulation ? {} : { emergency: { isSimulation: false } }),
        },
        orderBy: { recordedAt: 'desc' },
      });
      return rows.map((row) => mapOutcome(row as unknown as Record<string, unknown>));
    }, 'Failed to list outcomes');
  }
}
