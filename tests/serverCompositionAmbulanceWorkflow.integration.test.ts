import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { MockRoutingProvider } from '@resus/routing';
import { audioCarrier } from '@resus/speech';
import { noopLogger, type RoutingProvider } from '@resus/core';
import type { LLMService } from '@resus/protocols';
import { entitiesSchema } from '../modules/module_05_bystander_assistance/src/llm/contracts.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getLifecycle } from '../modules/module_12_dashboard_analytics/frontend/src/api.js';
import { resolve, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
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
const dispatcherPassword = 'Stage4102-test-only-dispatcher-9!';
const driverPassword = 'Stage4102-test-only-driver-9!';
const otherDriverPassword = 'Stage4102-test-only-other-driver-9!';
const operatorPassword = 'Stage4102-test-only-operator-9!';

type LoginResponse = { token: string };

compositionDescribe('isolated server composition: dispatch, route and mock notification workflow', () => {
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

  it('uses the real Fastify composition with only owned SQLite state and mock adapters', async () => {
    previousExternalConfig = Object.fromEntries(
      ['TRANSPORT_PROVIDER', 'MODULE3_NLP_ENABLED', 'MODULE7_AUTO_SELECT_SIMULATION', 'MODULE8_AUTO_ROUTE_SIMULATION', 'LLM_PROVIDER'].map((key) => [key, process.env[key]]),
    );

    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const approvedRoot = resolve(tmpdir(), 'resus-isolated-integration-tests');
    const absoluteDatabasePath = resolve(testDatabase.databasePath);
    expect(absoluteDatabasePath.startsWith(`${resolve(approvedRoot)}${sep}`)).toBe(true);
    expect(basename(absoluteDatabasePath)).toBe('integration.sqlite');
    assertDatabaseUrlMatches(testDatabase.databaseUrl, absoluteDatabasePath);
    expect(process.env.DATABASE_URL).toBe(testDatabase.databaseUrl);

    // Isolated simulated records may use the explicit route endpoint; all
    // automatic subscribers remain disabled by the helper's fail-closed flags.
    process.env.TRANSPORT_PROVIDER = 'loopback';
    process.env.MODULE3_NLP_ENABLED = 'false';
    // This only permits the test's explicit operator hospital-selection API
    // to include simulated rows; automatic selection remains disabled.
    process.env.MODULE7_AUTO_SELECT_SIMULATION = 'true';
    process.env.MODULE8_AUTO_ROUTE_SIMULATION = 'true';
    // The real Module 5 path is exercised below with this deterministic
    // provider double; no Ollama process or network request is involved.
    process.env.LLM_PROVIDER = 'isolated-test-double';

    const extractionCalls: string[] = [];
    let synthesisParaphraseAttempts = 0;
    const module5Provider: LLMService = {
      providerName: 'isolated-test-double',
      model: 'synthetic-schema-fixture',
      async health() {
        return { provider: this.providerName, model: this.model, available: true, checkedAt: new Date().toISOString() };
      },
      async extract(transcript) {
        extractionCalls.push(transcript);
        return {
          intent: 'OTHER',
          entities: entitiesSchema.parse({
            caller_location: transcript.includes('I do not know the location')
              ? null
              : transcript.includes('Synthetic No Match')
                ? 'Synthetic No Match'
                : 'Synthetic Test Site Seven',
          }),
          confidence: 1,
          requires_clarification: false,
          clarification_question: null,
          evidence: transcript,
        };
      },
      async respond() {
        synthesisParaphraseAttempts += 1;
        throw new Error('Deterministic test double does not paraphrase protocol wording.');
      },
      async generate() { throw new Error('Unneeded by isolated composition test.'); },
      async classify() { throw new Error('Unneeded by isolated composition test.'); },
    };

    db = new PrismaClient({ datasources: { db: { url: testDatabase.databaseUrl } } });
    const mock = new MockRoutingProvider(40);
    let providerMode: 'FAIL' | 'READY' = 'FAIL';
    const providerCalls = { primary: 0, fallback: 0 };
    const provider = (kind: 'primary' | 'fallback'): RoutingProvider => ({
      providerName: kind === 'primary' ? 'stage-4.10.2-deterministic' : 'stage-4.10.2-fallback',
      isLive: false,
      isLiveTraffic: false,
      async route(request) {
        providerCalls[kind] += 1;
        if (providerMode === 'FAIL') throw new Error(`isolated ${kind} route provider failure`);
        const result = await mock.route(request);
        return { ...result, providerName: kind === 'primary' ? 'stage-4.10.2-deterministic' : 'stage-4.10.2-fallback' };
      },
    });

    server = await buildServer(
      loadServerConfig({
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '4000',
        LOG_LEVEL: 'error',
        JWT_SECRET: 'stage-4.10.2-isolated-test-secret-only',
        MODULE3_NLP_ENABLED: 'false',
      }),
      {
        db,
        ownsDatabaseClient: false,
        logger: noopLogger,
        routingProviders: { primary: provider('primary'), fallback: provider('fallback') },
        module5Providers: [module5Provider],
        callerLocationResolver: {
          providerName: 'test-only-deterministic-location-mock',
          async resolve(text: string) {
            return text.toLowerCase().includes('synthetic test site seven')
              ? { outcome: 'AMBIGUOUS' as const, latitude: 0.0001, longitude: 0.0002, confidence: 0.42 }
              : { outcome: 'NOT_FOUND' as const };
          },
        },
      },
    );

    // This identity assertion proves the composition, replay, repositories and
    // route handlers all use the same explicitly owned client.
    expect(server.module11.db).toBe(db);
    expect(server.module6.config.autoDispatch.enabled).toBe(false);
    expect(server.module7.config.autoSelect.enabled).toBe(false);
    expect(server.module8.config.provider).toBe('mock');
    expect(server.module8.config.generation.enabled).toBe(false);
    expect(server.module9.config.enabled).toBe(false);
    expect(server.module8.autoRoute).toBeUndefined();
    expect(server.module9.autoCorridor).toBeUndefined();

    const passwordHash = await bcrypt.hash(dispatcherPassword, 4);
    const dispatcher = await server.module11.users.create({ email: 'dispatcher@stage4102.test', displayName: 'Isolated Dispatcher', passwordHash, role: 'DISPATCHER' });
    const driver = await server.module11.users.create({ email: 'driver@stage4102.test', displayName: 'Isolated Driver', passwordHash: await bcrypt.hash(driverPassword, 4), role: 'DRIVER' });
    const otherDriver = await server.module11.users.create({ email: 'other-driver@stage4102.test', displayName: 'Other Isolated Driver', passwordHash: await bcrypt.hash(otherDriverPassword, 4), role: 'DRIVER' });
    const operator = await server.module11.users.create({ email: 'operator@stage4102.test', displayName: 'Isolated Operator', passwordHash: await bcrypt.hash(operatorPassword, 4), role: 'OPERATOR' });
    const milestoneDriver = await server.module11.users.create({ email: 'milestone-driver@stage4102.test', displayName: 'Milestone Isolated Driver', passwordHash: await bcrypt.hash(driverPassword, 4), role: 'DRIVER' });
    const expiryDriver = await server.module11.users.create({ email: 'expiry-driver@stage4102.test', displayName: 'Expiry Isolated Driver', passwordHash: await bcrypt.hash(driverPassword, 4), role: 'DRIVER' });
    const replacementDriver = await server.module11.users.create({ email: 'replacement-driver@stage4102.test', displayName: 'Replacement Isolated Driver', passwordHash: await bcrypt.hash(driverPassword, 4), role: 'DRIVER' });
    const provenanceDriver = await server.module11.users.create({ email: 'provenance-driver@stage4102.test', displayName: 'Provenance Isolated Driver', passwordHash: await bcrypt.hash(driverPassword, 4), role: 'DRIVER' });

    const login = async (email: string, password: string): Promise<string> => {
      const response = await server!.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
      expect(response.statusCode).toBe(200);
      return (response.json() as LoginResponse).token;
    };
    const dispatcherToken = await login(dispatcher.email, dispatcherPassword);
    const driverToken = await login(driver.email, driverPassword);
    const otherDriverToken = await login(otherDriver.email, otherDriverPassword);
    const operatorToken = await login(operator.email, operatorPassword);
    const milestoneDriverToken = await login(milestoneDriver.email, driverPassword);
    const expiryDriverToken = await login(expiryDriver.email, driverPassword);
    expect((await server.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: dispatcher.email, password: 'incorrect' } })).statusCode).toBe(401);

    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    expect((await server.fastify.inject({ method: 'GET', url: '/api/dashboard/live?includeSimulation=true' })).statusCode).toBe(401);

    const createEmergency = async (latitude: number, longitude: number, isSimulation = true, incidentType = 'TRAUMA', severity = 'MEDIUM') => {
      const response = await server!.fastify.inject({
        method: 'POST',
        url: '/api/emergencies',
        headers: auth(dispatcherToken),
        payload: { incidentType, severity, latitude, longitude, isSimulation },
      });
      expect(response.statusCode).toBe(201);
      return { ...response.json().emergency, callSessionId: response.json().callSession.id } as { id: string; assignedAmbulanceId: string | null; callSessionId: string };
    };
    const createDriverBoundAmbulance = async (vehicleNumber: string, driverId: string, latitude: number, longitude: number) => {
      const ambulance = await server!.module11.ambulances.create({ vehicleNumber, latitude, longitude, status: 'AVAILABLE', isSimulation: true });
      await db!.ambulance.update({ where: { id: ambulance.id }, data: { assignedDriverId: driverId } });
      return ambulance;
    };

    const scene = { latitude: 12.9716, longitude: 77.5946 };
    const ambulance = await createDriverBoundAmbulance('STAGE4102-AMB-1', driver.id, scene.latitude, scene.longitude);
    const emergency = await createEmergency(scene.latitude, scene.longitude);

    const assign = await server.fastify.inject({
      method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken),
      payload: { emergencyId: emergency.id, ...scene },
    });
    expect(assign.statusCode).toBe(200);
    const assignment = assign.json() as { ambulanceId: string; assignmentId: string };
    expect(assignment.ambulanceId).toBe(ambulance.id);

    const ownAssignment = await server.fastify.inject({ method: 'GET', url: '/api/drivers/me/assignment', headers: auth(driverToken) });
    expect(ownAssignment.statusCode).toBe(200);
    expect(ownAssignment.json()).toMatchObject({ assigned: true, ambulance: { id: ambulance.id }, assignment: { id: assignment.assignmentId, status: 'OFFERED', expiresAt: expect.any(String) } });
    const foreignRead = await server.fastify.inject({ method: 'GET', url: '/api/drivers/me/assignment', headers: auth(otherDriverToken) });
    expect(foreignRead.statusCode).toBe(200);
    expect(foreignRead.json()).toMatchObject({ assigned: false, assignment: null });
    const competingDriverAccepts = await Promise.all([
      server.fastify.inject({ method: 'POST', url: `/api/drivers/me/assignment/${assignment.assignmentId}/accept`, headers: auth(otherDriverToken), payload: {} }),
      server.fastify.inject({ method: 'POST', url: `/api/drivers/me/assignment/${assignment.assignmentId}/accept`, headers: auth(driverToken), payload: {} }),
    ]);
    expect(competingDriverAccepts.map((response) => response.statusCode).sort()).toEqual([200, 403]);

    const duplicateAccepts = await Promise.all([
      server.fastify.inject({ method: 'POST', url: `/api/drivers/me/assignment/${assignment.assignmentId}/accept`, headers: auth(driverToken), payload: {} }),
      server.fastify.inject({ method: 'POST', url: `/api/drivers/me/assignment/${assignment.assignmentId}/accept`, headers: auth(driverToken), payload: {} }),
    ]);
    expect(duplicateAccepts.map((response) => response.statusCode)).toEqual([200, 200]);
    const accepted = duplicateAccepts.find((response) => response.statusCode === 200)!;
    expect(accepted.json()).toMatchObject({ assignment: { id: assignment.assignmentId, status: 'ACCEPTED' } });
    expect((await server.fastify.inject({ method: 'POST', url: `/api/drivers/me/assignment/${assignment.assignmentId}/accept`, headers: auth(driverToken), payload: {} })).statusCode).toBe(200);
    expect(await db.systemEvent.count({ where: { emergencyId: emergency.id, type: 'AMBULANCE_ASSIGNMENT_ACCEPTED' } })).toBe(1);

    // Expiry is tested through a real isolated SQLite row. The repository uses
    // a conditional expiry transition before accepting/reassigning; no clock or
    // external provider is involved.
    const expiryScene = { latitude: 12.9816, longitude: 77.6046 };
    const expiryAmbulance = await createDriverBoundAmbulance('STAGE4102-AMB-EXP', expiryDriver.id, expiryScene.latitude, expiryScene.longitude);
    const expiryEmergency = await createEmergency(expiryScene.latitude, expiryScene.longitude);
    const expiryOfferResponse = await server.fastify.inject({ method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken), payload: { emergencyId: expiryEmergency.id, ...expiryScene } });
    expect(expiryOfferResponse.statusCode).toBe(200);
    const expiryOffer = expiryOfferResponse.json() as { assignmentId: string };
    const offerEvents = await server.module11.events.list({ emergencyId: expiryEmergency.id, limit: 50 });
    expect(offerEvents.items.find((event) => event.type === 'AMBULANCE_ASSIGNMENT_OFFERED')?.payload).toMatchObject({ isSimulation: true, expiresAt: expect.any(String) });
    const exactExpiry = new Date();
    await db.ambulanceAssignment.update({ where: { id: expiryOffer.assignmentId }, data: { expiresAt: exactExpiry } });
    expect(await server.module11.ambulances.expireDueOffers({ assignmentId: expiryOffer.assignmentId }, exactExpiry)).toBe(1);
    const expiredAccept = await server.fastify.inject({ method: 'POST', url: `/api/drivers/me/assignment/${expiryOffer.assignmentId}/accept`, headers: auth(expiryDriverToken), payload: {} });
    expect(expiredAccept.statusCode).toBe(409);
    expect(await db.ambulanceAssignment.findUnique({ where: { id: expiryOffer.assignmentId } })).toMatchObject({ status: 'EXPIRED' });
    expect(await db.ambulance.findUnique({ where: { id: expiryAmbulance.id } })).toMatchObject({ status: 'AVAILABLE', currentEmergencyId: null });
    expect(await db.emergency.findUnique({ where: { id: expiryEmergency.id } })).toMatchObject({ assignedAmbulanceId: null });
    expect(await db.systemEvent.count({ where: { emergencyId: expiryEmergency.id, type: 'AMBULANCE_ASSIGNMENT_EXPIRED' } })).toBe(1);
    expect(await server.module11.ambulances.expireDueOffers({ assignmentId: expiryOffer.assignmentId }, exactExpiry)).toBe(0);
    expect(await db.systemEvent.count({ where: { emergencyId: expiryEmergency.id, type: 'AMBULANCE_DISPATCHED' } })).toBe(0);
    const expiryReplacement = await createDriverBoundAmbulance('STAGE4102-AMB-EXP-REPLACEMENT', replacementDriver.id, expiryScene.latitude, expiryScene.longitude);
    const expiryReassignment = await server.fastify.inject({ method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken), payload: { emergencyId: expiryEmergency.id, ...expiryScene } });
    expect(expiryReassignment.statusCode).toBe(200);
    expect(expiryReassignment.json()).toMatchObject({ ambulanceId: expiryReplacement.id, expiresAt: expect.any(String) });
    const duplicateReassignment = await server.fastify.inject({ method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken), payload: { emergencyId: expiryEmergency.id, ...expiryScene } });
    expect(duplicateReassignment.statusCode).toBe(200);
    expect(duplicateReassignment.json().assignmentId).toBe(expiryReassignment.json().assignmentId);

    const location = { latitude: 12.9721, longitude: 77.5951, speedKmh: 24, headingDeg: 91, accuracyM: 8, source: 'SPOOFED', isSimulation: false };
    expect((await server.fastify.inject({ method: 'POST', url: `/api/ambulances/${ambulance.id}/location`, headers: auth(otherDriverToken), payload: location })).statusCode).toBe(403);
    const gps = await server.fastify.inject({ method: 'POST', url: `/api/ambulances/${ambulance.id}/location`, headers: auth(driverToken), payload: location });
    expect(gps.statusCode).toBe(200);
    expect(gps.json().location).toMatchObject({ latitude: location.latitude, longitude: location.longitude, source: 'MOBILE', isSimulation: true });

    const routeUrl = `/api/emergencies/${emergency.id}/routes`;
    const beforeDispatchCalls = providerCalls.primary + providerCalls.fallback;
    const prematureRoute = await server.fastify.inject({ method: 'POST', url: routeUrl, headers: auth(dispatcherToken), payload: { leg: 'RESPONSE' } });
    expect(prematureRoute.statusCode).toBe(409);
    expect(providerCalls.primary + providerCalls.fallback).toBe(beforeDispatchCalls);
    expect((await server.fastify.inject({ method: 'POST', url: `/api/ambulances/${ambulance.id}/dispatch`, headers: auth(operatorToken), payload: { emergencyId: emergency.id } })).statusCode).toBe(403);
    expect((await server.fastify.inject({ method: 'POST', url: `/api/ambulances/${ambulance.id}/dispatch`, headers: auth(dispatcherToken), payload: { emergencyId: emergency.id } })).statusCode).toBe(200);

    const externalFetch = vi.spyOn(globalThis, 'fetch');
    try {
      const failedRoute = await server.fastify.inject({ method: 'POST', url: routeUrl, headers: auth(dispatcherToken), payload: { leg: 'RESPONSE' } });
      expect(failedRoute.statusCode).toBe(502);
      expect(failedRoute.json().error.code).toBe('ROUTING_FAILED');
      expect(providerCalls.primary).toBeGreaterThan(0);
      expect(providerCalls.fallback).toBeGreaterThan(0);

      providerMode = 'READY';
      const generated = await server.fastify.inject({ method: 'POST', url: routeUrl, headers: auth(dispatcherToken), payload: { leg: 'RESPONSE' } });
      expect(generated.statusCode).toBe(200);
      expect(generated.json().route).toMatchObject({ ambulanceId: ambulance.id, provider: 'stage-4.10.2-deterministic', isLiveTraffic: false, isSimulation: true });
      const routeId = generated.json().route.id as string;

      const eventTimeline = await server.fastify.inject({ method: 'GET', url: `/api/events?emergencyId=${encodeURIComponent(emergency.id)}`, headers: auth(dispatcherToken) });
      expect(eventTimeline.statusCode).toBe(200);
      expect(eventTimeline.json().items.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining([
        'AMBULANCE_ASSIGNED', 'AMBULANCE_ASSIGNMENT_ACCEPTED', 'AMBULANCE_DISPATCHED', 'ROUTE_FAILED', 'ROUTE_GENERATED',
      ]));

      const noticesUrl = `/api/emergencies/${emergency.id}/police-notifications`;
      const noticeResponse = await server.fastify.inject({ method: 'POST', url: noticesUrl, headers: auth(dispatcherToken), payload: { routeId } });
      expect(noticeResponse.statusCode).toBe(201);
      expect(noticeResponse.json()).toMatchObject({ simulation: true, recipient: 'MOCK_POLICE_CONTROL_ROOM', realPoliceContacted: false, trafficCleared: false, signalPriorityGranted: false, notification: { delivered: false, status: 'SIMULATED_SENT' } });
      const notice = noticeResponse.json().notification as { id: string; body: string };
      const duplicate = await server.fastify.inject({ method: 'POST', url: noticesUrl, headers: auth(dispatcherToken), payload: { routeId } });
      expect(duplicate.statusCode).toBe(201);
      expect(duplicate.json().notification.id).toBe(notice.id);

      const replacementRoute = await server.module11.routes.createRoute({
        emergencyId: emergency.id,
        ambulanceId: ambulance.id,
        originName: 'AMBULANCE',
        destinationName: 'SCENE',
        origin: { latitude: location.latitude, longitude: location.longitude },
        destination: scene,
        distanceKm: 0.2,
        polyline: [[location.latitude, location.longitude], [scene.latitude, scene.longitude]],
        estimatedMinutes: 1,
        isSimulation: true,
        provider: 'stage-4.10.2-deterministic',
        isLiveTraffic: false,
      });
      const replacementNotice = await server.fastify.inject({ method: 'POST', url: noticesUrl, headers: auth(dispatcherToken), payload: { routeId: replacementRoute.id } });
      expect(replacementNotice.statusCode).toBe(201);
      expect(replacementNotice.json().notification.id).not.toBe(notice.id);
      const ackUrl = `${noticesUrl}/${replacementNotice.json().notification.id}/acknowledge`;
      const acknowledged = await server.fastify.inject({ method: 'POST', url: ackUrl, headers: auth(dispatcherToken), payload: {} });
      expect(acknowledged.statusCode).toBe(200);
      expect(acknowledged.json()).toMatchObject({ simulation: true, realPoliceAcknowledged: false, notification: { status: 'ACKNOWLEDGED_SIMULATED' } });

      const storedNotices = await server.fastify.inject({ method: 'GET', url: noticesUrl, headers: auth(dispatcherToken) });
      expect(storedNotices.statusCode).toBe(200);
      expect(storedNotices.json().notifications).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: notice.id, status: 'SUPERSEDED', delivered: false }),
        expect.objectContaining({ id: replacementNotice.json().notification.id, status: 'ACKNOWLEDGED_SIMULATED', delivered: false }),
      ]));

      const driverRoutes = await server.fastify.inject({ method: 'GET', url: '/api/drivers/me/routes', headers: auth(driverToken) });
      expect(driverRoutes.statusCode).toBe(200);
      expect(driverRoutes.json().routes).toEqual(expect.arrayContaining([expect.objectContaining({ id: routeId, isLiveTraffic: false })]));
      expect((await server.fastify.inject({ method: 'GET', url: `/api/emergencies/${emergency.id}/routes`, headers: auth(dispatcherToken) })).json().routes)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: routeId, provider: 'stage-4.10.2-deterministic', isLiveTraffic: false })]));

      const dashboard = await server.fastify.inject({ method: 'GET', url: '/api/dashboard/live?includeSimulation=true', headers: auth(dispatcherToken) });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json().emergencies).toEqual(expect.arrayContaining([expect.objectContaining({ id: emergency.id, assignedAmbulanceId: ambulance.id, isSimulation: true })]));
      const liveAmbulance = dashboard.json().ambulances.find((item: { id: string }) => item.id === ambulance.id);
      expect(liveAmbulance).toMatchObject({ status: 'EN_ROUTE', latitude: location.latitude, longitude: location.longitude, isSimulation: true });
      expect(Date.parse(liveAmbulance.lastLocationUpdate)).toBeGreaterThan(Date.now() - 60_000);

      const driverFleet = await server.fastify.inject({ method: 'GET', url: '/api/dashboard/ambulances?includeSimulation=true', headers: auth(dispatcherToken) });
      expect(driverFleet.statusCode).toBe(200);
      expect(driverFleet.json().ambulances).toEqual(expect.arrayContaining([expect.objectContaining({ id: ambulance.id, latitude: location.latitude, longitude: location.longitude })]));
      expect(externalFetch).not.toHaveBeenCalled();

      // Exercise the previously unproduced terminal operational milestones via
      // the real authenticated Fastify composition and isolated SQLite event log.
      const milestoneScene = { latitude: 12.82, longitude: 77.31 };
      const milestoneEmergency = await createEmergency(milestoneScene.latitude, milestoneScene.longitude, true, 'CARDIAC_ARREST', 'CRITICAL');
      const transcriptResponse = await server.fastify.inject({
        method: 'POST',
        url: `/speech/transcribe?callSessionId=${encodeURIComponent(milestoneEmergency.callSessionId)}&emergencyId=${encodeURIComponent(milestoneEmergency.id)}`,
        headers: { ...auth(operatorToken), 'content-type': 'application/octet-stream' },
        payload: Buffer.from(audioCarrier('Caller reports a vehicle collision.')),
      });
      expect(transcriptResponse.statusCode).toBe(200);
      expect(transcriptResponse.json().persisted).toMatchObject({ isFinal: true });
      const nlpDisabled = await server.fastify.inject({ method: 'POST', url: `/api/emergencies/${milestoneEmergency.id}/classify`, headers: auth(dispatcherToken), payload: {} });
      expect(nlpDisabled.statusCode).toBe(503);
      const classification = await server.fastify.inject({
        method: 'PATCH', url: `/api/emergencies/${milestoneEmergency.id}`, headers: auth(dispatcherToken),
        payload: { normalizedClassification: { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL' } },
      });
      expect(classification.statusCode).toBe(200);
      expect(classification.json()).toMatchObject({ incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL' });
      const protocol = await server.fastify.inject({
        method: 'POST', url: '/api/protocol-sessions', payload: { emergencyId: milestoneEmergency.id, incidentType: 'CARDIAC_ARREST' },
      });
      expect(protocol.statusCode).toBe(201);
      const protocolSessionId = protocol.json().session.id as string;
      const protocolTurn = await server.fastify.inject({
        method: 'POST', url: `/api/protocol-sessions/${protocolSessionId}/utterance`,
        payload: { utterance: 'We are at Synthetic Test Site Seven.' },
      });
      expect(protocolTurn.statusCode).toBe(200);
      expect(protocolTurn.json()).toMatchObject({
        session: {
          emergencyId: milestoneEmergency.id,
          currentStep: 'confirm-arrest',
          collectedFacts: { caller_location: 'Synthetic Test Site Seven' },
        },
        instruction: expect.any(String),
        speech: expect.any(String),
      });
      const locationCandidates = await server.fastify.inject({ method: 'GET', url: `/api/emergencies/${milestoneEmergency.id}/location-resolutions`, headers: auth(dispatcherToken) });
      expect(locationCandidates.statusCode).toBe(200);
      const candidateEvent = locationCandidates.json().items.find((item: { type: string }) => item.type === 'EMERGENCY_LOCATION_CANDIDATE');
      expect(candidateEvent).toMatchObject({
        id: expect.stringMatching(/^LOC-/),
        emergencyId: milestoneEmergency.id,
        payload: { source: 'CALLER_STATED', outcome: 'AMBIGUOUS', provider: 'test-only-deterministic-location-mock', confidence: 0.42, candidateLatitude: 0.0001, candidateLongitude: 0.0002, isSimulation: true },
      });
      expect((await db.emergency.findUnique({ where: { id: milestoneEmergency.id } }))?.latitude).toBe(milestoneScene.latitude);
      const confirmationCoordinates = { latitude: milestoneScene.latitude + 0.001, longitude: milestoneScene.longitude + 0.001 };
      const confirmedLocation = await server.fastify.inject({
        method: 'POST', url: `/api/emergencies/${milestoneEmergency.id}/location-resolutions/${candidateEvent.id}/confirm`,
        headers: auth(operatorToken), payload: confirmationCoordinates,
      });
      expect(confirmedLocation.statusCode).toBe(200);
      expect(confirmedLocation.json()).toMatchObject({
        duplicate: false,
        emergency: { id: milestoneEmergency.id, latitude: confirmationCoordinates.latitude, longitude: confirmationCoordinates.longitude, isSimulation: true },
        event: { type: 'EMERGENCY_LOCATION_CONFIRMED', actorId: operator.id, payload: { source: 'OPERATOR_SUPPLIED', confirmedLatitude: confirmationCoordinates.latitude, confirmedLongitude: confirmationCoordinates.longitude, isSimulation: true } },
      });
      expect((await server.fastify.inject({
        method: 'POST', url: `/api/emergencies/${milestoneEmergency.id}/location-resolutions/${candidateEvent.id}/confirm`,
        headers: auth(operatorToken), payload: confirmationCoordinates,
      })).json().duplicate).toBe(true);

      const noLocationEmergency = await createEmergency(12.8, 77.3);
      const noLocationSession = await server.fastify.inject({ method: 'POST', url: '/api/protocol-sessions', payload: { emergencyId: noLocationEmergency.id, incidentType: 'CARDIAC_ARREST' } });
      const noLocationTurn = await server.fastify.inject({ method: 'POST', url: `/api/protocol-sessions/${noLocationSession.json().session.id}/utterance`, payload: { utterance: 'I do not know the location yet.' } });
      expect(noLocationTurn.statusCode).toBe(200);
      expect((await server.fastify.inject({ method: 'GET', url: `/api/emergencies/${noLocationEmergency.id}/location-resolutions`, headers: auth(dispatcherToken) })).json().items).toEqual([]);

      const noMatchEmergency = await createEmergency(12.8, 77.3);
      const noMatchSession = await server.fastify.inject({ method: 'POST', url: '/api/protocol-sessions', payload: { emergencyId: noMatchEmergency.id, incidentType: 'CARDIAC_ARREST' } });
      const noMatchTurn = await server.fastify.inject({ method: 'POST', url: `/api/protocol-sessions/${noMatchSession.json().session.id}/utterance`, payload: { utterance: 'We are at Synthetic No Match.' } });
      expect(noMatchTurn.statusCode).toBe(200);
      const noMatchCandidates = await server.fastify.inject({ method: 'GET', url: `/api/emergencies/${noMatchEmergency.id}/location-resolutions`, headers: auth(dispatcherToken) });
      const noMatchCandidate = noMatchCandidates.json().items[0];
      expect(noMatchCandidate.payload).toMatchObject({ outcome: 'NOT_FOUND', candidateLatitude: null, candidateLongitude: null, isSimulation: true });
      expect((await server.fastify.inject({ method: 'POST', url: `/api/emergencies/${noMatchEmergency.id}/location-resolutions/${noMatchCandidate.id}/confirm`, headers: auth(operatorToken), payload: {} })).statusCode).toBe(422);
      const retriedLocation = await server.fastify.inject({ method: 'POST', url: `/api/emergencies/${noMatchEmergency.id}/location-resolutions/${noMatchCandidate.id}/retry`, headers: auth(operatorToken), payload: {} });
      expect(retriedLocation.statusCode).toBe(200);
      expect(retriedLocation.json().item.payload).toMatchObject({ attempt: 2, outcome: 'NOT_FOUND', candidateLatitude: null });
      expect(extractionCalls).toContain('We are at Synthetic Test Site Seven.');
      expect(synthesisParaphraseAttempts).toBeGreaterThan(0);
      const persistedProtocolTranscripts = await server.module11.calls.transcriptsFor(milestoneEmergency.id);
      expect(persistedProtocolTranscripts.map((entry) => entry.speaker)).toEqual(expect.arrayContaining(['CALLER', 'SYSTEM']));
      expect(persistedProtocolTranscripts).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: 'We are at Synthetic Test Site Seven.', isSimulation: true }),
      ]));
      // The loopback synthesis provider intentionally returns no audio. This
      // verifies the request path, never claims audible playback.
      expect((await server.fastify.inject({ method: 'GET', url: `/api/events?emergencyId=${encodeURIComponent(milestoneEmergency.id)}`, headers: auth(dispatcherToken) })).json().items)
        .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'SPEECH_SYNTHESIZED' })]));
      const protocolRead = await server.fastify.inject({ method: 'GET', url: `/api/emergencies/${milestoneEmergency.id}/protocol-sessions`, headers: auth(operatorToken) });
      expect(protocolRead.statusCode).toBe(200);
      expect(protocolRead.json().sessions).toHaveLength(1);

      const hospitalId = 'HSP-STAGE419-DEMO';
      await db.hospital.create({ data: {
        id: hospitalId, name: 'Stage 4.19 Isolated Hospital', latitude: milestoneScene.latitude + 0.02,
        longitude: milestoneScene.longitude + 0.02, status: 'OPEN', capabilitiesJson: JSON.stringify(['ED_CARDIAC']),
        traumaLevel: 2, acceptingEmergencies: true, isSimulation: true,
        resources: { create: { id: 'HRS-STAGE419-DEMO', resourceType: 'ICU_BED', code: '', total: 10, available: 10 } },
      } });
      const hospitalSelection = await server.fastify.inject({
        method: 'POST', url: `/api/emergencies/${milestoneEmergency.id}/hospital-selection`, headers: auth(dispatcherToken), payload: {},
      });
      expect(hospitalSelection.statusCode).toBe(200);
      expect(hospitalSelection.json().result.hospitalId).toBe(hospitalId);

      const milestoneAmbulance = await createDriverBoundAmbulance('STAGE419-AMB-1', milestoneDriver.id, milestoneScene.latitude, milestoneScene.longitude);
      const milestoneAssignmentResponse = await server.fastify.inject({
        method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken),
        payload: { emergencyId: milestoneEmergency.id, ...milestoneScene },
      });
      expect(milestoneAssignmentResponse.statusCode).toBe(200);
      const milestoneAssignment = milestoneAssignmentResponse.json() as { assignmentId: string; ambulanceId: string };
      expect(milestoneAssignment.ambulanceId).toBe(milestoneAmbulance.id);
      expect((await server.fastify.inject({ method: 'GET', url: '/api/drivers/me/assignment', headers: auth(milestoneDriverToken) })).statusCode).toBe(200);
      expect((await server.fastify.inject({ method: 'POST', url: `/api/drivers/me/assignment/${milestoneAssignment.assignmentId}/accept`, headers: auth(milestoneDriverToken), payload: {} })).statusCode).toBe(200);

      const milestonePath = `/api/emergencies/${milestoneEmergency.id}/lifecycle-milestones`;
      expect((await server.fastify.inject({ method: 'POST', url: `${milestonePath}/scene-arrival`, payload: {} })).statusCode).toBe(401);
      expect((await server.fastify.inject({ method: 'POST', url: `${milestonePath}/scene-arrival`, headers: auth(dispatcherToken), payload: {} })).statusCode).toBe(409);
      expect((await server.fastify.inject({ method: 'POST', url: `${milestonePath}/scene-arrival`, headers: auth(otherDriverToken), payload: {} })).statusCode).toBe(403);
      expect((await server.fastify.inject({ method: 'POST', url: `/api/ambulances/${milestoneAmbulance.id}/dispatch`, headers: auth(dispatcherToken), payload: { emergencyId: milestoneEmergency.id } })).statusCode).toBe(200);
      const sceneArrival = await server.fastify.inject({ method: 'POST', url: `${milestonePath}/scene-arrival`, headers: auth(dispatcherToken), payload: {} });
      expect(sceneArrival.statusCode).toBe(201);
      expect(sceneArrival.json()).toMatchObject({ evidenceSource: 'OPERATOR_REPORTED', operationalOnly: true, event: { actorType: 'DISPATCHER' } });
      const duplicateSceneArrival = await server.fastify.inject({ method: 'POST', url: `${milestonePath}/scene-arrival`, headers: auth(dispatcherToken), payload: {} });
      expect(duplicateSceneArrival.statusCode).toBe(200);
      expect(duplicateSceneArrival.json().event.id).toBe(sceneArrival.json().event.id);
      const duplicateOnboardAttempts = await Promise.all([
        server.fastify.inject({ method: 'POST', url: `${milestonePath}/patient-onboard`, headers: auth(dispatcherToken), payload: {} }),
        server.fastify.inject({ method: 'POST', url: `${milestonePath}/patient-onboard`, headers: auth(dispatcherToken), payload: {} }),
      ]);
      expect(duplicateOnboardAttempts.map((response) => response.statusCode).sort()).toEqual([200, 201]);
      expect(duplicateOnboardAttempts[0]?.json().event.id).toBe(duplicateOnboardAttempts[1]?.json().event.id);
      expect((await server.fastify.inject({ method: 'POST', url: `${milestonePath}/hospital-arrival`, headers: auth(dispatcherToken), payload: {} })).statusCode).toBe(201);
      const beforeCompletion = await server.module11.emergencies.requireById(milestoneEmergency.id);
      const completion = await server.fastify.inject({ method: 'POST', url: `${milestonePath}/operational-completion`, headers: auth(dispatcherToken), payload: {} });
      expect(completion.statusCode).toBe(201);
      expect(completion.json()).toMatchObject({ operationalOnly: true, event: { type: 'EMERGENCY_COMPLETED' } });
      expect((await server.module11.emergencies.requireById(milestoneEmergency.id)).status).toBe(beforeCompletion.status);
      const projectionResponse = await server.fastify.inject({ method: 'GET', url: `/api/emergencies/${milestoneEmergency.id}/lifecycle`, headers: auth(dispatcherToken) });
      expect(projectionResponse.statusCode).toBe(200);
      expect(projectionResponse.json().projection.facts).toMatchObject({
        finalTranscript: { speaker: 'SYSTEM' },
        classification: { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL', source: 'OPERATOR' },
        sceneArrival: { ambulanceId: milestoneAmbulance.id, evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'SIMULATION' },
        patientOnboard: { ambulanceId: milestoneAmbulance.id, evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'SIMULATION' },
        hospitalArrival: { hospitalId, evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'SIMULATION' },
        operationalCompletion: { status: 'COMPLETED', isSimulation: true, evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'SIMULATION' },
      });
      expect(projectionResponse.json().projection.facts.operationalCompletion).not.toHaveProperty('survivalToDischarge');

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
        const dashboardLive = await server.fastify.inject({
          method: 'GET', url: '/api/dashboard/live?includeSimulation=true', headers: auth(dispatcherToken),
        });
        expect(dashboardLive.statusCode).toBe(200);
        expect(dashboardLive.json().emergencies.some((item: { id: string }) => item.id === milestoneEmergency.id)).toBe(true);
        const dashboardLifecycle = await getLifecycle(dispatcherToken, milestoneEmergency.id);
        expect(dashboardLifecycle.facts.operationalCompletion?.evidenceSource).toBe('OPERATOR_REPORTED');
      } finally {
        vi.stubGlobal('fetch', originalFetch);
      }

      // Outcome governance runs inside the same acceptance workflow: append-only
      // submission, an independent review that must refuse learning eligibility
      // for TEST-classified data, and a correction that supersedes rather than
      // rewrites. Learning stays off, so no sample may be written.
      const outcomeSubmitter = await server.module11.users.create({
        email: 'outcome-submitter@stage419.test', displayName: 'Isolated Outcome Submitter',
        passwordHash: await bcrypt.hash(operatorPassword, 4), role: 'OUTCOME_SUBMITTER',
      });
      const outcomeReviewer = await server.module11.users.create({
        email: 'outcome-reviewer@stage419.test', displayName: 'Isolated Outcome Reviewer',
        passwordHash: await bcrypt.hash(operatorPassword, 4), role: 'OUTCOME_REVIEWER',
      });
      const submitterToken = await login(outcomeSubmitter.email, operatorPassword);
      const reviewerToken = await login(outcomeReviewer.email, operatorPassword);
      await db!.emergencyOutcomeGrant.create({ data: {
        id: 'OGT-SCOPE419-SUBMITTER',
        emergencyId: milestoneEmergency.id,
        granteeUserId: outcomeSubmitter.id,
        capability: 'SUBMIT',
        grantedByUserId: dispatcher.id,
      } });
      await db!.emergencyOutcomeGrant.create({ data: {
        id: 'OGT-SCOPE419-REVIEWER',
        emergencyId: milestoneEmergency.id,
        granteeUserId: outcomeReviewer.id,
        capability: 'REVIEW',
        grantedByUserId: dispatcher.id,
      } });
      const outcomeUrl = `/api/emergencies/${milestoneEmergency.id}/outcomes`;
      expect((await server.fastify.inject({ method: 'POST', url: outcomeUrl, headers: { ...auth(dispatcherToken), 'idempotency-key': 'stage-4.19-forbidden-0001' }, payload: { category: 'UNKNOWN', categoryVersion: 'OUTCOME_V1' } })).statusCode).toBe(403);
      const submitted = await server.fastify.inject({
        method: 'POST', url: outcomeUrl,
        headers: { ...auth(submitterToken), 'idempotency-key': 'stage-4.19-outcome-00000001' },
        payload: { category: 'SURVIVED_TO_DISCHARGE', categoryVersion: 'OUTCOME_V1', survivalToDischarge: true, observedAt: new Date().toISOString(), evidenceRefs: ['opaque:stage-4.19'] },
      });
      expect(submitted.statusCode).toBe(201);
      expect(submitted.json()).toMatchObject({ dataClassification: 'SIMULATION', provenance: 'SIMULATION', reviewStatus: 'PENDING' });
      const reviewUrl = `${outcomeUrl}/${(submitted.json() as { id: string }).id}/reviews`;
      expect((await server.fastify.inject({
        method: 'POST', url: reviewUrl,
        headers: { ...auth(reviewerToken), 'idempotency-key': 'stage-4.19-eligib-0001' },
        payload: { decision: 'APPROVED', eligibilityDecision: 'ELIGIBLE', eligibilityReasonCode: 'VERIFIED_EVIDENCE' },
      })).statusCode).toBe(422);
      const review = await server.fastify.inject({
        method: 'POST', url: reviewUrl,
        headers: { ...auth(reviewerToken), 'idempotency-key': 'stage-4.19-review-000001' },
        payload: { decision: 'APPROVED', eligibilityDecision: 'INELIGIBLE', eligibilityReasonCode: 'TEST_DATA' },
      });
      expect(review.statusCode).toBe(201);
      expect(review.json()).toMatchObject({
        reviewStatus: 'APPROVED',
        review: { eligibleForLearning: false, eligibilityReasonCode: 'TEST_DATA' },
      });
      const correction = await server.fastify.inject({
        method: 'POST', url: `${outcomeUrl}/${(submitted.json() as { id: string }).id}/supersessions`,
        headers: { ...auth(submitterToken), 'idempotency-key': 'stage-4.19-correct-0001' },
        payload: { category: 'TRANSPORTED', categoryVersion: 'OUTCOME_V1', survivalToDischarge: null, correctionReasonCode: 'DATA_ENTRY_ERROR' },
      });
      expect(correction.statusCode).toBe(201);
      expect(correction.json()).toMatchObject({ supersedesOutcomeId: (submitted.json() as { id: string }).id, reviewStatus: 'PENDING' });
      expect(await db!.learningSample.count({ where: { emergencyId: milestoneEmergency.id } })).toBe(0);

      // Milestones and outcome records are attestations only: they may not
      // dispatch, route, notify or otherwise act on the emergency.
      const milestoneEvents = await server.module11.events.list({ emergencyId: milestoneEmergency.id, limit: 500 });
      const milestoneTypes = milestoneEvents.items.map((event) => event.type);
      expect(milestoneTypes.filter((type) => type === 'AMBULANCE_DISPATCHED')).toHaveLength(1);
      expect(milestoneTypes).not.toEqual(expect.arrayContaining(['ROUTE_GENERATED', 'CORRIDOR_ACTIVATED', 'NOTIFICATION_SENT']));
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      externalFetch.mockRestore();
    }

    // Decline is exercised with another isolated emergency and vehicle. The
    // database check confirms release without automatic reassignment/dispatch.
    const secondScene = { latitude: 12.82, longitude: 77.31 };
    const secondAmbulance = await createDriverBoundAmbulance('STAGE4102-AMB-2', otherDriver.id, secondScene.latitude, secondScene.longitude);
    const declineReplacement = await createDriverBoundAmbulance('STAGE4102-AMB-2-REPLACEMENT', replacementDriver.id, secondScene.latitude, secondScene.longitude);
    const declinedEmergency = await createEmergency(secondScene.latitude, secondScene.longitude);
    const secondAssignmentResponse = await server.fastify.inject({
      method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken),
      payload: { emergencyId: declinedEmergency.id, ...secondScene },
    });
    expect(secondAssignmentResponse.statusCode).toBe(200);
    const secondAssignment = secondAssignmentResponse.json() as { ambulanceId: string; assignmentId: string };
    expect(secondAssignment.ambulanceId).toBe(secondAmbulance.id);
    const declined = await server.fastify.inject({
      method: 'POST', url: `/api/drivers/me/assignment/${secondAssignment.assignmentId}/decline`,
      headers: auth(otherDriverToken), payload: { reason: 'isolated test decline' },
    });
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toMatchObject({ reassignmentRequired: true, assignment: { status: 'DECLINED' } });
    expect((await server.fastify.inject({ method: 'GET', url: '/api/drivers/me/assignment', headers: auth(otherDriverToken) })).json())
      .toMatchObject({ assigned: false, assignment: null });
    const declinedEmergencyRead = await server.fastify.inject({ method: 'GET', url: `/api/emergencies/${declinedEmergency.id}`, headers: auth(dispatcherToken) });
    expect(declinedEmergencyRead.json().assignedAmbulanceId).toBeNull();
    const reassigned = await server.fastify.inject({
      method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken),
      payload: { emergencyId: declinedEmergency.id, ...secondScene },
    });
    expect(reassigned.statusCode).toBe(200);
    expect(reassigned.json()).toMatchObject({ ambulanceId: declineReplacement.id });
    expect((await server.fastify.inject({ method: 'GET', url: `/api/emergencies/${declinedEmergency.id}`, headers: auth(dispatcherToken) })).json().assignedAmbulanceId)
      .toBe(declineReplacement.id);
    const declinedEvents = await server.fastify.inject({ method: 'GET', url: `/api/events?emergencyId=${encodeURIComponent(declinedEmergency.id)}`, headers: auth(dispatcherToken) });
    expect(declinedEvents.json().items.map((event: { type: string }) => event.type)).toContain('AMBULANCE_ASSIGNMENT_DECLINED');
    expect(declinedEvents.json().items.map((event: { type: string }) => event.type)).not.toContain('AMBULANCE_DISPATCHED');

    // A non-simulation flag on synthetic test input remains non-simulation in
    // persisted offer provenance; this is not a real-call test.
    const nonSimulationTestScene = { latitude: 12.71, longitude: 77.22 };
    await createDriverBoundAmbulance('STAGE4102-AMB-PROVENANCE', provenanceDriver.id, nonSimulationTestScene.latitude, nonSimulationTestScene.longitude);
    const nonSimulationTestEmergency = await createEmergency(nonSimulationTestScene.latitude, nonSimulationTestScene.longitude, false);
    const nonSimulationOfferResponse = await server.fastify.inject({
      method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken),
      payload: { emergencyId: nonSimulationTestEmergency.id, ...nonSimulationTestScene },
    });
    expect(nonSimulationOfferResponse.statusCode).toBe(200);
    const nonSimulationOfferEvents = await server.module11.events.list({ emergencyId: nonSimulationTestEmergency.id, limit: 50 });
    expect(nonSimulationOfferEvents.items.find((event) => event.type === 'AMBULANCE_ASSIGNMENT_OFFERED')?.payload).toMatchObject({ isSimulation: false });

    // A failed audit write rolls back the acceptance state transition in the
    // real isolated SQLite transaction, including its assignment reservation.
    const failureScene = { latitude: 12.61, longitude: 77.12 };
    const failureDriver = await server.module11.users.create({ email: 'failure-driver@stage4102.test', displayName: 'Failure Isolated Driver', passwordHash: await bcrypt.hash(driverPassword, 4), role: 'DRIVER' });
    await createDriverBoundAmbulance('STAGE4102-AMB-FAILURE', failureDriver.id, failureScene.latitude, failureScene.longitude);
    const failureEmergency = await createEmergency(failureScene.latitude, failureScene.longitude);
    const failureOfferResponse = await server.fastify.inject({ method: 'POST', url: '/api/ambulances/assign', headers: auth(dispatcherToken), payload: { emergencyId: failureEmergency.id, ...failureScene } });
    expect(failureOfferResponse.statusCode).toBe(200);
    const failureOffer = failureOfferResponse.json() as { assignmentId: string; ambulanceId: string };
    const auditWrite = vi.spyOn(server.module11.events, 'recordInTransaction').mockRejectedValueOnce(new Error('synthetic isolated event persistence failure'));
    try {
      const failureDriverToken = await login(failureDriver.email, driverPassword);
      const failedAcceptance = await server.fastify.inject({ method: 'POST', url: `/api/drivers/me/assignment/${failureOffer.assignmentId}/accept`, headers: auth(failureDriverToken), payload: {} });
      expect(failedAcceptance.statusCode).toBe(500);
      expect(await db.ambulanceAssignment.findUnique({ where: { id: failureOffer.assignmentId } })).toMatchObject({ status: 'OFFERED' });
      expect(await db.ambulance.findUnique({ where: { id: failureOffer.ambulanceId } })).toMatchObject({ status: 'ASSIGNED', currentEmergencyId: failureEmergency.id });
      expect(await db.systemEvent.count({ where: { emergencyId: failureEmergency.id, type: 'AMBULANCE_ASSIGNMENT_ACCEPTED' } })).toBe(0);
      expect(await db.systemEvent.count({ where: { emergencyId: failureEmergency.id, type: 'AMBULANCE_DISPATCHED' } })).toBe(0);
    } finally {
      auditWrite.mockRestore();
    }
  });
});
