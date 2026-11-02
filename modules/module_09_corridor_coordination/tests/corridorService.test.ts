import { describe, expect, it } from 'vitest';
import { noopLogger } from '@resus/core';
import { CorridorService } from '../src/corridorService.js';
import { MockRoadUserProvider } from '../src/providers/roadUserProvider.js';
import {
  buildService,
  FakeCorridorWriter,
  FakeNotificationWriter,
  makeRoute,
  TEST_CONFIG,
} from './support.js';

describe('Module 9 CorridorService', () => {
  it('activates a corridor, persists simulated road users, and records a suppressed notification', async () => {
    const { corridors, notifications, service } = buildService();
    const outcome = await service.activateForRoute(makeRoute());

    expect(outcome.outcome).toBe('ACTIVATED');
    expect(outcome.priorityMode).toBe('SIMULATED');
    expect(outcome.isLive).toBe(false);
    expect(outcome.signalsControlled).toBe(false);
    expect(outcome.simulatedRoadUsers.length).toBeGreaterThan(0);
    expect(outcome.simulatedRoadUsers.every((u) => u.simulated === true)).toBe(true);
    expect(outcome.simulatedRoadUsers.every((u) => u.id.startsWith('SIM-RU-'))).toBe(true);

    const stored = corridors.records.get('EMG-1')!;
    expect(stored.priorityMode).toBe('SIMULATED');
    expect(stored.radiusM).toBe(150);
    expect(stored.status).toBe('ACTIVE');
    expect(stored.geofence.length).toBeGreaterThan(1);
    expect(stored.signals).toEqual([]);

    expect(corridors.events).toEqual(['CORRIDOR_ACTIVATED']);
    expect(notifications.records).toHaveLength(1);
    const notification = notifications.records[0]!;
    expect(notification.delivered).toBe(false);
    expect(notification.status).toBe('SUPPRESSED');
    expect(notification.provider).toBe('mock-notification');
    expect(notification.audience).toBe('NEARBY_ROAD_USERS');
    expect(notification.body).toContain('SIMULATED');
  });

  it('is idempotent: a second activation yields ALREADY_ACTIVE with no second event or notification', async () => {
    const { corridors, notifications, service } = buildService();
    await service.activateForRoute(makeRoute());
    const second = await service.activateForRoute(makeRoute());

    expect(second.outcome).toBe('ALREADY_ACTIVE');
    expect(corridors.events).toEqual(['CORRIDOR_ACTIVATED']);
    expect(notifications.records).toHaveLength(1);
  });

  it('does not emit a success event when persistence fails', async () => {
    const { corridors, notifications, service } = buildService();
    corridors.failActivation = true;

    const outcome = await service.activateForRoute(makeRoute());
    expect(outcome.outcome).toBe('FAILED');
    expect(outcome.corridorId).toBeNull();
    expect(corridors.events).toEqual([]);
    expect(notifications.records).toEqual([]);
  });

  it('skips a simulation emergency unless inclusion is configured', async () => {
    const { service } = buildService();
    const skipped = await service.activateForRoute(makeRoute({ isSimulation: true }));
    expect(skipped.outcome).toBe('SKIPPED');

    const { service: including } = buildService({ ...TEST_CONFIG, includeSimulation: true });
    const outcome = await including.activateForRoute(makeRoute({ isSimulation: true }));
    expect(outcome.outcome).toBe('ACTIVATED');
    expect(outcome.isSimulation).toBe(true);
  });

  it('skips when there is no destination hospital or no usable geometry', async () => {
    const { service } = buildService();
    const noHospital = await service.activateForRoute(makeRoute({ hospitalId: null }));
    expect(noHospital.outcome).toBe('SKIPPED');

    const noGeometry = await service.activateForRoute(makeRoute({ polyline: [[12.97, 77.59]] }));
    expect(noGeometry.outcome).toBe('SKIPPED');
  });

  it('still records a notification intent as delivered:false when the provider throws', async () => {
    const corridors = new FakeCorridorWriter();
    const notifications = new FakeNotificationWriter();
    const service = new CorridorService({
      corridors,
      notifications,
      roadUsers: new MockRoadUserProvider({ maxUsers: 2 }),
      notificationProvider: {
        providerName: 'broken',
        isLive: false,
        notify: async () => {
          throw new Error('provider down');
        },
      },
      config: TEST_CONFIG,
      logger: noopLogger,
    });

    const outcome = await service.activateForRoute(makeRoute());
    expect(outcome.outcome).toBe('ACTIVATED');
    expect(notifications.records).toHaveLength(1);
    expect(notifications.records[0]!.delivered).toBe(false);
    expect(notifications.records[0]!.status).toBe('FAILED');
    expect(notifications.records[0]!.provider).toBe('broken');
  });

  it('releases once and is idempotent afterwards', async () => {
    const { corridors, service } = buildService();
    await service.activateForRoute(makeRoute());

    const first = await service.release('EMG-1', 'COMPLETED');
    expect(first.outcome).toBe('RELEASED');
    const second = await service.release('EMG-1');
    expect(second.outcome).toBe('ALREADY_RELEASED');
    expect(corridors.events).toEqual(['CORRIDOR_ACTIVATED', 'CORRIDOR_RELEASED']);
    expect(corridors.records.get('EMG-1')!.status).toBe('RELEASED');
  });

  it('reports persisted state without ever presenting it as live', async () => {
    const { service } = buildService();
    await service.activateForRoute(makeRoute());

    const state = await service.getState('EMG-1');
    expect(state.corridor?.status).toBe('ACTIVE');
    expect(state.isLive).toBe(false);
    expect(state.signalsControlled).toBe(false);

    const missing = await service.getState('EMG-404');
    expect(missing.corridor).toBeNull();
  });
});
