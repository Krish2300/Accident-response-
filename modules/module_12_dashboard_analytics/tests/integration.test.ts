import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createModule11, type Module11 } from '@resus/data';
import { Module12 } from '../src/module.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../../../tests/helpers/isolatedTestDatabase.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
describe('Module 12 integration', () => {
  let db: PrismaClient;
  let module11: Module11;
  let module12: Module12;
  let testDatabase: IsolatedTestDatabase;

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const dbUrl = testDatabase.databaseUrl;
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    module11 = createModule11({ db, ownsClient: false });
    module12 = new Module12({ analyticsRead: module11.analyticsRead, events: module11.eventQuery });
  }, 120000);

  afterAll(async () => {
    await db?.$disconnect();
    testDatabase?.cleanup();
  });

  it('gets live state with empty data', async () => {
    const live = await module12.dashboard.getLiveState();
    expect(live.emergencies).toEqual([]);
    expect(live.ambulances).toEqual([]);
    expect(live.corridors).toEqual([]);
  });

  it('calculates summary with empty dataset', async () => {
    const summary = await module12.analytics.getSummary();
    expect(summary.totalEmergencies).toBe(0);
    expect(summary.completedEmergencies).toBe(0);
  });
});
