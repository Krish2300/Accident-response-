import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteTable, type HttpRequest } from '@resus/core';
import { registerRoutes } from '../../../apps/server/src/http/routeAdapter.js';
import { createModule9Routes } from '../src/api/routes.js';
import { CorridorIntegrationAdapter } from '../src/corridorIntegration.js';
import type { CorridorRoute } from '../src/ports.js';

describe('Module 9 explicit simulated corridor route', () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  const transportRoute: CorridorRoute = {
    id: 'RTE-T', emergencyId: 'EMG-1', ambulanceId: 'AMB-1', hospitalId: 'HSP-1',
    originName: 'SCENE', destinationName: 'HOSPITAL',
    polyline: [[12.97, 77.59], [12.98, 77.6]] as Array<[number, number]>,
    estimatedMinutes: 5, isSimulation: true,
  };

  function mount(routes: CorridorRoute[] = [transportRoute], activationOutcome = 'ACTIVATED') {
    const activateForRoute = vi.fn(async () => ({
      outcome: activationOutcome,
      emergencyId: 'EMG-1',
      corridorId: activationOutcome === 'SKIPPED' || activationOutcome === 'FAILED' ? null : 'COR-1',
      status: activationOutcome === 'ACTIVATED' || activationOutcome === 'ALREADY_ACTIVE' ? 'ACTIVE' : null,
      reason: activationOutcome === 'SKIPPED' ? 'simulation emergencies are not coordinated' : undefined,
      released: activationOutcome === 'ACTIVATED',
      isSimulation: true,
      priorityMode: 'SIMULATED',
      isLive: false,
      signalsControlled: false,
      radiusM: 150,
      simulatedRoadUsers: [],
      notifications: [],
    }) as never);
    const integration = new CorridorIntegrationAdapter({
      corridors: { activateForRoute } as never,
      routes: { routesForEmergency: vi.fn(async (id: string) => routes.filter((route) => route.emergencyId === id)) },
    });
    const table = new RouteTable();
    table.addAll(createModule9Routes({ getState: vi.fn(async () => ({ corridor: null, isLive: false, signalsControlled: false })) } as never, integration));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async (request: HttpRequest) => {
        const token = request.headers.authorization;
        if (token === 'Bearer dispatcher') return { userId: 'U-D', role: 'DISPATCHER', email: 'dispatch@example.test' };
        if (token === 'Bearer operator') return { userId: 'U-O', role: 'OPERATOR', email: 'operator@example.test' };
        return null;
      },
    });
    return { activateForRoute };
  }

  it('requires dispatcher/admin authentication and validates the empty action body', async () => {
    mount();
    expect((await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/corridor', payload: {} })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/corridor', headers: { authorization: 'Bearer operator' }, payload: {} })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/corridor', headers: { authorization: 'Bearer dispatcher' }, payload: { routeId: 'RTE-T' } })).statusCode).toBe(422);
  });

  it('requires a persisted transport route and never fabricates route geometry', async () => {
    const { activateForRoute } = mount([]);
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/corridor', headers: { authorization: 'Bearer dispatcher' }, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('NO_ROUTE_AVAILABLE');
    expect(activateForRoute).not.toHaveBeenCalled();
  });

  it('activates through the existing corridor service and returns explicit simulation caveats', async () => {
    const { activateForRoute } = mount();
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/corridor', headers: { authorization: 'Bearer dispatcher' }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(activateForRoute).toHaveBeenCalledWith(transportRoute);
    expect(response.json()).toMatchObject({
      emergencyId: 'EMG-1', routeId: 'RTE-T',
      simulation: { priorityMode: 'SIMULATED', isLive: false, signalsControlled: false, notificationsDelivered: false },
    });
  });

  it.each([
    ['SKIPPED', 409],
    ['FAILED', 500],
    ['ALREADY_ACTIVE', 200],
  ])('maps service outcome %s to HTTP %s without false success', async (outcome, status) => {
    mount([transportRoute], outcome);
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/corridor', headers: { authorization: 'Bearer dispatcher' }, payload: {} });
    expect(response.statusCode).toBe(status);
    if (status !== 200) expect(response.json()).toHaveProperty('error');
  });

  it('ignores response routes and only accepts a hospital-bound route for this emergency', async () => {
    const responseRoute = { ...transportRoute, id: 'RTE-R', destinationName: 'SCENE', hospitalId: null };
    const { activateForRoute } = mount([responseRoute]);
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/corridor', headers: { authorization: 'Bearer dispatcher' }, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(activateForRoute).not.toHaveBeenCalled();
  });
});
