import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { AppError, ErrorCode } from '@resus/core';
import { vi, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { createModule11 } from '../modules/module_11_database_event_system/src/module.js';
import { MODULE10_LIFECYCLE_EVENT_TYPES } from '../modules/module10/module10/src/lifecycle/observer.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './helpers/isolatedTestDatabase.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = process.env.RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST === 'true';
const suite = enabled ? describe : describe.skip;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const schemaPath = resolve(repoRoot, 'modules/module_11_database_event_system/prisma/schema.prisma');
const password = 'Stage427-isolated-test-only-9!';

interface AuditEventShape {
  id: string;
  sequence: number;
  type: string;
  emergencyId: string | null;
  entityType: string | null;
  entityId: string | null;
  actorType: string | null;
  actorId: string | null;
  payload: Record<string, unknown>;
}

suite('durable outcome grant lifecycle audit events on an owned isolated SQLite database', () => {
  let owned: IsolatedTestDatabase | undefined;
  let db: PrismaClient | undefined;
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  const tokens: Record<string, string> = {};
  const userIds = {} as {
    admin: string; admin2: string; submitterA: string; submitterB: string;
    reviewerA: string; dispatcher: string; operator: string;
  };
  let auditA = '';
  let auditB = '';
  let grantAGrantId = '';
  let grantBId = '';
  let reviewerAGrantBId = '';

  beforeAll(async () => {
    owned = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: owned.databaseUrl } } });
    server = await buildServer(loadServerConfig({
      NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '4000', LOG_LEVEL: 'error',
      JWT_SECRET: 'stage-4.27-grant-audit-isolated-jwt-secret', MODULE3_NLP_ENABLED: 'false',
    }), { db, ownsDatabaseClient: false });
    const hash = await bcrypt.hash(password, 4);
    const users = [
      ['admin', 'grant-audit-admin@stage427.test', 'Grant Audit Admin', 'ADMIN'],
      ['admin2', 'grant-audit-admin2@stage427.test', 'Grant Audit Admin Two', 'ADMIN'],
      ['submitterA', 'grant-audit-submitter-a@stage427.test', 'Grant Audit Submitter A', 'OUTCOME_SUBMITTER'],
      ['submitterB', 'grant-audit-submitter-b@stage427.test', 'Grant Audit Submitter B', 'OUTCOME_SUBMITTER'],
      ['reviewerA', 'grant-audit-reviewer-a@stage427.test', 'Grant Audit Reviewer A', 'OUTCOME_REVIEWER'],
      ['dispatcher', 'grant-audit-dispatcher@stage427.test', 'Grant Audit Dispatcher', 'DISPATCHER'],
      ['operator', 'grant-audit-operator@stage427.test', 'Grant Audit Operator', 'OPERATOR'],
    ] as const;
    for (const [key, email, displayName, role] of users) {
      const created = await server.module11.users.create({ email, displayName, passwordHash: hash, role });
      userIds[key] = created.id;
      const login = await server.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
      expect(login.statusCode).toBe(200);
      tokens[key] = (login.json() as { token: string }).token;
    }
    auditA = await createEmergency('AUDIT-A');
    auditB = await createEmergency('AUDIT-B');
  }, 180000);

  afterAll(async () => {
    try { await server?.shutdown(); }
    finally {
      try { await db?.$disconnect(); }
      finally { owned?.cleanup(); }
    }
  });

  async function createEmergency(suffix: string): Promise<string> {
    const id = `EMG-STAGE427-${suffix}`;
    await db!.emergency.create({ data: {
      id, incidentType: 'TRAUMA', severity: 'HIGH', latitude: 12, longitude: 77, isSimulation: false,
    } });
    return id;
  }

  const auth = (key: string) => ({ authorization: `Bearer ${tokens[key]}` });

  async function grant(adminKey: string, emergency: string, grantee: string, capability: 'SUBMIT' | 'REVIEW', extraBody: Record<string, unknown> = {}) {
    return server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${emergency}/outcome-grants`,
      headers: auth(adminKey), payload: { granteeUserId: grantee, capability, ...extraBody },
    });
  }

  async function revoke(adminKey: string, emergency: string, grantId: string, payload?: Record<string, unknown>) {
    return server!.fastify.inject({
      method: 'DELETE', url: `/api/emergencies/${emergency}/outcome-grants/${grantId}`,
      headers: auth(adminKey), ...(payload ? { payload } : {}),
    });
  }

  async function audit(adminKey: string, emergency: string, query = '') {
    return server!.fastify.inject({
      method: 'GET', url: `/api/emergencies/${emergency}/outcome-grant-events${query}`, headers: auth(adminKey),
    });
  }

  async function grantEvents(emergency: string, type: 'OUTCOME_GRANTED' | 'OUTCOME_GRANT_REVOKED') {
    return db!.systemEvent.findMany({ where: { emergencyId: emergency, type }, orderBy: { seq: 'asc' } });
  }

  function payloadOf(row: { payloadJson: string }): Record<string, unknown> {
    return JSON.parse(row.payloadJson) as Record<string, unknown>;
  }

  it('writes exactly one durable OUTCOME_GRANTED event for a new grant', async () => {
    const created = await grant('admin', auditA, userIds.submitterA, 'SUBMIT');
    expect(created.statusCode).toBe(201);
    grantAGrantId = created.json().id as string;
    const events = await grantEvents(auditA, 'OUTCOME_GRANTED');
    expect(events).toHaveLength(1);
    const row = events[0]!;
    expect(row).toMatchObject({
      emergencyId: auditA,
      entityType: 'emergency_outcome_grant',
      entityId: grantAGrantId,
      actorType: 'OPERATOR',
      actorId: userIds.admin,
    });
    expect(payloadOf(row)).toEqual({
      contractVersion: 1,
      emergencyId: auditA,
      grantId: grantAGrantId,
      granteeUserId: userIds.submitterA,
      capability: 'SUBMIT',
      action: 'GRANTED',
      active: true,
      reactivatedAt: null,
    });
  });

  it('does not duplicate the event when an already-active grant is repeated', async () => {
    const repeat = await grant('admin', auditA, userIds.submitterA, 'SUBMIT');
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json().id).toBe(grantAGrantId);
    expect(await grantEvents(auditA, 'OUTCOME_GRANTED')).toHaveLength(1);
  });

  it('revokes once, then records a reactivation on regrant with the resulting state', async () => {
    const revoked = await revoke('admin', auditA, grantAGrantId, { revokeReason: 'Rotating on-call cover' });
    expect(revoked.statusCode).toBe(200);
    const revokedEvents = await grantEvents(auditA, 'OUTCOME_GRANT_REVOKED');
    expect(revokedEvents).toHaveLength(1);
    expect(payloadOf(revokedEvents[0]!)).toMatchObject({
      grantId: grantAGrantId,
      capability: 'SUBMIT',
      revokeReason: 'Rotating on-call cover',
    });
    expect(revokedEvents[0]!.actorId).toBe(userIds.admin);

    const reactivated = await grant('admin2', auditA, userIds.submitterA, 'SUBMIT');
    expect(reactivated.statusCode).toBe(201);
    expect(reactivated.json()).toMatchObject({ id: grantAGrantId, revokedAt: null, revokedByUserId: null, revokeReason: null });
    const grantedEvents = await grantEvents(auditA, 'OUTCOME_GRANTED');
    expect(grantedEvents).toHaveLength(2);
    const latest = grantedEvents[1]!;
    expect(latest).toMatchObject({ entityId: grantAGrantId, actorId: userIds.admin2 });
    expect(payloadOf(latest)).toMatchObject({
      action: 'REACTIVATED',
      active: true,
      granteeUserId: userIds.submitterA,
      capability: 'SUBMIT',
    });
    expect(typeof payloadOf(latest).reactivatedAt).toBe('string');
  });

  it('keeps the first revocation actor, timestamp and reason across repeated revokes', async () => {
    const granted = await grant('admin', auditB, userIds.submitterB, 'SUBMIT');
    expect(granted.statusCode).toBe(201);
    grantBId = granted.json().id as string;
    const first = await revoke('admin', auditB, grantBId, { revokeReason: 'Transfer to team B' });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    const second = await revoke('admin2', auditB, grantBId, { revokeReason: 'Should not overwrite' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(firstBody);
    const revokedEvents = await grantEvents(auditB, 'OUTCOME_GRANT_REVOKED');
    expect(revokedEvents).toHaveLength(1);
    expect(revokedEvents[0]).toMatchObject({ actorId: userIds.admin });
    expect(payloadOf(revokedEvents[0]!)).toMatchObject({ revokeReason: 'Transfer to team B' });
    const row = await db!.emergencyOutcomeGrant.findUnique({ where: { id: grantBId } });
    expect(row).toMatchObject({ revokedByUserId: userIds.admin, revokeReason: 'Transfer to team B' });
    expect(row!.revokedAt).not.toBeNull();
  });

  it('rejects forged actor fields and never lets them override the authenticated identity', async () => {
    const forgedGrant = await grant('admin', auditB, userIds.dispatcher, 'SUBMIT', { actorId: userIds.dispatcher, actorType: 'SYSTEM' });
    expect(forgedGrant.statusCode).toBe(422);
    expect(forgedGrant.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const forgedRevoke = await revoke('admin', auditB, grantBId, { revokedByUserId: userIds.dispatcher });
    expect(forgedRevoke.statusCode).toBe(422);
    expect(await db!.emergencyOutcomeGrant.count({ where: { emergencyId: auditB, granteeUserId: userIds.dispatcher } })).toBe(0);
    const adminGrant = await grant('admin', auditB, userIds.dispatcher, 'SUBMIT');
    expect(adminGrant.statusCode).toBe(201);
    const events = await grantEvents(auditB, 'OUTCOME_GRANTED');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ actorId: userIds.admin, actorType: 'OPERATOR' });
  });

  it('leaves no success event behind when the grant-row write fails', async () => {
    const realTransaction = db!.$transaction.bind(db!) as unknown as (arg: unknown, opts?: unknown) => Promise<unknown>;
    const failingDb = new Proxy(db!, {
      get(target, property) {
        if (property === '$transaction') {
          return (arg: unknown, opts?: unknown) => {
            if (typeof arg !== 'function') return realTransaction(arg, opts);
            return realTransaction(async (tx: unknown) => {
              const poisonedTx = new Proxy(tx as object, {
                get(txTarget, txProperty) {
                  if (txProperty === 'emergencyOutcomeGrant') {
                    return {
                      findUnique: async () => null,
                      create: async () => { throw new Error('simulated grant row write failure'); },
                    };
                  }
                  return Reflect.get(txTarget, txProperty) as unknown;
                },
              }) as typeof tx;
              return (arg as (t: unknown) => Promise<unknown>)(poisonedTx);
            }, opts);
          };
        }
        return Reflect.get(target, property) as unknown;
      },
    });
    const failingModule = createModule11({ db: failingDb as PrismaClient, ownsClient: false });
    await expect(failingModule.outcomes.recordGrant({
      emergencyId: auditB,
      granteeUserId: userIds.dispatcher,
      capability: 'REVIEW',
      grantedByUserId: userIds.admin,
    })).rejects.toMatchObject({ statusCode: 500 });
    const successEvents = await db!.systemEvent.findMany({
      where: {
        emergencyId: auditB,
        type: 'OUTCOME_GRANTED',
        payloadJson: { contains: `"capability":"REVIEW"` },
      },
    });
    expect(successEvents).toHaveLength(0);
    expect(await db!.emergencyOutcomeGrant.count({ where: { emergencyId: auditB, granteeUserId: userIds.dispatcher, capability: 'REVIEW' } })).toBe(0);
  });

  it('rolls the grant mutation back when the event write fails', async () => {
    const eventSpy = vi.spyOn(server!.module11.events, 'recordInTransaction')
      .mockRejectedValueOnce(new AppError(ErrorCode.DATABASE_FAILURE, 'simulated event write failure', 500));
    try {
      const failed = await grant('admin', auditB, userIds.reviewerA, 'REVIEW');
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({ error: { code: 'DATABASE_FAILURE' } });
    } finally {
      eventSpy.mockRestore();
    }
    expect(await db!.emergencyOutcomeGrant.count({ where: { emergencyId: auditB, granteeUserId: userIds.reviewerA, capability: 'REVIEW' } })).toBe(0);
    const grantWrite = await grant('admin', auditB, userIds.reviewerA, 'REVIEW');
    expect(grantWrite.statusCode).toBe(201);
    reviewerAGrantBId = grantWrite.json().id as string;
    expect(await grantEvents(auditB, 'OUTCOME_GRANTED')).toHaveLength(3);

    const revokeSpy = vi.spyOn(server!.module11.events, 'recordInTransaction')
      .mockRejectedValueOnce(new AppError(ErrorCode.DATABASE_FAILURE, 'simulated event write failure', 500));
    try {
      const failedRevoke = await revoke('admin', auditB, reviewerAGrantBId, { revokeReason: 'Must roll back' });
      expect(failedRevoke.statusCode).toBe(500);
    } finally {
      revokeSpy.mockRestore();
    }
    const stillActive = await db!.emergencyOutcomeGrant.findUnique({ where: { id: reviewerAGrantBId } });
    expect(stillActive).toMatchObject({ revokedAt: null, revokeReason: null });
    expect(await grantEvents(auditB, 'OUTCOME_GRANT_REVOKED')).toHaveLength(1);
  });

  it('validates the optional revocation reason and applies first-revocation semantics', async () => {
    expect((await revoke('admin', auditB, reviewerAGrantBId, { revokeReason: '   ' })).statusCode).toBe(422);
    expect((await revoke('admin', auditB, reviewerAGrantBId, { revokeReason: '' })).statusCode).toBe(422);
    expect((await revoke('admin', auditB, reviewerAGrantBId, { revokeReason: 'x'.repeat(501) })).statusCode).toBe(422);
    expect((await revoke('admin', auditB, reviewerAGrantBId, { revokeReason: 42 })).statusCode).toBe(422);
    const revoked = await revoke('admin', auditB, reviewerAGrantBId, { revokeReason: '  Policy updated  ' });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ revokeReason: 'Policy updated', revokedByUserId: userIds.admin });
    const repeat = await revoke('admin2', auditB, reviewerAGrantBId, { revokeReason: 'Different reason' });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().revokeReason).toBe('Policy updated');
    const revokedEvents = await grantEvents(auditB, 'OUTCOME_GRANT_REVOKED');
    expect(revokedEvents).toHaveLength(2);
    expect(payloadOf(revokedEvents[1]!)).toMatchObject({ revokeReason: 'Policy updated', grantId: reviewerAGrantBId });
    expect(revokedEvents[1]!.actorId).toBe(userIds.admin);
  });

  it('returns only the requested emergency grant events, newest-first and paginated', async () => {
    const key = `audit-key-${Date.now()}`;
    const submitted = await server!.fastify.inject({
      method: 'POST', url: `/api/emergencies/${auditA}/outcomes`,
      headers: { ...auth('submitterA'), 'idempotency-key': key },
      payload: { category: 'UNKNOWN', categoryVersion: 'OUTCOME_V1', survivalToDischarge: null },
    });
    expect(submitted.statusCode).toBe(201);

    const fullA = await audit('admin', auditA);
    expect(fullA.statusCode).toBe(200);
    const bodyA = fullA.json() as { emergencyId: string; items: AuditEventShape[]; total: number; limit: number; offset: number };
    expect(bodyA.emergencyId).toBe(auditA);
    expect(bodyA.total).toBe(3);
    expect(bodyA.items).toHaveLength(3);
    expect(bodyA.items.every((item) => item.emergencyId === auditA)).toBe(true);
    expect(bodyA.items.every((item) => ['OUTCOME_GRANTED', 'OUTCOME_GRANT_REVOKED'].includes(item.type))).toBe(true);
    expect(bodyA.items.map((item) => item.type)).toEqual(['OUTCOME_GRANTED', 'OUTCOME_GRANT_REVOKED', 'OUTCOME_GRANTED']);
    expect(bodyA.items.map((item) => item.sequence)).toEqual([...bodyA.items.map((item) => item.sequence)].sort((x, y) => y - x));
    expect(bodyA.items.some((item) => item.type === 'OUTCOME_RECORDED')).toBe(false);

    const page = await audit('admin', auditA, '?limit=2');
    expect((page.json() as { items: AuditEventShape[]; limit: number }).limit).toBe(2);
    expect((page.json() as { items: AuditEventShape[] }).items).toHaveLength(2);
    const secondPage = await audit('admin', auditA, '?limit=2&offset=2');
    expect((secondPage.json() as { items: AuditEventShape[] }).items).toHaveLength(1);

    const fullB = await audit('admin', auditB);
    const bodyB = fullB.json() as { items: AuditEventShape[]; total: number };
    expect(bodyB.total).toBe(5);
    expect(bodyB.items.every((item) => item.emergencyId === auditB)).toBe(true);
    expect(bodyB.items.some((item) => item.entityId === grantAGrantId)).toBe(false);
    expect((bodyA.items as AuditEventShape[]).some((item) => item.entityId === grantBId)).toBe(false);
  });

  it('denies anonymous and non-admin audit reads', async () => {
    const anonymous = await server!.fastify.inject({ method: 'GET', url: `/api/emergencies/${auditA}/outcome-grant-events` });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    for (const key of ['operator', 'dispatcher', 'submitterA', 'reviewerA'] as const) {
      const denied = await audit(key, auditA);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.message).toBe(`Role '${key === 'operator' ? 'OPERATOR' : key === 'dispatcher' ? 'DISPATCHER' : key === 'submitterA' ? 'OUTCOME_SUBMITTER' : 'OUTCOME_REVIEWER'}' may not call this endpoint.`);
    }
    expect((await audit('admin2', auditA)).statusCode).toBe(200);
    const absent = await audit('admin', 'EMG-STAGE427-ABSENT');
    expect(absent.statusCode).toBe(404);
  });

  it('leaves the Module 10 lifecycle projection and learning samples untouched', async () => {
    expect(MODULE10_LIFECYCLE_EVENT_TYPES).not.toContain('OUTCOME_GRANTED');
    expect(MODULE10_LIFECYCLE_EVENT_TYPES).not.toContain('OUTCOME_GRANT_REVOKED');
    expect(await db!.learningSample.count()).toBe(0);
    const grants = await db!.emergencyOutcomeGrant.findMany({ where: { emergencyId: { in: [auditA, auditB] } } });
    expect(grants).toHaveLength(4);
    expect(grants.filter((row) => row.revokedAt === null)).toHaveLength(2);
    const readProbe = await audit('admin', auditA);
    expect(readProbe.statusCode).toBe(200);
    expect(await db!.learningSample.count()).toBe(0);
  });

  it('lists only the requested emergency grant rows for ADMIN and hides them from other roles', async () => {
    const listed = await server!.fastify.inject({
      method: 'GET', url: `/api/emergencies/${auditB}/outcome-grants`, headers: auth('admin'),
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      emergencyId: string; total: number; limit: number; offset: number;
      items: Array<{ id: string; emergencyId: string; granteeUserId: string; capability: string; grantedByUserId: string; createdAt: string; revokedAt: string | null; revokedByUserId: string | null; revokeReason: string | null }>;
    };
    expect(body).toMatchObject({ emergencyId: auditB, total: 3, limit: 50, offset: 0 });
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item) => item.emergencyId === auditB)).toBe(true);
    expect(body.items.find((item) => item.id === grantBId)).toMatchObject({
      granteeUserId: userIds.submitterB,
      capability: 'SUBMIT',
      revokedByUserId: userIds.admin,
      revokeReason: 'Transfer to team B',
      revokedAt: expect.any(String),
    });
    expect(body.items.find((item) => item.id === reviewerAGrantBId)).toMatchObject({
      revokedAt: expect.any(String),
      revokeReason: 'Policy updated',
    });
    expect(body.items.find((item) => item.granteeUserId === userIds.dispatcher)).toMatchObject({
      revokedAt: null,
      revokeReason: null,
    });
    expect(body.items.some((item) => item.id === grantAGrantId)).toBe(false);
    const createdTimes = body.items.map((item) => item.createdAt);
    expect(createdTimes).toEqual([...createdTimes].sort().reverse());

    const listA = await server!.fastify.inject({
      method: 'GET', url: `/api/emergencies/${auditA}/outcome-grants`, headers: auth('admin2'),
    });
    expect(listA.statusCode).toBe(200);
    const bodyA = listA.json() as { total: number; items: Array<{ id: string; emergencyId: string }> };
    expect(bodyA.total).toBe(1);
    expect(bodyA.items).toHaveLength(1);
    expect(bodyA.items[0]).toMatchObject({ id: grantAGrantId, emergencyId: auditA });

    const anonymous = await server!.fastify.inject({ method: 'GET', url: `/api/emergencies/${auditB}/outcome-grants` });
    expect(anonymous.statusCode).toBe(401);
    for (const key of ['operator', 'dispatcher', 'submitterA', 'reviewerA'] as const) {
      const denied = await server!.fastify.inject({
        method: 'GET', url: `/api/emergencies/${auditB}/outcome-grants`, headers: auth(key),
      });
      expect(denied.statusCode).toBe(403);
    }
    const absent = await server!.fastify.inject({
      method: 'GET', url: '/api/emergencies/EMG-STAGE427-ABSENT/outcome-grants', headers: auth('admin'),
    });
    expect(absent.statusCode).toBe(404);
    const bounded = await server!.fastify.inject({
      method: 'GET', url: `/api/emergencies/${auditB}/outcome-grants?limit=1`, headers: auth('admin'),
    });
    expect(bounded.statusCode).toBe(200);
    expect((bounded.json() as { items: unknown[]; limit: number }).items).toHaveLength(1);
    expect((bounded.json() as { limit: number }).limit).toBe(1);
    const overLimit = await server!.fastify.inject({
      method: 'GET', url: `/api/emergencies/${auditB}/outcome-grants?limit=200`, headers: auth('admin'),
    });
    expect(overLimit.statusCode).toBe(422);
  });
});
