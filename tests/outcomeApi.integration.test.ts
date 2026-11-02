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
const password = 'Stage4172-isolated-test-only-9!';

suite('outcome HTTP workflow on an owned isolated SQLite database', () => {
  let owned: IsolatedTestDatabase | undefined;
  let db: PrismaClient | undefined;
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  let submitterToken = '';
  let reviewerToken = '';
  let dispatcherToken = '';
  let driverToken = '';
  let adminToken = '';
  let submitterId = '';
  let reviewerId = '';
  let adminId = '';
  let emergencyId = '';
  let otherEmergencyId = '';
  let counter = 0;
  let grantCounter = 0;

  beforeAll(async () => {
    owned = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: owned.databaseUrl } } });
    server = await buildServer(loadServerConfig({
      NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '4000', LOG_LEVEL: 'error',
      JWT_SECRET: 'stage-4.17.2-outcome-api-isolated-jwt-secret', MODULE3_NLP_ENABLED: 'false',
    }), { db, ownsDatabaseClient: false });
    const hash = await bcrypt.hash(password, 4);
    const submitter = await server.module11.users.create({ email: 'outcome-submitter@stage4172.test', displayName: 'Isolated Outcome Submitter', passwordHash: hash, role: 'OUTCOME_SUBMITTER' });
    const reviewer = await server.module11.users.create({ email: 'outcome-reviewer@stage4172.test', displayName: 'Isolated Outcome Reviewer', passwordHash: hash, role: 'OUTCOME_REVIEWER' });
    const dispatcher = await server.module11.users.create({ email: 'outcome-dispatcher@stage4172.test', displayName: 'Isolated Dispatcher', passwordHash: hash, role: 'DISPATCHER' });
    const driver = await server.module11.users.create({ email: 'outcome-driver@stage4172.test', displayName: 'Isolated Driver', passwordHash: hash, role: 'DRIVER' });
    const admin = await server.module11.users.create({ email: 'outcome-admin@stage4172.test', displayName: 'Isolated Admin', passwordHash: hash, role: 'ADMIN' });
    submitterId = submitter.id;
    reviewerId = reviewer.id;
    adminId = admin.id;
    const login = async (email: string) => {
      const response = await server!.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
      expect(response.statusCode).toBe(200);
      return (response.json() as { token: string }).token;
    };
    [submitterToken, reviewerToken, dispatcherToken, driverToken, adminToken] = await Promise.all([
      login(submitter.email), login(reviewer.email), login(dispatcher.email), login(driver.email), login(admin.email),
    ]);
    emergencyId = await createEmergency(false);
    otherEmergencyId = await createEmergency(true);
    await grantScope(emergencyId, 'SUBMIT', submitterId);
    await grantScope(emergencyId, 'REVIEW', reviewerId);
    await grantScope(otherEmergencyId, 'SUBMIT', submitterId);
  }, 180000);

  afterAll(async () => {
    try { await server?.shutdown(); }
    finally {
      try { await db?.$disconnect(); }
      finally { owned?.cleanup(); }
    }
  });

  async function createEmergency(isSimulation: boolean): Promise<string> {
    const id = `EMG-STAGE4172-${++counter}`;
    await db!.emergency.create({ data: {
      id, incidentType: 'TRAUMA', severity: 'HIGH', latitude: 12, longitude: 77, isSimulation,
    } });
    return id;
  }

  async function grantScope(emergency: string, capability: 'SUBMIT' | 'REVIEW', ...userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      await db!.emergencyOutcomeGrant.create({ data: {
        id: `OGT-SCOPE4172-${++grantCounter}`,
        emergencyId: emergency,
        granteeUserId: userId,
        capability,
        grantedByUserId: adminId,
      } });
    }
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const assertionBody = {
    category: 'UNKNOWN', categoryVersion: 'OUTCOME_V1', survivalToDischarge: null,
    observedAt: '2026-10-01T12:00:00.000Z', evidenceRefs: ['opaque:case-1'],
  };

  async function submit(token = submitterToken, key = `outcome-${Date.now()}-0001`, id = emergencyId) {
    return server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${id}/outcomes`, headers: { ...auth(token), 'idempotency-key': key }, payload: assertionBody,
    });
  }

  it('requires the dedicated submitter role and authenticates before route access', async () => {
    expect((await submit(submitterToken)).statusCode).toBe(201);
    expect((await server!.fastify.inject({ method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes`, headers: { 'idempotency-key': 'missing-auth-key-001' }, payload: assertionBody })).statusCode).toBe(401);
    expect((await server!.fastify.inject({ method: 'GET', url: `/api/emergencies/${emergencyId}/outcomes` })).statusCode).toBe(401);
    expect((await server!.fastify.inject({ method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes`, headers: auth(submitterToken), payload: assertionBody })).statusCode).toBe(422);
    expect((await submit(dispatcherToken, 'dispatcher-submit-key-001')).statusCode).toBe(403);
    expect((await server!.fastify.inject({ method: 'GET', url: `/api/emergencies/${emergencyId}/outcomes`, headers: auth(dispatcherToken) })).statusCode).toBe(403);
    expect((await server!.fastify.inject({ method: 'GET', url: `/api/emergencies/${emergencyId}/outcomes`, headers: auth(driverToken) })).statusCode).toBe(403);
    expect((await server!.fastify.inject({ method: 'GET', url: `/api/emergencies/${emergencyId}/outcomes`, headers: auth(adminToken) })).statusCode).toBe(403);
    expect((await submit(adminToken, 'admin-submit-key-001')).statusCode).toBe(403);
  });

  it('derives submitter and TEST provenance server-side and rejects forged trust fields', async () => {
    const response = await submit(submitterToken, 'server-provenance-key-001');
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ submittedByUserId: submitterId, dataClassification: 'TEST', provenance: 'SIMULATION', recordedAt: expect.any(String), reviewStatus: 'PENDING' });
    expect(response.json()).not.toHaveProperty('evidenceRefs');
    expect(response.json()).toMatchObject({ evidenceReferenceCount: 1 });
    const forged = await server!.fastify.inject({ method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes`, headers: { ...auth(submitterToken), 'idempotency-key': 'forged-provenance-key-001' }, payload: { ...assertionBody, dataClassification: 'OPERATIONAL', submittedByUserId: reviewerId, eligibleForLearning: true } });
    expect(forged.statusCode).toBe(422);
  });

  it('validates emergency/category labels and scopes corrections to their emergency', async () => {
    expect((await submit(submitterToken, 'missing-emergency-key-001', 'EMG-ABSENT-4172')).statusCode).toBe(404);
    const invalid = await server!.fastify.inject({ method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes`, headers: { ...auth(submitterToken), 'idempotency-key': 'invalid-survival-key-001' }, payload: { ...assertionBody, category: 'DECEASED', survivalToDischarge: true } });
    expect(invalid.statusCode).toBe(422);
    const invalidCategory = await server!.fastify.inject({ method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes`, headers: { ...auth(submitterToken), 'idempotency-key': 'invalid-category-key-001' }, payload: { ...assertionBody, category: 'ARRIVED_AT_HOSPITAL' } });
    expect(invalidCategory.statusCode).toBe(422);
    const original = await submit(submitterToken, 'cross-emergency-source-key-001');
    const correction = await server!.fastify.inject({ method: 'POST', url: `/api/emergencies/${otherEmergencyId}/outcomes/${original.json().id}/supersessions`, headers: { ...auth(submitterToken), 'idempotency-key': 'cross-emergency-correction-key-001' }, payload: { ...assertionBody, correctionReasonCode: 'DATA_ENTRY_ERROR' } });
    expect(correction.statusCode).toBe(404);
  });

  it('supports idempotent retries, rejects key reuse, and reports append-only correction lineage', async () => {
    const key = 'api-idempotency-key-4172-001';
    const first = await submit(submitterToken, key);
    const retry = await submit(submitterToken, key);
    expect(first.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    const reviewedRetryTarget = await server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes/${first.json().id}/reviews`,
      headers: { ...auth(reviewerToken), 'idempotency-key': 'idempotent-target-review-4172' },
      payload: { decision: 'APPROVED', eligibilityDecision: 'INELIGIBLE', eligibilityReasonCode: 'TEST_DATA' },
    });
    expect(reviewedRetryTarget.statusCode).toBe(201);
    const reviewEventCount = await db!.systemEvent.count({ where: { type: 'OUTCOME_REVIEW_RECORDED' } });
    const sameReviewRetry = await server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes/${first.json().id}/reviews`,
      headers: { ...auth(reviewerToken), 'idempotency-key': 'idempotent-target-review-4172' },
      payload: { decision: 'APPROVED', eligibilityDecision: 'INELIGIBLE', eligibilityReasonCode: 'TEST_DATA' },
    });
    expect(sameReviewRetry.json().review.id).toBe(reviewedRetryTarget.json().review.id);
    expect(await db!.systemEvent.count({ where: { type: 'OUTCOME_REVIEW_RECORDED' } })).toBe(reviewEventCount);
    expect((await submit(submitterToken, key)).json().reviewStatus).toBe('APPROVED');
    const conflict = await server!.fastify.inject({ method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes`, headers: { ...auth(submitterToken), 'idempotency-key': key }, payload: { ...assertionBody, category: 'TRANSPORTED', survivalToDischarge: null } });
    expect(conflict.statusCode).toBe(409);
    const corrected = await server!.fastify.inject({ method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes/${first.json().id}/supersessions`, headers: { ...auth(submitterToken), 'idempotency-key': 'api-correction-key-4172-001' }, payload: { ...assertionBody, category: 'TRANSPORTED', correctionReasonCode: 'NEW_VERIFIED_EVIDENCE' } });
    expect(corrected.statusCode).toBe(201);
    expect(corrected.json()).toMatchObject({ supersedesOutcomeId: first.json().id, reviewStatus: 'PENDING' });
    const history = await server!.fastify.inject({ method: 'GET', url: `/api/emergencies/${emergencyId}/outcomes`, headers: auth(submitterToken) });
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.json().id, isCurrent: false, successorId: corrected.json().id, reviewStatus: 'APPROVED', reviews: [expect.objectContaining({ id: reviewedRetryTarget.json().review.id, isCurrent: true })] }),
      expect.objectContaining({ id: corrected.json().id, isCurrent: true, predecessorId: first.json().id, reviewStatus: 'PENDING', reviews: [] }),
    ]));
    const eventHistory = await server!.module11.events.list({ emergencyId, types: ['OUTCOME_RECORDED', 'OUTCOME_REVIEW_RECORDED'] });
    const persistedAssertions = await db!.outcomeAssertion.findMany({ where: { emergencyId }, orderBy: { recordedAt: 'asc' } });
    const persistedReviews = await db!.outcomeReview.findMany({ where: { outcomeRecordId: { in: persistedAssertions.map((record) => record.id) } } });
    expect(eventHistory.items).toHaveLength(persistedAssertions.length + persistedReviews.length);
    expect(eventHistory.items.map((event) => event.id)).toEqual(expect.arrayContaining([
      ...persistedAssertions.map((record) => `EVT-OUTCOME-${record.id}`),
      ...persistedReviews.map((record) => `EVT-OUTCOME-REVIEW-${record.id}`),
    ]));
  });

  it('returns one correction and a conflict for concurrent supersession requests', async () => {
    const original = await submit(submitterToken, 'concurrent-correction-source-4172');
    const request = (key: string, category: 'TRANSPORTED' | 'DECEASED') => server!.fastify.inject({
      method: 'POST',
      url: `/api/emergencies/${emergencyId}/outcomes/${original.json().id}/supersessions`,
      headers: { ...auth(submitterToken), 'idempotency-key': key },
      payload: { ...assertionBody, category, survivalToDischarge: category === 'DECEASED' ? false : null, correctionReasonCode: 'NEW_VERIFIED_EVIDENCE' },
    });
    const results = await Promise.all([
      request('concurrent-correction-a-4172', 'TRANSPORTED'),
      request('concurrent-correction-b-4172', 'DECEASED'),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });

  it('requires an independent reviewer and keeps decisions append-only', async () => {
    const submitted = await submit(submitterToken, 'review-target-key-4172-001');
    const url = `/api/emergencies/${emergencyId}/outcomes/${submitted.json().id}/reviews`;
    const body = { decision: 'APPROVED', eligibilityDecision: 'INELIGIBLE', eligibilityReasonCode: 'TEST_DATA' };
    expect((await server!.fastify.inject({ method: 'POST', url, headers: { ...auth(submitterToken), 'idempotency-key': 'self-review-key-4172-001' }, payload: body })).statusCode).toBe(403);
    expect((await server!.fastify.inject({ method: 'POST', url, headers: { ...auth(reviewerToken), 'idempotency-key': 'review-no-reason-4172-001' }, payload: { decision: 'REJECTED', eligibilityDecision: 'INELIGIBLE', eligibilityReasonCode: 'REJECTED_INVALID' } })).statusCode).toBe(422);
    expect((await server!.fastify.inject({ method: 'POST', url, headers: { ...auth(reviewerToken), 'idempotency-key': 'review-invalid-decision-4172-001' }, payload: { decision: 'AUTO_APPROVED', eligibilityDecision: 'INELIGIBLE', eligibilityReasonCode: 'TEST_DATA' } })).statusCode).toBe(422);
    const review = await server!.fastify.inject({ method: 'POST', url, headers: { ...auth(reviewerToken), 'idempotency-key': 'review-valid-key-4172-001' }, payload: body });
    expect(review.statusCode).toBe(201);
    expect(review.json()).toMatchObject({
      review: { reviewerUserId: reviewerId, decision: 'APPROVED', reviewReasonCode: null, eligibleForLearning: false, eligibilityReasonCode: 'TEST_DATA' },
      reviewStatus: 'APPROVED', reviews: [expect.objectContaining({ reviewerUserId: reviewerId, isCurrent: true })],
    });
    expect(review.json().review).not.toHaveProperty('evidenceAssessment');
    const forged = await server!.fastify.inject({ method: 'POST', url, headers: { ...auth(reviewerToken), 'idempotency-key': 'review-forged-key-4172-001' }, payload: { ...body, reviewerUserId: submitterId, reviewedAt: new Date().toISOString(), eligibleForLearning: true } });
    expect(forged.statusCode).toBe(422);
    const history = await server!.fastify.inject({ method: 'GET', url: `/api/emergencies/${emergencyId}/outcomes`, headers: auth(reviewerToken) });
    expect(history.json().items.find((item: { id: string }) => item.id === submitted.json().id).reviews).toEqual(expect.arrayContaining([expect.objectContaining({ id: review.json().review.id, isCurrent: true })]));
  });

  it('rejects review attempts to mark test, simulation, unknown, or unverified observations learning eligible', async () => {
    const operationalShapeButTest = await submit(submitterToken, 'eligibility-gate-key-4172-001');
    const eligible = await server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes/${operationalShapeButTest.json().id}/reviews`,
      headers: { ...auth(reviewerToken), 'idempotency-key': 'eligibility-review-key-4172-001' },
      payload: { decision: 'APPROVED', eligibilityDecision: 'ELIGIBLE', eligibilityReasonCode: 'VERIFIED_EVIDENCE' },
    });
    expect(eligible.statusCode).toBe(422);
    const simulated = await server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${otherEmergencyId}/outcomes`, headers: { ...auth(submitterToken), 'idempotency-key': 'simulation-outcome-key-4172-001' }, payload: assertionBody,
    });
    expect(simulated.json()).toMatchObject({ dataClassification: 'SIMULATION', provenance: 'SIMULATION' });
  });

  it('does not emit operational side effects while submitting or reviewing outcomes', async () => {
    const eventsBefore = await db!.systemEvent.count();
    const submitted = await submit(submitterToken, 'side-effect-outcome-key-4172-001');
    const reviewed = await server!.fastify.inject({ method: 'POST', url: `/api/emergencies/${emergencyId}/outcomes/${submitted.json().id}/reviews`, headers: { ...auth(reviewerToken), 'idempotency-key': 'side-effect-review-key-4172-001' }, payload: { decision: 'REJECTED', eligibilityDecision: 'INELIGIBLE', reasonCode: 'UNVERIFIED_PROVENANCE', eligibilityReasonCode: 'UNVERIFIED_PROVENANCE' } });
    expect(reviewed.statusCode).toBe(201);
    const newEvents = await db!.systemEvent.findMany({ orderBy: { seq: 'desc' }, take: 3 });
    expect(await db!.systemEvent.count()).toBe(eventsBefore + 2);
    expect(newEvents.map((event) => event.type)).toEqual(expect.arrayContaining(['OUTCOME_RECORDED', 'OUTCOME_REVIEW_RECORDED']));
    expect(newEvents.map((event) => event.type)).not.toEqual(expect.arrayContaining(['AMBULANCE_DISPATCHED', 'ROUTE_UPDATED', 'CORRIDOR_ACTIVATED', 'PROTOCOL_STEP_COMPLETED', 'NOTIFICATION_SENT']));
  });
});
