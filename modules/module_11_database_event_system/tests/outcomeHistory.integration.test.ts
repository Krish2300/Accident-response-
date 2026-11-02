import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AppError, defineEvent } from '@resus/core';
import { loadModule12Config } from '../../module_12_dashboard_analytics/src/config.js';
import { createModule11, type Module11 } from '../src/module.js';
import { withTransaction } from '../src/db/client.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../../../tests/helpers/isolatedTestDatabase.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = process.env.RESUS_RUN_ISOLATED_OUTCOME_TEST === 'true';
const suite = enabled ? describe : describe.skip;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const schemaPath = resolve(here, '../prisma/schema.prisma');

suite('append-only outcome history on an isolated SQLite database', () => {
  let owned: IsolatedTestDatabase;
  let db: PrismaClient;
  let module11: Module11;
  let eventRows: Array<{ id: string; type: string; emergencyId: string | null }>;
  let unsubscribe: () => void;
  let idCounter = 0;

  beforeAll(async () => {
    owned = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: owned.databaseUrl } } });
    module11 = createModule11({ db, ownsClient: false });
    eventRows = [];
    unsubscribe = module11.bus.subscribeAll((event) => { eventRows.push({ id: event.id, type: event.type, emergencyId: event.emergencyId }); });
  }, 180000);

  afterAll(async () => {
    unsubscribe?.();
    await db?.$disconnect();
    owned?.cleanup();
  });

  async function fixture(options: { simulation?: boolean } = {}) {
    const id = `EMG-OUTCOME-${++idCounter}`;
    await db.emergency.create({ data: {
      id, incidentType: 'TRAUMA', severity: 'HIGH', latitude: 12, longitude: 77,
      isSimulation: options.simulation ?? false,
    } });
    await db.user.create({ data: {
      id: `USR-OUTCOME-${idCounter}`, email: `outcome-${idCounter}@example.test`,
      displayName: 'Isolated outcome reviewer', passwordHash: 'test-hash-only', role: 'CLINICAL_SUPERVISOR',
    } });
    return { id, userId: `USR-OUTCOME-${idCounter}` };
  }

  function assertion(emergencyId: string, overrides: Record<string, unknown> = {}) {
    return module11.outcomes.recordAssertion({
      emergencyId, category: 'SURVIVED_TO_DISCHARGE', categoryVersion: 'OUTCOME_V1',
      provenance: 'REAL_OBSERVED', dataClassification: 'OPERATIONAL',
      survivalToDischarge: true, observedAt: '2026-10-01T12:00:00.000Z',
      ...(overrides.supersedesOutcomeId ? { correctionReasonCode: 'DATA_ENTRY_ERROR' } : {}),
      idempotencyKey: `outcome-key-${emergencyId}-0001`, ...overrides,
    } as Parameters<typeof module11.outcomes.recordAssertion>[0]);
  }

  function review(outcomeRecordId: string, reviewerUserId: string, overrides: Record<string, unknown> = {}) {
    return module11.outcomes.recordReview({
      outcomeRecordId, reviewerUserId, decision: 'APPROVED', eligibleForLearning: true,
      eligibilityReasonCode: 'VERIFIED_EVIDENCE', evidenceAssessment: { evidenceCount: 1 },
      idempotencyKey: `review-key-${outcomeRecordId}-0001`, ...overrides,
    } as Parameters<typeof module11.outcomes.recordReview>[0]);
  }

  it('stores multiple assertions for one canonical emergency', async () => {
    const { id } = await fixture();
    const first = await assertion(id);
    const second = await assertion(id, {
      category: 'TRANSPORTED', survivalToDischarge: null,
      idempotencyKey: `outcome-key-${id}-0002`, supersedesOutcomeId: first.id,
    });
    expect(second.id).not.toBe(first.id);
    expect(await db.outcomeAssertion.count({ where: { emergencyId: id } })).toBe(2);
  });

  it('appends a correction and preserves its predecessor', async () => {
    const { id } = await fixture();
    const predecessor = await assertion(id);
    const correction = await assertion(id, { category: 'DECEASED', survivalToDischarge: false,
      idempotencyKey: `outcome-key-${id}-0002`, supersedesOutcomeId: predecessor.id });
    expect(correction.supersedesOutcomeId).toBe(predecessor.id);
    expect(await db.outcomeAssertion.findUnique({ where: { id: predecessor.id } })).toBeTruthy();
    expect((await db.outcomeAssertion.findUnique({ where: { id: predecessor.id } }))?.category).toBe('SURVIVED_TO_DISCHARGE');
  });

  it('preserves successive review decisions as linked history', async () => {
    const { id, userId } = await fixture();
    const outcome = await assertion(id);
    const approved = await review(outcome.id, userId);
    const duplicate = await review(outcome.id, userId);
    expect(duplicate.id).toBe(approved.id);
    const corrected = await review(outcome.id, userId, {
      decision: 'NEEDS_EVIDENCE', eligibleForLearning: false, eligibilityReasonCode: 'INSUFFICIENT_EVIDENCE',
      reviewReasonCode: 'INSUFFICIENT_EVIDENCE',
      idempotencyKey: `review-key-${outcome.id}-0002`, supersedesReviewId: approved.id,
    });
    expect(corrected.supersedesReviewId).toBe(approved.id);
    expect(await db.outcomeReview.count({ where: { outcomeRecordId: outcome.id } })).toBe(2);
    expect((await db.outcomeReview.findUnique({ where: { id: approved.id } }))?.decision).toBe('APPROVED');
  });

  it('rejects a reviewer who is the submitter of the assertion', async () => {
    const { id, userId } = await fixture();
    const outcome = await assertion(id, { submittedByUserId: userId });
    await expect(module11.outcomes.recordReview({
      outcomeRecordId: outcome.id, reviewerUserId: userId, decision: 'APPROVED',
      eligibleForLearning: false, eligibilityReasonCode: 'OUTCOME_UNCERTAIN',
      idempotencyKey: `self-review-${outcome.id}-0001`,
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects inconsistent category and survival labels', async () => {
    const { id } = await fixture();
    await expect(assertion(id, { category: 'UNKNOWN', survivalToDischarge: true })).rejects.toMatchObject({ statusCode: 422 });
  });

  it('does not infer survival from stabilization, transport, handover, or cancellation', async () => {
    const { id } = await fixture();
    for (const category of ['STABILISED', 'TRANSPORTED', 'HANDED_OVER_OTHER_SERVICE', 'CANCELLED_BEFORE_ARRIVAL'] as const) {
      await expect(assertion(id, {
        category, survivalToDischarge: true,
        idempotencyKey: `not-survival-${category.toLowerCase()}-${id}`,
      })).rejects.toMatchObject({ statusCode: 422 });
    }
  });

  it('keeps UNKNOWN outcome survival label null', async () => {
    const { id } = await fixture();
    const row = await assertion(id, { category: 'UNKNOWN', survivalToDischarge: null });
    expect(row.category).toBe('UNKNOWN');
    expect(row.survivalToDischarge).toBeNull();
  });

  it('returns an identical record for duplicate idempotency and rejects key reuse with different content', async () => {
    const { id } = await fixture();
    const first = await assertion(id);
    const retry = await assertion(id);
    expect(retry.id).toBe(first.id);
    await expect(assertion(id, { category: 'DECEASED', survivalToDischarge: false })).rejects.toMatchObject({ statusCode: 409 });
    expect(await db.outcomeAssertion.count({ where: { emergencyId: id } })).toBe(1);
  });

  it('allows only one concurrent correction successor', async () => {
    const { id } = await fixture();
    const predecessor = await assertion(id);
    const results = await Promise.allSettled([
      assertion(id, { category: 'TRANSPORTED', survivalToDischarge: null, idempotencyKey: `race-key-${id}-0001`, supersedesOutcomeId: predecessor.id }),
      assertion(id, { category: 'DECEASED', survivalToDischarge: false, idempotencyKey: `race-key-${id}-0002`, supersedesOutcomeId: predecessor.id }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    expect(await db.outcomeAssertion.count({ where: { supersedesOutcomeId: predecessor.id } })).toBe(1);
  });

  it('rejects a correction predecessor from another emergency', async () => {
    const first = await fixture();
    const second = await fixture();
    const predecessor = await assertion(first.id);
    await expect(assertion(second.id, { idempotencyKey: `outcome-key-${second.id}-0002`, supersedesOutcomeId: predecessor.id }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects direct updates and deletes from append-only history tables', async () => {
    const { id, userId } = await fixture();
    const outcome = await assertion(id);
    const outcomeReview = await review(outcome.id, userId);
    await expect(db.outcomeAssertion.update({ where: { id: outcome.id }, data: { category: 'UNKNOWN' } })).rejects.toThrow();
    await expect(db.outcomeAssertion.delete({ where: { id: outcome.id } })).rejects.toThrow();
    await expect(db.outcomeReview.update({ where: { id: outcomeReview.id }, data: { decision: 'REJECTED' } })).rejects.toThrow();
    await expect(db.outcomeReview.delete({ where: { id: outcomeReview.id } })).rejects.toThrow();
  });

  it('enforces database uniqueness and foreign-key constraints for outcome history', async () => {
    const { id, userId } = await fixture();
    const outcome = await assertion(id);
    await expect(db.outcomeAssertion.create({ data: {
      id: `OUTA-DUPLICATE-${id}`, emergencyId: id, category: 'UNKNOWN', categoryVersion: 'OUTCOME_V1',
      provenance: 'REAL_OBSERVED', dataClassification: 'OPERATIONAL', survivalToDischarge: null,
      idempotencyKey: outcome.idempotencyKey, supersedesOutcomeId: null,
    } })).rejects.toThrow();
    await expect(db.outcomeAssertion.create({ data: {
      id: `OUTA-MISSING-EMERGENCY-${id}`, emergencyId: 'EMG-NOT-FOUND-4173', category: 'UNKNOWN',
      categoryVersion: 'OUTCOME_V1', provenance: 'REAL_OBSERVED', dataClassification: 'OPERATIONAL',
      survivalToDischarge: null, idempotencyKey: `missing-emergency-${id}-0001`,
    } })).rejects.toThrow();
    await expect(db.outcomeReview.create({ data: {
      id: `OUTR-MISSING-OUTCOME-${id}`, outcomeRecordId: 'OUTA-NOT-FOUND-4173', reviewerUserId: userId,
      decision: 'APPROVED', reviewReasonCode: null, eligibleForLearning: false, eligibilityReasonCode: 'OUTCOME_UNCERTAIN',
      idempotencyKey: `missing-outcome-review-${id}-0001`,
    } })).rejects.toThrow();
  });

  it('rolls back both an outcome row and event in the same transaction', async () => {
    const { id } = await fixture();
    const before = await db.systemEvent.count({ where: { emergencyId: id } });
    await expect(withTransaction(db, async (tx) => {
      const row = await tx.outcomeAssertion.create({ data: {
        id: `OUTA-ROLLBACK-${id}`, emergencyId: id, category: 'UNKNOWN', categoryVersion: 'OUTCOME_V1',
        provenance: 'REAL_OBSERVED', dataClassification: 'OPERATIONAL', survivalToDischarge: null,
        supersedesOutcomeId: null, correctionReasonCode: null,
        idempotencyKey: `rollback-key-${id}-0001`,
      } });
      await module11.events.recordInTransaction(tx as never, defineEvent('OUTCOME_RECORDED', {
        eventId: `EVT-ROLLBACK-${row.id}`, emergencyId: id, entityType: 'outcome_assertion', entityId: row.id,
        payload: { contractVersion: 1, emergencyId: id, outcomeRecordId: row.id, category: 'UNKNOWN', categoryVersion: 'OUTCOME_V1',
          provenance: 'REAL_OBSERVED', dataClassification: 'OPERATIONAL', reviewStatus: 'PENDING', observedAt: null,
          supersedesOutcomeId: null, correctionReasonCode: null,
          recordedAt: new Date().toISOString() },
      }));
      throw new Error('forced rollback');
    })).rejects.toBeInstanceOf(AppError);
    expect(await db.outcomeAssertion.findUnique({ where: { id: `OUTA-ROLLBACK-${id}` } })).toBeNull();
    expect(await db.systemEvent.count({ where: { emergencyId: id } })).toBe(before);
  });

  it('rolls back repository writes when durable event persistence fails before commit', async () => {
    const { id, userId } = await fixture();
    const assertionKey = `event-failure-outcome-${id}-0001`;
    const failAssertionEvent = vi.spyOn(module11.events, 'recordInTransaction').mockRejectedValueOnce(new Error('injected outcome event failure'));
    try {
      await expect(assertion(id, { idempotencyKey: assertionKey })).rejects.toMatchObject({ statusCode: 500 });
    } finally {
      failAssertionEvent.mockRestore();
    }
    expect(await db.outcomeAssertion.findUnique({ where: { idempotencyKey: assertionKey } })).toBeNull();
    expect(await db.systemEvent.count({ where: { emergencyId: id, type: 'OUTCOME_RECORDED' } })).toBe(0);

    const outcome = await assertion(id);
    const reviewKey = `event-failure-review-${outcome.id}-0001`;
    const beforeReviewEvents = await db.systemEvent.count({ where: { emergencyId: id, type: 'OUTCOME_REVIEW_RECORDED' } });
    const failReviewEvent = vi.spyOn(module11.events, 'recordInTransaction').mockRejectedValueOnce(new Error('injected review event failure'));
    try {
      await expect(review(outcome.id, userId, { idempotencyKey: reviewKey })).rejects.toMatchObject({ statusCode: 500 });
    } finally {
      failReviewEvent.mockRestore();
    }
    expect(await db.outcomeReview.findUnique({ where: { idempotencyKey: reviewKey } })).toBeNull();
    expect(await db.systemEvent.count({ where: { emergencyId: id, type: 'OUTCOME_REVIEW_RECORDED' } })).toBe(beforeReviewEvents);
  });

  it('persists a versioned minimal event atomically with an outcome', async () => {
    const { id } = await fixture();
    eventRows.length = 0;
    const row = await assertion(id, { evidenceRefs: ['case-ref:opaque-1'] });
    const persisted = await db.systemEvent.findFirst({ where: { emergencyId: id, type: 'OUTCOME_RECORDED' } });
    expect(persisted?.id).toBe(`EVT-OUTCOME-${row.id}`);
    expect(JSON.parse(persisted!.payloadJson)).toMatchObject({
      contractVersion: 1, outcomeRecordId: row.id, category: row.category,
      dataClassification: 'OPERATIONAL', reviewStatus: 'PENDING',
    });
    expect(persisted!.payloadJson).not.toContain('case-ref:opaque-1');
    expect(JSON.parse(persisted!.payloadJson)).not.toHaveProperty('evidenceRefs');
    expect(eventRows.filter((event) => event.id === persisted?.id)).toHaveLength(1);
  });

  it('does not duplicate an outcome or event after post-commit publication failure and retry', async () => {
    const { id } = await fixture();
    let failPublicationOnce = true;
    const failingModule = createModule11({
      db, ownsClient: false,
      realtime: { publish() { if (failPublicationOnce) { failPublicationOnce = false; throw new Error('simulated post-commit publication failure'); } }, subscriberCount() { return 0; } },
    });
    const input = {
      emergencyId: id, category: 'UNKNOWN' as const, categoryVersion: 'OUTCOME_V1',
      provenance: 'REAL_OBSERVED' as const, dataClassification: 'OPERATIONAL' as const,
      survivalToDischarge: null, idempotencyKey: `publish-key-${id}-0001`,
    };
    await expect(failingModule.outcomes.recordAssertion(input)).rejects.toMatchObject({ statusCode: 500 });
    const committed = await db.outcomeAssertion.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    expect(committed).toBeTruthy();
    const retried = await failingModule.outcomes.recordAssertion(input);
    expect(retried.id).toBe(committed?.id);
    expect(await db.outcomeAssertion.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
    expect(await db.systemEvent.count({ where: { id: `EVT-OUTCOME-${committed!.id}` } })).toBe(1);
  });

  it('blocks simulated and test-classified outcomes from real learning samples', async () => {
    const simulation = await fixture({ simulation: true });
    const simulatedOutcome = await assertion(simulation.id, {
      category: 'UNKNOWN', survivalToDischarge: null, provenance: 'SIMULATION', dataClassification: 'SIMULATION',
    });
    await module11.outcomes.recordReview({
      outcomeRecordId: simulatedOutcome.id, reviewerUserId: simulation.userId, decision: 'APPROVED',
      eligibleForLearning: false, eligibilityReasonCode: 'SIMULATION_DATA', idempotencyKey: `review-key-${simulatedOutcome.id}-0001`,
    });
    const test = await fixture();
    const testOutcome = await assertion(test.id, {
      category: 'UNKNOWN', survivalToDischarge: null, provenance: 'SIMULATION', dataClassification: 'TEST',
    });
    await module11.outcomes.recordReview({
      outcomeRecordId: testOutcome.id, reviewerUserId: test.userId, decision: 'APPROVED',
      eligibleForLearning: false, eligibilityReasonCode: 'TEST_DATA', idempotencyKey: `review-key-${testOutcome.id}-0001`,
    });
    const sample = { emergencyId: test.id, emergencyType: 'TRAUMA', severity: 'HIGH', escalationRequired: false,
      outcomeStatus: 'UNKNOWN', survivalToDischarge: null, features: { version: 1, review: {} }, provenance: 'REAL_OBSERVED' };
    await expect(module11.analyticsRead.insertLearningSample({ ...sample, emergencyId: simulation.id }))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(module11.analyticsRead.insertLearningSample(sample)).rejects.toMatchObject({ statusCode: 422 });
    expect(await db.learningSample.count()).toBe(0);
  });

  it('requires the current approved eligible assertion and links each real sample to that exact assertion', async () => {
    const sample = (emergencyId: string) => ({ emergencyId, emergencyType: 'TRAUMA', severity: 'HIGH',
      escalationRequired: false, outcomeStatus: 'SURVIVED_TO_DISCHARGE', survivalToDischarge: true,
      features: { version: 1, review: { status: 'VERIFIED' } }, provenance: 'REAL_OBSERVED' });

    const legacy = await fixture();
    await module11.outcomes.upsert({
      emergencyId: legacy.id, status: 'SURVIVED_TO_DISCHARGE', provenance: 'REAL_OBSERVED', survivalToDischarge: true,
    });
    await expect(module11.analyticsRead.insertLearningSample(sample(legacy.id))).rejects.toMatchObject({ statusCode: 422 });

    const pending = await fixture();
    await assertion(pending.id);
    await expect(module11.analyticsRead.insertLearningSample(sample(pending.id))).rejects.toMatchObject({ statusCode: 422 });

    for (const decision of ['REJECTED', 'NEEDS_EVIDENCE'] as const) {
      const reviewed = await fixture();
      const outcome = await assertion(reviewed.id);
      await review(outcome.id, reviewed.userId, {
        decision, eligibleForLearning: false,
        eligibilityReasonCode: 'INSUFFICIENT_EVIDENCE', reviewReasonCode: 'INSUFFICIENT_EVIDENCE',
      });
      await expect(module11.analyticsRead.insertLearningSample(sample(reviewed.id))).rejects.toMatchObject({ statusCode: 422 });
    }

    const corrected = await fixture();
    const original = await assertion(corrected.id);
    await review(original.id, corrected.userId);
    await module11.analyticsRead.insertLearningSample(sample(corrected.id));
    const originalSample = await db.learningSample.findUnique({ where: { emergencyId: corrected.id } });
    expect(originalSample?.outcomeAssertionId).toBe(original.id);

    const successor = await assertion(corrected.id, {
      idempotencyKey: `corrected-learning-${corrected.id}-0001`, supersedesOutcomeId: original.id,
    });
    await expect(module11.analyticsRead.insertLearningSample(sample(corrected.id))).rejects.toMatchObject({ statusCode: 422 });
    expect(await module11.analyticsRead.learningSamples({ windowDays: 3650, includeSimulation: false }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ emergencyId: corrected.id })]));

    await review(successor.id, corrected.userId);
    await module11.analyticsRead.insertLearningSample(sample(corrected.id));
    const currentSample = await db.learningSample.findUnique({ where: { emergencyId: corrected.id } });
    expect(currentSample?.outcomeAssertionId).toBe(successor.id);
    expect(await module11.analyticsRead.learningSamples({ windowDays: 3650, includeSimulation: false }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ emergencyId: corrected.id, outcomeStatus: 'SURVIVED_TO_DISCHARGE' })]));
  });

  it('rejects simulated provenance on a non-simulation emergency', async () => {
    const { id } = await fixture();
    await expect(module11.analyticsRead.insertLearningSample({
      emergencyId: id, emergencyType: 'TRAUMA', severity: 'HIGH', escalationRequired: false,
      outcomeStatus: 'UNKNOWN', survivalToDischarge: null, features: { version: 1 }, provenance: 'SIMULATION',
    })).rejects.toMatchObject({ statusCode: 422 });
    expect(await db.learningSample.count({ where: { emergencyId: id } })).toBe(0);
  });

  it('keeps legacy Outcome rows readable through the existing API', async () => {
    const { id } = await fixture();
    await module11.outcomes.upsert({ emergencyId: id, status: 'UNKNOWN', provenance: 'SIMULATION' });
    expect(await module11.outcomes.forEmergency(id)).toMatchObject({ emergencyId: id, status: 'UNKNOWN', survivalToDischarge: null });
  });

  it('keeps Module 12 learning disabled by default', () => {
    const previous = process.env.MODULE12_LEARNING_ENABLED;
    delete process.env.MODULE12_LEARNING_ENABLED;
    try { expect(loadModule12Config().learning.enabled).toBe(false); }
    finally { if (previous === undefined) delete process.env.MODULE12_LEARNING_ENABLED; else process.env.MODULE12_LEARNING_ENABLED = previous; }
  });
});
