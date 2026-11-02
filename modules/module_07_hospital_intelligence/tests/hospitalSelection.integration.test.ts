import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createId, defineEvent } from '@resus/core';
import { createModule11, type Module11 } from '@resus/data';
import { Module7 } from '../src/module.js';
import { loadModule7Config } from '../src/config.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../../../tests/helpers/isolatedTestDatabase.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
async function seedHospital(
  db: PrismaClient,
  input: {
    name: string;
    latitude: number;
    longitude: number;
    capabilities: string[];
    icuBeds: number;
    emergencyBeds: number;
  },
): Promise<string> {
  const id = createId('HSP');
  await db.hospital.create({
    data: {
      id,
      name: input.name,
      latitude: input.latitude,
      longitude: input.longitude,
      status: 'OPEN',
      capabilitiesJson: JSON.stringify(input.capabilities),
      traumaLevel: 2,
      acceptingEmergencies: true,
      address: `${input.name}, Bengaluru`,
      isSimulation: true,
    },
  });
  await db.hospitalResource.createMany({
    data: [
      { id: createId('RSC'), hospitalId: id, resourceType: 'ICU_BED', code: '', total: 10, available: input.icuBeds, updatedAt: new Date() },
      { id: createId('RSC'), hospitalId: id, resourceType: 'EMERGENCY_BED', code: '', total: 8, available: input.emergencyBeds, updatedAt: new Date() },
    ],
  });
  return id;
}

describe('Module 7 hospital selection integration', () => {
  let db: PrismaClient;
  let module11: Module11;
  let module7: Module7;
  let testDatabase: IsolatedTestDatabase;
  let closeButFull: string;
  let fartherButReady: string;

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const dbUrl = testDatabase.databaseUrl;
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    module11 = createModule11({ db, ownsClient: false });

    closeButFull = await seedHospital(db, {
      name: 'Close But Full',
      latitude: 12.975,
      longitude: 77.595,
      capabilities: ['ED_CARDIAC', 'GENERAL'],
      icuBeds: 0,
      emergencyBeds: 2,
    });
    fartherButReady = await seedHospital(db, {
      name: 'Farther But Ready',
      latitude: 12.995,
      longitude: 77.6,
      capabilities: ['ED_CARDIAC', 'GENERAL'],
      icuBeds: 3,
      emergencyBeds: 4,
    });

    const config = loadModule7Config();
    config.autoSelect = { enabled: true, includeSimulation: false };

    module7 = new Module7({
      hospitals: module11.hospitals,
      emergencies: module11.emergencies,
      events: module11.eventPublisher,
      bus: module11.bus,
      config,
    });
  }, 120000);

  afterAll(async () => {
    module7?.dispose();
    await db?.$disconnect();
    testDatabase?.cleanup();
  });

  it('selects the farther hospital with a free ICU over the closer full one', async () => {
    const emergency = await module11.emergencies.create({
      incidentType: 'CARDIAC_ARREST',
      severity: 'CRITICAL',
      latitude: 12.9716,
      longitude: 77.5946,
      isSimulation: false,
    });

    // Creating an emergency must not select a hospital: only classification does.
    expect((await module11.emergencies.requireById(emergency.id)).selectedHospitalId).toBeNull();

    await module11.eventPublisher.record(
      defineEvent('EMERGENCY_CLASSIFIED', {
        emergencyId: emergency.id,
        entityType: 'emergency',
        entityId: emergency.id,
        payload: { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL', confidence: 0.9, source: 'OPERATOR' },
      }),
    );
    await module7.autoSelect!.idle();

    const stored = await module11.emergencies.requireById(emergency.id);
    expect(stored.selectedHospitalId).toBe(fartherButReady);
    expect(stored.selectedHospitalId).not.toBe(closeButFull);

    const timeline = await module11.eventQuery.timeline(emergency.id);
    const selected = timeline.find((event) => event.type === 'HOSPITAL_SELECTED');
    expect(selected).toBeDefined();
    expect((selected!.payload as { hospitalId: string }).hospitalId).toBe(fartherButReady);

    const rejected = timeline.filter((event) => event.type === 'HOSPITAL_REJECTED');
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.payload as { hospitalId: string }).hospitalId).toBe(closeButFull);
    expect((rejected[0]!.payload as { reason: string }).reason).toContain('ICU_BED');
  });

  it('does not select twice when classification is redelivered', async () => {
    const emergency = await module11.emergencies.create({
      incidentType: 'CARDIAC_ARREST',
      severity: 'CRITICAL',
      latitude: 12.9716,
      longitude: 77.5946,
      isSimulation: false,
    });

    const classification = defineEvent('EMERGENCY_CLASSIFIED', {
      emergencyId: emergency.id,
      entityType: 'emergency',
      entityId: emergency.id,
      payload: { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL', confidence: 0.9, source: 'OPERATOR' },
    });

    await module11.eventPublisher.record(classification);
    await module7.autoSelect!.idle();
    const first = (await module11.emergencies.requireById(emergency.id)).selectedHospitalId;
    expect(first).toBe(fartherButReady);

    await module11.eventPublisher.record(classification);
    await module7.autoSelect!.idle();

    const timeline = await module11.eventQuery.timeline(emergency.id);
    expect(timeline.filter((event) => event.type === 'HOSPITAL_SELECTED')).toHaveLength(1);
  });

  it('leaves a simulation emergency untouched by default', async () => {
    const emergency = await module11.emergencies.create({
      incidentType: 'TRAUMA',
      severity: 'HIGH',
      latitude: 12.9716,
      longitude: 77.5946,
      isSimulation: true,
    });

    await module11.eventPublisher.record(
      defineEvent('EMERGENCY_CLASSIFIED', {
        emergencyId: emergency.id,
        entityType: 'emergency',
        entityId: emergency.id,
        payload: { incidentType: 'TRAUMA', severity: 'HIGH', confidence: 0.8, source: 'OPERATOR' },
      }),
    );
    await module7.autoSelect!.idle();

    expect((await module11.emergencies.requireById(emergency.id)).selectedHospitalId).toBeNull();
  });
});
