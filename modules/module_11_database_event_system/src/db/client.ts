import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaClient, Prisma } from '@prisma/client';
import type { Database } from '@resus/core';
import { AppError, ErrorCode, createConsoleLogger } from '@resus/core';
import { runScoped } from './transactionScope.js';

/**
 * The one and only database client. Created by the composition root and injected
 * into every repository. Module 5, 6 and 12 never construct their own.
 */
export type PrismaDatabase = PrismaClient | Prisma.TransactionClient;

let instance: PrismaClient | null = null;

export function createPrismaClient(options: { log?: boolean } = {}): PrismaClient {
  return new PrismaClient({
    log: options.log ? ['warn', 'error'] : ['error'],
  });
}

/** Process-wide singleton used by the server, scripts and the seed. */
export function getPrismaClient(): PrismaClient {
  if (!instance) instance = createPrismaClient();
  return instance;
}

export async function disconnectPrisma(): Promise<void> {
  if (instance) {
    await instance.$disconnect();
    instance = null;
  }
}

/** Structural adapter so repositories can be typed against a core port. */
export const asDatabase = (db: PrismaDatabase): Database => db as unknown as Database;

const logger = createConsoleLogger('info', 'module_11.db');

/**
 * Runs `fn` inside a transaction and maps failures to AppError. Used wherever a
 * domain write and its event must commit together (specification section 21).
 *
 * The body is wrapped in a per-transaction `TransactionScope`, so events recorded
 * via `EventService.recordInTransaction` are broadcast only after this transaction
 * commits, and are discarded if it rolls back.
 */
export async function withTransaction<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await serialiseForSqlite(() => runScoped(() => db.$transaction(fn, { timeout: 15000, maxWait: 5000 })));
  } catch (error) {
    throw mapDatabaseError(error, 'Transaction failed');
  }
}

/**
 * SQLite has a single writer. Two interactive transactions that both read and
 * then write deadlock on the lock upgrade, and SQLite resolves that by failing
 * one immediately (surfacing as "Transaction failed" / socket timeout). That
 * happens as soon as several modules react to the same committed event at once
 * (Modules 6, 7, 8, 9 and 10 all do). Transactions are therefore queued
 * in-process when the datasource is SQLite. PostgreSQL is unaffected.
 *
 * Re-entrant: a transaction started from inside another one's async context
 * runs immediately instead of waiting for itself.
 */
const sqliteLock = { tail: Promise.resolve() as Promise<unknown> };
const insideLock = new AsyncLocalStorage<true>();

function usesSqlite(): boolean {
  const url = process.env.DATABASE_URL ?? 'file:';
  return url.startsWith('file:') || url.startsWith('sqlite:');
}

async function serialiseForSqlite<T>(work: () => Promise<T>): Promise<T> {
  if (!usesSqlite() || insideLock.getStore()) return work();
  const previous = sqliteLock.tail;
  let release!: () => void;
  sqliteLock.tail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await previous.catch(() => undefined);
    return await insideLock.run(true, work);
  } finally {
    release();
  }
}

/**
 * Switches a SQLite database to write-ahead logging, so readers never wait for
 * the writer. Persistent in the database file; a no-op on other providers.
 */
export async function prepareSqlite(db: PrismaClient): Promise<void> {
  if (!usesSqlite()) return;
  try {
    await db.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
    await db.$queryRawUnsafe('PRAGMA busy_timeout=10000;');
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'could not enable SQLite WAL mode');
  }
}

export function mapDatabaseError(error: unknown, fallbackMessage: string): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        return new AppError(ErrorCode.CONFLICT, 'A record with these unique values already exists.', 409, {
          prismaCode: error.code,
          target: error.meta?.target,
        });
      case 'P2003':
        return new AppError(
          ErrorCode.VALIDATION_ERROR,
          'Referenced record does not exist (foreign key constraint).',
          422,
          { prismaCode: error.code, field: error.meta?.field_name },
        );
      case 'P2025':
        return new AppError(ErrorCode.NOT_FOUND, 'Record not found.', 404, { prismaCode: error.code });
      case 'P2010':
        return mapRawError(String(error.message), error.meta);
      default:
        return new AppError(ErrorCode.DATABASE_FAILURE, fallbackMessage, 500, { prismaCode: error.code });
    }
  }

  return new AppError(ErrorCode.DATABASE_FAILURE, fallbackMessage, 500, {
    cause: error instanceof Error ? error.message : String(error),
  });
}

function mapRawError(message: string, meta: unknown): AppError {
  if (message.includes('IMMUTABLE_RECORD')) {
    return new AppError(
      ErrorCode.IMMUTABLE_RECORD,
      'The system event log is append-only and cannot be modified.',
      409,
    );
  }
  if (message.includes('VALIDATION_ERROR')) {
    return new AppError(ErrorCode.VALIDATION_ERROR, 'A domain constraint rejected the write.', 422, meta);
  }
  return new AppError(ErrorCode.DATABASE_FAILURE, 'Raw database statement failed.', 500, { message, meta });
}

/** Applies `mapDatabaseError` to a repository read/write. */
export async function guardDatabase<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const appError = mapDatabaseError(error, message);
    if (appError.statusCode >= 500) logger.error({ code: appError.code, message }, 'database failure');
    throw appError;
  }
}
