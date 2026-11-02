import type { PrismaClient, EmergencyOutcomeGrant } from '@prisma/client';
import {
  type Decision,
  type Outcome,
  outcomeStatusSchema,
  DATA_PROVENANCE,
  type OutcomeStatus,
  type DataProvenance,
  OUTCOME_CORRECTION_REASON_CODES,
  OUTCOME_REVIEW_REASON_CODES,
  type OutcomeCorrectionReasonCode,
  type ProtocolSession,
  type ProtocolStepRecord,
  type ProtocolSessionStatus,
  type ProtocolStepStatus,
  type SystemEventType,
  type SystemEventRecord,
  AppError,
  ErrorCode,
  createId,
  defineEvent,
  noopLogger,
  type Logger,
} from '@resus/core';
import { guardDatabase, withTransaction } from '../db/client.js';
import { mapDecision, mapOutcome, mapProtocolSession, mapProtocolStep, mapSystemEvent } from '../models/mappers.js';
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

export type OutcomeDataClassification = 'OPERATIONAL' | 'SIMULATION' | 'TEST' | 'UNVERIFIED_LEGACY';
export type OutcomeReviewDecision = 'APPROVED' | 'REJECTED' | 'NEEDS_EVIDENCE';

export const OUTCOME_ACCESS_CAPABILITIES = ['SUBMIT', 'REVIEW'] as const;
export type OutcomeAccessCapability = (typeof OUTCOME_ACCESS_CAPABILITIES)[number];
export type OutcomeScopeCapability = OutcomeAccessCapability | 'READ';

/** Audit event types emitted by the outcome access grant lifecycle. */
export const OUTCOME_GRANT_EVENT_TYPES = ['OUTCOME_GRANTED', 'OUTCOME_GRANT_REVOKED'] as const;

export interface OutcomeAssertionRecord {
  id: string;
  emergencyId: string;
  category: OutcomeStatus;
  categoryVersion: string;
  provenance: DataProvenance;
  dataClassification: OutcomeDataClassification;
  survivalToDischarge: boolean | null;
  observedAt: string | null;
  recordedAt: string;
  submittedByUserId: string | null;
  evidenceRefs: string[] | null;
  correctionReasonCode: OutcomeCorrectionReasonCode | null;
  idempotencyKey: string;
  supersedesOutcomeId: string | null;
}

export interface OutcomeHistoryRecord extends OutcomeAssertionRecord {
  isCurrent: boolean;
  reviewStatus: OutcomeReviewDecision | 'PENDING';
  predecessorId: string | null;
  successorId: string | null;
  reviews: Array<OutcomeReviewRecord & { isCurrent: boolean }>;
}

export interface OutcomeReviewRecord {
  id: string;
  outcomeRecordId: string;
  reviewerUserId: string;
  decision: OutcomeReviewDecision;
  reviewReasonCode: OutcomeReviewReasonCode | null;
  reviewedAt: string;
  eligibleForLearning: boolean;
  eligibilityReasonCode: string;
  evidenceAssessment: Record<string, unknown> | null;
  idempotencyKey: string;
  supersedesReviewId: string | null;
}

export interface OutcomeGrantRecord {
  id: string;
  emergencyId: string;
  granteeUserId: string;
  capability: OutcomeAccessCapability;
  grantedByUserId: string;
  createdAt: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
}

export class OutcomeRepository {
  constructor(private readonly db: PrismaClient, private readonly events?: EventService) {}

  async recordAssertion(input: {
    emergencyId: string;
    category: OutcomeStatus;
    categoryVersion: string;
    provenance: DataProvenance;
    dataClassification: OutcomeDataClassification;
    survivalToDischarge?: boolean | null;
    observedAt?: string | null;
    submittedByUserId?: string | null;
    evidenceRefs?: string[] | null;
    correctionReasonCode?: OutcomeCorrectionReasonCode | null;
    idempotencyKey: string;
    supersedesOutcomeId?: string | null;
  }): Promise<OutcomeAssertionRecord> {
    const normalized = normalizeOutcomeAssertion(input);
    const events = this.requireEvents();
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const existing = await tx.outcomeAssertion.findUnique({ where: { idempotencyKey: normalized.idempotencyKey } });
      if (existing) {
        if (!sameAssertion(existing, normalized)) throw AppErrorConflict('Outcome idempotency key was already used for different content.');
        return mapOutcomeAssertion(existing);
      }

      const emergency = await tx.emergency.findUnique({ where: { id: normalized.emergencyId }, select: { isSimulation: true } });
      if (!emergency) throw AppError.notFound('Emergency', normalized.emergencyId);
      enforceOutcomeClassification(normalized, emergency.isSimulation);

      if (normalized.supersedesOutcomeId) {
        const predecessor = await tx.outcomeAssertion.findFirst({
          where: { id: normalized.supersedesOutcomeId, emergencyId: normalized.emergencyId },
        });
        if (!predecessor) throw AppError.validation('Correction predecessor must belong to the same emergency.');
        const successor = await tx.outcomeAssertion.findUnique({ where: { supersedesOutcomeId: normalized.supersedesOutcomeId } });
        if (successor) throw AppErrorConflict('Outcome assertion already has a correction successor.');
      }

      const row = await tx.outcomeAssertion.create({ data: {
        id: createId('OUTA'), emergencyId: normalized.emergencyId, category: normalized.category,
        categoryVersion: normalized.categoryVersion, provenance: normalized.provenance,
        dataClassification: normalized.dataClassification, survivalToDischarge: normalized.survivalToDischarge,
        observedAt: normalized.observedAt, submittedByUserId: normalized.submittedByUserId,
        evidenceRefsJson: normalized.evidenceRefs ? JSON.stringify(normalized.evidenceRefs) : null,
        correctionReasonCode: normalized.correctionReasonCode,
        idempotencyKey: normalized.idempotencyKey, supersedesOutcomeId: normalized.supersedesOutcomeId,
      } });
      await events.recordInTransaction(tx as never, defineEvent('OUTCOME_RECORDED', {
        eventId: `EVT-OUTCOME-${row.id}`,
        emergencyId: row.emergencyId,
        entityType: 'outcome_assertion',
        entityId: row.id,
        actorType: row.submittedByUserId ? 'OPERATOR' : 'SYSTEM',
        actorId: row.submittedByUserId,
        payload: {
          contractVersion: 1,
          emergencyId: row.emergencyId,
          outcomeRecordId: row.id,
          category: row.category,
          categoryVersion: row.categoryVersion,
          provenance: row.provenance as DataProvenance,
          dataClassification: row.dataClassification as OutcomeDataClassification,
          reviewStatus: 'PENDING',
          observedAt: row.observedAt?.toISOString() ?? null,
          recordedAt: row.recordedAt.toISOString(),
          supersedesOutcomeId: row.supersedesOutcomeId,
          correctionReasonCode: row.correctionReasonCode,
        },
      }));
      return mapOutcomeAssertion(row);
    }), 'Failed to record outcome assertion');
  }

  async recordReview(input: {
    outcomeRecordId: string;
    reviewerUserId: string;
    decision: OutcomeReviewDecision;
    reviewReasonCode?: OutcomeReviewReasonCode | null;
    eligibleForLearning: boolean;
    eligibilityReasonCode: string;
    evidenceAssessment?: Record<string, unknown> | null;
    idempotencyKey: string;
    supersedesReviewId?: string | null;
  }): Promise<OutcomeReviewRecord> {
    const normalized = normalizeOutcomeReview(input);
    const events = this.requireEvents();
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const existing = await tx.outcomeReview.findUnique({ where: { idempotencyKey: normalized.idempotencyKey } });
      if (existing) {
        if (!sameReview(existing, normalized)) throw AppErrorConflict('Review idempotency key was already used for different content.');
        return mapOutcomeReview(existing);
      }

      const outcome = await tx.outcomeAssertion.findUnique({ where: { id: normalized.outcomeRecordId } });
      if (!outcome) throw AppError.notFound('Outcome assertion', normalized.outcomeRecordId);
      if (outcome.submittedByUserId === normalized.reviewerUserId) {
        throw new AppError(ErrorCode.FORBIDDEN, 'An outcome submitter may not review their own assertion.', 403);
      }
      if (normalized.eligibleForLearning && (
        normalized.decision !== 'APPROVED' || outcome.dataClassification !== 'OPERATIONAL' ||
        outcome.provenance !== 'REAL_OBSERVED' || !['SURVIVED_TO_DISCHARGE', 'DECEASED'].includes(outcome.category)
      )) throw AppError.validation('Only approved operational observations with supported outcome labels may be learning eligible.');

      if (normalized.supersedesReviewId) {
        const predecessor = await tx.outcomeReview.findFirst({
          where: { id: normalized.supersedesReviewId, outcomeRecordId: normalized.outcomeRecordId },
        });
        if (!predecessor) throw AppError.validation('Review correction predecessor must concern the same outcome assertion.');
        const successor = await tx.outcomeReview.findUnique({ where: { supersedesReviewId: normalized.supersedesReviewId } });
        if (successor) throw AppErrorConflict('Review already has a correction successor.');
      } else {
        const root = await tx.outcomeReview.findFirst({ where: { outcomeRecordId: normalized.outcomeRecordId, supersedesReviewId: null } });
        if (root) throw AppErrorConflict('A review already exists; a subsequent decision must supersede it.');
      }

      const row = await tx.outcomeReview.create({ data: {
        id: createId('OUTR'), outcomeRecordId: normalized.outcomeRecordId,
        reviewerUserId: normalized.reviewerUserId, decision: normalized.decision,
        reviewReasonCode: normalized.reviewReasonCode,
        eligibleForLearning: normalized.eligibleForLearning,
        eligibilityReasonCode: normalized.eligibilityReasonCode,
        evidenceAssessmentJson: normalized.evidenceAssessment ? JSON.stringify(normalized.evidenceAssessment) : null,
        idempotencyKey: normalized.idempotencyKey, supersedesReviewId: normalized.supersedesReviewId,
      } });
      await events.recordInTransaction(tx as never, defineEvent('OUTCOME_REVIEW_RECORDED', {
        eventId: `EVT-OUTCOME-REVIEW-${row.id}`,
        emergencyId: outcome.emergencyId,
        entityType: 'outcome_review',
        entityId: row.id,
        actorType: 'OPERATOR',
        actorId: row.reviewerUserId,
        payload: {
          contractVersion: 1,
          emergencyId: outcome.emergencyId,
          outcomeRecordId: outcome.id,
          reviewRecordId: row.id,
          decision: row.decision as OutcomeReviewDecision,
          reviewReasonCode: row.reviewReasonCode as OutcomeReviewReasonCode | null,
          eligibleForLearning: row.eligibleForLearning,
          eligibilityReasonCode: row.eligibilityReasonCode,
          reviewedAt: row.reviewedAt.toISOString(),
        },
      }));
      return mapOutcomeReview(row);
    }), 'Failed to record outcome review');
  }

  async assertionForEmergency(emergencyId: string, outcomeRecordId: string): Promise<OutcomeAssertionRecord | null> {
    return guardDatabase(async () => {
      const row = await this.db.outcomeAssertion.findFirst({ where: { id: outcomeRecordId, emergencyId } });
      return row ? mapOutcomeAssertion(row) : null;
    }, 'Failed to read outcome assertion');
  }

  async reviewStatusForAssertion(emergencyId: string, outcomeRecordId: string): Promise<OutcomeReviewDecision | 'PENDING' | null> {
    return guardDatabase(async () => {
      const row = await this.db.outcomeAssertion.findFirst({
        where: { id: outcomeRecordId, emergencyId },
        include: { reviews: { include: { successor: { select: { id: true } } } } },
      });
      if (!row) return null;
      const current = row.reviews.find((review) => review.successor === null);
      return current ? current.decision as OutcomeReviewDecision : 'PENDING';
    }, 'Failed to read outcome review status');
  }

  async historyForEmergency(emergencyId: string, limit = 100, offset = 0): Promise<{ items: OutcomeHistoryRecord[]; total: number }> {
    return guardDatabase(async () => {
      const where = { emergencyId };
      const [rows, total] = await Promise.all([
        this.db.outcomeAssertion.findMany({
          where, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }], take: limit, skip: offset,
          include: { predecessor: { select: { id: true } }, successor: { select: { id: true } },
            reviews: { orderBy: [{ reviewedAt: 'asc' }, { id: 'asc' }], include: { successor: { select: { id: true } } } } },
        }),
        this.db.outcomeAssertion.count({ where }),
      ]);
      return { total, items: rows.map((row) => {
        const reviews = row.reviews.map((review) => ({ ...mapOutcomeReview(review), isCurrent: review.successor === null }));
        const currentReview = reviews.find((review) => review.isCurrent);
        return { ...mapOutcomeAssertion(row), isCurrent: row.successor === null,
          reviewStatus: currentReview?.decision ?? 'PENDING', predecessorId: row.predecessor?.id ?? null,
          successorId: row.successor?.id ?? null, reviews };
      }) };
    }, 'Failed to list outcome history');
  }

  async recordGrant(input: {
    emergencyId: string;
    granteeUserId: string;
    capability: OutcomeAccessCapability;
    grantedByUserId: string;
  }): Promise<OutcomeGrantRecord> {
    const events = this.requireEvents();
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const existing = await tx.emergencyOutcomeGrant.findUnique({
        where: {
          emergencyId_granteeUserId_capability: {
            emergencyId: input.emergencyId,
            granteeUserId: input.granteeUserId,
            capability: input.capability,
          },
        },
      });
      // Already active: idempotent no-op, and deliberately no duplicate event.
      if (existing && !existing.revokedAt) return mapOutcomeGrant(existing);

      let action: 'GRANTED' | 'REACTIVATED';
      let reactivatedAt: string | null = null;
      let grant: EmergencyOutcomeGrant;
      if (existing) {
        grant = await tx.emergencyOutcomeGrant.update({
          where: { id: existing.id },
          data: { revokedAt: null, revokedByUserId: null, revokeReason: null, grantedByUserId: input.grantedByUserId },
        });
        action = 'REACTIVATED';
        reactivatedAt = new Date().toISOString();
      } else {
        grant = await tx.emergencyOutcomeGrant.create({
          data: {
            id: createId('OGT'),
            emergencyId: input.emergencyId,
            granteeUserId: input.granteeUserId,
            capability: input.capability,
            grantedByUserId: input.grantedByUserId,
          },
        });
        action = 'GRANTED';
      }
      await events.recordInTransaction(tx as never, defineEvent('OUTCOME_GRANTED', {
        emergencyId: grant.emergencyId,
        entityType: 'emergency_outcome_grant',
        entityId: grant.id,
        actorType: 'OPERATOR',
        actorId: input.grantedByUserId,
        payload: {
          contractVersion: 1,
          emergencyId: grant.emergencyId,
          grantId: grant.id,
          granteeUserId: grant.granteeUserId,
          capability: grant.capability as OutcomeAccessCapability,
          action,
          active: true,
          reactivatedAt,
        },
      }));
      return mapOutcomeGrant(grant);
    }), 'Failed to record outcome access grant');
  }

  async revokeGrant(
    grantId: string,
    emergencyId: string,
    revokedByUserId: string,
    revokeReason?: string | null,
  ): Promise<OutcomeGrantRecord | null> {
    const events = this.requireEvents();
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const existing = await tx.emergencyOutcomeGrant.findFirst({ where: { id: grantId, emergencyId } });
      if (!existing) return null;
      // Already revoked: idempotent no-op; the first revocation's actor,
      // timestamp and reason win, and no duplicate event is written.
      if (existing.revokedAt) return mapOutcomeGrant(existing);
      const revoked = await tx.emergencyOutcomeGrant.update({
        where: { id: grantId },
        data: { revokedAt: new Date(), revokedByUserId, revokeReason: revokeReason ?? null },
      });
      await events.recordInTransaction(tx as never, defineEvent('OUTCOME_GRANT_REVOKED', {
        emergencyId: revoked.emergencyId,
        entityType: 'emergency_outcome_grant',
        entityId: revoked.id,
        actorType: 'OPERATOR',
        actorId: revokedByUserId,
        payload: {
          contractVersion: 1,
          emergencyId: revoked.emergencyId,
          grantId: revoked.id,
          granteeUserId: revoked.granteeUserId,
          capability: revoked.capability as OutcomeAccessCapability,
          revokedAt: (revoked.revokedAt ?? new Date()).toISOString(),
          revokeReason: revoked.revokeReason,
        },
      }));
      return mapOutcomeGrant(revoked);
    }), 'Failed to revoke outcome access grant');
  }

  /** Newest-first audit history of grant lifecycle events, scoped to one emergency. */
  async listGrantEvents(
    emergencyId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: SystemEventRecord[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const where = { emergencyId, type: { in: [...OUTCOME_GRANT_EVENT_TYPES] as SystemEventType[] } };
    return guardDatabase(async () => {
      const [rows, total] = await Promise.all([
        this.db.systemEvent.findMany({ where, orderBy: { seq: 'desc' }, take: limit, skip: offset }),
        this.db.systemEvent.count({ where }),
      ]);
      return { items: rows.map((row) => mapSystemEvent(row as unknown as Record<string, unknown>)), total };
    }, 'Failed to list outcome grant audit events');
  }

  /** Current grant rows (active and revoked) for one emergency, newest first. */
  async listGrants(
    emergencyId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: OutcomeGrantRecord[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    return guardDatabase(async () => {
      const [rows, total] = await Promise.all([
        this.db.emergencyOutcomeGrant.findMany({
          where: { emergencyId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        this.db.emergencyOutcomeGrant.count({ where: { emergencyId } }),
      ]);
      return { items: rows.map(mapOutcomeGrant), total };
    }, 'Failed to list outcome access grants');
  }

  /**
   * Per-emergency scope for the outcome HTTP surface, by capability. Explicit
   * grants are authoritative once any grant row exists for this user on this
   * emergency: an active grant with the required capability authorizes, and a
   * revocation removes access even when the user previously submitted or
   * reviewed here. Without grant rows the legacy outcome-ownership
   * relationships remain (documented compatibility): a prior assertion or the
   * legacy outcome recorder may submit and read; a prior reviewer may review
   * and read. Operational participation (dispatch decisions, protocol starts,
   * driver assignment links) and incidental event actor records never grant
   * access. Fails closed on unknown capabilities and storage errors.
   */
  async hasEmergencyAccess(
    userId: string,
    emergencyId: string,
    capability: OutcomeScopeCapability,
  ): Promise<boolean> {
    if (!userId || !emergencyId) return false;
    if (capability !== 'READ' && !OUTCOME_ACCESS_CAPABILITIES.includes(capability as OutcomeAccessCapability)) {
      return false;
    }
    return guardDatabase(async () => {
      const grants = await this.db.emergencyOutcomeGrant.findMany({
        where: { emergencyId, granteeUserId: userId },
        select: { capability: true, revokedAt: true },
      });
      if (grants.length > 0) {
        const active = grants.filter((grant) => grant.revokedAt === null);
        if (capability === 'READ') return active.length > 0;
        return active.some((grant) => grant.capability === capability);
      }
      if (capability === 'SUBMIT') {
        const [priorAssertion, priorLegacyOutcome] = await Promise.all([
          this.db.outcomeAssertion.findFirst({ where: { emergencyId, submittedByUserId: userId }, select: { id: true } }),
          this.db.outcome.findFirst({ where: { emergencyId, recordedByUserId: userId }, select: { id: true } }),
        ]);
        return Boolean(priorAssertion || priorLegacyOutcome);
      }
      if (capability === 'REVIEW') {
        const priorReview = await this.db.outcomeReview.findFirst({
          where: { reviewerUserId: userId, outcome: { emergencyId } },
          select: { id: true },
        });
        return Boolean(priorReview);
      }
      const [priorAssertion, priorReview, priorLegacyOutcome] = await Promise.all([
        this.db.outcomeAssertion.findFirst({ where: { emergencyId, submittedByUserId: userId }, select: { id: true } }),
        this.db.outcomeReview.findFirst({ where: { reviewerUserId: userId, outcome: { emergencyId } }, select: { id: true } }),
        this.db.outcome.findFirst({ where: { emergencyId, recordedByUserId: userId }, select: { id: true } }),
      ]);
      return Boolean(priorAssertion || priorReview || priorLegacyOutcome);
    }, 'Failed to evaluate emergency outcome access');
  }

  private requireEvents(): EventService {
    if (!this.events) throw new Error('Outcome history writes require the Module 11 event service.');
    return this.events;
  }

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


type NormalizedAssertion = {
  emergencyId: string; category: OutcomeStatus; categoryVersion: string; provenance: DataProvenance;
  dataClassification: OutcomeDataClassification; survivalToDischarge: boolean | null; observedAt: Date | null;
  submittedByUserId: string | null; evidenceRefs: string[] | null; correctionReasonCode: OutcomeCorrectionReasonCode | null;
  idempotencyKey: string; supersedesOutcomeId: string | null;
};
export type OutcomeReviewReasonCode = (typeof OUTCOME_REVIEW_REASON_CODES)[number];
type NormalizedReview = {
  outcomeRecordId: string; reviewerUserId: string; decision: OutcomeReviewDecision;
  reviewReasonCode: OutcomeReviewReasonCode | null; eligibleForLearning: boolean;
  eligibilityReasonCode: string; evidenceAssessment: Record<string, unknown> | null; idempotencyKey: string;
  supersedesReviewId: string | null;
};

function normalizeOutcomeAssertion(input: Parameters<OutcomeRepository['recordAssertion']>[0]): NormalizedAssertion {
  const category = outcomeStatusSchema.safeParse(input.category);
  if (!category.success) throw AppError.validation('Unsupported outcome category.');
  if (input.categoryVersion !== 'OUTCOME_V1') throw AppError.validation('Unsupported outcome category version.');
  if (!Object.values(DATA_PROVENANCE).includes(input.provenance)) throw AppError.validation('Unsupported outcome provenance.');
  if (!['OPERATIONAL', 'SIMULATION', 'TEST', 'UNVERIFIED_LEGACY'].includes(input.dataClassification)) throw AppError.validation('Unsupported outcome data classification.');
  const expectedSurvival = category.data === 'SURVIVED_TO_DISCHARGE' ? true : category.data === 'DECEASED' ? false : null;
  const survival = input.survivalToDischarge ?? null;
  if (survival !== expectedSurvival) throw AppError.validation('Outcome category and survival label are inconsistent.');
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const observedAt = input.observedAt == null ? null : new Date(input.observedAt);
  if (observedAt && Number.isNaN(observedAt.getTime())) throw AppError.validation('Invalid outcome observation timestamp.');
  if (input.evidenceRefs != null && !Array.isArray(input.evidenceRefs)) throw AppError.validation('Evidence references must be a list.');
  const evidenceRefs = input.evidenceRefs == null ? null : input.evidenceRefs.map((ref) => {
    if (typeof ref !== 'string' || ref.trim().length < 1 || ref.trim().length > 256) throw AppError.validation('Invalid evidence reference.');
    return ref.trim();
  });
  if (evidenceRefs && evidenceRefs.length > 32) throw AppError.validation('Too many evidence references.');
  const correctionReasonCode = input.correctionReasonCode ?? null;
  if (input.supersedesOutcomeId && (!correctionReasonCode || !OUTCOME_CORRECTION_REASON_CODES.includes(correctionReasonCode))) {
    throw AppError.validation('A correction requires a supported correction reason code.');
  }
  if (!input.supersedesOutcomeId && correctionReasonCode) throw AppError.validation('A correction reason is only valid when superseding an outcome.');
  return {
    emergencyId: validateIdentifier(input.emergencyId, 'emergencyId'), category: category.data,
    categoryVersion: input.categoryVersion, provenance: input.provenance,
    dataClassification: input.dataClassification, survivalToDischarge: survival, observedAt,
    submittedByUserId: input.submittedByUserId ? validateIdentifier(input.submittedByUserId, 'submitter id') : null,
    evidenceRefs, correctionReasonCode, idempotencyKey,
    supersedesOutcomeId: input.supersedesOutcomeId ? validateIdentifier(input.supersedesOutcomeId, 'predecessor id') : null,
  };
}

function normalizeOutcomeReview(input: Parameters<OutcomeRepository['recordReview']>[0]): NormalizedReview {
  if (!['APPROVED', 'REJECTED', 'NEEDS_EVIDENCE'].includes(input.decision)) throw AppError.validation('Unsupported review decision.');
  if (input.eligibleForLearning && input.decision !== 'APPROVED') throw AppError.validation('Only an approved review may mark an outcome eligible.');
  if (!OUTCOME_REVIEW_REASON_CODES.includes(input.eligibilityReasonCode as never)) throw AppError.validation('Unsupported eligibility reason code.');
  if (input.reviewReasonCode != null && !OUTCOME_REVIEW_REASON_CODES.includes(input.reviewReasonCode as never)) throw AppError.validation('Unsupported review reason code.');
  if (input.decision !== 'APPROVED' && !input.reviewReasonCode) throw AppError.validation('Rejected or deferred reviews require a reason code.');
  const evidenceAssessment = input.evidenceAssessment == null ? null : JSON.parse(stableJson(input.evidenceAssessment)) as Record<string, unknown>;
  if (evidenceAssessment && stableJson(evidenceAssessment).length > 4096) throw AppError.validation('Evidence assessment metadata is too large.');
  return {
    outcomeRecordId: validateIdentifier(input.outcomeRecordId, 'outcome record id'),
    reviewerUserId: validateIdentifier(input.reviewerUserId, 'reviewer id'), decision: input.decision,
    reviewReasonCode: input.reviewReasonCode ?? null,
    eligibleForLearning: input.eligibleForLearning, eligibilityReasonCode: input.eligibilityReasonCode,
    evidenceAssessment, idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
    supersedesReviewId: input.supersedesReviewId ? validateIdentifier(input.supersedesReviewId, 'review predecessor id') : null,
  };
}

function enforceOutcomeClassification(input: NormalizedAssertion, isSimulation: boolean): void {
  if (isSimulation && (input.dataClassification !== 'SIMULATION' || input.provenance !== 'SIMULATION')) {
    throw AppError.validation('Simulation emergencies must be classified and labelled as simulation.');
  }
  if (!isSimulation && input.dataClassification === 'SIMULATION') throw AppError.validation('Simulation outcome data requires a simulation emergency.');
  if (input.dataClassification === 'OPERATIONAL' && input.provenance !== 'REAL_OBSERVED') {
    throw AppError.validation('Operational outcome data must use REAL_OBSERVED provenance.');
  }
  if (input.dataClassification === 'TEST' && input.provenance === 'REAL_OBSERVED') {
    throw AppError.validation('Test outcome data cannot claim real observed provenance.');
  }
}

function validateIdempotencyKey(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(value)) throw AppError.validation('Invalid idempotency key.');
  return value;
}
function validateIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 128) throw AppError.validation(`Invalid ${label}.`);
  return value.trim();
}
function AppErrorConflict(message: string): AppError { return new AppError(ErrorCode.CONFLICT, message, 409); }
function sameAssertion(row: { emergencyId: string; category: string; categoryVersion: string; provenance: string; dataClassification: string; survivalToDischarge: boolean | null; observedAt: Date | null; submittedByUserId: string | null; evidenceRefsJson: string | null; correctionReasonCode: string | null; supersedesOutcomeId: string | null }, input: NormalizedAssertion): boolean {
  return row.emergencyId === input.emergencyId && row.category === input.category && row.categoryVersion === input.categoryVersion &&
    row.provenance === input.provenance && row.dataClassification === input.dataClassification && row.survivalToDischarge === input.survivalToDischarge &&
    row.observedAt?.toISOString() === input.observedAt?.toISOString() && row.submittedByUserId === input.submittedByUserId &&
    row.evidenceRefsJson === (input.evidenceRefs ? JSON.stringify(input.evidenceRefs) : null) && row.correctionReasonCode === input.correctionReasonCode && row.supersedesOutcomeId === input.supersedesOutcomeId;
}
function sameReview(row: { outcomeRecordId: string; reviewerUserId: string; decision: string; reviewReasonCode: string | null; eligibleForLearning: boolean; eligibilityReasonCode: string; evidenceAssessmentJson: string | null; supersedesReviewId: string | null }, input: NormalizedReview): boolean {
  return row.outcomeRecordId === input.outcomeRecordId && row.reviewerUserId === input.reviewerUserId && row.decision === input.decision &&
    row.reviewReasonCode === input.reviewReasonCode &&
    row.eligibleForLearning === input.eligibleForLearning && row.eligibilityReasonCode === input.eligibilityReasonCode &&
    row.evidenceAssessmentJson === (input.evidenceAssessment ? stableJson(input.evidenceAssessment) : null) && row.supersedesReviewId === input.supersedesReviewId;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function mapOutcomeAssertion(row: { id: string; emergencyId: string; category: string; categoryVersion: string; provenance: string; dataClassification: string; survivalToDischarge: boolean | null; observedAt: Date | null; recordedAt: Date; submittedByUserId: string | null; evidenceRefsJson: string | null; correctionReasonCode: string | null; idempotencyKey: string; supersedesOutcomeId: string | null }): OutcomeAssertionRecord {
  let evidenceRefs: string[] | null = null;
  if (row.evidenceRefsJson) {
    try { const parsed: unknown = JSON.parse(row.evidenceRefsJson); if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) evidenceRefs = parsed; }
    catch { evidenceRefs = null; }
  }
  return { id: row.id, emergencyId: row.emergencyId, category: outcomeStatusSchema.parse(row.category), categoryVersion: row.categoryVersion,
    provenance: row.provenance as DataProvenance, dataClassification: row.dataClassification as OutcomeDataClassification,
    survivalToDischarge: row.survivalToDischarge, observedAt: row.observedAt?.toISOString() ?? null,
    recordedAt: row.recordedAt.toISOString(), submittedByUserId: row.submittedByUserId, evidenceRefs,
    correctionReasonCode: row.correctionReasonCode as OutcomeCorrectionReasonCode | null,
    idempotencyKey: row.idempotencyKey, supersedesOutcomeId: row.supersedesOutcomeId };
}
function mapOutcomeReview(row: { id: string; outcomeRecordId: string; reviewerUserId: string; decision: string; reviewReasonCode: string | null; reviewedAt: Date; eligibleForLearning: boolean; eligibilityReasonCode: string; evidenceAssessmentJson: string | null; idempotencyKey: string; supersedesReviewId: string | null }): OutcomeReviewRecord {
  let evidenceAssessment: Record<string, unknown> | null = null;
  if (row.evidenceAssessmentJson) {
    try { const parsed: unknown = JSON.parse(row.evidenceAssessmentJson); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) evidenceAssessment = parsed as Record<string, unknown>; }
    catch { evidenceAssessment = null; }
  }
  return { id: row.id, outcomeRecordId: row.outcomeRecordId, reviewerUserId: row.reviewerUserId,
    decision: row.decision as OutcomeReviewDecision, reviewReasonCode: row.reviewReasonCode as OutcomeReviewReasonCode | null,
    reviewedAt: row.reviewedAt.toISOString(),
    eligibleForLearning: row.eligibleForLearning, eligibilityReasonCode: row.eligibilityReasonCode,
    evidenceAssessment, idempotencyKey: row.idempotencyKey, supersedesReviewId: row.supersedesReviewId };
}
function mapOutcomeGrant(row: { id: string; emergencyId: string; granteeUserId: string; capability: string; grantedByUserId: string; createdAt: Date; revokedAt: Date | null; revokedByUserId: string | null; revokeReason: string | null }): OutcomeGrantRecord {
  return { id: row.id, emergencyId: row.emergencyId, granteeUserId: row.granteeUserId,
    capability: row.capability as OutcomeAccessCapability, grantedByUserId: row.grantedByUserId,
    createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId, revokeReason: row.revokeReason };
}
