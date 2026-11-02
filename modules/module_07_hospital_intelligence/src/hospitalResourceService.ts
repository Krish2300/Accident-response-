import type { HospitalResource } from '@resus/core';

/**
 * The write side Module 7 needs to record a hospital resource availability
 * change. Implemented by Module 11's hospital repository, which persists the
 * count and records `HOSPITAL_RESOURCE_UPDATED` atomically.
 */
export interface HospitalResourceWriterPort {
  updateResourceAvailability(input: {
    hospitalId: string;
    resourceType: string;
    code?: string | null;
    total: number;
    available: number;
    actor?: { actorType?: string; actorId?: string | null };
  }): Promise<HospitalResource>;
}
