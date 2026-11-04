import type { PrismaClient } from '@prisma/client';
import { createId } from '@resus/core';
import { guardDatabase } from '../db/client.js';

export interface AccessAuditEntry {
  id: string;
  at: string;
  userId: string;
  userEmail: string;
  role: string;
  action: string;
  emergencyId: string | null;
  caseNumber: string | null;
  ipAddress: string | null;
  detail: string | null;
}

/**
 * Append-only record of who accessed caller data (the table rejects UPDATE and
 * DELETE at the database level). Written for every police / control-room read.
 */
export class AccessAuditRepository {
  constructor(private readonly db: PrismaClient) {}

  async record(input: Omit<AccessAuditEntry, 'id' | 'at'>): Promise<void> {
    await guardDatabase(
      () => this.db.accessAudit.create({ data: { id: createId('AUD'), ...input } }).then(() => undefined),
      'Failed to write access audit',
    );
  }

  async list(filter: { emergencyId?: string; userId?: string; limit?: number } = {}): Promise<AccessAuditEntry[]> {
    return guardDatabase(async () => {
      const rows = await this.db.accessAudit.findMany({
        where: { ...(filter.emergencyId ? { emergencyId: filter.emergencyId } : {}), ...(filter.userId ? { userId: filter.userId } : {}) },
        orderBy: { at: 'desc' },
        take: Math.min(Math.max(filter.limit ?? 200, 1), 1000),
      });
      return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
    }, 'Failed to read access audit');
  }
}
