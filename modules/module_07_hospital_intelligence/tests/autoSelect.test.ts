import { describe, expect, it, vi } from 'vitest';
import type { SystemEventRecord, SystemEventType } from '@resus/core';
import { AutoSelectService, AUTO_SELECT_EVENT_TYPES } from '../src/autoSelectService.js';
import type { HospitalSelectionResult, HospitalSelectionService } from '../src/hospitalSelectionService.js';

function fakeBus() {
  const handlers: Array<(event: SystemEventRecord) => void | Promise<void>> = [];
  let subscribedTypes: SystemEventType[] = [];
  return {
    subscribe: vi.fn((types: SystemEventType[], handler: (event: SystemEventRecord) => void | Promise<void>) => {
      subscribedTypes = types;
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    }),
    publish: vi.fn(),
    emit: (event: SystemEventRecord) => Promise.all(handlers.map((handler) => handler(event))),
    subscribedTypes: () => subscribedTypes,
    handlerCount: () => handlers.length,
  };
}

function event(type: SystemEventType, emergencyId: string | null): SystemEventRecord {
  return {
    id: 'EVT-1',
    sequence: 1,
    type,
    emergencyId,
    entityType: 'emergency',
    entityId: emergencyId,
    timestamp: '2026-01-01T00:00:00.000Z',
    actorType: 'SYSTEM',
    actorId: null,
    payload: { emergencyId },
    metadata: null,
  };
}

function fakeSelection(result: HospitalSelectionResult): HospitalSelectionService {
  return {
    selectForEmergency: vi.fn().mockResolvedValue(result),
  } as unknown as HospitalSelectionService;
}

describe('AutoSelectService', () => {
  it('subscribes only to EMERGENCY_CLASSIFIED', () => {
    const bus = fakeBus();
    new AutoSelectService({ events: bus as never, selection: fakeSelection({ emergencyId: 'EMG-1', outcome: 'SELECTED' }) });

    expect(bus.subscribedTypes()).toEqual(AUTO_SELECT_EVENT_TYPES);
    expect(AUTO_SELECT_EVENT_TYPES).toEqual(['EMERGENCY_CLASSIFIED']);
  });

  it('selects on a classification event for the carried emergency', async () => {
    const bus = fakeBus();
    const selection = fakeSelection({ emergencyId: 'EMG-1', outcome: 'SELECTED', hospitalId: 'HSP-1' });
    const service = new AutoSelectService({ events: bus as never, selection });

    await bus.emit(event('EMERGENCY_CLASSIFIED', 'EMG-1'));
    await service.idle();

    expect(selection.selectForEmergency).toHaveBeenCalledWith('EMG-1');
  });

  it('reads the emergency id from the payload when the envelope omits it', async () => {
    const bus = fakeBus();
    const selection = fakeSelection({ emergencyId: 'EMG-9', outcome: 'SELECTED' });
    const service = new AutoSelectService({ events: bus as never, selection });

    const result = await service.handleEvent({
      ...event('EMERGENCY_CLASSIFIED', null),
      payload: { emergencyId: 'EMG-9' },
    });
    expect(result.emergencyId).toBe('EMG-9');
    expect(selection.selectForEmergency).toHaveBeenCalledWith('EMG-9');
  });

  it('collapses concurrent selections for the same emergency', async () => {
    const bus = fakeBus();
    let release: (value: HospitalSelectionResult) => void = () => {};
    const pending = new Promise<HospitalSelectionResult>((resolve) => {
      release = resolve;
    });
    const selection = {
      selectForEmergency: vi.fn().mockReturnValue(pending),
    } as unknown as HospitalSelectionService;
    const service = new AutoSelectService({ events: bus as never, selection });

    const first = service.selectForEmergency('EMG-1');
    const second = await service.selectForEmergency('EMG-1');

    expect(second.outcome).toBe('SKIPPED_ALREADY_SELECTED');
    release({ emergencyId: 'EMG-1', outcome: 'SELECTED' });
    await first;
    expect(selection.selectForEmergency).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on dispose', () => {
    const bus = fakeBus();
    const service = new AutoSelectService({ events: bus as never, selection: fakeSelection({ emergencyId: 'EMG-1', outcome: 'SELECTED' }) });

    expect(bus.handlerCount()).toBe(1);
    service.dispose();
    expect(bus.handlerCount()).toBe(0);
  });

  it('reports no emergency id when the event carries none', async () => {
    const bus = fakeBus();
    const selection = fakeSelection({ emergencyId: '', outcome: 'SKIPPED_NOT_FOUND' });
    const service = new AutoSelectService({ events: bus as never, selection });

    const result = await service.handleEvent({
      ...event('EMERGENCY_CLASSIFIED', null),
      payload: {},
    });

    expect(result.outcome).toBe('SKIPPED_NOT_FOUND');
    expect(selection.selectForEmergency).not.toHaveBeenCalled();
  });
});
