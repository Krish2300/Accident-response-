import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createModule11, type Module11 } from '@resus/data';
import { Module6 } from '@resus/fleet';
import { Module12 } from '@resus/analytics';
import { RouteTable, type AuthContext, type RouteDefinition, isAppError } from '@resus/core';
import { registerRoutes } from '../apps/server/src/http/routeAdapter.js';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Driver GPS end-to-end integration test.
 *
 * Spans the whole path a physical phone takes: Module 6's location route, the
 * server's route adapter (authentication, role checks, zod validation), Module 11's
 * repositories and event log, and Module 12's live-state projection. It runs against
 * a throwaway SQLite database built by the real migrations, so the `assignedDriverId`
 * column and every query used here are the ones production uses.
 *
 * Isolation: `DATABASE_URL` is overridden before any client is constructed and the
 * resolved file is asserted to be the throwaway one, so a test can never write into a
 * developer's working data.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
const prismaCli = resolve(repoRoot, 'node_modules/prisma/build/index.js');
const devDbPath = resolve(prismaDir, 'dev.db');
const dbPath = resolve(prismaDir, 'test-driver-location.db');
const dbUrl = `file:${dbPath.replace(/\\/g, '/')}`;

const DRIVER_ID = 'USR_DRV_TEST';
const OTHER_DRIVER_ID = 'USR_DRV_OTHER';
const AMBULANCE_ID = 'AMB_DRV_TEST_001';
const UNASSIGNED_AMBULANCE_ID = 'AMB_DRV_TEST_002';

function removeDatabaseFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

let db: PrismaClient;
let module11: Module11;
let app: FastifyInstance;

/** The identity the adapter resolves for each simulated bearer token. */
const identities: Record<string, AuthContext> = {
  'token-driver': { userId: DRIVER_ID, role: 'DRIVER', email: 'driver@resus.local' },
  'token-other-driver': { userId: OTHER_DRIVER_ID, role: 'AMBULANCE_DRIVER', email: 'other@resus.local' },
  'token-dispatcher': { userId: 'USR_DISPATCH', role: 'DISPATCHER', email: 'dispatch@resus.local' },
  'token-operator': { userId: 'USR_OPERATOR', role: 'OPERATOR', email: 'operator@resus.local' },
};

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

  const passwordHash = bcrypt.hashSync('Password123!', 10);
  await db.user.createMany({
    data: [
      { id: DRIVER_ID, email: 'driver@resus.local', displayName: 'Test Driver', passwordHash, role: 'DRIVER' },
      { id: OTHER_DRIVER_ID, email: 'other@resus.local', displayName: 'Other Driver', passwordHash, role: 'AMBULANCE_DRIVER' },
      { id: 'USR_DISPATCH', email: 'dispatch@resus.local', displayName: 'Dispatcher', passwordHash, role: 'DISPATCHER' },
      { id: 'USR_OPERATOR', email: 'operator@resus.local', displayName: 'Operator', passwordHash, role: 'OPERATOR' },
    ],
  });

  // Two real (non-simulation) ambulances: one assigned to the driver under test,
  // one assigned to nobody.
  await db.ambulance.createMany({
    data: [
      { id: AMBULANCE_ID, vehicleNumber: 'AMBDRV001', isSimulation: false, assignedDriverId: DRIVER_ID },
      { id: UNASSIGNED_AMBULANCE_ID, vehicleNumber: 'AMBDRV002', isSimulation: false },
    ],
  });

  // Mount exactly what the production composition root mounts, through the same adapter.
  const module6 = new Module6({ ambulances: module11.ambulances, events: module11.eventPublisher });
  const module12 = new Module12({ analyticsRead: module11.analyticsRead, events: module11.eventQuery });

  const table = new RouteTable();
  module6.register(table);
  module12.register(table);

  app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.', details: null } });
  });
  const registered = registerRoutes(app as never, table.routes as RouteDefinition<never>[], {
    authenticate: async (request) => {
      const header = String(request.headers.authorization ?? '');
      const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      return identities[token] ?? null;
    },
  });
  await app.ready();

  // The milestone depends on these two routes actually being mounted.
  expect(registered.count).toBeGreaterThan(0);
  expect(registered.modules).toContain('module_06');
  expect(registered.modules).toContain('module_12');
  expect(app.hasRoute({ method: 'POST', url: '/api/ambulances/:id/location' })).toBe(true);
  expect(app.hasRoute({ method: 'GET', url: '/api/dashboard/live' })).toBe(true);
}, 180000);

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  removeDatabaseFiles();
});

const bengaluru = { latitude: 12.9716, longitude: 77.5946 };
const payload = (overrides: Record<string, unknown> = {}) => ({
  ...bengaluru,
  speedKmh: 24.5,
  headingDeg: 91.2,
  accuracyM: 8.4,
  source: 'MOBILE',
  isSimulation: false,
  ...overrides,
});

describe('POST /api/ambulances/:id/location', () => {
  it('rejects an unauthenticated request with 401 and writes nothing', async () => {
    const before = await db.ambulanceLocation.count();

    const response = await app.inject({
      method: 'POST',
      url: `/api/ambulances/${AMBULANCE_ID}/location`,
      payload: payload(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    expect(await db.ambulanceLocation.count()).toBe(before);
  });

  it('rejects a role that may not report locations with 403', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/ambulances/${AMBULANCE_ID}/location`,
      headers: { authorization: 'Bearer token-operator' },
      payload: payload(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('rejects an out-of-range coordinate with 422', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/ambulances/${AMBULANCE_ID}/location`,
      headers: { authorization: 'Bearer token-driver' },
      payload: payload({ latitude: 999 }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a real update from the assigned driver and returns the stored position', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/ambulances/${AMBULANCE_ID}/location`,
      headers: { authorization: 'Bearer token-driver' },
      payload: payload(),
    });

    expect(response.statusCode).toBe(200);
    const location = response.json().location;
    expect(location.latitude).toBe(bengaluru.latitude);
    expect(location.longitude).toBe(bengaluru.longitude);
    expect(location.speedKmh).toBe(24.5);
    expect(location.headingDeg).toBe(91.2);
    expect(location.accuracyM).toBe(8.4);
    expect(location.source).toBe('MOBILE');
    expect(location.isSimulation).toBe(false);
  });

  it('refuses to let a driver update an ambulance assigned to somebody else', async () => {
    const other = await db.ambulance.update({
      where: { id: AMBULANCE_ID },
      data: { assignedDriverId: OTHER_DRIVER_ID },
    });
    expect(other.assignedDriverId).toBe(OTHER_DRIVER_ID);

    const response = await app.inject({
      method: 'POST',
      url: `/api/ambulances/${AMBULANCE_ID}/location`,
      headers: { authorization: 'Bearer token-driver' },
      payload: payload({ latitude: 1, longitude: 1 }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');

    // Restore ownership for the remaining tests.
    await db.ambulance.update({ where: { id: AMBULANCE_ID }, data: { assignedDriverId: DRIVER_ID } });
  });

  it('refuses to let a driver update an ambulance with no driver at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/ambulances/${UNASSIGNED_AMBULANCE_ID}/location`,
      headers: { authorization: 'Bearer token-driver' },
      payload: payload(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('keeps dispatcher access to any ambulance', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/ambulances/${UNASSIGNED_AMBULANCE_ID}/location`,
      headers: { authorization: 'Bearer token-dispatcher' },
      payload: payload({ latitude: 19.076, longitude: 72.8777 }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().location.latitude).toBe(19.076);
  });
});

describe('location persistence', () => {
  it('appends one trail row per accepted report with the phone values', async () => {
    const rows = await db.ambulanceLocation.findMany({
      where: { ambulanceId: AMBULANCE_ID },
      orderBy: { recordedAt: 'asc' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ambulanceId: AMBULANCE_ID,
      latitude: bengaluru.latitude,
      longitude: bengaluru.longitude,
      speedKmh: 24.5,
      headingDeg: 91.2,
      accuracyM: 8.4,
      source: 'MOBILE',
      isSimulation: false,
    });
  });

  it('updates the cached position on the ambulance row', async () => {
    const ambulance = await db.ambulance.findUniqueOrThrow({ where: { id: AMBULANCE_ID } });

    expect(ambulance.latitude).toBe(bengaluru.latitude);
    expect(ambulance.longitude).toBe(bengaluru.longitude);
    expect(ambulance.lastLocationUpdate).not.toBeNull();
  });

  it('emits exactly one AMBULANCE_LOCATION_UPDATED event per real update', async () => {
    const events = await module11.eventQuery.list({
      entityId: AMBULANCE_ID,
      types: ['AMBULANCE_LOCATION_UPDATED'],
    });

    expect(events.items).toHaveLength(1);
    const event = events.items[0]!;
    expect(event.type).toBe('AMBULANCE_LOCATION_UPDATED');
    expect(event.entityType).toBe('ambulance');
    const payloadJson = event.payload as { latitude: number; longitude: number };
    expect(payloadJson.latitude).toBe(bengaluru.latitude);
    expect(payloadJson.longitude).toBe(bengaluru.longitude);
  });

  it('keeps the one-event guarantee across repeated reports from the same driver', async () => {
    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/ambulances/${AMBULANCE_ID}/location`,
        headers: { authorization: 'Bearer token-driver' },
        payload: payload({ latitude: bengaluru.latitude + i * 0.001 }),
      });
      expect(response.statusCode).toBe(200);
    }

    const events = await module11.eventQuery.list({
      entityId: AMBULANCE_ID,
      types: ['AMBULANCE_LOCATION_UPDATED'],
    });

    // One from the first test, plus one per additional report: never two per report.
    expect(events.items).toHaveLength(4);
    expect(await db.ambulanceLocation.count({ where: { ambulanceId: AMBULANCE_ID } })).toBe(4);
  });

  it('does not emit a location event for a rejected update', async () => {
    const before = await module11.eventQuery.list({
      entityId: UNASSIGNED_AMBULANCE_ID,
      types: ['AMBULANCE_LOCATION_UPDATED'],
    });

    await app.inject({
      method: 'POST',
      url: `/api/ambulances/${UNASSIGNED_AMBULANCE_ID}/location`,
      headers: { authorization: 'Bearer token-driver' },
      payload: payload(),
    });

    const after = await module11.eventQuery.list({
      entityId: UNASSIGNED_AMBULANCE_ID,
      types: ['AMBULANCE_LOCATION_UPDATED'],
    });
    expect(after.items).toHaveLength(before.items.length);
  });
});

describe('GET /api/drivers/me/assignment', () => {
  it('returns the ambulance assigned to the driver', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/drivers/me/assignment',
      headers: { authorization: 'Bearer token-driver' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.assigned).toBe(true);
    expect(body.ambulance.id).toBe(AMBULANCE_ID);
    expect(body.ambulance.vehicleNumber).toBe('AMBDRV001');
  });

  it('reports no assignment rather than inventing one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/drivers/me/assignment',
      headers: { authorization: 'Bearer token-other-driver' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assigned: false, ambulance: null });
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/drivers/me/assignment' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/dashboard/live', () => {
  it('projects the ambulance at the position the phone reported', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/live',
      headers: { authorization: 'Bearer token-operator' },
    });

    expect(response.statusCode).toBe(200);
    const ambulance = response.json().ambulances.find((row: { id: string }) => row.id === AMBULANCE_ID);
    expect(ambulance).toBeDefined();
    expect(ambulance.vehicleNumber).toBe('AMBDRV001');
    // The last accepted report from the repeated-report test.
    expect(ambulance.latitude).toBeCloseTo(bengaluru.latitude + 0.002, 6);
    expect(ambulance.longitude).toBe(bengaluru.longitude);
    expect(ambulance.lastLocationUpdate).not.toBeNull();
  });

  it('moves the projected marker when a new position arrives', async () => {
    const moved = { latitude: 13.0827, longitude: 80.2707 };
    const response = await app.inject({
      method: 'POST',
      url: `/api/ambulances/${AMBULANCE_ID}/location`,
      headers: { authorization: 'Bearer token-driver' },
      payload: payload(moved),
    });
    expect(response.statusCode).toBe(200);

    const live = await app.inject({
      method: 'GET',
      url: '/api/dashboard/live',
      headers: { authorization: 'Bearer token-operator' },
    });
    const ambulance = live.json().ambulances.find((row: { id: string }) => row.id === AMBULANCE_ID);

    expect(ambulance.latitude).toBeCloseTo(moved.latitude, 6);
    expect(ambulance.longitude).toBeCloseTo(moved.longitude, 6);
  });

  it('hides simulated ambulances unless they are explicitly requested', async () => {
    await db.ambulance.create({
      data: { id: 'AMB_SIM', vehicleNumber: 'AMBSIM001', isSimulation: true },
    });

    const withoutSimulation = await app.inject({
      method: 'GET',
      url: '/api/dashboard/live',
      headers: { authorization: 'Bearer token-operator' },
    });
    expect(withoutSimulation.json().ambulances.map((row: { id: string }) => row.id)).not.toContain('AMB_SIM');

    const withSimulation = await app.inject({
      method: 'GET',
      url: '/api/dashboard/live?includeSimulation=true',
      headers: { authorization: 'Bearer token-operator' },
    });
    expect(withSimulation.json().ambulances.map((row: { id: string }) => row.id)).toContain('AMB_SIM');
  });

  it('is not readable without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/dashboard/live' });
    expect(response.statusCode).toBe(401);
  });
});

describe('route metadata', () => {
  it('keeps the location endpoint authenticated and role-scoped', () => {
    const route = new Module6({
      ambulances: module11.ambulances,
      events: module11.eventPublisher,
    })
      .routes()
      .find((candidate) => candidate.url === '/api/ambulances/:id/location');

    expect(route?.auth?.public).toBe(false);
    expect(route?.auth?.roles).toContain('DRIVER');
    expect(route?.auth?.roles).toContain('AMBULANCE_DRIVER');
    expect(route?.auth?.roles).toContain('DISPATCHER');
  });
});