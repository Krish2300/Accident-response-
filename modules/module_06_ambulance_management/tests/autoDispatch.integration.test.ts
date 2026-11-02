import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createModule11, type Module11 } from '@resus/data';
import { Module6 } from '../src/module.js';
import { loadModule6Config } from '../src/config.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../../../tests/helpers/isolatedTestDatabase.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
describe('Module 6 automatic assignment integration', () => {
  let db: PrismaClient;
  let module11: Module11;
  let module6: Module6;
  let testDatabase: IsolatedTestDatabase;

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const dbUrl = testDatabase.databaseUrl;
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    module11 = createModule11({ db, ownsClient: false });

    const config = loadModule6Config();
    config.autoDispatch = { enabled: true, includeSimulation: false };

    module6 = new Module6({
      ambulances: module11.ambulances,
      events: module11.eventPublisher,
      bus: module11.bus,
      emergencies: module11.emergencies,
      config,
    });
  }, 120000);

  afterAll(async () => {
    await db?.$disconnect();
    testDatabase?.cleanup();
  });

  it('automatically assigns a real emergency without dispatching the ambulance', async () => {
    const ambulance = await module6.fleet.registerAmbulance({ vehicleNumber: 'AMB-AUTO-1' });
    await module6.tracking.updateLocation({
      ambulanceId: ambulance.id,
      latitude: 12.9716,
      longitude: 77.5946,
    });

    const emergency = await module11.emergencies.create({
      incidentType: 'CARDIAC_ARREST',
      severity: 'CRITICAL',
      latitude: 12.975,
      longitude: 77.595,
      isSimulation: false,
    });

    await module6.autoDispatch!.idle();

    const assignments = await module11.ambulances.assignmentsForEmergency(emergency.id);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.ambulanceId).toBe(ambulance.id);
    expect(assignments[0]!.source).toBe('AUTOMATIC');

    const assigned = await module11.ambulances.requireById(ambulance.id);
    expect(assigned.status).toBe('ASSIGNED');

    const timeline = await module11.eventQuery.timeline(emergency.id);
    expect(timeline.some((event) => event.type === 'AMBULANCE_ASSIGNED')).toBe(true);
    expect(timeline.some((event) => event.type === 'AMBULANCE_DISPATCHED')).toBe(false);
  });

  it('does not create a second assignment when the same event is redelivered', async () => {
    const ambulance = await module6.fleet.registerAmbulance({ vehicleNumber: 'AMB-DUP-1' });
    await module6.tracking.updateLocation({
      ambulanceId: ambulance.id,
      latitude: 12.9716,
      longitude: 77.5946,
    });

    const emergency = await module11.emergencies.create({
      incidentType: 'SEVERE_BLEEDING',
      severity: 'HIGH',
      latitude: 12.975,
      longitude: 77.595,
      isSimulation: false,
    });

    await module6.autoDispatch!.idle();
    expect(await module11.ambulances.assignmentsForEmergency(emergency.id)).toHaveLength(1);

    const timeline = await module11.eventQuery.timeline(emergency.id);
    const created = timeline.find((event) => event.type === 'EMERGENCY_CREATED');
    expect(created).toBeDefined();

    const replay = await module6.autoDispatch!.handleEvent(created!);
    expect(replay.outcome).toBe('SKIPPED_ALREADY_ASSIGNED');
    expect(await module11.ambulances.assignmentsForEmergency(emergency.id)).toHaveLength(1);
  });

  it('reports no ambulance and leaves the emergency untouched when none is available', async () => {
    const emergency = await module11.emergencies.create({
      incidentType: 'OTHER',
      severity: 'MEDIUM',
      latitude: 12.9,
      longitude: 77.6,
      isSimulation: false,
    });

    await module6.autoDispatch!.idle();

    expect(await module11.ambulances.assignmentsForEmergency(emergency.id)).toHaveLength(0);
    const stored = await module11.emergencies.requireById(emergency.id);
    expect(stored.assignedAmbulanceId).toBeNull();
  });

  it('does not assign an ambulance whose reported GPS is stale', async () => {
    const stale = await module6.fleet.registerAmbulance({ vehicleNumber: 'AMB-STALE-1' });
    await module11.ambulances.appendLocation({
      ambulanceId: stale.id,
      latitude: 12.9716,
      longitude: 77.5946,
      recordedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const emergency = await module11.emergencies.create({
      incidentType: 'OTHER',
      severity: 'LOW',
      latitude: 12.9,
      longitude: 77.6,
      isSimulation: false,
    });

    await module6.autoDispatch!.idle();

    expect(await module11.ambulances.assignmentsForEmergency(emergency.id)).toHaveLength(0);
  });

  it('still serves the manual assignment endpoint', async () => {
    const ambulance = await module6.fleet.registerAmbulance({ vehicleNumber: 'AMB-MANUAL-1' });
    await module6.tracking.updateLocation({
      ambulanceId: ambulance.id,
      latitude: 12.9716,
      longitude: 77.5946,
    });

    // Simulation so automatic assignment deliberately ignores it; only the manual call
    // may assign this one.
    const emergency = await module11.emergencies.create({
      incidentType: 'TRAUMA',
      severity: 'HIGH',
      latitude: 12.975,
      longitude: 77.595,
      isSimulation: true,
    });
    await module6.autoDispatch!.idle();
    expect(await module11.ambulances.assignmentsForEmergency(emergency.id)).toHaveLength(0);

    const route = module6.routes().find((candidate) => candidate.url === '/api/ambulances/assign');
    expect(route).toBeDefined();

    let sent: unknown;
    const reply = {
      send: (body: unknown) => {
        sent = body;
        return reply;
      },
      status: () => reply,
    };
    await route!.handler(
      { body: { emergencyId: emergency.id, latitude: 12.975, longitude: 77.595 } } as never,
      reply as never,
    );

    expect((sent as { ambulanceId: string }).ambulanceId).toBe(ambulance.id);
    expect(await module11.ambulances.assignmentsForEmergency(emergency.id)).toHaveLength(1);
  });
});
