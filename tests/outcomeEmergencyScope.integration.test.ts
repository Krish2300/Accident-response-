import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './helpers/isolatedTestDatabase.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = process.env.RESUS_RUN_ISOLATED_OUTCOME_API_TEST === 'true';
const suite = enabled ? describe : describe.skip;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const schemaPath = resolve(repoRoot, 'modules/module_11_database_event_system/prisma/schema.prisma');
const password = 'Stage425-isolated-test-only-9!';
const scopeMessage = 'You are not authorized to access outcome records for this emergency.';

suite('per-emergency outcome authorization on an owned isolated SQLite database', () => {
  let owned: IsolatedTestDatabase | undefined;
  let db: PrismaClient | undefined;
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let emergencyOne = '';
  let emergencyTwo = '';
  let emergencyThree = '';
  let assertionInOne = '';
  let assertionInTwo = '';
  let sourceInOne = '';
  let grantCounter = 0;
  let keyCounter = 0;

  beforeAll(async () => {
    owned = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: owned.databaseUrl } } });
    server = await buildServer(loadServerConfig({
      NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '4000', LOG_LEVEL: 'error',
      JWT_SECRET: 'stage-4.25-outcome-scope-isolated-jwt-secret', MODULE3_NLP_ENABLED: 'false',
    }), { db, ownsDatabaseClient: false });
    const hash = await bcrypt.hash(password, 4);
    const users = [
      ['submitterA', 'outcome-scope-submitter-a@stage425.test', 'Scope Submitter A', 'OUTCOME_SUBMITTER'],
      ['submitterB', 'outcome-scope-submitter-b@stage425.test', 'Scope Submitter B', 'OUTCOME_SUBMITTER'],
      ['reviewerA', 'outcome-scope-reviewer-a@stage425.test', 'Scope Reviewer A', 'OUTCOME_REVIEWER'],
      ['reviewerB', 'outcome-scope-reviewer-b@stage425.test', 'Scope Reviewer B', 'OUTCOME_REVIEWER'],
      ['admin', 'outcome-scope-admin@stage425.test', 'Scope Admin', 'ADMIN'],
      ['clinical', 'outcome-scope-clinical@stage425.test', 'Scope Clinical Supervisor', 'CLINICAL_SUPERVISOR'],
      ['dispatcher', 'outcome-scope-dispatcher@stage425.test', 'Scope Dispatcher', 'DISPATCHER'],
      ['driver', 'outcome-scope-driver@stage425.test', 'Scope Driver', 'DRIVER'],
    ] as const;
    for (const [key, email, displayName, role] of users) {
      const created = await server.module11.users.create({ email, displayName, passwordHash: hash, role });
      userIds[key] = created.id;
      const login = await server.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
      expect(login.statusCode).toBe(200);
      tokens[key] = (login.json() as { token: string }).token;
    }
    emergencyOne = await createEmergency('ONE');
    emergencyTwo = await createEmergency('TWO');
    emergencyThree = await createEmergency('THREE');
    await grantScope(emergencyOne, 'SUBMIT', 'submitterA');
    await grantScope(emergencyOne, 'REVIEW', 'reviewerA');
    await grantScope(emergencyTwo, 'SUBMIT', 'submitterB');
    await grantScope(emergencyTwo, 'REVIEW', 'reviewerB');
    await grantScope(emergencyOne, 'SUBMIT', 'admin', 'clinical', 'dispatcher', 'driver');
  }, 180000);

  afterAll(async () => {
    try { await server?.shutdown(); }
    finally {
      try { await db?.$disconnect(); }
      finally { owned?.cleanup(); }
    }
  });

  async function createEmergency(suffix: string): Promise<string> {
    const id = `EMG-STAGE425-${suffix}`;
    await db!.emergency.create({ data: {
      id, incidentType: 'TRAUMA', severity: 'HIGH', latitude: 12, longitude: 77, isSimulation: false,
    } });
    return id;
  }

  async function grantScope(emergency: string, capability: 'SUBMIT' | 'REVIEW', ...userKeys: string[]): Promise<void> {
    for (const userKey of userKeys) {
      await db!.emergencyOutcomeGrant.create({ data: {
        id: `OGT-SCOPE425-${++grantCounter}`,
        emergencyId: emergency,
        granteeUserId: userIds[userKey]!,
        capability,
        grantedByUserId: userIds.admin!,
      } });
    }
  }

  const auth = (key: string) => ({ authorization: `Bearer ${tokens[key]}` });
  const assertionBody = { category: 'UNKNOWN', categoryVersion: 'OUTCOME_V1', survivalToDischarge: null };
  const reviewBody = { decision: 'APPROVED', eligibilityDecision: 'INELIGIBLE', eligibilityReasonCode: 'TEST_DATA' };
  const idem = () => `scope-key-${String(++keyCounter).padStart(4, '0')}`;

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
    return {
      assertions: await db!.outcomeAssertion.count(),
      reviews: await db!.outcomeReview.count(),
      events: await db!.systemEvent.count(),
      legacyOutcomes: await db!.outcome.count(),
      learningSamples: await db!.learningSample.count(),
    };
  }

  it('admits submission, history and independent review inside an established scope', async () => {
    const submitted = await submit('submitterA', emergencyOne);
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json()).toMatchObject({ emergencyId: emergencyOne, submittedByUserId: userIds.submitterA });
    assertionInOne = submitted.json().id as string;
    const read = await history('reviewerA', emergencyOne);
    expect(read.statusCode).toBe(200);
    expect(read.json().items).toHaveLength(1);
    const reviewed = await review('reviewerA', emergencyOne, assertionInOne);
    expect(reviewed.statusCode).toBe(201);
    expect(reviewed.json()).toMatchObject({
      reviewStatus: 'APPROVED',
      review: { reviewerUserId: userIds.reviewerA, eligibleForLearning: false },
    });
  });

  it('denies submission, history and review for emergencies outside the caller scope', async () => {
    const inScopeSecond = await submit('submitterB', emergencyTwo);
    expect(inScopeSecond.statusCode).toBe(201);
    assertionInTwo = inScopeSecond.json().id as string;
    const outOfScopeSubmit = await submit('submitterA', emergencyThree);
    expect(outOfScopeSubmit.statusCode).toBe(403);
    expect(outOfScopeSubmit.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: scopeMessage, details: null } });
    const crossRead = await history('submitterA', emergencyTwo);
    expect(crossRead.statusCode).toBe(403);
    expect(crossRead.json().error.message).toBe(scopeMessage);
    const freshRead = await history('submitterA', emergencyThree);
    expect(freshRead.statusCode).toBe(403);
    expect(freshRead.json().error.message).toBe(scopeMessage);
    const reviewerCrossRead = await history('reviewerA', emergencyTwo);
    expect(reviewerCrossRead.statusCode).toBe(403);
    expect(reviewerCrossRead.json().error.message).toBe(scopeMessage);
    const crossUrlSubmit = await submit('submitterA', emergencyTwo);
    expect(crossUrlSubmit.statusCode).toBe(403);
    expect(crossUrlSubmit.json().error.message).toBe(scopeMessage);
    const reviewerOutOfScope = await review('reviewerA', emergencyTwo, assertionInTwo);
    expect(reviewerOutOfScope.statusCode).toBe(403);
    expect(reviewerOutOfScope.json().error.message).toBe(scopeMessage);
    const absentEmergency = await submit('submitterA', 'EMG-STAGE425-ABSENT');
    expect(absentEmergency.statusCode).toBe(404);
    expect(absentEmergency.json().error.code).toBe('NOT_FOUND');
    expect(await db!.outcomeAssertion.count({ where: { emergencyId: emergencyThree } })).toBe(0);
  });

  it('blocks supersession of another emergency outcome through unscoped and scoped URLs', async () => {
    const source = await submit('submitterA', emergencyOne);
    expect(source.statusCode).toBe(201);
    sourceInOne = source.json().id as string;
    const viaUnscopedUrl = await supersede('submitterA', emergencyTwo, sourceInOne);
    expect(viaUnscopedUrl.statusCode).toBe(403);
    expect(viaUnscopedUrl.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: scopeMessage } });
    const viaScopedForeignUrl = await supersede('submitterB', emergencyTwo, sourceInOne);
    expect(viaScopedForeignUrl.statusCode).toBe(404);
    expect(viaScopedForeignUrl.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: `Outcome assertion '${sourceInOne}' was not found.` },
    });
    const lineage = await history('submitterA', emergencyOne);
    const item = lineage.json().items.find((row: { id: string }) => row.id === sourceInOne);
    expect(item).toMatchObject({ isCurrent: true, successorId: null, predecessorId: null });
    expect(await db!.outcomeAssertion.count({ where: { supersedesOutcomeId: sourceInOne } })).toBe(0);
  });

  it('keeps reviews scoped: the in-scope reviewer succeeds and foreign reviewers are refused', async () => {
    const fresh = await submit('submitterB', emergencyTwo);
    expect(fresh.statusCode).toBe(201);
    const freshId = fresh.json().id as string;
    const inScopeReviewer = await review('reviewerB', emergencyTwo, freshId);
    expect(inScopeReviewer.statusCode).toBe(201);
    const foreignReviewer = await review('reviewerA', emergencyTwo, freshId);
    expect(foreignReviewer.statusCode).toBe(403);
    expect(foreignReviewer.json().error.message).toBe(scopeMessage);
    expect(await db!.outcomeReview.count({ where: { outcomeRecordId: freshId } })).toBe(1);
    const otherForeignReviewer = await review('reviewerB', emergencyOne, assertionInOne);
    expect(otherForeignReviewer.statusCode).toBe(403);
    expect(otherForeignReviewer.json().error.message).toBe(scopeMessage);
    expect(await db!.outcomeReview.count({ where: { outcomeRecordId: assertionInOne } })).toBe(1);
  });

  it('rejects foreign outcome IDs presented through an in-scope URL without an existence oracle', async () => {
    const foreignReview = await review('reviewerB', emergencyTwo, assertionInOne);
    expect(foreignReview.statusCode).toBe(404);
    expect(foreignReview.json().error.code).toBe('NOT_FOUND');
    expect(foreignReview.json().error.message).toBe(`Outcome assertion '${assertionInOne}' was not found.`);
    const foreignCorrection = await supersede('submitterB', emergencyTwo, assertionInOne);
    expect(foreignCorrection.statusCode).toBe(404);
    expect(foreignCorrection.json().error.code).toBe('NOT_FOUND');
    const wrongEmergencyCorrection = await supersede('submitterB', emergencyOne, assertionInTwo);
    expect(wrongEmergencyCorrection.statusCode).toBe(403);
    expect(wrongEmergencyCorrection.json().error.message).toBe(scopeMessage);
    expect(await db!.outcomeReview.count({ where: { outcomeRecordId: assertionInOne } })).toBe(1);
    expect(await db!.outcomeAssertion.count({ where: { supersedesOutcomeId: assertionInOne } })).toBe(0);
  });

  it('rejects forged identity, scope and provenance fields without granting access', async () => {
    const forgedSubmit = await submit('submitterA', emergencyThree, {
      ...assertionBody,
      submittedByUserId: userIds.submitterB,
      emergencyId: emergencyOne,
      dataClassification: 'OPERATIONAL',
      provenance: 'REAL_OBSERVED',
      eligibleForLearning: true,
    });
    expect(forgedSubmit.statusCode).toBe(422);
    expect(forgedSubmit.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: 'The request did not match the expected shape.' } });
    const forgedReview = await review('reviewerA', emergencyThree, assertionInOne, {
      ...reviewBody,
      reviewerUserId: userIds.reviewerB,
      emergencyId: emergencyOne,
    });
    expect(forgedReview.statusCode).toBe(422);
    expect(forgedReview.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: 'The request did not match the expected shape.' } });
    const forgedCorrection = await server!.fastify.inject({
      method: 'POST',
      url: `/api/emergencies/${emergencyThree}/outcomes/${assertionInOne}/supersessions`,
      headers: { ...auth('submitterA'), 'idempotency-key': idem() },
      payload: { ...assertionBody, category: 'TRANSPORTED', correctionReasonCode: 'DATA_ENTRY_ERROR', emergencyId: emergencyOne, submittedByUserId: userIds.submitterB },
    });
    expect(forgedCorrection.statusCode).toBe(422);
    expect(forgedCorrection.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: 'The request did not match the expected shape.' } });
    const forgedQuery = await server!.fastify.inject({
      method: 'GET',
      url: `/api/emergencies/${emergencyTwo}/outcomes?scope=GRANTED&emergencyId=${emergencyOne}`,
      headers: auth('reviewerA'),
    });
    expect(forgedQuery.statusCode).toBe(403);
    expect(forgedQuery.json().error.message).toBe(scopeMessage);
    expect(await db!.outcomeAssertion.count({ where: { emergencyId: emergencyThree } })).toBe(0);
    expect(await db!.outcomeAssertion.count({ where: { emergencyId: emergencyOne, submittedByUserId: userIds.submitterB } })).toBe(0);
  });

  it('preserves idempotency, append-only correction, independence and the learning gate in scope', async () => {
    const key = idem();
    const first = await submit('submitterA', emergencyOne, assertionBody, key);
    const retry = await submit('submitterA', emergencyOne, assertionBody, key);
    expect(first.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    const conflict = await submit('submitterA', emergencyOne, { ...assertionBody, category: 'TRANSPORTED' }, key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('CONFLICT');
    const original = await submit('submitterA', emergencyOne);
    expect(original.statusCode).toBe(201);
    const corrected = await supersede('submitterA', emergencyOne, original.json().id);
    expect(corrected.statusCode).toBe(201);
    expect(corrected.json()).toMatchObject({ supersedesOutcomeId: original.json().id, reviewStatus: 'PENDING' });
    const selfReview = await review('submitterA', emergencyOne, corrected.json().id);
    expect(selfReview.statusCode).toBe(403);
    expect(selfReview.json().error.message).toBe("Role 'OUTCOME_SUBMITTER' may not call this endpoint.");
    const learningGate = await review('reviewerA', emergencyOne, corrected.json().id, {
      decision: 'APPROVED', eligibilityDecision: 'ELIGIBLE', eligibilityReasonCode: 'VERIFIED_EVIDENCE',
    });
    expect(learningGate.statusCode).toBe(422);
    expect(learningGate.json().error.code).toBe('VALIDATION_ERROR');
    const approved = await review('reviewerA', emergencyOne, corrected.json().id);
    expect(approved.statusCode).toBe(201);
    expect(approved.json()).toMatchObject({ reviewStatus: 'APPROVED' });
    const read = await history('submitterA', emergencyOne);
    expect(read.statusCode).toBe(200);
    expect(read.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original.json().id, isCurrent: false, successorId: corrected.json().id }),
      expect.objectContaining({ id: corrected.json().id, isCurrent: true, predecessorId: original.json().id, reviewStatus: 'APPROVED' }),
    ]));
    expect(await db!.learningSample.count()).toBe(0);
  });

  it('leaves assertions, reviews, events, legacy outcomes and learning samples untouched across denials', async () => {
    const before = await snapshotState();
    const denials = await Promise.all([
      submit('submitterA', emergencyThree),
      history('reviewerB', emergencyOne),
      supersede('submitterA', emergencyTwo, assertionInOne),
      supersede('submitterB', emergencyTwo, assertionInOne),
      review('reviewerB', emergencyOne, assertionInOne),
      server!.fastify.inject({
        method: 'POST', url: `/api/emergencies/${emergencyOne}/outcomes`,
        headers: { 'idempotency-key': 'scope-key-anonymous-0001' }, payload: assertionBody,
      }),
      submit('admin', emergencyOne),
      submit('submitterA', emergencyThree, { ...assertionBody, submittedByUserId: userIds.admin }),
      history('submitterA', 'EMG-STAGE425-ABSENT'),
      server!.fastify.inject({
        method: 'GET', url: `/api/emergencies/${emergencyTwo}/outcomes?scope=GRANTED`,
        headers: auth('reviewerA'),
      }),
    ]);
    expect(denials.map((response) => response.statusCode)).toEqual([403, 403, 403, 404, 403, 401, 403, 422, 404, 403]);
    const after = await snapshotState();
    expect(after).toEqual(before);
    expect(after.learningSamples).toBe(0);
    expect(after.legacyOutcomes).toBe(0);
  });

  it('keeps privileged roles at role-gate denial even when granted emergency scope', async () => {
    const adminSubmit = await submit('admin', emergencyOne);
    expect(adminSubmit.statusCode).toBe(403);
    expect(adminSubmit.json().error.message).toBe("Role 'ADMIN' may not call this endpoint.");
    const adminRead = await history('admin', emergencyTwo);
    expect(adminRead.statusCode).toBe(403);
    expect(adminRead.json().error.message).toBe("Role 'ADMIN' may not call this endpoint.");
    const clinicalReview = await review('clinical', emergencyOne, assertionInOne);
    expect(clinicalReview.statusCode).toBe(403);
    expect(clinicalReview.json().error.message).toBe("Role 'CLINICAL_SUPERVISOR' may not call this endpoint.");
    const clinicalCorrection = await supersede('clinical', emergencyOne, assertionInOne);
    expect(clinicalCorrection.statusCode).toBe(403);
    const dispatcherSubmit = await submit('dispatcher', emergencyOne);
    expect(dispatcherSubmit.statusCode).toBe(403);
    const driverRead = await history('driver', emergencyOne);
    expect(driverRead.statusCode).toBe(403);
    expect(await db!.outcomeAssertion.count({ where: { submittedByUserId: userIds.admin } })).toBe(0);
    expect(await db!.outcomeReview.count({ where: { reviewerUserId: userIds.clinical } })).toBe(0);
  });
});
