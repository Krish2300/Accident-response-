import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { noopLogger, RouteTable, type HttpRequest, type SystemEventRecord } from '@resus/core';
import { createModule11, type Module11 } from '@resus/data';
import { registerRoutes } from '../../../apps/server/src/http/routeAdapter.js';
import { Module8 } from '../src/module.js';
import { loadModule8Config } from '../src/config.js';
import type { RoutingProvider } from '@resus/core';
import { RoutingProviderError } from '../src/providers/routingProviderError.js';
import { createModule8Routes } from '../src/api/routes.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../../../tests/helpers/isolatedTestDatabase.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');

const TOKENS: Record<string, { userId: string; role: string; email: string }> = {
  'Bearer dispatcher': { userId: 'USR-DISP', role: 'DISPATCHER', email: 'dispatch@resus.test' },
  'Bearer admin': { userId: 'USR-ADM', role: 'ADMIN', email: 'admin@resus.test' },
  'Bearer operator': { userId: 'USR-OP', role: 'OPERATOR', email: 'operator@resus.test' },
  'Bearer driver': { userId: 'USR-DRV', role: 'DRIVER', email: 'driver@resus.test' },
};

function throwingProvider(name: string): RoutingProvider {
  return {
    providerName: name,
    isLive: true,
    isLiveTraffic: false,
    route: async () => {
      throw new RoutingProviderError(`${name} unavailable`, name);
    },
  };
}

describe('ROUTE_RECALCULATED authenticated actor attribution', () => {
  let db: PrismaClient;
  let module11: Module11;
  let module8: Module8;
  let testDatabase: IsolatedTestDatabase;
  const apps: Array<ReturnType<typeof Fastify>> = [];

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: testDatabase.databaseUrl } } });
    module11 = createModule11({ db, ownsClient: false, logger: noopLogger });
    const config = loadModule8Config();
    config.generation = { ...config.generation, enabled: false, includeSimulation: false };
    module8 = new Module8({
      routes: module11.routes,
      emergencies: module11.emergencies,
      ambulances: module11.ambulances,
      hospitals: module11.hospitals,
      events: module11.eventPublisher,
      config,
      logger: noopLogger,
    });
  }, 120000);

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    module8?.dispose();
    await db?.$disconnect();
    testDatabase?.cleanup();
  });

  function buildApp(optimization = module8.optimization): ReturnType<typeof Fastify> {
    const table = new RouteTable();
    table.addAll(createModule8Routes(optimization, module11.routes));
    const app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async (request: HttpRequest) =>
        TOKENS[request.headers.authorization as string] ?? null,
    });
    apps.push(app);
    return app;
  }

  async function seedAssignedEmergency(): Promise<{ emergencyId: string; ambulanceId: string }> {
    const ambulance = await module11.ambulances.create({
      vehicleNumber: `KA-02-${Math.floor(Math.random() * 1_000_000)}`,
      status: 'EN_ROUTE',
      latitude: 12.95,
      longitude: 77.58,
    });
    const emergency = await module11.emergencies.create({
      incidentType: 'CARDIAC_ARREST',
      severity: 'CRITICAL',
      latitude: 12.9716,
      longitude: 77.5946,
      isSimulation: false,
    });
    await module11.emergencies.update(emergency.id, { assignedAmbulanceId: ambulance.id });
    return { emergencyId: emergency.id, ambulanceId: ambulance.id };
  }

  async function generateResponseRoute(emergencyId: string): Promise<string> {
    const generated = await module8.optimization.generateForEmergency(emergencyId, 'RESPONSE');
    expect(generated.outcome).toBe('GENERATED');
    return generated.routeId as string;
  }

  async function recalcEventsFor(routeId: string): Promise<SystemEventRecord[]> {
    const page = await module11.eventQuery.list({ types: ['ROUTE_RECALCULATED'], limit: 100 });
    return page.items.filter((event) => event.entityId === routeId);
  }

  async function recalc(
    app: ReturnType<typeof Fastify>,
    routeId: string,
    token: string | undefined,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/routes/${routeId}/recalculate`,
      ...(token ? { headers: { authorization: token } } : {}),
      payload,
    });
  }

  it('persists the dispatcher identity from trusted auth context into the durable event', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);
    const app = buildApp();

    const response = await recalc(app, routeId, 'Bearer dispatcher', { reason: 'traffic hold cleared' });
    expect(response.statusCode).toBe(200);

    const events = await recalcEventsFor(routeId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ROUTE_RECALCULATED',
      emergencyId,
      entityType: 'route',
      entityId: routeId,
      actorType: 'DISPATCHER',
      actorId: 'USR-DISP',
      payload: { routeId, emergencyId, reason: 'traffic hold cleared' },
    });
  });

  it('persists the administrator identity for an administrator-initiated recalculation', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);
    const app = buildApp();

    const response = await recalc(app, routeId, 'Bearer admin', { reason: 'hospital re-route requested' });
    expect(response.statusCode).toBe(200);

    const events = await recalcEventsFor(routeId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'ADMIN',
      actorId: 'USR-ADM',
      payload: { routeId, reason: 'hospital re-route requested' },
    });
  });

  it('rejects forged actor fields in the request body before any write or event', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);
    const app = buildApp();

    const forged = await recalc(app, routeId, 'Bearer dispatcher', {
      reason: 'impersonation attempt',
      actorType: 'ADMIN',
      actorId: 'USR-EVIL',
    });
    expect(forged.statusCode).toBe(422);
    // The strict body schema rejects the unknown actor fields before the handler runs.
    expect(String((forged.json() as { message?: string }).message ?? ''))
      .toContain('did not match the expected shape');
    expect(await recalcEventsFor(routeId)).toHaveLength(0);
    expect((await module11.routes.findById(routeId))!.recalculationCount).toBe(0);

    // The legitimate retry is attributed to the real authenticated identity.
    const legit = await recalc(app, routeId, 'Bearer dispatcher', { reason: 'legitimate reason' });
    expect(legit.statusCode).toBe(200);
    const events = await recalcEventsFor(routeId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: 'DISPATCHER', actorId: 'USR-DISP' });
    expect(JSON.stringify(events[0])).not.toContain('USR-EVIL');
    expect(JSON.stringify(events[0])).not.toContain('impersonation attempt');
  });

  it('preserves the SYSTEM default when the service is called without an authenticated actor', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);

    const result = await module8.optimization.recalculateRoute(routeId, 'scheduled maintenance');
    expect(result).toMatchObject({ outcome: 'RECALCULATED', routeId });

    const events = await recalcEventsFor(routeId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null });
  });

  it('emits no successful event when the provider fails on an actor-initiated recalculation', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);
    const before = await module11.routes.findById(routeId);

    const config = loadModule8Config();
    config.generation = { ...config.generation, enabled: false, includeSimulation: false };
    const failing = new Module8({
      routes: module11.routes,
      emergencies: module11.emergencies,
      ambulances: module11.ambulances,
      hospitals: module11.hospitals,
      events: module11.eventPublisher,
      primaryProvider: throwingProvider('osrm'),
      fallbackProvider: throwingProvider('google'),
      config,
      logger: noopLogger,
    });
    try {
      const app = buildApp(failing.optimization);
      const response = await recalc(app, routeId, 'Bearer dispatcher', { reason: 'provider outage' });
      expect(response.statusCode).toBe(502);
      expect((response.json() as { error: { code: string } }).error.code).toBe('ROUTING_FAILED');
    } finally {
      failing.dispose();
    }

    expect(await recalcEventsFor(routeId)).toHaveLength(0);
    const after = await module11.routes.findById(routeId);
    expect(after).toMatchObject({
      distanceKm: before!.distanceKm,
      polyline: before!.polyline,
      recalculationCount: 0,
    });
    const failed = (await module11.eventQuery.timeline(emergencyId))
      .filter((event) => event.type === 'ROUTE_FAILED');
    expect(failed).toHaveLength(1);
  });

  it('rolls back the route replacement and emits no successful event when the durable event write fails', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);
    const before = await module11.routes.findById(routeId);
    const app = buildApp();

    const spy = vi
      .spyOn(module11.eventPublisher, 'recordInTransaction')
      .mockRejectedValueOnce(new Error('forced durable event write failure'));
    try {
      const response = await recalc(app, routeId, 'Bearer dispatcher', { reason: 'durable write outage' });
      expect(response.statusCode).toBe(502);
    } finally {
      spy.mockRestore();
    }

    // The route replacement and its event share one transaction: the failure
    // rolled back the distance and recalculation-count change.
    const after = await module11.routes.findById(routeId);
    expect(after).toMatchObject({
      distanceKm: before!.distanceKm,
      polyline: before!.polyline,
      estimatedMinutes: before!.estimatedMinutes,
      recalculationCount: 0,
    });
    expect(await recalcEventsFor(routeId)).toHaveLength(0);
    const timeline = await module11.eventQuery.timeline(emergencyId);
    expect(timeline.filter((event) => event.type === 'ROUTE_RECALCULATED')).toHaveLength(0);
    expect(timeline.filter((event) => event.type === 'ROUTE_FAILED')).toHaveLength(1);
  });

  it('rejects unauthenticated and wrong-role requests without any event', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);
    const app = buildApp();
    const payload = { reason: 'should never run' };

    expect((await recalc(app, routeId, undefined, payload)).statusCode).toBe(401);
    expect((await recalc(app, routeId, 'Bearer operator', payload)).statusCode).toBe(403);
    expect((await recalc(app, routeId, 'Bearer driver', payload)).statusCode).toBe(403);

    expect(await recalcEventsFor(routeId)).toHaveLength(0);
    expect((await module11.routes.findById(routeId))!.recalculationCount).toBe(0);
    expect((await module11.eventQuery.timeline(emergencyId))
      .filter((event) => event.type === 'ROUTE_RECALCULATED')).toHaveLength(0);
  });
});
