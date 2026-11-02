import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteTable, type HttpRequest } from '@resus/core';
import { registerRoutes } from '../../../apps/server/src/http/routeAdapter.js';
import { createModule9Routes } from '../src/api/routes.js';

describe('Module 9 simulated police notice routes', () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('enforces dispatcher action roles and labels create/acknowledgement as simulated', async () => {
    const notification = { id: 'NTF-1', status: 'SIMULATED_SENT', audience: 'MOCK_POLICE_CONTROL_ROOM', delivered: false };
    const policeNotifications = {
      list: vi.fn(async () => [notification]),
      create: vi.fn(async () => notification),
      acknowledge: vi.fn(async () => ({ ...notification, status: 'ACKNOWLEDGED_SIMULATED' })),
    };
    const table = new RouteTable();
    table.addAll(createModule9Routes({ getState: vi.fn() } as never, {} as never, policeNotifications as never));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async (request: HttpRequest) => request.headers.authorization === 'Bearer dispatcher'
        ? { userId: 'USER-D', role: 'DISPATCHER', email: 'd@example.test' }
        : request.headers.authorization === 'Bearer operator'
          ? { userId: 'USER-O', role: 'OPERATOR', email: 'o@example.test' }
          : null,
    });

    expect((await app.inject({ method: 'POST', url: '/api/emergencies/EMG-1/police-notifications', headers: { authorization: 'Bearer operator' }, payload: { routeId: 'RTE-1' } })).statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/emergencies/EMG-1/police-notifications', headers: { authorization: 'Bearer dispatcher' }, payload: { routeId: 'RTE-1' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ simulation: true, recipient: 'MOCK_POLICE_CONTROL_ROOM', realPoliceContacted: false, trafficCleared: false, signalPriorityGranted: false });
    expect(policeNotifications.create).toHaveBeenCalledWith('EMG-1', 'RTE-1', 'USER-D');

    const acknowledged = await app.inject({ method: 'POST', url: '/api/emergencies/EMG-1/police-notifications/NTF-1/acknowledge', headers: { authorization: 'Bearer dispatcher' }, payload: {} });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toMatchObject({ simulation: true, realPoliceAcknowledged: false, notification: { status: 'ACKNOWLEDGED_SIMULATED' } });
    expect(policeNotifications.acknowledge).toHaveBeenCalledWith('EMG-1', 'NTF-1', 'USER-D');
  });
});
