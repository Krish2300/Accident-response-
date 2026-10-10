import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createModule11, type Module11 } from '@resus/data';
import { Module1 } from '@resus/call';
import { RouteTable, type RouteDefinition } from '@resus/core';
import { registerRoutes } from '../apps/server/src/http/routeAdapter.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { isAppError } from '@resus/core';

/**
 * Module 1 integration test against the real database and the real route adapter.
 *
 * Lives at the repository root rather than inside the module because it deliberately spans three
 * boundaries: Module 1's routes, the server's route adapter, and Module 11's repositories.
 *
 * The unit tests fake persistence, which is the right way to pin lifecycle rules
 * but proves nothing about wiring. This suite therefore runs the actual
 * repositories, the actual `RouteTable` adapter and real HTTP requests over a
 * throwaway SQLite database built by the real migrations.
 *
 * Isolation: Prisma reads `.env` itself, so `DATABASE_URL` is overridden before
 * any client is constructed and the resolved file is asserted to be the
 * throwaway one. A test that quietly wrote emergency rows into a developer's
 * working data would be worse than no test at all.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
const prismaCli = resolve(repoRoot, 'node_modules/prisma/build/index.js');
const devDbPath = resolve(prismaDir, 'dev.db');
const dbPath = resolve(prismaDir, 'test-module-01.db');
const dbUrl = `file:${dbPath.replace(/\\/g, '/')}`;

function removeDatabaseFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

let db: PrismaClient;
let module11: Module11;
let module1: Module1;
let app: FastifyInstance;

beforeAll(async () => {
  removeDatabaseFiles();
  process.env.DATABASE_URL = dbUrl;

  // Invoke the Prisma CLI through node directly: `npx` is not a resolvable bare
  // binary on Windows.
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
  });

  db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  const probe = await db.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
  const target = probe.find((row) => row.name === 'main')?.file ?? '';
  if (target && resolve(target) === resolve(devDbPath)) {
    throw new Error(`Refusing to run: resolved to the development database (${devDbPath}).`);
  }

  module11 = createModule11({ db, ownsClient: false });
  module1 = new Module1({
    emergencies: module11.emergencies,
    calls: module11.calls,
    events: module11.eventPublisher,
  });

  // Mount exactly what the production composition root mounts, through the same
  // adapter, so a route that is broken here is broken there too.
  const table = new RouteTable();
  module1.register(table);
  app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  });
  const registered = registerRoutes(app as never, table.routes as RouteDefinition<never>[], {
    authenticate: async () => ({ userId: 'test', role: 'ADMIN', email: 'test@local' }),
  });
  await app.ready();
  expect(registered.count).toBeGreaterThan(0);
}, 180000);

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  removeDatabaseFiles();
});

const location = { latitude: 12.9716, longitude: 77.5946, incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL' };

describe('POST /calls', () => {
  it('creates an emergency, a session and the event trail', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/calls',
      payload: { ...location, callerId: '+919999999999', description: 'Middle-aged man, not breathing.' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.emergency.incidentType).toBe('CARDIAC_ARREST');
    expect(body.emergency.status).toBe('CREATED');
    expect(body.session.status).toBe('ACTIVE');
    // The loopback transport must never be reported as live telephony.
    expect(body.isLiveTransport).toBe(false);
    expect(body.transport).toBe('LOOPBACK');

    const events = await module11.eventQuery.list({ emergencyId: body.emergency.id });
    const types = events.items.map((event) => event.type);
    expect(types).toContain('EMERGENCY_CREATED');
    // Exactly one CALL_STARTED: the repository emits it in-transaction and the
    // service must not add a duplicate.
    expect(types.filter((type) => type === 'CALL_STARTED')).toHaveLength(1);
    expect(types.filter((type) => type === 'CALL_CONNECTED')).toHaveLength(1);
  });

  it('returns 200 rather than creating a duplicate on a repeated open', async () => {
    const first = await app.inject({ method: 'POST', url: '/calls', payload: location });

    const second = await app.inject({
      method: 'POST',
      url: '/calls',
      payload: { emergencyId: first.json().emergency.id },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().reused).toBe(true);
    expect(second.json().emergency.id).toBe(first.json().emergency.id);
  });

  it('rejects a body with a latitude but no longitude', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/calls',
      payload: { latitude: 12.97 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a body with neither an emergencyId nor a location', async () => {
    const response = await app.inject({ method: 'POST', url: '/calls', payload: { incidentType: 'FALL' } });

    expect(response.statusCode).toBe(422);
  });
});

describe('utterances and transcripts', () => {
  it('appends caller speech and reads it back in order', async () => {
    const opened = await app.inject({ method: 'POST', url: '/calls', payload: location });
    const callSessionId = opened.json().session.id;
    const emergencyId = opened.json().emergency.id;

    for (const text of ['He is not breathing.', 'I started chest compressions.']) {
      const response = await app.inject({
        method: 'POST',
        url: `/calls/${callSessionId}/utterances`,
        payload: { speaker: 'CALLER', text },
      });
      expect(response.statusCode).toBe(201);
    }

    const transcript = await app.inject({ method: 'GET', url: `/emergencies/${emergencyId}/transcript` });

    expect(transcript.statusCode).toBe(200);
    const body = transcript.json();
    expect(body.transcripts).toHaveLength(2);
    expect(body.transcripts.map((line: { text: string }) => line.text)).toEqual([
      'He is not breathing.',
      'I started chest compressions.',
    ]);
    // Sequence must be assigned by the repository, atomically.
    expect(body.transcripts.map((line: { sequence: number }) => line.sequence)).toEqual([1, 2]);

    const events = await module11.eventQuery.list({ emergencyId });
    expect(events.items.filter((event) => event.type === 'TRANSCRIPT_UPDATED')).toHaveLength(2);
  });

  it('rejects an utterance on a call that has already ended', async () => {
    const opened = await app.inject({ method: 'POST', url: '/calls', payload: location });
    const callSessionId = opened.json().session.id;

    await app.inject({ method: 'POST', url: `/calls/${callSessionId}/hangup`, payload: {} });
    const response = await app.inject({
      method: 'POST',
      url: `/calls/${callSessionId}/utterances`,
      payload: { speaker: 'CALLER', text: 'Still there?' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONVERSATION_CLOSED');
  });
});

describe('hangup', () => {
  it('ends the session, records the duration and closes it once', async () => {
    const opened = await app.inject({ method: 'POST', url: '/calls', payload: location });
    const callSessionId = opened.json().session.id;
    const emergencyId = opened.json().emergency.id;

    const response = await app.inject({
      method: 'POST',
      url: `/calls/${callSessionId}/hangup`,
      payload: { reason: 'Ambulance on scene.' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().closed).toBe(true);
    expect(response.json().session.status).toBe('ENDED');

    const again = await app.inject({ method: 'POST', url: `/calls/${callSessionId}/hangup`, payload: {} });
    expect(again.json().closed).toBe(false);

    const events = await module11.eventQuery.list({ emergencyId });
    expect(events.items.filter((event) => event.type === 'CALL_DISCONNECTED')).toHaveLength(1);
  });

  it('returns 404 for a call that does not exist', async () => {
    const response = await app.inject({ method: 'POST', url: '/calls/CALL-missing/hangup', payload: {} });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('CALL_NOT_FOUND');
  });
});

describe('transport status', () => {
  it('reports the development transport as reachable but not live', async () => {
    const response = await app.inject({ method: 'GET', url: '/calls/transport/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: 'loopback', isLive: false, reachable: true });
  });
});

describe('auth', () => {
  it('leaves the call-opening route public and guards the rest', async () => {
    const publicRoute = module1.routes().find((route) => route.url === '/calls');
    const guarded = module1.routes().find((route) => route.url === '/calls/:id/hangup');

    // A bystander dialling in has no token; staff routes must not be public.
    expect(publicRoute?.auth?.public).toBe(true);
    expect(guarded?.auth?.public).toBeUndefined();
    expect(guarded?.auth?.roles).toContain('OPERATOR');
  });
});