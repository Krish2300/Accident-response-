import { describe, expect, it } from 'vitest';
import type { HospitalWithResources } from '@resus/core';
import { loadModule7Config } from '../src/config.js';
import { requirementFor, scoreHospital } from '../src/suitability.js';

const config = loadModule7Config();

function hospital(overrides: Partial<HospitalWithResources> = {}): HospitalWithResources {
  return {
    id: 'HSP-1',
    name: 'Test Hospital',
    latitude: 12.9716,
    longitude: 77.5946,
    status: 'OPEN',
    capabilities: ['GENERAL'],
    traumaLevel: 1,
    acceptingEmergencies: true,
    contactPhone: null,
    address: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resources: [],
    ...overrides,
  };
}

function resource(
  hospitalId: string,
  resourceType: HospitalWithResources['resources'][number]['resourceType'],
  available: number,
  code = '',
) {
  return {
    id: `RSC-${resourceType}-${code || '0'}`,
    hospitalId,
    resourceType,
    code,
    total: Math.max(available, 1),
    available,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('module 7 incident requirements', () => {
  it('maps cardiac arrest to ED_CARDIAC + ICU_BED', () => {
    expect(requirementFor('CARDIAC_ARREST')).toEqual({ capability: 'ED_CARDIAC', resourceType: 'ICU_BED' });
  });

  it('maps trauma to ED_TRAUMA + EMERGENCY_BED', () => {
    expect(requirementFor('TRAUMA')).toEqual({ capability: 'ED_TRAUMA', resourceType: 'EMERGENCY_BED' });
  });

  it('falls back to GENERAL for unknown incidents', () => {
    expect(requirementFor('OTHER').capability).toBe('GENERAL');
  });
});

describe('module 7 hospital scoring', () => {
  const incident = { incidentType: 'CARDIAC_ARREST' as const, latitude: 12.9716, longitude: 77.5946 };

  it('rejects a closer hospital with no free ICU, regardless of distance', () => {
    const near = hospital({
      id: 'HSP-NEAR',
      name: 'Close But Full',
      latitude: 12.975,
      longitude: 77.595,
      capabilities: ['ED_CARDIAC', 'GENERAL'],
      resources: [resource('HSP-NEAR', 'ICU_BED', 0)],
    });

    const scored = scoreHospital(near, incident, config);

    expect(scored.eligible).toBe(false);
    expect(scored.rejectReason).toBe('no ICU_BED available');
  });

  it('accepts a farther hospital that has the capability and a free ICU', () => {
    const far = hospital({
      id: 'HSP-FAR',
      name: 'Far But Ready',
      latitude: 13.05,
      longitude: 77.63,
      capabilities: ['ED_CARDIAC', 'GENERAL'],
      resources: [resource('HSP-FAR', 'ICU_BED', 3), resource('HSP-ED', 'EMERGENCY_BED', 2)],
    });

    const scored = scoreHospital(far, incident, config);

    expect(scored.eligible).toBe(true);
    expect(scored.rejectReason).toBeNull();
    expect(scored.matchingFactors).toContain('has ED_CARDIAC');
    expect(scored.score).toBeGreaterThanOrEqual(config.scoring.capabilityMatch + config.scoring.resourceAvailable);
  });

  it('rejects a hospital outside the distance limit', () => {
    const remote = hospital({
      id: 'HSP-REMOTE',
      name: 'Remote',
      latitude: 13.5,
      longitude: 78.5,
      capabilities: ['ED_CARDIAC', 'GENERAL'],
      resources: [resource('HSP-REMOTE', 'ICU_BED', 5)],
    });

    const scored = scoreHospital(remote, incident, config);

    expect(scored.eligible).toBe(false);
    expect(scored.rejectReason).toContain('beyond');
  });

  it('rejects a hospital that is not accepting emergencies', () => {
    const closed = hospital({
      id: 'HSP-CLOSED',
      name: 'Diverting',
      acceptingEmergencies: false,
      capabilities: ['ED_CARDIAC', 'GENERAL'],
      resources: [resource('HSP-CLOSED', 'ICU_BED', 5)],
    });

    const scored = scoreHospital(closed, incident, config);

    expect(scored.eligible).toBe(false);
    expect(scored.rejectReason).toBe('hospital is not accepting emergencies');
  });
});
