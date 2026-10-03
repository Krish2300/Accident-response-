import { AsyncLocalStorage } from 'node:async_hooks';
import type { SystemEventRecord } from '@resus/core';

/**
 * Per-transaction broadcast buffering.
 *
 * Why this exists: events written inside a transaction must not be broadcast
 * until that transaction commits, and must be discarded if it rolls back. An
 * earlier implementation used a module-global array, which meant a transaction
 * calling `flushPending()` would also publish events buffered by *other*
 * in-flight transactions - including events belonging to work that later rolled
 * back. Subscribers would then observe state changes that never happened.
 *
 * AsyncLocalStorage scopes the buffer to the actual async execution context of
 * the transaction, so interleaved transactions cannot observe each other's
 * events. Node keeps the context alive across `await` boundaries, which is
 * exactly the lifetime a Prisma interactive transaction has.
 */
export interface TransactionScope {
  /** Events written so far by the transaction that owns this scope. */
  records: SystemEventRecord[];
}

const storage = new AsyncLocalStorage<TransactionScope>();

/**
 * Invoked with the buffered records after a successful commit.
 * Registered once by the EventService at construction time.
 */
let commitSink: ((records: SystemEventRecord[]) => Promise<void> | void) | null = null;

export function registerCommitSink(sink: (records: SystemEventRecord[]) => Promise<void> | void): void {
  commitSink = sink;
}

export function currentScope(): TransactionScope | undefined {
  return storage.getStore();
}

export function bufferRecord(record: SystemEventRecord): void {
  const scope = storage.getStore();
  if (scope) scope.records.push(record);
}

/**
 * Runs `fn` inside a fresh scope.
 *
 * On success the buffered records are handed to the commit sink, which broadcasts
 * them. On any failure the buffer is discarded along with the transaction, so a
 * rollback can never leak a broadcast.
 */
export async function runScoped<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ records: [] }, async () => {
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      // Rollback: drop the buffer explicitly rather than relying on GC, so the
      // contents cannot be observed by a later commit in the same context.
      const scope = storage.getStore();
      if (scope) scope.records.length = 0;
      throw error;
    }

    const scope = storage.getStore();
    const records = scope ? scope.records.splice(0) : [];
    if (records.length > 0 && commitSink) {
      await commitSink(records);
    }
    return result;
  });
}

/** Test helper: drops any registered sink. */
export function resetCommitSink(): void {
  commitSink = null;
}
