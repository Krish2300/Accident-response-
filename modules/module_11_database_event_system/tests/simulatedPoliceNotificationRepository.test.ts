import { describe, expect, it, vi } from 'vitest';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';

function harness() {
  const rows = new Map<string, Record<string, unknown>>();
  const writtenEvents: Array<{ type: string; payload: unknown }> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
  const notification = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('missing row');
      return row;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [...rows.values()].filter((row) => matches(row, where))),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: Record<string, unknown> = { corridorId: null, latitude: null, longitude: null, failureReason: null, sentAt: null, ...data };
      rows.set(String(row.id), row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = rows.get(String(where.id));
      if (!row || !matches(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const db = { notification, $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation({ notification })) };
  const events = { recordInTransaction: vi.fn(async (_tx: unknown, event: { type: string; payload: unknown }) => { writtenEvents.push(event); return event; }) };
  return { repository: new NotificationRepository(db as never, events as never), rows, writtenEvents };
}

const input = (routeId: string) => ({
  emergencyId: 'EMG-1', createdByUserId: 'DISPATCHER-1', ambulanceId: 'AMB-1', routeId, provider: 'deterministic',
  isLiveTraffic: false, routeIsSimulation: true, estimatedMinutes: 5, geometry: [[12.9, 77.5], [12.91, 77.51]] as Array<[number, number]>,
});

describe('Module 11 simulated police notification persistence', () => {
  it('is idempotent for the same emergency and route and atomically records a replacement/supersession', async () => {
    const { repository, rows, writtenEvents } = harness();
    const first = await repository.createPoliceRouteNotification(input('RTE-1'));
    const duplicate = await repository.createPoliceRouteNotification(input('RTE-1'));
    expect(duplicate.id).toBe(first.id);
    expect(writtenEvents.map((event) => event.type)).toEqual(['SIMULATED_POLICE_NOTIFICATION_CREATED']);
    expect(JSON.parse(first.body)).toMatchObject({ routeId: 'RTE-1', isLiveTraffic: false, routeIsSimulation: true, simulation: true, recipient: 'MOCK_POLICE_CONTROL_ROOM', delivered: false });

    const replacement = await repository.createPoliceRouteNotification(input('RTE-2'));
    expect(rows.get(first.id)?.status).toBe('SUPERSEDED');
    expect(replacement.status).toBe('SIMULATED_SENT');
    expect(writtenEvents.map((event) => event.type)).toEqual([
      'SIMULATED_POLICE_NOTIFICATION_CREATED', 'SIMULATED_POLICE_NOTIFICATION_SUPERSEDED', 'SIMULATED_POLICE_NOTIFICATION_CREATED',
    ]);
  });

  it('records only an explicit simulated acknowledgement and rejects a duplicate acknowledgement', async () => {
    const { repository, writtenEvents } = harness();
    const created = await repository.createPoliceRouteNotification(input('RTE-1'));
    const acknowledged = await repository.acknowledgePoliceRouteNotification({ emergencyId: 'EMG-1', notificationId: created.id, acknowledgedByUserId: 'DISPATCHER-1' });
    expect(acknowledged.status).toBe('ACKNOWLEDGED_SIMULATED');
    expect(writtenEvents.at(-1)).toMatchObject({ type: 'SIMULATED_POLICE_NOTIFICATION_ACKNOWLEDGED', payload: { routeId: 'RTE-1', simulation: true, acknowledgedByUserId: 'DISPATCHER-1' } });
    await expect(repository.acknowledgePoliceRouteNotification({ emergencyId: 'EMG-1', notificationId: created.id, acknowledgedByUserId: 'DISPATCHER-1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(writtenEvents.filter((event) => event.type === 'SIMULATED_POLICE_NOTIFICATION_ACKNOWLEDGED')).toHaveLength(1);
  });
});
