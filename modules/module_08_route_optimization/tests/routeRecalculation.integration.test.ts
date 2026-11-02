import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  noopLogger,
  type RoutingProvider,
  type SystemEventRecord,
} from '@resus/core';
import { createModule11, type Module11 } from '@resus/data';
import { Module8 } from '../src/module.js';
import { loadModule8Config } from '../src/config.js';
import { RoutingProviderError } from '../src/providers/routingProviderError.js';
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

describe('Module 8 route recalculation integration (ROUTE_RECALCULATED)', () => {
  let db: PrismaClient;
  let module11: Module11;
  let module8: Module8;
  let testDatabase: IsolatedTestDatabase;

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: testDatabase.databaseUrl } } });
    module11 = createModule11({ db, ownsClient: false, logger: noopLogger });

    // Recalculation is an explicit operator action: auto-dispatch stays off,
    // matching application defaults. Routes are generated directly through the
    // optimization service, which is how the explicit HTTP route reaches it.
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
    module8?.dispose();
    await db?.$disconnect();
    testDatabase?.cleanup();
  });

  async function seedAssignedEmergency(): Promise<{ emergencyId: string; ambulanceId: string }> {
    const ambulance = await module11.ambulances.create({
      vehicleNumber: `KA-01-${Math.floor(Math.random() * 1_000_000)}`,
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
    expect(generated.routeId).toBeTruthy();
    return generated.routeId as string;
  }

  it('initial generation emits no ROUTE_RECALCULATED', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    await generateResponseRoute(emergencyId);
    expect(await timelineOfType(module11, emergencyId, 'ROUTE_RECALCULATED')).toHaveLength(0);
  });

  it('recalculates the established route in place after the ambulance moves, with previous/new values and no lifecycle mutation', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);
    const before = await module11.routes.findById(routeId);
    expect(before).toMatchObject({ id: routeId, recalculationCount: 0 });
    const previousDistanceKm = before!.distanceKm;

    // The ambulance closes in on the scene; the mock provider recomputes the
    // RESPONSE leg from the new position.
    await module11.ambulances.update(ambulanceId, {
      latitude: 12.965,
      longitude: 77.59,
      lastLocationUpdate: new Date(),
    });

    const emergencyBefore = await module11.emergencies.requireById(emergencyId);
    const result = await module8.optimization.recalculateRoute(routeId, 'ambulance repositioned');
    expect(result).toMatchObject({ outcome: 'RECALCULATED', routeId, emergencyId, provider: 'mock' });

    const after = await module11.routes.findById(routeId);
    expect(after).toMatchObject({ id: routeId, recalculationCount: 1 });
    expect(after!.distanceKm).toBeLessThan(previousDistanceKm);

    const recalculated = await timelineOfType(module11, emergencyId, 'ROUTE_RECALCULATED');
    expect(recalculated).toHaveLength(1);
    expect(recalculated[0]).toMatchObject({
      emergencyId,
      entityType: 'route',
      entityId: routeId,
      actorType: 'SYSTEM',
      actorId: null,
      payload: {
        routeId,
        emergencyId,
        previousDistanceKm,
        distanceKm: after!.distanceKm,
        reason: 'ambulance repositioned',
      },
    });
    expect(await timelineOfType(module11, emergencyId, 'ROUTE_GENERATED')).toHaveLength(1);
    expect(await timelineOfType(module11, emergencyId, 'ROUTE_FAILED')).toHaveLength(0);

    // Module 8 never mutates lifecycle state; Module 10 stays read-only, so the
    // emergency must be exactly where it was before the recalculation.
    const emergencyAfter = await module11.emergencies.requireById(emergencyId);
    expect(emergencyAfter.status).toBe(emergencyBefore.status);
    expect(emergencyAfter.assignedAmbulanceId).toBe(emergencyBefore.assignedAmbulanceId);
  });

  it('records ROUTE_FAILED and leaves the route row untouched when every provider fails', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);
    const before = await module11.routes.findById(routeId);
    const emergencyBefore = await module11.emergencies.requireById(emergencyId);

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
      const result = await failing.optimization.recalculateRoute(routeId, 'provider outage');
      expect(result).toMatchObject({ outcome: 'FAILED', routeId, emergencyId });
      expect(result.reason).toContain('osrm unavailable');
    } finally {
      failing.dispose();
    }

    const after = await module11.routes.findById(routeId);
    expect(after).toMatchObject({
      id: routeId,
      distanceKm: before!.distanceKm,
      estimatedMinutes: before!.estimatedMinutes,
      polyline: before!.polyline,
      recalculationCount: 0,
    });
    expect(await timelineOfType(module11, emergencyId, 'ROUTE_RECALCULATED')).toHaveLength(0);
    const failed = await timelineOfType(module11, emergencyId, 'ROUTE_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ ambulanceId: expect.any(String), degradedToEstimate: false });

    const emergencyAfter = await module11.emergencies.requireById(emergencyId);
    expect(emergencyAfter.status).toBe(emergencyBefore.status);
  });

  it('skips a terminal route without an event or a write', async () => {
    const { emergencyId } = await seedAssignedEmergency();
    const routeId = await generateResponseRoute(emergencyId);
    await db.route.update({ where: { id: routeId }, data: { status: 'ARRIVED' } });

    const result = await module8.optimization.recalculateRoute(routeId, 'any reason');
    expect(result).toMatchObject({ outcome: 'SKIPPED_STATUS', routeId, emergencyId });

    const after = await module11.routes.findById(routeId);
    expect(after!.recalculationCount).toBe(0);
    expect(await timelineOfType(module11, emergencyId, 'ROUTE_RECALCULATED')).toHaveLength(0);
  });
});
