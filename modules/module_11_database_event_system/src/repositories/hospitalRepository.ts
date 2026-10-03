import type { PrismaClient } from '@prisma/client';
import { type Hospital, AppError } from '@resus/core';
import { guardDatabase } from '../db/client.js';
import { mapHospital } from '../models/mappers.js';

export class HospitalRepository {
  constructor(private readonly db: PrismaClient) {}

  async list(filter: { includeSimulation?: boolean } = {}): Promise<Hospital[]> {
    return guardDatabase(async () => {
      const rows = await this.db.hospital.findMany({
        where: filter.includeSimulation ? {} : { isSimulation: false },
        orderBy: { name: 'asc' },
      });
      return rows.map((row) => mapHospital(row as unknown as Record<string, unknown>));
    }, 'Failed to list hospitals');
  }

  async findById(id: string): Promise<Hospital | null> {
    return guardDatabase(async () => {
      const row = await this.db.hospital.findUnique({ where: { id } });
      return row ? mapHospital(row as unknown as Record<string, unknown>) : null;
    }, 'Failed to read hospital');
  }

  async requireById(id: string): Promise<Hospital> {
    const hospital = await this.findById(id);
    if (!hospital) throw AppError.notFound('Hospital', id);
    return hospital;
  }

  async setStatus(id: string, status: string): Promise<Hospital> {
    const row = await guardDatabase(
      async () =>
        this.db.hospital.update({
          where: { id },
          data: { status, acceptingEmergencies: status === 'OPEN' },
        }),
      'Failed to update hospital status',
    );
    return mapHospital(row as unknown as Record<string, unknown>);
  }

  async countByStatus(includeSimulation: boolean): Promise<Record<string, number>> {
    return guardDatabase(async () => {
      const grouped = await this.db.hospital.groupBy({
        by: ['status'],
        where: includeSimulation ? {} : { isSimulation: false },
        _count: { _all: true },
      });
      return Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    }, 'Failed to count hospitals by status');
  }
}
