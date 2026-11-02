import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  createId,
  defineEvent,
  noopLogger,
  type EventPayloadMap,
  type SystemEventRecord,
} from '@resus/core';
import { createModule11, type Module11 } from '@resus/data';
import { Module8 } from '../src/module.js';
import { loadModule8Config } from '../src/config.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../../../tests/helpers/isolatedTestDatabase.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
async function timelineOfType(
  module11: Module11,
  emergencyId: string,
  type: SystemEventRecord['type'],
): Promise<SystemEventRecord[]> {
  const timeline = await module11.eventQuery.timeline(emergencyId);
  return timeline.filter((event) => event.type === type);
}

function assignmentPayload(
  emergencyId: string,
  ambulanceId: string,
): EventPayloadMap['AMBULANCE_ASSIGNED'] {
  return {
    emergencyId,
    ambulanceId,
    assignmentId: createId('ASG'),
    distanceKm: 2.4,
    estimatedResponseTimeMin: 6,
    matchingFactors: ['available', 'distance'],
    score: 84,
    source: 'AUTOMATIC',
    consideredCandidates: 1,
  };
}

function hospitalSelectionPayload(
  emergencyId: string,
  hospitalId: string,
): EventPayloadMap['HOSPITAL_SELECTED'] {
  return { emergencyId, hospitalId, distanceKm: 0, reason: 'hospital selected' };
}

describe('Module 8 route generation integration', () => {
  let db: PrismaClient;
  let module11: Module11;
  let module8: Module8;
  let testDatabase: IsolatedTestDatabase;

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const dbUrl = testDatabase.databaseUrl;
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    module11 = createModule11({ db, ownsClient: false, logger: noopLogger });

    const config = loadModule8Config();
    // This integration suite intentionally verifies the event-driven route
    // subscriber. Keep the opt-in local to this isolated test; the harness
    // leaves application defaults disabled.
    config.generation = { ...config.generation, enabled: true, includeSimulation: false };
    module8 = new Module8({
      routes: module11.routes,
      emergencies: module11.emergencies,
      ambulances: module11.ambulances,
      hospitals: module11.hospitals,
      events: module11.eventPublisher,
      bus: module11.bus,
      config,
      logger: noopLogger,
    });
  }, 120000);

  afterAll(async () => {
    module8?.dispose();
    await db?.$disconnect();
    testDatabase?.cleanup();
  });

  async function seedAssignedEmergency(): Promise<{ emergencyId: string; ambulanceId: string }> {
    const ambulance = await module11.ambulances.create({
      vehicleNumber: `KA-01-${Math.floor(Math.random() * 1_000_000)}`,
      status: 'AVAILABLE',
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

  async function assignAndSelect(emergencyId: string, ambulanceId: string, hospitalId?: string) {
    await module11.eventPublisher.record(
      defineEvent('AMBULANCE_ASSIGNED', {
        emergencyId,
        entityType: 'emergency',
        entityId: emergencyId,
        payload: assignmentPayload(emergencyId, ambulanceId),
      }),
    );
    // Route planning observes dispatch, not assignment. Keep the fixture aligned
    // with the explicit Module 6 assignment/dispatch boundary.
    await module11.eventPublisher.record(
      defineEvent('AMBULANCE_DISPATCHED', {
        emergencyId,
        entityType: 'emergency',
        entityId: emergencyId,
        payload: { emergencyId, ambulanceId },
      }),
    );
    await module8.autoRoute!.idle();
    if (hospitalId) {
      await module11.emergencies.update(emergencyId, { selectedHospitalId: hospitalId });
      await module11.eventPublisher.record(
        defineEvent('HOSPITAL_SELECTED', {
          emergencyId,
          entityType: 'emergency',
          entityId: emergencyId,
          payload: hospitalSelectionPayload(emergencyId, hospitalId),
        }),
      );
      await module8.autoRoute!.idle();
    }
  }

  it('persists every route field through Module 11 and emits ROUTE_GENERATED', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    await assignAndSelect(emergencyId, ambulanceId);

    const stored = await module11.routes.routesForEmergency(emergencyId);
    expect(stored).toHaveLength(1);
    const route = stored[0]!;

    expect(route).toMatchObject({
      emergencyId,
      ambulanceId,
      hospitalId: null,
      originName: 'AMBULANCE',
      destinationName: 'SCENE',
      provider: 'mock',
      isLiveTraffic: false,
      isSimulation: false,
      status: 'PLANNED',
    });
    expect(route.polyline).toEqual([
      [12.95, 77.58],
      [12.9716, 77.5946],
    ]);
    expect(route.distanceKm).toBeGreaterThan(0);
    expect(route.estimatedMinutes).toBeGreaterThan(0);
    expect(route.originLat).toBeCloseTo(12.95, 6);
    expect(route.originLng).toBeCloseTo(77.58, 6);
    expect(route.destLat).toBeCloseTo(12.9716, 6);
    expect(route.destLng).toBeCloseTo(77.5946, 6);
    expect(route.trafficFactor).toBe(1);
    expect(route.recalculationCount).toBe(0);

    const generated = await timelineOfType(module11, emergencyId, 'ROUTE_GENERATED');
    expect(generated).toHaveLength(1);
    expect(generated[0]!.payload).toMatchObject({
      routeId: route.id,
      emergencyId,
      ambulanceId,
      provider: 'mock',
      isLiveTraffic: false,
    });
    expect(await timelineOfType(module11, emergencyId, 'ROUTE_FAILED')).toHaveLength(0);
  });

  it('does not create a second route when the trigger event is redelivered', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    await assignAndSelect(emergencyId, ambulanceId);
    await assignAndSelect(emergencyId, ambulanceId);

    expect(await module11.routes.routesForEmergency(emergencyId)).toHaveLength(1);
    expect(await timelineOfType(module11, emergencyId, 'ROUTE_GENERATED')).toHaveLength(1);
  });

  it('plans the transport leg once a hospital is selected, with the hospital recorded', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    const hospitalId = createId('HSP');
    await db.hospital.create({
      data: {
        id: hospitalId,
        name: 'Integration Hospital',
        latitude: 12.99,
        longitude: 77.6,
        status: 'OPEN',
        capabilitiesJson: JSON.stringify(['ED_CARDIAC']),
        traumaLevel: 2,
        acceptingEmergencies: true,
        address: 'Integration Hospital, Bengaluru',
        isSimulation: false,
      },
    });
    await assignAndSelect(emergencyId, ambulanceId, hospitalId);

    const stored = await module11.routes.routesForEmergency(emergencyId);
    expect(stored).toHaveLength(2);
    const transport = stored.find((route) => route.destinationName === 'HOSPITAL');
    expect(transport).toBeDefined();
    expect(transport).toMatchObject({
      originName: 'SCENE',
      destinationName: 'HOSPITAL',
      hospitalId,
      provider: 'mock',
      isLiveTraffic: false,
    });
    expect(transport!.polyline).toEqual([
      [12.9716, 77.5946],
      [12.99, 77.6],
    ]);
    expect(await timelineOfType(module11, emergencyId, 'ROUTE_GENERATED')).toHaveLength(2);
  });

  it('degrades to the deterministic provider when OSRM is unreachable, and says so', async () => {
    const config = loadModule8Config();
    config.provider = 'osrm';
    config.osrm = { baseUrl: 'http://127.0.0.1:9', timeoutMs: 1500 };
    const degraded = new Module8({
      routes: module11.routes,
      emergencies: module11.emergencies,
      ambulances: module11.ambulances,
      hospitals: module11.hospitals,
      events: module11.eventPublisher,
      config,
      logger: noopLogger,
    });
    try {
      const { emergencyId } = await seedAssignedEmergency();
      const result = await degraded.optimization.generateForEmergency(emergencyId, 'RESPONSE');

      expect(result.outcome).toBe('GENERATED');
      expect(result.provider).toBe('mock');
      const stored = await module11.routes.routesForEmergency(emergencyId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ provider: 'mock', isLiveTraffic: false });
      expect((stored[0]!.selectionReason as { degraded?: boolean }).degraded).toBe(true);

      const failed = await timelineOfType(module11, emergencyId, 'ROUTE_FAILED');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.payload).toMatchObject({ degradedToEstimate: true, provider: 'osrm' });
      expect(await timelineOfType(module11, emergencyId, 'ROUTE_GENERATED')).toHaveLength(1);
    } finally {
      degraded.dispose();
    }
  });

  it('uses the explicitly selected Google provider and persists its traffic provenance', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [{
          distanceMeters: 12_000,
          duration: '1500s',
          staticDuration: '1200s',
          polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
        }],
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const config = loadModule8Config({
      MODULE8_PROVIDER: 'google',
      MODULE8_GOOGLE_API_KEY: 'test-only-key',
      MODULE8_GOOGLE_TIMEOUT_MS: '1000',
      MODULE8_AUTO_ROUTE_ENABLED: 'false',
    });
    const googleModule = new Module8({
      routes: module11.routes,
      emergencies: module11.emergencies,
      ambulances: module11.ambulances,
      hospitals: module11.hospitals,
      events: module11.eventPublisher,
      config,
      logger: noopLogger,
    });
    try {
      const result = await googleModule.optimization.generateForEmergency(emergencyId, 'RESPONSE');
      expect(result).toMatchObject({ outcome: 'GENERATED', provider: 'google-routes' });
      const persisted = await module11.routes.routesForEmergency(emergencyId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        provider: 'google-routes',
        isLiveTraffic: true,
        trafficFactor: null,
        distanceKm: 12,
        estimatedMinutes: 25,
      });
      const generated = await timelineOfType(module11, emergencyId, 'ROUTE_GENERATED');
      expect(generated.at(-1)?.payload).toMatchObject({ provider: 'google-routes', isLiveTraffic: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      googleModule.dispose();
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('requests and persists a real road route from the configured OSRM provider', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => ({
        code: 'Ok',
        routes: [{
          distance: 8600,
          duration: 720,
          geometry: { coordinates: [[77.59, 12.97], [77.60, 12.975], [77.5946, 12.9716]] },
        }],
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const config = loadModule8Config({
      MODULE8_PROVIDER: 'osrm',
      MODULE8_OSRM_BASE_URL: 'https://routing.example.test',
      MODULE8_OSRM_TIMEOUT_MS: '1000',
      MODULE8_AUTO_ROUTE_ENABLED: 'false',
    });
    const osrmModule = new Module8({
      routes: module11.routes,
      emergencies: module11.emergencies,
      ambulances: module11.ambulances,
      hospitals: module11.hospitals,
      events: module11.eventPublisher,
      config,
      logger: noopLogger,
    });
    try {
      const result = await osrmModule.optimization.generateForEmergency(emergencyId, 'RESPONSE');
      expect(result).toMatchObject({ outcome: 'GENERATED', provider: 'osrm' });
      const [requestUrl] = fetchMock.mock.calls[0] ?? [];
      expect(String(requestUrl)).toContain('https://routing.example.test/route/v1/driving/');
      const persisted = await module11.routes.routesForEmergency(emergencyId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        provider: 'osrm', isLiveTraffic: false, distanceKm: 8.6,
        estimatedMinutes: 12,
        polyline: [[12.97, 77.59], [12.975, 77.6], [12.9716, 77.5946]],
      });
      expect(await timelineOfType(module11, emergencyId, 'ROUTE_GENERATED')).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ provider: 'osrm', isLiveTraffic: false }) }),
      ]);
    } finally {
      osrmModule.dispose();
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('stops planning new legs after dispose()', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    module8.dispose();

    await module11.eventPublisher.record(
      defineEvent('AMBULANCE_DISPATCHED', {
        emergencyId,
        entityType: 'emergency',
        entityId: emergencyId,
        payload: { emergencyId, ambulanceId },
      }),
    );
    await module8.autoRoute!.idle();

    expect(await module11.routes.routesForEmergency(emergencyId)).toHaveLength(0);
    expect(await timelineOfType(module11, emergencyId, 'ROUTE_GENERATED')).toHaveLength(0);
  });
});
