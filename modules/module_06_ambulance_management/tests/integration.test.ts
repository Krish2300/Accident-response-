import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createModule11, type Module11 } from '@resus/data';
import { Module6 } from '../src/module.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../../../tests/helpers/isolatedTestDatabase.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
describe('Module 6 integration', () => {
  let db: PrismaClient;
  let module11: Module11;
  let module6: Module6;
  let testDatabase: IsolatedTestDatabase;

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const dbUrl = testDatabase.databaseUrl;
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    module11 = createModule11({ db, ownsClient: false });
    module6 = new Module6({ ambulances: module11.ambulances, events: module11.eventPublisher });
  }, 120000);

  afterAll(async () => {
    await db?.$disconnect();
    testDatabase?.cleanup();
  });

  it('registers ambulance and assigns it', async () => {
    const ambulance = await module6.fleet.registerAmbulance({ vehicleNumber: 'AMB_TEST_001' });
    expect(ambulance.id).toBeDefined();
    expect(ambulance.status).toBe('AVAILABLE');

    const location = await module6.tracking.updateLocation({
      ambulanceId: ambulance.id,
      latitude: 12.9716,
      longitude: 77.5946,
    });
    expect(location.latitude).toBe(12.9716);

    const emergency = await module11.emergencies.create({
      incidentType: 'CARDIAC_ARREST' as any,
      severity: 'CRITICAL' as any,
      latitude: 12.975,
      longitude: 77.595,
      isSimulation: true,
    });
    const result = await module6.assignment.selectAndAssign({
      emergencyId: emergency.id,
      latitude: 12.975,
      longitude: 77.595,
    });
    expect(result.ambulanceId).toBe(ambulance.id);
  });
});
