import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteTable, type HttpRequest } from '@resus/core';
import { registerRoutes } from '../../../apps/server/src/http/routeAdapter.js';
import { createModule8Routes } from '../src/api/routes.js';

describe('Module 8 explicit route-generation route', () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  const persistedRoute = {
    id: 'RTE-1', emergencyId: 'EMG-1', ambulanceId: 'AMB-1', hospitalId: null,
    originName: 'AMBULANCE', destinationName: 'SCENE', distanceKm: 2,
    polyline: [[12.97, 77.59], [12.98, 77.6]], estimatedMinutes: 4,
    provider: 'mock', isLiveTraffic: false, isSimulation: false,
  };

  function mount(result: Record<string, unknown> = { emergencyId: 'EMG-1', leg: 'RESPONSE', outcome: 'GENERATED', routeId: 'RTE-1' }) {
    const generateForEmergency = vi.fn(async () => result as never);
    const routes = { findById: vi.fn(async (id: string) => id === 'RTE-1' ? persistedRoute : null), routesForEmergency: vi.fn(async () => [persistedRoute]) };
    const table = new RouteTable();
    table.addAll(createModule8Routes({ generateForEmergency } as never, routes as never));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async (request: HttpRequest) => {
        const token = request.headers.authorization;
        if (token === 'Bearer dispatcher') return { userId: 'U-D', role: 'DISPATCHER', email: 'dispatch@example.test' };
        if (token === 'Bearer operator') return { userId: 'U-O', role: 'OPERATOR', email: 'operator@example.test' };
        return null;
      },
    });
    return { generateForEmergency, routes };
  }

  it('requires dispatcher/admin authentication and validates the requested route leg', async () => {
    mount();
    expect((await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/routes', payload: { leg: 'RESPONSE' } })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/routes', headers: { authorization: 'Bearer operator' }, payload: { leg: 'RESPONSE' } })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/routes', headers: { authorization: 'Bearer dispatcher' }, payload: { leg: 'ANY' } })).statusCode).toBe(422);
  });

  it('invokes the existing optimizer and returns persisted route provenance', async () => {
    const { generateForEmergency, routes } = mount();
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/routes', headers: { authorization: 'Bearer dispatcher' }, payload: { leg: 'RESPONSE' } });
    expect(response.statusCode).toBe(200);
    expect(generateForEmergency).toHaveBeenCalledWith('EMG-1', 'RESPONSE');
    expect(routes.findById).toHaveBeenCalledWith('RTE-1');
    expect(response.json().route).toMatchObject({ id: 'RTE-1', isLiveTraffic: false, provider: 'mock' });
  });

  it('requires a committed dispatch newer than the current assignment before response route generation', async () => {
    const generateForEmergency = vi.fn(async () => ({ emergencyId: 'EMG-1', leg: 'RESPONSE', outcome: 'GENERATED', routeId: 'RTE-1' } as never));
    const routes = { findById: vi.fn(async () => persistedRoute), routesForEmergency: vi.fn(async () => [persistedRoute]) };
    const dispatchEvents = { list: vi.fn(async () => ({ items: [
      { id: 'EVT-A', sequence: 4, type: 'AMBULANCE_ASSIGNED', payload: { ambulanceId: 'AMB-1' } },
      { id: 'EVT-D', sequence: 3, type: 'AMBULANCE_DISPATCHED', payload: { ambulanceId: 'AMB-1' } },
    ], total: 2, latestSequence: 4 })) };
    const table = new RouteTable();
    table.addAll(createModule8Routes({ generateForEmergency, getEmergencyForDispatchCheck: vi.fn(async () => ({ assignedAmbulanceId: 'AMB-1' })) } as never, routes as never, undefined, dispatchEvents as never));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async () => ({ userId: 'U-D', role: 'DISPATCHER', email: 'dispatch@example.test' }),
    });
    const response = await app.inject({ method: 'POST', url: '/api/emergencies/EMG-1/routes', payload: { leg: 'RESPONSE' } });
    expect(response.statusCode).toBe(409);
    expect(generateForEmergency).not.toHaveBeenCalled();
  });

  it('allows response route generation after the current ambulance dispatch is recorded', async () => {
    const generateForEmergency = vi.fn(async () => ({ emergencyId: 'EMG-1', leg: 'RESPONSE', outcome: 'GENERATED', routeId: 'RTE-1' } as never));
    const routes = { findById: vi.fn(async () => persistedRoute), routesForEmergency: vi.fn(async () => [persistedRoute]) };
    const dispatchEvents = { list: vi.fn(async () => ({ items: [
      { id: 'EVT-A', sequence: 3, type: 'AMBULANCE_ASSIGNED', payload: { ambulanceId: 'AMB-1' } },
      { id: 'EVT-D', sequence: 4, type: 'AMBULANCE_DISPATCHED', payload: { ambulanceId: 'AMB-1' } },
    ], total: 2, latestSequence: 4 })) };
    const table = new RouteTable();
    table.addAll(createModule8Routes({ generateForEmergency, getEmergencyForDispatchCheck: vi.fn(async () => ({ assignedAmbulanceId: 'AMB-1' })) } as never, routes as never, undefined, dispatchEvents as never));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, { authenticate: async () => ({ userId: 'U-D', role: 'DISPATCHER', email: 'dispatch@example.test' }) });
    const response = await app.inject({ method: 'POST', url: '/api/emergencies/EMG-1/routes', payload: { leg: 'RESPONSE' } });
    expect(response.statusCode).toBe(200);
    expect(generateForEmergency).toHaveBeenCalledWith('EMG-1', 'RESPONSE');
    expect(response.json().route).toMatchObject({ provider: 'mock', isLiveTraffic: false });
  });

  it('exposes only the authenticated driver ambulance response route after dispatch', async () => {
    const own = { ...persistedRoute, id: 'RTE-OWN', ambulanceId: 'AMB-1', hospitalId: 'HSP-1', destinationName: 'SCENE' };
    const foreign = { ...persistedRoute, id: 'RTE-OTHER', ambulanceId: 'AMB-2', destinationName: 'SCENE' };
    const routes = { routesForEmergency: vi.fn(async () => [own, foreign]) };
    const driverAmbulances = { getAssignedAmbulanceForDriver: vi.fn(async (driverId: string) => driverId === 'DRIVER-1'
      ? { id: 'AMB-1', status: 'EN_ROUTE', currentEmergencyId: 'EMG-1' }
      : null) };
    const table = new RouteTable();
    table.addAll(createModule8Routes({} as never, routes as never, driverAmbulances as never));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async (request: HttpRequest) => request.headers.authorization === 'Bearer driver'
        ? { userId: 'DRIVER-1', role: 'DRIVER', email: 'driver@example.test' }
        : null,
    });
    const denied = await app.inject({ method: 'GET', url: '/api/drivers/me/routes?ambulanceId=AMB-2' });
    expect(denied.statusCode).toBe(401);
    const response = await app.inject({ method: 'GET', url: '/api/drivers/me/routes?ambulanceId=AMB-2', headers: { authorization: 'Bearer driver' } });
    expect(response.statusCode).toBe(200);
    expect(driverAmbulances.getAssignedAmbulanceForDriver).toHaveBeenCalledWith('DRIVER-1');
    expect(response.json().routes.map((route: { id: string }) => route.id)).toEqual(['RTE-OWN']);
  });

  it.each([
    ['SKIPPED_NOT_FOUND', 404],
    ['SKIPPED_SIMULATION', 409],
    ['SKIPPED_STATUS', 409],
    ['SKIPPED_NO_AMBULANCE', 409],
    ['SKIPPED_NO_HOSPITAL', 409],
    ['SKIPPED_NO_POSITION', 409],
    ['SKIPPED_INVALID_LOCATION', 409],
    ['FAILED', 502],
  ])('maps %s to a non-success response', async (outcome, statusCode) => {
    mount({ emergencyId: 'EMG-1', leg: 'RESPONSE', outcome });
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/routes', headers: { authorization: 'Bearer dispatcher' }, payload: { leg: 'RESPONSE' } });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toHaveProperty('error');
  });

  it('returns the persisted route on an idempotent repeat', async () => {
    const { routes } = mount({ emergencyId: 'EMG-1', leg: 'RESPONSE', outcome: 'SKIPPED_ALREADY_EXISTS', routeId: 'RTE-1' });
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/routes', headers: { authorization: 'Bearer dispatcher' }, payload: { leg: 'RESPONSE' } });
    expect(response.statusCode).toBe(200);
    expect(routes.findById).toHaveBeenCalledWith('RTE-1');
    expect(response.json().outcome).toBe('SKIPPED_ALREADY_EXISTS');
  });

  it('does not return success if a generated route cannot be read back', async () => {
    const { routes } = mount();
    routes.findById.mockResolvedValueOnce(null as never);
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/routes', headers: { authorization: 'Bearer dispatcher' }, payload: { leg: 'RESPONSE' } });
    expect(response.statusCode).toBe(500);
  });
});

describe('Module 8 explicit route-recalculation route', () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  const persistedRoute = {
    id: 'RTE-1', emergencyId: 'EMG-1', ambulanceId: 'AMB-1', hospitalId: null,
    originName: 'AMBULANCE', destinationName: 'SCENE', distanceKm: 2,
    polyline: [[12.97, 77.59], [12.98, 77.6]], estimatedMinutes: 4,
    provider: 'mock', isLiveTraffic: false, isSimulation: false,
  };

  function mountRecalculate(result: Record<string, unknown> = { routeId: 'RTE-1', emergencyId: 'EMG-1', outcome: 'RECALCULATED', provider: 'mock' }) {
    const recalculateRoute = vi.fn(async () => result as never);
    const routes = { findById: vi.fn(async () => persistedRoute) };
    const table = new RouteTable();
    table.addAll(createModule8Routes({ recalculateRoute } as never, routes as never));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async (request: HttpRequest) => {
        const token = request.headers.authorization;
        if (token === 'Bearer dispatcher') return { userId: 'U-D', role: 'DISPATCHER', email: 'dispatch@example.test' };
        if (token === 'Bearer operator') return { userId: 'U-O', role: 'OPERATOR', email: 'operator@example.test' };
        return null;
      },
    });
    return { recalculateRoute, routes };
  }

  const url = '/api/routes/RTE-1/recalculate';
  const payload = { reason: 'ambulance repositioned' };

  it('requires authentication and the dispatcher/admin action role', async () => {
    mountRecalculate();
    expect((await app!.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url, headers: { authorization: 'Bearer operator' }, payload })).statusCode).toBe(403);
  });

  it('rejects a missing or empty recalculation reason before invoking the service', async () => {
    const { recalculateRoute } = mountRecalculate();
    const missing = await app!.inject({ method: 'POST', url, headers: { authorization: 'Bearer dispatcher' }, payload: {} });
    expect(missing.statusCode).toBe(422);
    const empty = await app!.inject({ method: 'POST', url, headers: { authorization: 'Bearer dispatcher' }, payload: { reason: '' } });
    expect(empty.statusCode).toBe(422);
    expect(recalculateRoute).not.toHaveBeenCalled();
  });

  it('invokes the optimizer with the canonical route id and trimmed reason, returning the persisted route', async () => {
    const { recalculateRoute, routes } = mountRecalculate();
    const response = await app!.inject({ method: 'POST', url, headers: { authorization: 'Bearer dispatcher' }, payload });
    expect(response.statusCode).toBe(200);
    expect(recalculateRoute).toHaveBeenCalledWith('RTE-1', 'ambulance repositioned', { actorType: 'DISPATCHER', actorId: 'U-D' });
    expect(routes.findById).toHaveBeenCalledWith('RTE-1');
    expect(response.json()).toMatchObject({ routeId: 'RTE-1', outcome: 'RECALCULATED' });
    expect(response.json().route).toMatchObject({ id: 'RTE-1', provider: 'mock', isLiveTraffic: false });
  });

  it.each([
    ['SKIPPED_NOT_FOUND', 404],
    ['SKIPPED_SIMULATION', 409],
    ['SKIPPED_STATUS', 409],
    ['SKIPPED_NO_AMBULANCE', 409],
    ['SKIPPED_NO_HOSPITAL', 409],
    ['SKIPPED_NO_POSITION', 409],
    ['SKIPPED_INVALID_LOCATION', 409],
    ['UNSUPPORTED', 503],
    ['FAILED', 502],
  ])('maps %s to a non-success response', async (outcome, statusCode) => {
    mountRecalculate({ routeId: 'RTE-1', emergencyId: 'EMG-1', outcome });
    const response = await app!.inject({ method: 'POST', url, headers: { authorization: 'Bearer dispatcher' }, payload });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toHaveProperty('error');
  });

  it('does not return success if a recalculated route cannot be read back', async () => {
    const { routes } = mountRecalculate();
    routes.findById.mockResolvedValueOnce(null as never);
    const response = await app!.inject({ method: 'POST', url, headers: { authorization: 'Bearer dispatcher' }, payload });
    expect(response.statusCode).toBe(500);
  });
});
