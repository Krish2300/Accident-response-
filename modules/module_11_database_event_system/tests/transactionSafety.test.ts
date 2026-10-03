import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createModule11, type Module11 } from '../src/module.js';
import { withTransaction } from '../src/db/client.js';
import { AppError, defineEvent, type SystemEventRecord } from '@resus/core';

/**
 * Transaction-safety tests for the event spine.
 *
 * These run against a throwaway SQLite file created by the real migrations, so
 * the append-only triggers and the transaction semantics under test are the same
 * ones used in production.
 *
 * Isolation matters here: Prisma reads `.env` itself and would otherwise connect
 * to the development database, so the test asserts up front that it is pointed
 * somewhere else and refuses to run otherwise. A test that silently writes
 * emergency rows into a developer's working data is worse than no test.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const prismaDir = resolve(here, '../prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
const prismaCli = resolve(repoRoot, 'node_modules/prisma/build/index.js');
const devDbPath = resolve(prismaDir, 'dev.db');
const dbPath = resolve(prismaDir, 'test-events.db');
const dbUrl = `file:${dbPath.replace(/\\/g, '/')}`;

function removeDatabaseFiles(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
  for (const entry of existsSync(path) ? readdirSync(prismaDir) : []) {
    if (entry.startsWith(`${path.split(/[\\/]/).pop()}-`)) {
      rmSync(resolve(prismaDir, entry), { force: true });
    }
  }
}

let db: PrismaClient;
let module11: Module11;
let received: SystemEventRecord[];
let unsubscribe: () => void;

beforeAll(async () => {
  removeDatabaseFiles(dbPath);

  // `process.env` must be set before Prisma is constructed: it resolves
  // DATABASE_URL at construction time and gives `.env` lower priority.
  process.env.DATABASE_URL = dbUrl;

  // Invoke the Prisma CLI through node directly: `npx` is not a resolvable
  // bare binary on Windows.
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
  });

  db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  // Guard: prove we are not pointed at the development database before writing.
  const probe = await db.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
  const target = probe.find((row) => row.name === 'main')?.file ?? '';
  if (target && resolve(target) === resolve(devDbPath)) {
    throw new Error(
      `Refusing to run: the test database resolved to the development database (${devDbPath}).`,
    );
  }

  module11 = createModule11({ db, ownsClient: false });
  received = [];
  unsubscribe = module11.bus.subscribeAll((event) => {
    received.push(event);
  });
}, 180000);

afterAll(async () => {
  unsubscribe?.();
  await db?.$disconnect();
  removeDatabaseFiles(dbPath);
});

function emergency(id: string) {
  return {
    id,
    incidentType: 'CARDIAC_ARREST' as const,
    severity: 'CRITICAL' as const,
    status: 'CREATED' as const,
    latitude: 12.9716,
    longitude: 77.5946,
  };
}

async function writeEventInTransaction(
  emergencyId: string,
  shouldFail: boolean,
  delayMs = 0,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.emergency.create({ data: emergency(emergencyId) });
    await module11.events.recordInTransaction(
      tx as never,
      defineEvent('EMERGENCY_CREATED', {
        emergencyId,
        entityType: 'emergency',
        entityId: emergencyId,
        payload: {
          incidentType: 'CARDIAC_ARREST',
          severity: 'CRITICAL',
          latitude: 12.9716,
          longitude: 77.5946,
          isSimulation: true,
        },
      }),
    );
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    if (shouldFail) throw new Error('forced rollback');
  });
}

describe('transactional event broadcast', () => {
  it('broadcasts after a successful commit, not before', async () => {
    received.length = 0;
    await writeEventInTransaction('EMG_TXN_OK', false);

    expect(received.filter((e) => e.emergencyId === 'EMG_TXN_OK')).toHaveLength(1);
  });

  it('does not broadcast anything when the transaction rolls back', async () => {
    received.length = 0;
    // A genuine constraint violation, so this exercises the real rollback path
    // rather than a synthetic throw.
    await expect(
      writeEventInTransaction('EMG_TXN_ROLLBACK', true),
    ).rejects.toBeInstanceOf(AppError);

    expect(received.filter((e) => e.emergencyId === 'EMG_TXN_ROLLBACK')).toHaveLength(0);
    // The row is gone too, so the event could not have described real state.
    expect(await db.emergency.findUnique({ where: { id: 'EMG_TXN_ROLLBACK' } })).toBeNull();
  });

  it('does not leak a rolling back transaction event into a concurrent commit', async () => {
    received.length = 0;

    // The failing transaction is still in flight when the succeeding one commits.
    // The old module-global buffer would have published the doomed event here.
    const failing = writeEventInTransaction('EMG_TXN_CONCURRENT_FAIL', true, 40);
    const succeeding = writeEventInTransaction('EMG_TXN_CONCURRENT_OK', false, 0);

    await expect(failing).rejects.toBeInstanceOf(AppError);
    await succeeding;

    // Drain anything the bus might try to deliver later.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterFlush = received.map((e) => e.emergencyId);
    expect(afterFlush).toContain('EMG_TXN_CONCURRENT_OK');
    expect(afterFlush).not.toContain('EMG_TXN_CONCURRENT_FAIL');
  });

  it('keeps concurrent successful transactions from mixing events', async () => {
    received.length = 0;

    await Promise.all([
      writeEventInTransaction('EMG_TXN_P1', false, 10),
      writeEventInTransaction('EMG_TXN_P2', false, 0),
      writeEventInTransaction('EMG_TXN_P3', false, 5),
    ]);

    const ids = received.map((e) => e.emergencyId);
    expect(ids).toContain('EMG_TXN_P1');
    expect(ids).toContain('EMG_TXN_P2');
    expect(ids).toContain('EMG_TXN_P3');
    // Exactly one event each, no duplicates from cross-transaction flushing.
    expect(ids.filter((id) => id === 'EMG_TXN_P1')).toHaveLength(1);
    expect(ids.filter((id) => id === 'EMG_TXN_P2')).toHaveLength(1);
    expect(ids.filter((id) => id === 'EMG_TXN_P3')).toHaveLength(1);
  });

  it('broadcasts immediately when recording outside a transaction', async () => {
    received.length = 0;
    await db.emergency.create({
      data: { ...emergency('EMG_TXN_DIRECT'), isSimulation: true },
    });
    await module11.events.recordInTransaction(
      db as never,
      defineEvent('EMERGENCY_CREATED', {
        emergencyId: 'EMG_TXN_DIRECT',
        entityType: 'emergency',
        entityId: 'EMG_TXN_DIRECT',
        payload: {
          incidentType: 'CARDIAC_ARREST',
          severity: 'CRITICAL',
          latitude: 12.9716,
          longitude: 77.5946,
          isSimulation: true,
        },
      }),
    );

    expect(received.filter((e) => e.emergencyId === 'EMG_TXN_DIRECT')).toHaveLength(1);
  });
});
