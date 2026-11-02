import type { PrismaClient } from '@prisma/client';
import {
  type Hospital,
  type HospitalResource,
  type HospitalWithResources,
  AppError,
  HOSPITAL_RESOURCE_TYPES,
  defineEvent,
} from '@resus/core';
import { guardDatabase, withTransaction } from '../db/client.js';
import type { EventService } from '../events/eventService.js';
import { mapHospital, mapHospitalResource } from '../models/mappers.js';

export class HospitalRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly events?: EventService,
  ) {}

  async list(filter: { includeSimulation?: boolean } = {}): Promise<Hospital[]> {
    return guardDatabase(async () => {
      const rows = await this.db.hospital.findMany({
        where: filter.includeSimulation ? {} : { isSimulation: false },
        orderBy: { name: 'asc' },
      });
      return rows.map((row) => mapHospital(row as unknown as Record<string, unknown>));
    }, 'Failed to list hospitals');
  }

  /**
   * Hospitals together with their resource rows, in one query.
   *
   * Module 7 scores suitability against live bed/specialist/equipment counts, so
   * it needs the hospital and its `HospitalResource` rows together. Read-only:
   * this never writes availability.
   */
  async listWithResources(filter: { includeSimulation?: boolean } = {}): Promise<HospitalWithResources[]> {
    return guardDatabase(async () => {
      const rows = await this.db.hospital.findMany({
        where: filter.includeSimulation ? {} : { isSimulation: false },
        include: { resources: true },
        orderBy: { name: 'asc' },
      });
      return rows.map((row) => {
        const record = row as unknown as Record<string, unknown>;
        const resources = Array.isArray(record.resources) ? record.resources : [];
        return {
          ...mapHospital(record),
          resources: resources.map((resource) =>
            mapHospitalResource(resource as Record<string, unknown>),
          ),
        };
      });
    }, 'Failed to list hospitals with resources');
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

  /**
   * Updates one existing resource row and records `HOSPITAL_RESOURCE_UPDATED`
   * in the same transaction. The row must already exist (seeded or created by
   * an approved path): this never fabricates capacity for an unknown
   * hospital/resource pair, and the event commits only with the write.
   */
  async updateResourceAvailability(input: {
    hospitalId: string;
    resourceType: string;
    code?: string | null;
    total: number;
    available: number;
    actor?: { actorType?: string; actorId?: string | null };
  }): Promise<HospitalResource> {
    if (!(HOSPITAL_RESOURCE_TYPES as readonly string[]).includes(input.resourceType)) {
      throw AppError.validation(`Unknown hospital resource type '${input.resourceType}'.`);
    }
    if (!Number.isInteger(input.total) || input.total < 0) {
      throw AppError.validation('Resource total must be a non-negative integer.');
    }
    if (!Number.isInteger(input.available) || input.available < 0) {
      throw AppError.validation('Resource available must be a non-negative integer.');
    }
    if (input.available > input.total) {
      throw AppError.validation('Resource available cannot exceed total.');
    }
    const code = input.code ?? '';
    const row = await guardDatabase(
      async () =>
        withTransaction(this.db, async (tx) => {
          const existing = await tx.hospitalResource.findUnique({
            where: {
              hospitalId_resourceType_code: {
                hospitalId: input.hospitalId,
                resourceType: input.resourceType,
                code,
              },
            },
          });
          if (!existing) {
            throw AppError.notFound(
              'Hospital resource',
              `${input.hospitalId}/${input.resourceType}/${code || 'default'}`,
            );
          }
          const updated = await tx.hospitalResource.update({
            where: {
              hospitalId_resourceType_code: {
                hospitalId: input.hospitalId,
                resourceType: input.resourceType,
                code,
              },
            },
            data: { total: input.total, available: input.available },
          });
          if (this.events) {
            await this.events.recordInTransaction(
              tx as never,
              defineEvent('HOSPITAL_RESOURCE_UPDATED', {
                entityType: 'hospital',
                entityId: input.hospitalId,
                actorType: input.actor?.actorType ?? 'OPERATOR',
                actorId: input.actor?.actorId ?? null,
                payload: {
                  hospitalId: input.hospitalId,
                  resourceType: input.resourceType,
                  code,
                  total: input.total,
                  available: input.available,
                },
              }),
            );
          }
          return updated;
        }),
      'Failed to update hospital resource',
    );
    return mapHospitalResource(row as unknown as Record<string, unknown>);
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
