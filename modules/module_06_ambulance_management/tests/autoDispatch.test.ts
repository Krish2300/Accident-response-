import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  ErrorCode,
  type Emergency,
  type SystemEventRecord,
  type SystemEventType,
} from '@resus/core';
import { AutoDispatchService } from '../src/dispatch/autoDispatchService.js';

class FakeBus {
  private readonly subs: Array<{
    types: SystemEventType[];
    handler: (event: SystemEventRecord) => void | Promise<void>;
  }> = [];

  subscribe<T extends SystemEventType>(
    types: T[],
    handler: (event: SystemEventRecord) => void | Promise<void>,
  ): () => void {
    this.subs.push({ types, handler });
    return () => {};
  }

  publish(event: SystemEventRecord): void {
    for (const sub of this.subs) {
      if (!sub.types.includes(event.type)) continue;
      void sub.handler(event);
    }
  }
}

function makeEmergency(overrides: Partial<Emergency> = {}): Emergency {
  return {
    id: 'EMG-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'CREATED',
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

function makeEvent(id: string, type: SystemEventType = 'EMERGENCY_CREATED'): SystemEventRecord {
  return {
    id: `EVT-${id}-${type}`,
    sequence: 1,
    type,
    emergencyId: id,
    entityType: 'emergency',
    entityId: id,
    timestamp: new Date().toISOString(),
    actorType: 'SYSTEM',
    actorId: null,
    payload: {},
    metadata: null,
  };
}

function makeConfig(includeSimulation = false) {
  return {
    fleet: {
      maxStaleLocationMinutes: 10,
      maxAmbulances: 50,
      defaultAverageSpeedKmh: 40,
      trafficFactor: 1.25,
    },
    assignment: {
      timeoutMs: 5000,
      maxRetries: 3,
      minConfidenceScore: 0.3,
      enableManualOverride: true,
    },
    dispatch: { timeoutMs: 5000, requireValidLocation: true },
    simulation: { enabled: false, updateIntervalMs: 2000 },
    autoDispatch: { enabled: true, includeSimulation },
  };
}

interface HarnessOptions {
  findById?: (id: string) => Promise<Emergency | null>;
  getAssignments?: (emergencyId: string) => Promise<unknown[]>;
  selectAndAssign?: (criteria: unknown) => Promise<unknown>;
  includeSimulation?: boolean;
}

function buildHarness(options: HarnessOptions = {}) {
  const findById = vi.fn(options.findById ?? (async () => makeEmergency()));
  const getAssignments = vi.fn(options.getAssignments ?? (async () => []));
  const selectAndAssign = vi.fn(
    options.selectAndAssign ?? (async () => ({ ambulanceId: 'AMB-1', assignmentId: 'ASG-1' })),
  );
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const bus = new FakeBus();
  const service = new AutoDispatchService({
    events: bus,
    assignment: { selectAndAssign } as never,
    fleet: { getAssignmentsForEmergency: getAssignments } as never,
    emergencies: { findById } as never,
    config: makeConfig(options.includeSimulation) as never,
    logger: logger as never,
  });
  return { service, bus, findById, getAssignments, selectAndAssign, logger };
}

describe('AutoDispatchService', () => {
  it('assigns an eligible emergency when its created event fires', async () => {
    const { service, bus, selectAndAssign } = buildHarness();

    bus.publish(makeEvent('EMG-1'));
    await service.idle();

    expect(selectAndAssign).toHaveBeenCalledTimes(1);
    expect(selectAndAssign).toHaveBeenCalledWith({
      emergencyId: 'EMG-1',
      latitude: 12.9716,
      longitude: 77.5946,
    });
  });

  it('reports a successful assignment', async () => {
    const { service } = buildHarness();
    const result = await service.dispatchForEmergency('EMG-1');
    expect(result.outcome).toBe('ASSIGNED');
    expect(result.ambulanceId).toBe('AMB-1');
    expect(result.assignmentId).toBe('ASG-1');
  });

  it('skips an emergency that already has an assigned unit', async () => {
    const getAssignments = vi.fn(async () => [
      { id: 'ASG-9', ambulanceId: 'AMB-9', emergencyId: 'EMG-1', status: 'ASSIGNED' },
    ]);
    const { service, selectAndAssign } = buildHarness({ getAssignments });

    const result = await service.dispatchForEmergency('EMG-1');
    expect(result.outcome).toBe('SKIPPED_ALREADY_ASSIGNED');
    expect(result.ambulanceId).toBe('AMB-9');
    expect(selectAndAssign).not.toHaveBeenCalled();
  });

  it('collapses concurrent events for the same emergency', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((res) => {
      resolve = res as (value: unknown) => void;
    });
    const selectAndAssign = vi.fn(() => pending);
    const { service } = buildHarness({ selectAndAssign });

    const first = service.dispatchForEmergency('EMG-1');
    const second = await service.dispatchForEmergency('EMG-1');
    expect(second.outcome).toBe('SKIPPED_IN_FLIGHT');

    resolve({ ambulanceId: 'AMB-1', assignmentId: 'ASG-1' });
    expect((await first).outcome).toBe('ASSIGNED');
    expect(selectAndAssign).toHaveBeenCalledTimes(1);
  });

  it('does not double-assign when created and classified events both fire', async () => {
    const assignments: Array<Record<string, unknown>> = [];
    const selectAndAssign = vi.fn(async () => {
      assignments.push({ id: 'ASG-1', ambulanceId: 'AMB-1', status: 'ASSIGNED' });
      return { ambulanceId: 'AMB-1', assignmentId: 'ASG-1' };
    });
    const getAssignments = vi.fn(async () => assignments);
    const { service, bus } = buildHarness({ selectAndAssign, getAssignments });

    bus.publish(makeEvent('EMG-1', 'EMERGENCY_CREATED'));
    bus.publish(makeEvent('EMG-1', 'EMERGENCY_CLASSIFIED'));
    await service.idle();

    expect(selectAndAssign).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveLength(1);
  });

  it('reports no ambulance without throwing when the engine finds none', async () => {
    const selectAndAssign = vi.fn().mockRejectedValue(new Error('No available ambulances found'));
    const { service, logger } = buildHarness({ selectAndAssign });

    const result = await service.dispatchForEmergency('EMG-1');
    expect(result.outcome).toBe('NO_AMBULANCE');
    expect(result.ambulanceId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws out of the subscriber when a dispatch fails', async () => {
    const selectAndAssign = vi.fn().mockRejectedValue(new Error('No suitable ambulance found'));
    const { service, bus } = buildHarness({ selectAndAssign });

    bus.publish(makeEvent('EMG-1'));
    await expect(service.idle()).resolves.toBeUndefined();
  });

  it('skips an emergency whose coordinates are invalid', async () => {
    const findById = vi.fn(async () => makeEmergency({ latitude: 999, longitude: 999 }));
    const { service, selectAndAssign } = buildHarness({ findById });

    const result = await service.dispatchForEmergency('EMG-1');
    expect(result.outcome).toBe('SKIPPED_INVALID_LOCATION');
    expect(selectAndAssign).not.toHaveBeenCalled();
  });

  it('reports an unexpected failure without claiming success', async () => {
    const selectAndAssign = vi
      .fn()
      .mockRejectedValue(new AppError(ErrorCode.DATABASE_FAILURE, 'database down', 500));
    const { service } = buildHarness({ selectAndAssign });

    const result = await service.dispatchForEmergency('EMG-1');
    expect(result.outcome).toBe('FAILED');
    expect(result.ambulanceId).toBeUndefined();
  });

  it('skips an emergency that is already beyond needing a unit', async () => {
    const findById = vi.fn(async () => makeEmergency({ status: 'TRANSPORTING' }));
    const { service, selectAndAssign } = buildHarness({ findById });

    const result = await service.dispatchForEmergency('EMG-1');
    expect(result.outcome).toBe('SKIPPED_STATUS');
    expect(selectAndAssign).not.toHaveBeenCalled();
  });

  it('skips an emergency that does not exist', async () => {
    const findById = vi.fn(async () => null);
    const { service } = buildHarness({ findById });
    const result = await service.dispatchForEmergency('EMG-1');
    expect(result.outcome).toBe('SKIPPED_NOT_FOUND');
  });

  it('skips simulation emergencies by default', async () => {
    const findById = vi.fn(async () => makeEmergency({ isSimulation: true }));
    const { service, selectAndAssign } = buildHarness({ findById });

    const result = await service.dispatchForEmergency('EMG-1');
    expect(result.outcome).toBe('SKIPPED_SIMULATION');
    expect(selectAndAssign).not.toHaveBeenCalled();
  });

  it('dispatches simulation emergencies when explicitly configured', async () => {
    const findById = vi.fn(async () => makeEmergency({ isSimulation: true }));
    const { service, selectAndAssign } = buildHarness({ findById, includeSimulation: true });

    const result = await service.dispatchForEmergency('EMG-1');
    expect(result.outcome).toBe('ASSIGNED');
    expect(selectAndAssign).toHaveBeenCalledTimes(1);
  });
});
