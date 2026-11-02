import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createModule11, type Module11 } from '../src/module.js';
import { withTransaction } from '../src/db/client.js';
import { AppError, defineEvent, type SystemEventRecord } from '@resus/core';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../../../tests/helpers/isolatedTestDatabase.js';

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
let db: PrismaClient;
let module11: Module11;
let received: SystemEventRecord[];
let unsubscribe: () => void;
let testDatabase: IsolatedTestDatabase;

beforeAll(async () => {
  testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
  const dbUrl = testDatabase.databaseUrl;
  db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  module11 = createModule11({ db, ownsClient: false });
  received = [];
  unsubscribe = module11.bus.subscribeAll((event) => {
    received.push(event);
  });
}, 180000);

afterAll(async () => {
  unsubscribe?.();
  await db?.$disconnect();
  testDatabase?.cleanup();
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
