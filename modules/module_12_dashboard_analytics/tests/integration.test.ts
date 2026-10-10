import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createModule11, type Module11 } from '@resus/data';
import { Module12 } from '../src/module.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
const prismaCli = resolve(repoRoot, 'node_modules/prisma/build/index.js');
const devDbPath = resolve(prismaDir, 'dev.db');
const dbPath = resolve(prismaDir, 'test-module12.db');
const dbUrl = `file:${dbPath.replace(/\\/g, '/')}`;

function removeDatabaseFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

describe('Module 12 integration', () => {
  let db: PrismaClient;
  let module11: Module11;
  let module12: Module12;

  beforeAll(async () => {
    removeDatabaseFiles();
    process.env.DATABASE_URL = dbUrl;
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schemaPath], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'pipe',
    });
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    module11 = createModule11({ db, ownsClient: false });
    module12 = new Module12({ analyticsRead: module11.analyticsRead, events: module11.eventQuery });
  }, 120000);

  afterAll(async () => {
    await db?.$disconnect();
    removeDatabaseFiles();
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
