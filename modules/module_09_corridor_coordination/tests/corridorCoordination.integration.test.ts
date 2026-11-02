import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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
import { Module8, loadModule8Config } from '@resus/routing';
import { Module9, loadModule9Config } from '@resus/corridor';
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

describe('Module 9 corridor coordination integration (Module 8 + Module 11)', () => {
  let db: PrismaClient;
  let module11: Module11;
  let module8: Module8;
  let module9: Module9;
  let testDatabase: IsolatedTestDatabase;

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const dbUrl = testDatabase.databaseUrl;
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    module11 = createModule11({ db, ownsClient: false, logger: noopLogger });

    const routeConfig = loadModule8Config();
    // These test-only opt-ins exercise the committed-event subscribers; the
    // shared harness keeps automatic behaviors disabled for other tests.
    routeConfig.generation = { ...routeConfig.generation, enabled: true, includeSimulation: false };
    module8 = new Module8({
      routes: module11.routes,
      emergencies: module11.emergencies,
      ambulances: module11.ambulances,
      hospitals: module11.hospitals,
      events: module11.eventPublisher,
      bus: module11.bus,
      config: routeConfig,
      logger: noopLogger,
    });

    const corridorConfig = loadModule9Config();
    corridorConfig.enabled = true;
    corridorConfig.includeSimulation = false;
    module9 = new Module9({
      corridors: module11.routes,
      notifications: module11.notifications,
      routes: module11.routes,
      bus: module11.bus,
      config: { ...corridorConfig, radiusM: 150 },
      logger: noopLogger,
    });
  }, 120000);

  afterAll(async () => {
    module9?.dispose();
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

  async function seedHospital(): Promise<string> {
    const hospitalId = createId('HSP');
    await db.hospital.create({
      data: {
        id: hospitalId,
        name: 'Corridor Integration Hospital',
        latitude: 12.99,
        longitude: 77.6,
        status: 'OPEN',
        capabilitiesJson: JSON.stringify(['ED_CARDIAC']),
        traumaLevel: 2,
        acceptingEmergencies: true,
        address: 'Corridor Integration Hospital, Bengaluru',
        isSimulation: false,
      },
    });
    return hospitalId;
  }

  async function dispatchToHospital(emergencyId: string, ambulanceId: string, hospitalId: string) {
    await module11.eventPublisher.record(
      defineEvent('AMBULANCE_ASSIGNED', {
        emergencyId,
        entityType: 'emergency',
        entityId: emergencyId,
        payload: assignmentPayload(emergencyId, ambulanceId),
      }),
    );
    await module8.autoRoute!.idle();
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
    await module9.autoCorridor!.idle();
  }

  it('persists an explicitly simulated corridor and records a suppressed notification', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    const hospitalId = await seedHospital();
    await dispatchToHospital(emergencyId, ambulanceId, hospitalId);

    const corridor = await module11.routes.getCorridor(emergencyId);
    expect(corridor).not.toBeNull();
    expect(corridor).toMatchObject({
      emergencyId,
      ambulanceId,
      hospitalId,
      fromLabel: 'SCENE',
      toLabel: 'HOSPITAL',
      isActive: true,
      status: 'ACTIVE',
      priorityMode: 'SIMULATED',
      radiusM: 150,
      isSimulation: false,
      renegotiationCount: 0,
      signals: [],
    });
    // Geometry is derived from the persisted transport route, so the corridor
    // centre line starts at the scene and reaches out toward the hospital.
    expect(corridor!.geofence.length).toBeGreaterThan(1);
    expect(corridor!.roadUsers.length).toBeGreaterThan(0);
    expect(JSON.stringify(corridor!.roadUsers)).toContain('SIM-RU-');

    const activated = await timelineOfType(module11, emergencyId, 'CORRIDOR_ACTIVATED');
    expect(activated).toHaveLength(1);
    expect(activated[0]!.payload).toMatchObject({
      emergencyId,
      ambulanceId,
      hospitalId,
      from: 'SCENE',
      to: 'HOSPITAL',
    });

    const notifications = await module11.notifications.listForEmergency(emergencyId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      provider: 'mock-notification',
      delivered: false,
      status: 'SUPPRESSED',
      audience: 'NEARBY_ROAD_USERS',
    });

    const sent = await timelineOfType(module11, emergencyId, 'NOTIFICATION_SENT');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ delivered: false, provider: 'mock-notification' });
  });

  it('does not create a second corridor or event when the trigger is redelivered', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    const hospitalId = await seedHospital();
    await dispatchToHospital(emergencyId, ambulanceId, hospitalId);

    // Redeliver both triggers.
    await module11.eventPublisher.record(
      defineEvent('HOSPITAL_SELECTED', {
        emergencyId,
        entityType: 'emergency',
        entityId: emergencyId,
        payload: hospitalSelectionPayload(emergencyId, hospitalId),
      }),
    );
    await module8.autoRoute!.idle();
    await module9.autoCorridor!.idle();

    expect(await timelineOfType(module11, emergencyId, 'CORRIDOR_ACTIVATED')).toHaveLength(1);
    expect(await module11.notifications.listForEmergency(emergencyId)).toHaveLength(1);
  });

  it('releases the corridor once, idempotently, and emits CORRIDOR_RELEASED once', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    const hospitalId = await seedHospital();
    await dispatchToHospital(emergencyId, ambulanceId, hospitalId);

    const first = await module9.service.release(emergencyId, 'PATIENT_HANDOVER');
    expect(first.released).toBe(true);
    const second = await module9.service.release(emergencyId);
    expect(second.released).toBe(false);

    const corridor = await module11.routes.getCorridor(emergencyId);
    expect(corridor).toMatchObject({ isActive: false, status: 'RELEASED' });
    expect(corridor!.releasedAt).not.toBeNull();

    const released = await timelineOfType(module11, emergencyId, 'CORRIDOR_RELEASED');
    expect(released).toHaveLength(1);
    expect(released[0]!.payload).toMatchObject({ emergencyId, reason: 'PATIENT_HANDOVER' });
  });

  it('exposes corridor state through the read path without claiming a live integration', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    const hospitalId = await seedHospital();
    await dispatchToHospital(emergencyId, ambulanceId, hospitalId);

    const state = await module9.service.getState(emergencyId);
    expect(state.isLive).toBe(false);
    expect(state.signalsControlled).toBe(false);
    expect(state.corridor?.priorityMode).toBe('SIMULATED');
  });

  it('activates through the CorridorIntegrationPort adapter', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    const hospitalId = await seedHospital();
    await dispatchToHospital(emergencyId, ambulanceId, hospitalId);

    const result = await module9.integration.activateCorridor({
      emergencyId,
      ambulanceId,
      hospitalId,
      from: 'SCENE',
      to: 'HOSPITAL',
    });
    expect(result.ok).toBe(true);
    // Re-requesting an already-active corridor is reported as ok without a new event.
    expect(await timelineOfType(module11, emergencyId, 'CORRIDOR_ACTIVATED')).toHaveLength(1);
  });

  it('reports ok:false from the adapter when no transport route exists', async () => {
    const { emergencyId, ambulanceId } = await seedAssignedEmergency();
    const result = await module9.integration.activateCorridor({
      emergencyId,
      ambulanceId,
      hospitalId: 'HSP-NONE',
      from: 'SCENE',
      to: 'HOSPITAL',
    });
    expect(result.ok).toBe(false);
  });
});
