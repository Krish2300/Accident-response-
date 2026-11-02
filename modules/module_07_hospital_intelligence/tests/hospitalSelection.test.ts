import { describe, expect, it, vi } from 'vitest';
import type {
  Emergency,
  HospitalWithResources,
  HospitalResource,
  SystemEventEnvelope,
  SystemEventRecord,
} from '@resus/core';
import { loadModule7Config } from '../src/config.js';
import {
  HospitalSelectionService,
  type EmergencySelectionPort,
  type HospitalCandidatePort,
} from '../src/hospitalSelectionService.js';

const config = loadModule7Config();

function makeHospital(
  id: string,
  name: string,
  latitude: number,
  longitude: number,
  capability: HospitalWithResources['capabilities'][number],
  resources: HospitalResource[],
): HospitalWithResources {
  return {
    id,
    name,
    latitude,
    longitude,
    status: 'OPEN',
    capabilities: [capability, 'GENERAL'],
    traumaLevel: 2,
    acceptingEmergencies: true,
    contactPhone: null,
    address: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resources,
  };
}

function res(hospitalId: string, resourceType: HospitalResource['resourceType'], available: number): HospitalResource {
  return {
    id: `RSC-${hospitalId}-${resourceType}`,
    hospitalId,
    resourceType,
    code: '',
    total: Math.max(available, 1),
    available,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function emergency(overrides: Partial<Emergency> = {}): Emergency {
  return {
    id: 'EMG-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'CLASSIFIED',
    incidentType: 'CARDIAC_ARREST',
    severity: 'CRITICAL',
    latitude: 12.9716,
    longitude: 77.5946,
    description: null,
    callerId: null,
    assignedAmbulanceId: null,
    selectedHospitalId: null,
    isSimulation: false,
    ...overrides,
  };
}

function harness(hospitals: HospitalWithResources[], initial: Emergency = emergency()) {
  const recorded: SystemEventEnvelope[] = [];
  let stored = initial;

  const candidates: HospitalCandidatePort = {
    listWithResources: vi.fn().mockResolvedValue(hospitals),
  };

  const emergencies: EmergencySelectionPort = {
    findById: vi.fn(async () => stored),
    update: vi.fn(async (_id, patch, event) => {
      stored = { ...stored, ...patch };
      if (event) recorded.push(event as SystemEventEnvelope);
      return stored;
    }),
  };

  const events = {
    record: vi.fn(async (event: SystemEventEnvelope) => {
      recorded.push(event);
      return { id: 'EVT', type: event.type, payload: event.payload } as unknown as SystemEventRecord;
    }),
    recordMany: vi.fn(async (list: SystemEventEnvelope[]) => list as unknown as SystemEventRecord[]),
    recordInTransaction: vi.fn(),
  };

  const service = new HospitalSelectionService({ hospitals: candidates, emergencies, events: events as never, config });
  return { service, recorded, candidates, emergencies, events, current: () => stored };
}

describe('HospitalSelectionService.rank', () => {
  it('orders eligible hospitals by score, then distance', async () => {
    const near = makeHospital('HSP-NEAR', 'Near', 12.975, 77.595, 'ED_CARDIAC', [res('HSP-NEAR', 'ICU_BED', 1)]);
    const far = makeHospital('HSP-FAR', 'Far', 13.02, 77.62, 'ED_CARDIAC', [res('HSP-FAR', 'ICU_BED', 4)]);

    const { service } = harness([near, far]);
    const ranking = await service.rank({ incidentType: 'CARDIAC_ARREST', latitude: 12.9716, longitude: 77.5946 });

    expect(ranking.selected?.hospital.id).toBe('HSP-NEAR');
    expect(ranking.consideredCandidates).toBe(2);
  });

  it('never returns an ineligible hospital as selected', async () => {
    const full = makeHospital('HSP-FULL', 'Full', 12.975, 77.595, 'ED_CARDIAC', [res('HSP-FULL', 'ICU_BED', 0)]);
    const { service } = harness([full]);

    const ranking = await service.rank({ incidentType: 'CARDIAC_ARREST', latitude: 12.9716, longitude: 77.5946 });

    expect(ranking.selected).toBeNull();
    expect(ranking.rejected).toHaveLength(1);
  });
});

describe('HospitalSelectionService.selectForEmergency', () => {
  it('writes selectedHospitalId and emits HOSPITAL_SELECTED', async () => {
    const near = makeHospital('HSP-NEAR', 'Near', 12.975, 77.595, 'ED_CARDIAC', [res('HSP-NEAR', 'ICU_BED', 2)]);
    const { service, recorded, current } = harness([near]);

    const result = await service.selectForEmergency('EMG-1');

    expect(result.outcome).toBe('SELECTED');
    expect(result.hospitalId).toBe('HSP-NEAR');
    expect(current().selectedHospitalId).toBe('HSP-NEAR');

    const selected = recorded.find((event) => event.type === 'HOSPITAL_SELECTED');
    expect(selected).toBeDefined();
    expect((selected!.payload as { hospitalId: string }).hospitalId).toBe('HSP-NEAR');
  });

  it('records HOSPITAL_REJECTED for an in-range hospital ruled out on resources', async () => {
    const full = makeHospital('HSP-FULL', 'Full', 12.975, 77.595, 'ED_CARDIAC', [res('HSP-FULL', 'ICU_BED', 0)]);
    const ready = makeHospital('HSP-READY', 'Ready', 12.99, 77.6, 'ED_CARDIAC', [res('HSP-READY', 'ICU_BED', 2)]);
    const { service, recorded } = harness([full, ready]);

    const result = await service.selectForEmergency('EMG-1');

    expect(result.outcome).toBe('SELECTED');
    const rejected = recorded.filter((event) => event.type === 'HOSPITAL_REJECTED');
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.payload as { hospitalId: string }).hospitalId).toBe('HSP-FULL');
  });

  it('is idempotent: skips an emergency that already has a selected hospital', async () => {
    const near = makeHospital('HSP-NEAR', 'Near', 12.975, 77.595, 'ED_CARDIAC', [res('HSP-NEAR', 'ICU_BED', 2)]);
    const { service, emergencies, recorded } = harness([near], emergency({ selectedHospitalId: 'HSP-EXISTING' }));

    const result = await service.selectForEmergency('EMG-1');

    expect(result.outcome).toBe('SKIPPED_ALREADY_SELECTED');
    expect(emergencies.update).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it('serializes concurrent explicit selections for the same emergency', async () => {
    const near = makeHospital('HSP-NEAR', 'Near', 12.975, 77.595, 'ED_CARDIAC', [res('HSP-NEAR', 'ICU_BED', 2)]);
    const { service, candidates, recorded } = harness([near]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    candidates.listWithResources = vi.fn(async () => {
      await gate;
      return [near];
    });

    const first = service.selectForEmergency('EMG-1');
    const second = service.selectForEmergency('EMG-1');
    release();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.outcome)).toEqual(['SELECTED', 'SELECTED']);
    expect(candidates.listWithResources).toHaveBeenCalledTimes(1);
    expect(recorded.filter((event) => event.type === 'HOSPITAL_SELECTED')).toHaveLength(1);
  });

  it('skips simulation emergencies unless explicitly enabled', async () => {
    const near = makeHospital('HSP-NEAR', 'Near', 12.975, 77.595, 'ED_CARDIAC', [res('HSP-NEAR', 'ICU_BED', 2)]);
    const { service, emergencies } = harness([near], emergency({ isSimulation: true }));

    const result = await service.selectForEmergency('EMG-1');

    expect(result.outcome).toBe('SKIPPED_SIMULATION');
    expect(emergencies.update).not.toHaveBeenCalled();
  });

  it('reports NO_CANDIDATE and writes nothing when nothing qualifies', async () => {
    const full = makeHospital('HSP-FULL', 'Full', 12.975, 77.595, 'ED_CARDIAC', [res('HSP-FULL', 'ICU_BED', 0)]);
    const { service, emergencies, recorded } = harness([full]);

    const result = await service.selectForEmergency('EMG-1');

    expect(result.outcome).toBe('NO_CANDIDATE');
    expect(emergencies.update).not.toHaveBeenCalled();
    expect(recorded.map((event) => event.type)).not.toContain('HOSPITAL_SELECTED');
  });

  it('skips a terminal emergency', async () => {
    const near = makeHospital('HSP-NEAR', 'Near', 12.975, 77.595, 'ED_CARDIAC', [res('HSP-NEAR', 'ICU_BED', 2)]);
    const { service, emergencies } = harness([near], emergency({ status: 'CANCELLED' }));

    const result = await service.selectForEmergency('EMG-1');

    expect(result.outcome).toBe('SKIPPED_STATUS');
    expect(emergencies.update).not.toHaveBeenCalled();
  });
});
