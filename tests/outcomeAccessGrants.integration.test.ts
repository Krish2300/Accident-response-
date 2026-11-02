import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { AppError, ErrorCode } from '@resus/core';
import { vi, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { createModule11 } from '../modules/module_11_database_event_system/src/module.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './helpers/isolatedTestDatabase.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = process.env.RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST === 'true';
const suite = enabled ? describe : describe.skip;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const schemaPath = resolve(repoRoot, 'modules/module_11_database_event_system/prisma/schema.prisma');
const password = 'Stage426-isolated-test-only-9!';
const scopeMessage = 'You are not authorized to access outcome records for this emergency.';

suite('explicit emergency outcome access grants on an owned isolated SQLite database', () => {
  let owned: IsolatedTestDatabase | undefined;
  let db: PrismaClient | undefined;
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  const tokens: Record<string, string> = {};
  const userIds = {} as {
    admin: string; submitterA: string; submitterB: string;
    reviewerA: string; reviewerB: string; dispatcher: string;
  };
  let emgA = '';
  let emgB = '';
  let emgC = '';
  let outA1 = '';
  let outB1 = '';
  let outA2 = '';
  let outA3 = '';
  let subAGrantOnA = '';
  let revAGrantOnA = '';
  let revAGrantOnB = '';
  let keyCounter = 0;

  beforeAll(async () => {
    owned = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: owned.databaseUrl } } });
    server = await buildServer(loadServerConfig({
      NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '4000', LOG_LEVEL: 'error',
      JWT_SECRET: 'stage-4.26-outcome-grants-isolated-jwt-secret', MODULE3_NLP_ENABLED: 'false',
    }), { db, ownsDatabaseClient: false });
    const hash = await bcrypt.hash(password, 4);
    const users = [
      ['admin', 'outcome-grant-admin@stage426.test', 'Grant Admin', 'ADMIN'],
      ['submitterA', 'outcome-grant-submitter-a@stage426.test', 'Grant Submitter A', 'OUTCOME_SUBMITTER'],
      ['submitterB', 'outcome-grant-submitter-b@stage426.test', 'Grant Submitter B', 'OUTCOME_SUBMITTER'],
      ['reviewerA', 'outcome-grant-reviewer-a@stage426.test', 'Grant Reviewer A', 'OUTCOME_REVIEWER'],
      ['reviewerB', 'outcome-grant-reviewer-b@stage426.test', 'Grant Reviewer B', 'OUTCOME_REVIEWER'],
      ['dispatcher', 'outcome-grant-dispatcher@stage426.test', 'Grant Dispatcher', 'DISPATCHER'],
    ] as const;
    for (const [key, email, displayName, role] of users) {
      const created = await server.module11.users.create({ email, displayName, passwordHash: hash, role });
      userIds[key] = created.id;
      const login = await server.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
      expect(login.statusCode).toBe(200);
      tokens[key] = (login.json() as { token: string }).token;
    }
    emgA = await createEmergency('A');
    emgB = await createEmergency('B');
    emgC = await createEmergency('C');
  }, 180000);

  afterAll(async () => {
    try { await server?.shutdown(); }
    finally {
      try { await db?.$disconnect(); }
      finally { owned?.cleanup(); }
    }
  });

  async function createEmergency(suffix: string): Promise<string> {
    const id = `EMG-STAGE426-${suffix}`;
    await db!.emergency.create({ data: {
      id, incidentType: 'TRAUMA', severity: 'HIGH', latitude: 12, longitude: 77, isSimulation: false,
    } });
    return id;
  }

  const auth = (key: string) => ({ authorization: `Bearer ${tokens[key]}` });
  const assertionBody = { category: 'UNKNOWN', categoryVersion: 'OUTCOME_V1', survivalToDischarge: null };
  const reviewBody = { decision: 'APPROVED', eligibilityDecision: 'INELIGIBLE', eligibilityReasonCode: 'TEST_DATA' };
  const idem = () => `grant-key-${String(++keyCounter).padStart(4, '0')}`;

  async function grant(adminKey: string, emergency: string, granteeUserId: string, capability: 'SUBMIT' | 'REVIEW', extraBody: Record<string, unknown> = {}) {
    return server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${emergency}/outcome-grants`,
      headers: auth(adminKey), payload: { granteeUserId, capability, ...extraBody },
    });
  }

  async function revoke(adminKey: string, emergency: string, grantId: string) {
    return server!.fastify.inject({
      method: 'DELETE', url: `/api/emergencies/${emergency}/outcome-grants/${grantId}`,
      headers: auth(adminKey),
    });
  }

  async function submit(key: string, emergency: string, body: Record<string, unknown> = assertionBody, idempotencyKey = idem()) {
    return server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${emergency}/outcomes`,
      headers: { ...auth(key), 'idempotency-key': idempotencyKey }, payload: body,
    });
  }

  async function review(key: string, emergency: string, outcomeId: string, body: Record<string, unknown> = reviewBody, idempotencyKey = idem()) {
    return server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${emergency}/outcomes/${outcomeId}/reviews`,
      headers: { ...auth(key), 'idempotency-key': idempotencyKey }, payload: body,
    });
  }

  async function supersede(key: string, emergency: string, outcomeId: string, idempotencyKey = idem()) {
    return server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${emergency}/outcomes/${outcomeId}/supersessions`,
      headers: { ...auth(key), 'idempotency-key': idempotencyKey },
      payload: { ...assertionBody, category: 'TRANSPORTED', correctionReasonCode: 'DATA_ENTRY_ERROR' },
    });
  }

  async function history(key: string, emergency: string) {
    return server!.fastify.inject({ method: 'GET', url: `/api/emergencies/${emergency}/outcomes`, headers: auth(key) });
  }

  async function snapshotState() {
    const grants = await db!.emergencyOutcomeGrant.findMany({ orderBy: { id: 'asc' } });
    return {
      assertions: await db!.outcomeAssertion.count(),
      reviews: await db!.outcomeReview.count(),
      events: await db!.systemEvent.count(),
      legacyOutcomes: await db!.outcome.count(),
      learningSamples: await db!.learningSample.count(),
      grantCount: grants.length,
      grantStates: grants.map((row) => ({ id: row.id, revokedAt: row.revokedAt?.toISOString() ?? null, revokedByUserId: row.revokedByUserId })),
    };
  }

  it('authorizes a SUBMIT grant for the granted emergency only', async () => {
    const created = await grant('admin', emgA, userIds.submitterA, 'SUBMIT');
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      emergencyId: emgA,
      granteeUserId: userIds.submitterA,
      capability: 'SUBMIT',
      grantedByUserId: userIds.admin,
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
    });
    subAGrantOnA = created.json().id as string;
    expect(await db!.emergencyOutcomeGrant.count({ where: { emergencyId: emgA, granteeUserId: userIds.submitterA } })).toBe(1);
    const submitted = await submit('submitterA', emgA);
    expect(submitted.statusCode).toBe(201);
    outA1 = submitted.json().id as string;
    const crossSubmit = await submit('submitterA', emgB);
    expect(crossSubmit.statusCode).toBe(403);
    expect(crossSubmit.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: scopeMessage } });
    const crossRead = await history('submitterA', emgB);
    expect(crossRead.statusCode).toBe(403);
    const grantedRead = await history('submitterA', emgA);
    expect(grantedRead.statusCode).toBe(200);
    expect(grantedRead.json().items).toHaveLength(1);
  });

  it('authorizes a REVIEW grant only alongside the independent-review rules', async () => {
    const created = await grant('admin', emgA, userIds.reviewerA, 'REVIEW');
    expect(created.statusCode).toBe(201);
    revAGrantOnA = created.json().id as string;
    const reviewed = await review('reviewerA', emgA, outA1);
    expect(reviewed.statusCode).toBe(201);
    expect(reviewed.json()).toMatchObject({ reviewStatus: 'APPROVED', review: { reviewerUserId: userIds.reviewerA } });
    const selfReview = await review('submitterA', emgA, outA1);
    expect(selfReview.statusCode).toBe(403);
    expect(selfReview.json().error.message).toBe("Role 'OUTCOME_SUBMITTER' may not call this endpoint.");
    const secondGrant = await grant('admin', emgB, userIds.submitterB, 'SUBMIT');
    expect(secondGrant.statusCode).toBe(201);
    const submittedB = await submit('submitterB', emgB);
    expect(submittedB.statusCode).toBe(201);
    outB1 = submittedB.json().id as string;
    const crossEmergencyReview = await review('reviewerA', emgB, outB1);
    expect(crossEmergencyReview.statusCode).toBe(403);
    expect(crossEmergencyReview.json().error.message).toBe(scopeMessage);
  });

  it('does not let a SUBMIT-only grant authorize reviews', async () => {
    const created = await grant('admin', emgA, userIds.reviewerB, 'SUBMIT');
    expect(created.statusCode).toBe(201);
    const attemptedReview = await review('reviewerB', emgA, outA1);
    expect(attemptedReview.statusCode).toBe(403);
    expect(attemptedReview.json().error.message).toBe(scopeMessage);
    expect(await db!.outcomeReview.count({ where: { outcomeRecordId: outA1 } })).toBe(1);
    const readViaSubmitGrant = await history('reviewerB', emgA);
    expect(readViaSubmitGrant.statusCode).toBe(200);
  });

  it('does not let a REVIEW-only grant authorize submission or supersession', async () => {
    const created = await grant('admin', emgB, userIds.submitterA, 'REVIEW');
    expect(created.statusCode).toBe(201);
    const attemptedSubmit = await submit('submitterA', emgB);
    expect(attemptedSubmit.statusCode).toBe(403);
    expect(attemptedSubmit.json().error.message).toBe(scopeMessage);
    const attemptedSupersession = await supersede('submitterA', emgB, outB1);
    expect(attemptedSupersession.statusCode).toBe(403);
    expect(attemptedSupersession.json().error.message).toBe(scopeMessage);
    expect(await db!.outcomeAssertion.count({ where: { supersedesOutcomeId: outB1 } })).toBe(0);
    const readViaReviewGrant = await history('submitterA', emgB);
    expect(readViaReviewGrant.statusCode).toBe(200);
  });

  it('stops authorizing a revoked grant even when the grantee previously participated', async () => {
    const revokedSubmit = await revoke('admin', emgA, subAGrantOnA);
    expect(revokedSubmit.statusCode).toBe(200);
    expect(revokedSubmit.json()).toMatchObject({
      id: subAGrantOnA,
      revokedAt: expect.any(String),
      revokedByUserId: userIds.admin,
    });
    const submitAfterRevoke = await submit('submitterA', emgA);
    expect(submitAfterRevoke.statusCode).toBe(403);
    expect(submitAfterRevoke.json().error.message).toBe(scopeMessage);
    const readAfterRevoke = await history('submitterA', emgA);
    expect(readAfterRevoke.statusCode).toBe(403);
    const continuityGrant = await grant('admin', emgA, userIds.submitterB, 'SUBMIT');
    expect(continuityGrant.statusCode).toBe(201);
    const continued = await submit('submitterB', emgA);
    expect(continued.statusCode).toBe(201);
    outA2 = continued.json().id as string;
    const revokedReview = await revoke('admin', emgA, revAGrantOnA);
    expect(revokedReview.statusCode).toBe(200);
    const reviewAfterRevoke = await review('reviewerA', emgA, outA2);
    expect(reviewAfterRevoke.statusCode).toBe(403);
    expect(reviewAfterRevoke.json().error.message).toBe(scopeMessage);
    const readReviewerAfterRevoke = await history('reviewerA', emgA);
    expect(readReviewerAfterRevoke.statusCode).toBe(403);
  });

  it('treats repeated grant requests as idempotent and re-grants after revocation', async () => {
    const first = await grant('admin', emgB, userIds.reviewerA, 'REVIEW');
    expect(first.statusCode).toBe(201);
    revAGrantOnB = first.json().id as string;
    const repeat = await grant('admin', emgB, userIds.reviewerA, 'REVIEW');
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json().id).toBe(revAGrantOnB);
    expect(await db!.emergencyOutcomeGrant.count({ where: { emergencyId: emgB, granteeUserId: userIds.reviewerA, capability: 'REVIEW' } })).toBe(1);
    const regrant = await grant('admin', emgA, userIds.submitterA, 'SUBMIT');
    expect(regrant.statusCode).toBe(201);
    expect(regrant.json()).toMatchObject({ id: subAGrantOnA, revokedAt: null, revokedByUserId: null });
    const submitAfterRegrant = await submit('submitterA', emgA);
    expect(submitAfterRegrant.statusCode).toBe(201);
    outA3 = submitAfterRegrant.json().id as string;
  });

  it('refuses grant management from every non-admin role', async () => {
    expect((await grant('submitterA', emgC, userIds.submitterA, 'SUBMIT')).statusCode).toBe(403);
    expect((await grant('reviewerA', emgC, userIds.reviewerA, 'REVIEW')).statusCode).toBe(403);
    expect((await grant('submitterB', emgC, userIds.submitterB, 'SUBMIT')).statusCode).toBe(403);
    const dispatcherAttempt = await grant('dispatcher', emgC, userIds.dispatcher, 'SUBMIT');
    expect(dispatcherAttempt.statusCode).toBe(403);
    expect(dispatcherAttempt.json().error.message).toBe("Role 'DISPATCHER' may not call this endpoint.");
    expect((await revoke('submitterA', emgA, subAGrantOnA)).statusCode).toBe(403);
    expect((await revoke('dispatcher', emgA, subAGrantOnA)).statusCode).toBe(403);
    expect((await revoke('reviewerA', emgA, subAGrantOnA)).statusCode).toBe(403);
    expect(await db!.emergencyOutcomeGrant.count({ where: { emergencyId: emgC } })).toBe(0);
  });

  it('rejects forged grantor, scope, status and capability fields under the strict schema', async () => {
    const forgedGrantor = await grant('admin', emgC, userIds.dispatcher, 'SUBMIT', { grantedByUserId: userIds.dispatcher });
    expect(forgedGrantor.statusCode).toBe(422);
    expect(forgedGrantor.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: 'The request did not match the expected shape.' } });
    const forgedStatus = await grant('admin', emgC, userIds.dispatcher, 'SUBMIT', { revokedAt: null, isActive: true, emergencyId: emgA });
    expect(forgedStatus.statusCode).toBe(422);
    const forgedRead = await grant('admin', emgC, userIds.dispatcher, 'READ' as 'SUBMIT');
    expect(forgedRead.statusCode).toBe(422);
    const forgedOwner = await grant('admin', emgC, userIds.dispatcher, 'OWNER' as 'SUBMIT');
    expect(forgedOwner.statusCode).toBe(422);
    expect(await db!.emergencyOutcomeGrant.count({ where: { emergencyId: emgC } })).toBe(0);
  });

  it('keeps foreign outcome IDs bound to their own emergency URL', async () => {
    const foreignReview = await review('reviewerA', emgB, outA1);
    expect(foreignReview.statusCode).toBe(404);
    expect(foreignReview.json().error.code).toBe('NOT_FOUND');
    expect(foreignReview.json().error.message).toBe(`Outcome assertion '${outA1}' was not found.`);
    const foreignCorrection = await supersede('submitterB', emgB, outA2);
    expect(foreignCorrection.statusCode).toBe(404);
    expect(foreignCorrection.json().error.code).toBe('NOT_FOUND');
    const lineage = await history('submitterA', emgA);
    const original = lineage.json().items.find((row: { id: string }) => row.id === outA1);
    expect(original).toMatchObject({ isCurrent: true, successorId: null });
    expect(await db!.outcomeReview.count({ where: { outcomeRecordId: outA1 } })).toBe(1);
    expect(await db!.outcomeAssertion.count({ where: { supersedesOutcomeId: outA2 } })).toBe(0);
  });

  it('leaves outcomes, reviews, events, legacy rows, learning samples and grant state untouched across denials', async () => {
    const before = await snapshotState();
    const denials = await Promise.all([
      submit('submitterA', emgC),
      history('submitterA', emgC),
      grant('dispatcher', emgC, userIds.dispatcher, 'SUBMIT'),
      grant('submitterA', emgC, userIds.submitterA, 'SUBMIT'),
      review('reviewerB', emgB, outB1),
      supersede('submitterB', emgB, outA2),
      grant('admin', emgC, userIds.dispatcher, 'READ' as 'SUBMIT'),
      server!.fastify.inject({
        method: 'POST', url: `/api/emergencies/${emgA}/outcomes`,
        headers: { 'idempotency-key': 'grant-key-anonymous-0001' }, payload: assertionBody,
      }),
      grant('admin', 'EMG-STAGE426-ABSENT', userIds.dispatcher, 'SUBMIT'),
      grant('admin', emgC, 'USR-STAGE426-ABSENT', 'SUBMIT'),
      revoke('admin', emgB, 'OGT-STAGE426-ABSENT'),
      revoke('admin', emgB, subAGrantOnA),
    ]);
    expect(denials.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403, 404, 422, 401, 404, 404, 404, 404]);
    const after = await snapshotState();
    expect(after).toEqual(before);
    expect(after.learningSamples).toBe(0);
  });

  it('fails closed when authorization storage cannot be queried', async () => {
    const failingDb = new Proxy(db!, {
      get(target, property) {
        if (property === 'emergencyOutcomeGrant') {
          return { findMany: async () => { throw new Error('simulated grant store failure'); } };
        }
        return Reflect.get(target, property) as unknown;
      },
    });
    const failingModule = createModule11({ db: failingDb as PrismaClient, ownsClient: false });
    await expect(failingModule.outcomes.hasEmergencyAccess(userIds.submitterA, emgA, 'SUBMIT'))
      .rejects.toMatchObject({ statusCode: 500 });
    const scopeSpy = vi.spyOn(server!.module11.outcomes, 'hasEmergencyAccess')
      .mockRejectedValueOnce(new AppError(ErrorCode.DATABASE_FAILURE, 'Failed to evaluate emergency outcome access', 500));
    try {
      const denied = await submit('submitterA', emgA);
      expect(denied.statusCode).toBe(500);
      expect(denied.json()).toMatchObject({ error: { code: 'DATABASE_FAILURE' } });
    } finally {
      scopeSpy.mockRestore();
    }
    const grantSpy = vi.spyOn(server!.module11.outcomes, 'recordGrant')
      .mockRejectedValueOnce(new AppError(ErrorCode.DATABASE_FAILURE, 'Failed to record outcome access grant', 500));
    const grantsBefore = await db!.emergencyOutcomeGrant.count();
    try {
      const failed = await grant('admin', emgC, userIds.dispatcher, 'SUBMIT');
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({ error: { code: 'DATABASE_FAILURE' } });
    } finally {
      grantSpy.mockRestore();
    }
    expect(await db!.emergencyOutcomeGrant.count()).toBe(grantsBefore);
    const assertionCount = await db!.outcomeAssertion.count({ where: { emergencyId: emgA } });
    expect(assertionCount).toBe(3);
    expect(outA3).toBeTruthy();
  });

  it('preserves idempotency, append-only correction, independence and the learning gate under grants', async () => {
    const granted = await grant('admin', emgC, userIds.submitterA, 'SUBMIT');
    expect(granted.statusCode).toBe(201);
    const key = idem();
    const first = await submit('submitterA', emgC, assertionBody, key);
    const retry = await submit('submitterA', emgC, assertionBody, key);
    expect(first.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    const conflict = await submit('submitterA', emgC, { ...assertionBody, category: 'TRANSPORTED' }, key);
    expect(conflict.statusCode).toBe(409);
    const original = await submit('submitterA', emgC);
    expect(original.statusCode).toBe(201);
    const corrected = await supersede('submitterA', emgC, original.json().id);
    expect(corrected.statusCode).toBe(201);
    expect(corrected.json()).toMatchObject({ supersedesOutcomeId: original.json().id, reviewStatus: 'PENDING' });
    const selfReview = await review('submitterA', emgC, corrected.json().id);
    expect(selfReview.statusCode).toBe(403);
    const reviewGrant = await grant('admin', emgC, userIds.reviewerA, 'REVIEW');
    expect(reviewGrant.statusCode).toBe(201);
    const learningGate = await review('reviewerA', emgC, corrected.json().id, {
      decision: 'APPROVED', eligibilityDecision: 'ELIGIBLE', eligibilityReasonCode: 'VERIFIED_EVIDENCE',
    });
    expect(learningGate.statusCode).toBe(422);
    const approved = await review('reviewerA', emgC, corrected.json().id);
    expect(approved.statusCode).toBe(201);
    const read = await history('submitterA', emgC);
    expect(read.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original.json().id, isCurrent: false, successorId: corrected.json().id }),
      expect.objectContaining({ id: corrected.json().id, isCurrent: true, predecessorId: original.json().id, reviewStatus: 'APPROVED' }),
    ]));
    expect(await db!.learningSample.count()).toBe(0);
  });
});
