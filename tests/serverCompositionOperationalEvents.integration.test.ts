import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { MockRoutingProvider } from '@resus/routing';
import { noopLogger, type RoutingProvider } from '@resus/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getOperationalEvents } from '../modules/module_12_dashboard_analytics/frontend/src/api.js';
import { resolve, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { MODULE10_LIFECYCLE_EVENT_TYPES } from '../modules/module10/module10/src/lifecycle/observer.js';
import {
  assertDatabaseUrlMatches,
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from './helpers/isolatedTestDatabase.js';

const runCompositionIntegration = process.env.RESUS_RUN_ISOLATED_COMPOSITION_TEST === 'true';
const compositionDescribe = runCompositionIntegration ? describe : describe.skip;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const schemaPath = resolve(repoRoot, 'modules/module_11_database_event_system/prisma/schema.prisma');
const dispatcherPassword = 'Stage423-test-only-dispatcher-7!';
const driverPassword = 'Stage423-test-only-driver-7!';
const operatorPassword = 'Stage423-test-only-operator-7!';

type LoginResponse = { token: string; user: { userId: string; email: string; role: string } };
type EventWire = {
  id: string;
  sequence: number;
  type: string;
  emergencyId: string | null;
  entityType: string | null;
  entityId: string | null;
  timestamp: string;
  actorType: string | null;
  actorId: string | null;
  payload: Record<string, unknown>;
};

compositionDescribe('isolated server composition: operational events, hospital resources and route recalculation', () => {
  let testDatabase: IsolatedTestDatabase | undefined;
  let db: PrismaClient | undefined;
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  let previousExternalConfig: Record<string, string | undefined> = {};

  afterAll(async () => {
    try {
      await server?.shutdown();
    } finally {
      try {
        await db?.$disconnect();
      } finally {
        try {
          testDatabase?.cleanup();
        } finally {
          for (const [key, value] of Object.entries(previousExternalConfig)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      }
    }
  });

  it('updates hospital resources and recalculates a route end to end with durable events and operator visibility', async () => {
    previousExternalConfig = Object.fromEntries(
      ['TRANSPORT_PROVIDER', 'MODULE3_NLP_ENABLED', 'MODULE8_AUTO_ROUTE_SIMULATION'].map((key) => [key, process.env[key]]),
    );

    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const approvedRoot = resolve(tmpdir(), 'resus-isolated-integration-tests');
    const absoluteDatabasePath = resolve(testDatabase.databasePath);
    expect(absoluteDatabasePath.startsWith(`${resolve(approvedRoot)}${sep}`)).toBe(true);
    expect(basename(absoluteDatabasePath)).toBe('integration.sqlite');
    assertDatabaseUrlMatches(testDatabase.databaseUrl, absoluteDatabasePath);
    expect(process.env.DATABASE_URL).toBe(testDatabase.databaseUrl);

    process.env.TRANSPORT_PROVIDER = 'loopback';
    process.env.MODULE3_NLP_ENABLED = 'false';
    process.env.MODULE8_AUTO_ROUTE_SIMULATION = 'true';

    db = new PrismaClient({ datasources: { db: { url: testDatabase.databaseUrl } } });
    const mock = new MockRoutingProvider(40);
    let providerMode: 'FAIL' | 'READY' = 'FAIL';
    const provider = (kind: 'primary' | 'fallback'): RoutingProvider => ({
      providerName: kind === 'primary' ? 'stage-4.23-deterministic' : 'stage-4.23-fallback',
      isLive: false,
      isLiveTraffic: false,
      async route(request) {
        if (providerMode === 'FAIL') throw new Error(`isolated ${kind} route provider failure`);
        const result = await mock.route(request);
        return {
          ...result,
          providerName: kind === 'primary' ? 'stage-4.23-deterministic' : 'stage-4.23-fallback',
        };
      },
    });

    server = await buildServer(
      loadServerConfig({
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '4000',
        LOG_LEVEL: 'error',
        JWT_SECRET: 'stage-4.23-isolated-test-secret-only',
        MODULE3_NLP_ENABLED: 'false',
      }),
      {
        db,
        ownsDatabaseClient: false,
        logger: noopLogger,
        routingProviders: { primary: provider('primary'), fallback: provider('fallback') },
      },
    );

    // The composition uses this exact client and keeps every automation flag off.
    expect(server.module11.db).toBe(db);
    expect(server.module6.config.autoDispatch.enabled).toBe(false);
    expect(server.module7.config.autoSelect.enabled).toBe(false);
    expect(server.module8.config.generation.enabled).toBe(false);
    expect(server.module9.config.enabled).toBe(false);

    const passwordHash = await bcrypt.hash(dispatcherPassword, 4);
    const dispatcher = await server.module11.users.create({
      email: 'dispatcher@stage423.test',
      displayName: 'Stage 4.23 Dispatcher',
      passwordHash,
      role: 'DISPATCHER',
    });
    const driver = await server.module11.users.create({
      email: 'driver@stage423.test',
      displayName: 'Stage 4.23 Driver',
      passwordHash: await bcrypt.hash(driverPassword, 4),
      role: 'DRIVER',
    });
    const operator = await server.module11.users.create({
      email: 'operator@stage423.test',
      displayName: 'Stage 4.23 Operator',
      passwordHash: await bcrypt.hash(operatorPassword, 4),
      role: 'OPERATOR',
    });

    const login = async (email: string, password: string): Promise<LoginResponse> => {
      const response = await server!.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
      expect(response.statusCode).toBe(200);
      return response.json() as LoginResponse;
    };
    const dispatcherSession = await login(dispatcher.email, dispatcherPassword);
    const driverSession = await login(driver.email, driverPassword);
    const operatorSession = await login(operator.email, operatorPassword);
    expect(dispatcherSession.user.userId).toBe(dispatcher.id);
    expect(dispatcherSession.user.role).toBe('DISPATCHER');
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    const dispatcherToken = dispatcherSession.token;
    const driverToken = driverSession.token;
    const operatorToken = operatorSession.token;

    let recalculatedRouteId = '';
    const externalFetch = vi.spyOn(globalThis, 'fetch');
    try {
      // ===== Hospital resource update: API write, repository read-back, durable event =====
      const hospitalId = 'HSP-STAGE423-OPS';
      await db.hospital.create({ data: {
        id: hospitalId, name: 'Stage 4.23 Operational Hospital',
        latitude: 12.99, longitude: 77.61, status: 'OPEN',
        capabilitiesJson: JSON.stringify(['ED_CARDIAC']), traumaLevel: 2,
        acceptingEmergencies: true, isSimulation: false,
        resources: { create: { id: 'HRS-STAGE423-ICU', resourceType: 'ICU_BED', code: '', total: 8, available: 3 } },
      } });

      const readHospital = async () => {
        const hospitals = await server!.module11.hospitals.listWithResources();
        return hospitals.find((item) => item.id === hospitalId) ?? null;
      };
      const hospitalBefore = await readHospital();
      expect(hospitalBefore?.resources).toHaveLength(1);
      expect(hospitalBefore?.resources[0]).toMatchObject({ resourceType: 'ICU_BED', code: '', total: 8, available: 3 });

      const patchUrl = `/api/hospitals/${hospitalId}/resources`;
      const hospitalEvents = async () => {
        const response = await server!.fastify.inject({
          method: 'GET',
          url: `/api/events?types=HOSPITAL_RESOURCE_UPDATED&entityId=${hospitalId}`,
          headers: auth(dispatcherToken),
        });
        expect(response.statusCode).toBe(200);
        return response.json() as { items: EventWire[]; total: number };
      };
      expect((await hospitalEvents()).total).toBe(0);

      // Server-side role enforcement, not just UI: 401 unauthenticated, 403 insufficient role.
      const anonymousPatch = await server.fastify.inject({
        method: 'PATCH', url: patchUrl,
        payload: { resourceType: 'ICU_BED', total: 9, available: 4 },
      });
      expect(anonymousPatch.statusCode).toBe(401);
      const operatorPatch = await server.fastify.inject({
        method: 'PATCH', url: patchUrl, headers: auth(operatorToken),
        payload: { resourceType: 'ICU_BED', total: 9, available: 4 },
      });
      expect(operatorPatch.statusCode).toBe(403);

      // Update-only: an unseeded resource row is refused without a fabricated row or event.
      const missingRow = await server.fastify.inject({
        method: 'PATCH', url: patchUrl, headers: auth(dispatcherToken),
        payload: { resourceType: 'OPERATION_THEATRE', total: 2, available: 2 },
      });
      expect(missingRow.statusCode).toBe(404);
      expect(await db.hospitalResource.count({ where: { hospitalId, resourceType: 'OPERATION_THEATRE' } })).toBe(0);
      expect((await hospitalEvents()).total).toBe(0);

      // Validation: available cannot exceed total → 422, no event.
      const invalidCount = await server.fastify.inject({
        method: 'PATCH', url: patchUrl, headers: auth(dispatcherToken),
        payload: { resourceType: 'ICU_BED', total: 8, available: 9 },
      });
      expect(invalidCount.statusCode).toBe(422);
      expect((invalidCount.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
      expect((await hospitalEvents()).total).toBe(0);

      // The authenticated dispatcher update persists and commits exactly one event.
      const firstUpdate = await server.fastify.inject({
        method: 'PATCH', url: patchUrl, headers: auth(dispatcherToken),
        payload: { resourceType: 'ICU_BED', total: 12, available: 5 },
      });
      expect(firstUpdate.statusCode).toBe(200);
      expect(firstUpdate.json()).toMatchObject({
        hospitalId,
        resource: { hospitalId, resourceType: 'ICU_BED', total: 12, available: 5 },
      });

      const hospitalAfterFirst = await readHospital();
      expect(hospitalAfterFirst?.resources).toHaveLength(1);
      expect(hospitalAfterFirst?.resources[0]).toMatchObject({ total: 12, available: 5 });

      const firstEvents = await hospitalEvents();
      expect(firstEvents.total).toBe(1);
      expect(firstEvents.items[0]).toMatchObject({
        type: 'HOSPITAL_RESOURCE_UPDATED',
        emergencyId: null,
        entityType: 'hospital',
        entityId: hospitalId,
        actorType: 'DISPATCHER',
        actorId: dispatcher.id,
        payload: { hospitalId, resourceType: 'ICU_BED', code: '', total: 12, available: 5 },
      });
      expect(Number.isNaN(Date.parse(firstEvents.items[0]!.timestamp))).toBe(false);
      expect(typeof firstEvents.items[0]!.sequence).toBe('number');

      const secondUpdate = await server.fastify.inject({
        method: 'PATCH', url: patchUrl, headers: auth(dispatcherToken),
        payload: { resourceType: 'ICU_BED', total: 14, available: 6 },
      });
      expect(secondUpdate.statusCode).toBe(200);
      expect((await hospitalEvents()).total).toBe(2);
      // Still update-only: no additional resource row appeared.
      expect((await readHospital())?.resources).toHaveLength(1);

      // ===== Non-simulation emergency: assign, dispatch, generate, then recalculate =====
      const scene = { latitude: 12.9716, longitude: 77.5946 };
      const ambulance = await server.module11.ambulances.create({
        vehicleNumber: 'STAGE423-AMB-1',
        latitude: 12.95,
        longitude: 77.58,
        status: 'AVAILABLE',
      });
      expect(ambulance.isSimulation).toBe(false);
      await db.ambulance.update({ where: { id: ambulance.id }, data: { assignedDriverId: driver.id } });

      const emergencyResponse = await server.fastify.inject({
        method: 'POST', url: '/api/emergencies', headers: auth(dispatcherToken),
        payload: { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL', latitude: scene.latitude, longitude: scene.longitude, isSimulation: false },
      });
      expect(emergencyResponse.statusCode).toBe(201);
      const emergency = (emergencyResponse.json() as { emergency: { id: string; isSimulation: boolean } }).emergency;
      expect(emergency.isSimulation).toBe(false);

      const assign = await server.fastify.inject({
        method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken),
        payload: { emergencyId: emergency.id, ...scene },
      });
      expect(assign.statusCode).toBe(200);
      const assignment = assign.json() as { ambulanceId: string; assignmentId: string };
      expect(assignment.ambulanceId).toBe(ambulance.id);

      const accepted = await server.fastify.inject({
        method: 'POST', url: `/api/drivers/me/assignment/${assignment.assignmentId}/accept`,
        headers: auth(driverToken), payload: {},
      });
      expect(accepted.statusCode).toBe(200);

      const routeUrl = `/api/emergencies/${emergency.id}/routes`;
      const premature = await server.fastify.inject({
        method: 'POST', url: routeUrl, headers: auth(dispatcherToken), payload: { leg: 'RESPONSE' },
      });
      expect(premature.statusCode).toBe(409);

      const dispatched = await server.fastify.inject({
        method: 'POST', url: `/api/ambulances/${ambulance.id}/dispatch`,
        headers: auth(dispatcherToken), payload: { emergencyId: emergency.id },
      });
      expect(dispatched.statusCode).toBe(200);

      providerMode = 'READY';
      const generated = await server.fastify.inject({
        method: 'POST', url: routeUrl, headers: auth(dispatcherToken), payload: { leg: 'RESPONSE' },
      });
      expect(generated.statusCode).toBe(200);
      const route = (generated.json() as { route: { id: string; distanceKm: number; isSimulation: boolean } }).route;
      expect(route.isSimulation).toBe(false);
      recalculatedRouteId = route.id;

      const routeRead = await server.fastify.inject({
        method: 'GET', url: `/api/routes/${route.id}`, headers: auth(dispatcherToken),
      });
      expect(routeRead.statusCode).toBe(200);
      const routeBefore = routeRead.json() as { id: string; recalculationCount: number; distanceKm: number; estimatedMinutes: number | null };
      expect(routeBefore).toMatchObject({ id: route.id, recalculationCount: 0 });

      const emergencyBefore = await server.fastify.inject({
        method: 'GET', url: `/api/emergencies/${emergency.id}`, headers: auth(dispatcherToken),
      });
      expect(emergencyBefore.statusCode).toBe(200);
      const emergencySnapshot = emergencyBefore.json() as { status: string; assignedAmbulanceId: string | null };
      expect(emergencySnapshot.assignedAmbulanceId).toBe(ambulance.id);

      const lifecycleBefore = await server.fastify.inject({
        method: 'GET', url: `/api/emergencies/${emergency.id}/lifecycle`, headers: auth(dispatcherToken),
      });
      expect(lifecycleBefore.statusCode).toBe(200);
      expect((lifecycleBefore.json() as { projection: { facts: Record<string, unknown> } }).projection.facts.route)
        .toMatchObject({ routeId: route.id });

      const recalcUrl = `/api/routes/${route.id}/recalculate`;
      const recalcEvents = async () => {
        const response = await server!.fastify.inject({
          method: 'GET',
          url: `/api/events?emergencyId=${encodeURIComponent(emergency.id)}&types=ROUTE_RECALCULATED`,
          headers: auth(dispatcherToken),
        });
        expect(response.statusCode).toBe(200);
        return (response.json() as { items: EventWire[] }).items;
      };
      expect(await recalcEvents()).toHaveLength(0);

      // Server-side authorization: 401 without a token, 403 outside DISPATCHER/ADMIN.
      expect((await server.fastify.inject({ method: 'POST', url: recalcUrl, payload: { reason: 'attempt' } })).statusCode).toBe(401);
      expect((await server.fastify.inject({ method: 'POST', url: recalcUrl, headers: auth(operatorToken), payload: { reason: 'attempt' } })).statusCode).toBe(403);
      expect((await server.fastify.inject({ method: 'POST', url: recalcUrl, headers: auth(driverToken), payload: { reason: 'attempt' } })).statusCode).toBe(403);
      expect(await recalcEvents()).toHaveLength(0);

      // A meaningful reason is mandatory: missing and blank reasons are refused with 422.
      const missingReason = await server.fastify.inject({
        method: 'POST', url: recalcUrl, headers: auth(dispatcherToken), payload: {},
      });
      expect(missingReason.statusCode).toBe(422);
      expect((missingReason.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
      const blankReason = await server.fastify.inject({
        method: 'POST', url: recalcUrl, headers: auth(dispatcherToken), payload: { reason: '   ' },
      });
      expect(blankReason.statusCode).toBe(422);
      expect((blankReason.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
      expect(await recalcEvents()).toHaveLength(0);

      // The ambulance closes in on the scene through the supported GPS workflow path.
      const gps = await server.fastify.inject({
        method: 'POST', url: `/api/ambulances/${ambulance.id}/location`,
        headers: auth(driverToken),
        payload: { latitude: 12.965, longitude: 77.59, speedKmh: 30, headingDeg: 45, accuracyM: 6 },
      });
      expect(gps.statusCode).toBe(200);

      const recalculated = await server.fastify.inject({
        method: 'POST', url: recalcUrl, headers: auth(dispatcherToken),
        payload: { reason: 'ambulance repositioned after traffic hold' },
      });
      expect(recalculated.statusCode).toBe(200);
      expect(recalculated.json()).toMatchObject({ routeId: route.id, emergencyId: emergency.id, outcome: 'RECALCULATED' });

      const routeAfter = await server.fastify.inject({
        method: 'GET', url: `/api/routes/${route.id}`, headers: auth(dispatcherToken),
      });
      const routeAfterBody = routeAfter.json() as { id: string; recalculationCount: number; distanceKm: number; estimatedMinutes: number | null };
      expect(routeAfterBody).toMatchObject({ id: route.id, recalculationCount: 1 });
      expect(routeAfterBody.distanceKm).toBeLessThan(routeBefore.distanceKm);

      // Exactly one durable event carrying previous/new values and the operator's reason.
      const recalculatedEvents = await recalcEvents();
      expect(recalculatedEvents).toHaveLength(1);
      expect(recalculatedEvents[0]).toMatchObject({
        emergencyId: emergency.id,
        entityType: 'route',
        entityId: route.id,
        actorType: 'DISPATCHER',
        actorId: dispatcher.id,
        payload: {
          routeId: route.id,
          emergencyId: emergency.id,
          previousDistanceKm: routeBefore.distanceKm,
          distanceKm: routeAfterBody.distanceKm,
          previousEstimatedMinutes: routeBefore.estimatedMinutes ?? 0,
          estimatedMinutes: routeAfterBody.estimatedMinutes ?? 0,
          reason: 'ambulance repositioned after traffic hold',
        },
      });

      // The recalculation never mutates emergency lifecycle state.
      const emergencyAfter = await server.fastify.inject({
        method: 'GET', url: `/api/emergencies/${emergency.id}`, headers: auth(dispatcherToken),
      });
      expect(emergencyAfter.json()).toMatchObject({
        status: emergencySnapshot.status,
        assignedAmbulanceId: ambulance.id,
      });

      // Provider failure: 502, no additional ROUTE_RECALCULATED, route row untouched.
      providerMode = 'FAIL';
      const failedRecalc = await server.fastify.inject({
        method: 'POST', url: recalcUrl, headers: auth(dispatcherToken), payload: { reason: 'provider outage' },
      });
      expect(failedRecalc.statusCode).toBe(502);
      expect((failedRecalc.json() as { error: { code: string } }).error.code).toBe('ROUTING_FAILED');
      expect(await recalcEvents()).toHaveLength(1);
      const routeUnchanged = await server.fastify.inject({
        method: 'GET', url: `/api/routes/${route.id}`, headers: auth(dispatcherToken),
      });
      expect(routeUnchanged.json()).toMatchObject({ recalculationCount: 1, distanceKm: routeAfterBody.distanceKm });

      // Terminal route: 409, still no additional event.
      await db.route.update({ where: { id: route.id }, data: { status: 'ARRIVED' } });
      const terminalRecalc = await server.fastify.inject({
        method: 'POST', url: recalcUrl, headers: auth(dispatcherToken), payload: { reason: 'should not run' },
      });
      expect(terminalRecalc.statusCode).toBe(409);
      expect(await recalcEvents()).toHaveLength(1);

      // ===== Operator-facing durable history and Module 10 separation =====
      const combined = await server.fastify.inject({
        method: 'GET',
        url: '/api/events?types=HOSPITAL_RESOURCE_UPDATED,ROUTE_RECALCULATED&limit=50',
        headers: auth(dispatcherToken),
      });
      expect(combined.statusCode).toBe(200);
      const combinedBody = combined.json() as { items: EventWire[]; total: number };
      expect(combinedBody.total).toBe(3);
      expect(combinedBody.items.map((event) => event.type).sort())
        .toEqual(['HOSPITAL_RESOURCE_UPDATED', 'HOSPITAL_RESOURCE_UPDATED', 'ROUTE_RECALCULATED']);

      // The event-history endpoint enforces its own roles.
      expect((await server.fastify.inject({ method: 'GET', url: '/api/events' })).statusCode).toBe(401);
      const driverHistory = await server.fastify.inject({ method: 'GET', url: '/api/events', headers: auth(driverToken) });
      expect(driverHistory.statusCode).toBe(403);

      // The dashboard timeline surfaces the recalculation for this emergency.
      const timeline = await server.fastify.inject({
        method: 'GET', url: `/api/dashboard/emergencies/${emergency.id}/timeline`, headers: auth(dispatcherToken),
      });
      expect(timeline.statusCode).toBe(200);
      const timelineTypes = (timeline.json() as { events: Array<{ type: string }> }).events.map((event) => event.type);
      expect(timelineTypes).toEqual(expect.arrayContaining([
        'AMBULANCE_ASSIGNED', 'AMBULANCE_DISPATCHED', 'ROUTE_GENERATED', 'ROUTE_RECALCULATED',
      ]));

      // Module 10 stays read-only: the lifecycle projection is identical before
      // and after the operational events, and both types are outside its vocabulary.
      const lifecycleAfter = await server.fastify.inject({
        method: 'GET', url: `/api/emergencies/${emergency.id}/lifecycle`, headers: auth(dispatcherToken),
      });
      expect(lifecycleAfter.statusCode).toBe(200);
      expect((lifecycleAfter.json() as { projection: unknown }).projection)
        .toEqual((lifecycleBefore.json() as { projection: unknown }).projection);
      expect(MODULE10_LIFECYCLE_EVENT_TYPES).not.toContain('ROUTE_RECALCULATED');
      expect(MODULE10_LIFECYCLE_EVENT_TYPES).not.toContain('HOSPITAL_RESOURCE_UPDATED');

      // Learning stays off: operational events write no learning sample.
      expect(await db.learningSample.count({ where: { emergencyId: emergency.id } })).toBe(0);

      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      externalFetch.mockRestore();
    }

    // The smallest operator-facing client change runs against the real
    // composition through the established fetch→inject bridge.
    const originalFetch = globalThis.fetch;
    try {
      vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        const injected = await server!.fastify.inject({
          method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH',
          url: String(url),
          headers: init?.headers as Record<string, string> | undefined,
          ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
        });
        return new Response(injected.body, { status: injected.statusCode, headers: { 'content-type': 'application/json' } });
      });
      const operationalEvents = await getOperationalEvents(dispatcherToken);
      expect(operationalEvents.map((event) => event.type)).toEqual([
        'ROUTE_RECALCULATED', 'HOSPITAL_RESOURCE_UPDATED', 'HOSPITAL_RESOURCE_UPDATED',
      ]);
      expect(operationalEvents[0]?.entityId).toBe(recalculatedRouteId);
      expect(operationalEvents[0]?.entityType).toBe('route');
      expect(operationalEvents[0]?.actorType).toBe('DISPATCHER');
      expect(operationalEvents[0]?.actorId).toBe(dispatcher.id);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  }, 240_000);
});
