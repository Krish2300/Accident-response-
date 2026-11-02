import { describe, expect, it, vi } from 'vitest';
import {
  type Ambulance,
  type Emergency,
  type EventPublisherPort,
  type Hospital,
  type RoutingProvider,
  type SystemEventEnvelope,
  type SystemEventRecord,
} from '@resus/core';
import { loadModule8Config, type Module8Config } from '../src/config.js';
import { MockRoutingProvider } from '../src/providers/mockRoutingProvider.js';
import { GoogleRoutesProvider } from '../src/providers/googleRoutesProvider.js';
import { RoutingProviderError } from '../src/providers/routingProviderError.js';
import {
  RouteOptimizationService,
  type PlannedRoute,
  type RouteCreateInput,
  type RouteWriterPort,
} from '../src/routeOptimizationService.js';

function makeEmergency(overrides: Partial<Emergency> = {}): Emergency {
  return {
    id: 'EMG1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'AMBULANCE_ASSIGNED',
    incidentType: 'CARDIAC_ARREST',
    severity: 'CRITICAL',
    latitude: 12.9716,
    longitude: 77.5946,
    description: null,
    callerId: null,
    assignedAmbulanceId: 'AMB1',
    selectedHospitalId: null,
    isSimulation: false,
    ...overrides,
  };
}

function makeAmbulance(overrides: Partial<Ambulance> = {}): Ambulance {
  return {
    id: 'AMB1',
    vehicleNumber: 'KA-01-0001',
    status: 'EN_ROUTE',
    latitude: 12.95,
    longitude: 77.58,
    lastLocationUpdate: '2026-01-01T00:00:00.000Z',
    equipment: [],
    crew: [],
    currentEmergencyId: 'EMG1',
    assignedAt: null,
    availableAt: null,
    isSimulation: false,
    stationName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeHospital(overrides: Partial<Hospital> = {}): Hospital {
  return {
    id: 'HSP1',
    name: 'Test Hospital',
    latitude: 12.99,
    longitude: 77.6,
    status: 'OPEN',
    capabilities: [],
    traumaLevel: 2,
    acceptingEmergencies: true,
    contactPhone: null,
    address: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEvents() {
  const envelopes: SystemEventEnvelope[] = [];
  const record = async (event: SystemEventEnvelope): Promise<SystemEventRecord> => {
    envelopes.push(event);
    const shape = event as {
      emergencyId?: string | null;
      entityType?: string | null;
      entityId?: string | null;
      payload?: unknown;
    };
    return {
      id: `EVT${envelopes.length}`,
      sequence: envelopes.length,
      type: event.type,
      emergencyId: shape.emergencyId ?? null,
      entityType: shape.entityType ?? null,
      entityId: shape.entityId ?? null,
      timestamp: new Date().toISOString(),
      actorType: null,
      actorId: null,
      payload: shape.payload ?? null,
      metadata: null,
    };
  };
  const publisher: EventPublisherPort = {
    record,
    recordMany: async (events) => Promise.all(events.map(record)),
    recordInTransaction: async () => {
      throw new Error('recordInTransaction is not used by Module 8');
    },
  };
  return { publisher, envelopes };
}

function makeRoutes() {
  const rows: PlannedRoute[] = [];
  const created: RouteCreateInput[] = [];
  let counter = 0;
  const writer: RouteWriterPort = {
    async createRoute(input) {
      created.push(input);
      const route: PlannedRoute = {
        id: `RTE${++counter}`,
        emergencyId: input.emergencyId,
        ambulanceId: input.ambulanceId,
        hospitalId: input.hospitalId ?? null,
        originName: input.originName ?? 'INCIDENT',
        destinationName: input.destinationName,
        distanceKm: input.distanceKm,
        polyline: input.polyline ?? [],
        estimatedMinutes: input.estimatedMinutes ?? null,
        provider: input.provider ?? 'mock',
        isLiveTraffic: input.isLiveTraffic ?? false,
        isSimulation: input.isSimulation ?? false,
      };
      rows.push(route);
      return route;
    },
    async routesForEmergency(emergencyId) {
      return rows.filter((route) => route.emergencyId === emergencyId);
    },
    async findById(id) {
      return rows.find((route) => route.id === id) ?? null;
    },
  };
  return { writer, rows, created };
}

function throwingProvider(name = 'osrm'): RoutingProvider {
  return {
    providerName: name,
    isLive: true,
    isLiveTraffic: false,
    route: async () => {
      throw new RoutingProviderError(`${name} unavailable`, name);
    },
  };
}

function harness(
  options: {
    emergency?: Emergency | null;
    ambulance?: Ambulance | null;
    hospital?: Hospital | null;
    primary?: RoutingProvider;
    fallback?: RoutingProvider;
    config?: Partial<Module8Config>;
  } = {},
) {
  const events = makeEvents();
  const routes = makeRoutes();
  const emergency = options.emergency === undefined ? makeEmergency() : options.emergency;
  const ambulance = options.ambulance === undefined ? makeAmbulance() : options.ambulance;
  const hospital = options.hospital === undefined ? makeHospital() : options.hospital;
  const base = loadModule8Config();
  const config: Module8Config = {
    ...base,
    ...options.config,
    osrm: { ...base.osrm, ...(options.config?.osrm ?? {}) },
    generation: { ...base.generation, ...(options.config?.generation ?? {}) },
  };
  const primary = options.primary ?? new MockRoutingProvider(config.averageSpeedKmh);
  const fallback = options.fallback ?? new MockRoutingProvider(config.averageSpeedKmh);
  const service = new RouteOptimizationService({
    primary,
    fallback,
    routes: routes.writer,
    emergencies: { findById: async (id) => (emergency && emergency.id === id ? emergency : null) },
    ambulances: { findById: async (id) => (ambulance && ambulance.id === id ? ambulance : null) },
    hospitals: { findById: async (id) => (hospital && hospital.id === id ? hospital : null) },
    events: events.publisher,
    config,
  });
  return { service, events, routes, config };
}

describe('RouteOptimizationService.generateForEmergency', () => {
  it('plans the RESPONSE leg from the ambulance to the scene and emits ROUTE_GENERATED', async () => {
    const { service, routes, events } = harness();
    const result = await service.generateForEmergency('EMG1', 'RESPONSE');

    expect(result.outcome).toBe('GENERATED');
    expect(routes.rows).toHaveLength(1);
    expect(routes.rows[0]).toMatchObject({
      originName: 'AMBULANCE',
      destinationName: 'SCENE',
      provider: 'mock',
      isLiveTraffic: false,
      hospitalId: null,
    });
    expect(events.envelopes.map((event) => event.type)).toEqual(['ROUTE_GENERATED']);
    expect((events.envelopes[0]!.payload as { routeId?: string }).routeId).toBe(routes.rows[0]!.id);
  });

  it('plans the TRANSPORT leg from the scene to the selected hospital', async () => {
    const { service, routes } = harness({
      emergency: makeEmergency({ selectedHospitalId: 'HSP1' }),
    });
    const result = await service.generateForEmergency('EMG1', 'TRANSPORT');

    expect(result.outcome).toBe('GENERATED');
    expect(routes.rows[0]).toMatchObject({
      originName: 'SCENE',
      destinationName: 'HOSPITAL',
      hospitalId: 'HSP1',
    });
  });

  it('is idempotent: a redelivered trigger never plans the same leg twice', async () => {
    const { service, routes, events } = harness();
    const first = await service.generateForEmergency('EMG1', 'RESPONSE');
    const second = await service.generateForEmergency('EMG1', 'RESPONSE');

    expect(first.outcome).toBe('GENERATED');
    expect(second.outcome).toBe('SKIPPED_ALREADY_EXISTS');
    expect(routes.rows).toHaveLength(1);
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_GENERATED')).toHaveLength(1);
    expect(routes.created).toHaveLength(1);
  });

  it('collapses concurrent explicit requests for the same emergency and leg', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fallback = new MockRoutingProvider(60);
    const primary: RoutingProvider = {
      providerName: 'delayed-test',
      isLive: false,
      isLiveTraffic: false,
      async route(input) {
        await gate;
        return fallback.route(input);
      },
    };
    const { service, routes, events } = harness({ primary });

    const first = service.generateForEmergency('EMG1', 'RESPONSE');
    const second = service.generateForEmergency('EMG1', 'RESPONSE');
    release();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.outcome)).toEqual(['GENERATED', 'GENERATED']);
    expect(routes.created).toHaveLength(1);
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_GENERATED')).toHaveLength(1);
  });

  it('uses the atomic persistence/event capability when the repository provides it', async () => {
    const { service, events, routes } = harness();
    const createRoute = routes.writer.createRoute.bind(routes.writer);
    const createRouteWithEvent = vi.fn(async (input: RouteCreateInput, eventFor: (route: PlannedRoute) => SystemEventEnvelope) => {
      const route = await createRoute(input);
      expect(routes.rows).toContain(route);
      events.envelopes.push(eventFor(route));
      return route;
    });
    routes.writer.createRouteWithEvent = createRouteWithEvent;

    const result = await service.generateForEmergency('EMG1', 'RESPONSE');

    expect(result.outcome).toBe('GENERATED');
    expect(createRouteWithEvent).toHaveBeenCalledTimes(1);
    expect(events.envelopes.map((event) => event.type)).toEqual(['ROUTE_GENERATED']);
  });

  it('falls back to the deterministic provider and records the downgrade when the primary fails', async () => {
    const { service, routes, events } = harness({ primary: throwingProvider() });
    const result = await service.generateForEmergency('EMG1', 'RESPONSE');

    expect(result.outcome).toBe('GENERATED');
    expect(result.provider).toBe('mock');
    expect(routes.rows[0]).toMatchObject({ provider: 'mock', isLiveTraffic: false });
    expect(events.envelopes.map((event) => event.type)).toEqual(['ROUTE_FAILED', 'ROUTE_GENERATED']);
    expect(events.envelopes[0]!.payload).toMatchObject({ degradedToEstimate: true });
    expect((routes.created[0]!.selectionReason as { degraded?: boolean })?.degraded).toBe(true);
  });

  it('persists Google provider and per-response traffic provenance without inventing a traffic factor', async () => {
    const google = new GoogleRoutesProvider({
      apiKey: 'test-only-key',
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          routes: [{
            distanceMeters: 12_000,
            duration: '1500s',
            staticDuration: '1200s',
            polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
          }],
        }),
      }) as unknown as Response) as unknown as typeof fetch,
    });
    const { service, routes, events } = harness({ primary: google });
    const result = await service.generateForEmergency('EMG1', 'RESPONSE');

    expect(result).toMatchObject({ outcome: 'GENERATED', provider: 'google-routes' });
    expect(routes.created[0]).toMatchObject({
      provider: 'google-routes',
      isLiveTraffic: true,
      trafficFactor: null,
      distanceKm: 12,
      estimatedMinutes: 25,
    });
    expect(events.envelopes.at(-1)?.payload).toMatchObject({ provider: 'google-routes', isLiveTraffic: true });
  });

  it('labels and persists the mock fallback when Google fails', async () => {
    const google = new GoogleRoutesProvider({
      apiKey: 'test-only-key',
      fetchImpl: vi.fn(async () => ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch,
    });
    const { service, routes, events } = harness({ primary: google });
    const result = await service.generateForEmergency('EMG1', 'RESPONSE');

    expect(result).toMatchObject({ outcome: 'GENERATED', provider: 'mock' });
    expect(routes.rows[0]).toMatchObject({ provider: 'mock', isLiveTraffic: false });
    expect((routes.created[0]!.selectionReason as { degraded?: boolean }).degraded).toBe(true);
    expect(events.envelopes[0]?.payload).toMatchObject({
      provider: 'google-routes',
      degradedToEstimate: true,
    });
  });

  it('reports failure once and persists nothing when both providers fail', async () => {
    const { service, routes, events } = harness({
      primary: throwingProvider('osrm'),
      fallback: throwingProvider('mock'),
    });
    const result = await service.generateForEmergency('EMG1', 'RESPONSE');

    expect(result.outcome).toBe('FAILED');
    expect(routes.rows).toHaveLength(0);
    const failed = events.envelopes.filter((event) => event.type === 'ROUTE_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ degradedToEstimate: false });
  });

  it('never marks a deterministic fallback route as live traffic', async () => {
    const { service, routes } = harness({ primary: throwingProvider() });
    await service.generateForEmergency('EMG1', 'RESPONSE');
    expect(routes.rows.every((route) => route.isLiveTraffic === false)).toBe(true);
  });

  it('skips simulation emergencies unless simulation routing is enabled', async () => {
    const off = harness({ emergency: makeEmergency({ isSimulation: true }) });
    expect((await off.service.generateForEmergency('EMG1', 'RESPONSE')).outcome).toBe(
      'SKIPPED_SIMULATION',
    );
    const on = harness({
      emergency: makeEmergency({ isSimulation: true }),
      config: { generation: { enabled: true, includeSimulation: true } },
    });
    expect((await on.service.generateForEmergency('EMG1', 'RESPONSE')).outcome).toBe('GENERATED');
  });

  it('skips terminals, missing ambulances, absent positions and missing hospitals', async () => {
    expect(
      (
        await harness({ emergency: makeEmergency({ status: 'COMPLETED' }) }).service.generateForEmergency(
          'EMG1',
          'RESPONSE',
        )
      ).outcome,
    ).toBe('SKIPPED_STATUS');
    expect(
      (
        await harness({ emergency: makeEmergency({ assignedAmbulanceId: null }) }).service.generateForEmergency(
          'EMG1',
          'RESPONSE',
        )
      ).outcome,
    ).toBe('SKIPPED_NO_AMBULANCE');
    expect(
      (
        await harness({ ambulance: makeAmbulance({ latitude: null, longitude: null }) }).service.generateForEmergency(
          'EMG1',
          'RESPONSE',
        )
      ).outcome,
    ).toBe('SKIPPED_NO_POSITION');
    expect((await harness().service.generateForEmergency('EMG1', 'TRANSPORT')).outcome).toBe(
      'SKIPPED_NO_HOSPITAL',
    );
  });
});

describe('RouteOptimizationService.optimizeRoute', () => {
  it('requires emergency and ambulance identifiers', async () => {
    const { service } = harness();
    await expect(
      service.optimizeRoute({ from: { latitude: 1, longitude: 1 }, to: { latitude: 2, longitude: 2 } }),
    ).rejects.toThrow(/emergencyId and ambulanceId/);
  });

  it('computes and records a route for valid coordinates', async () => {
    const { service, routes } = harness();
    const result = await service.optimizeRoute({
      from: { latitude: 12.9, longitude: 77.5 },
      to: { latitude: 13.0, longitude: 77.6 },
      emergencyId: 'EMG1',
      ambulanceId: 'AMB1',
    });
    expect(result.isLiveTraffic).toBe(false);
    expect(routes.rows).toHaveLength(1);
  });
});

describe('MockRoutingProvider with OSRM disabled', () => {
  it('produces deterministic geometry without any outbound request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service, routes } = harness({ config: { provider: 'mock' } });
    const first = await service.optimizeRoute({
      from: { latitude: 12.9, longitude: 77.5 },
      to: { latitude: 13.0, longitude: 77.6 },
      emergencyId: 'EMG1',
      ambulanceId: 'AMB1',
    });
    const second = await service.optimizeRoute({
      from: { latitude: 12.9, longitude: 77.5 },
      to: { latitude: 13.0, longitude: 77.6 },
      emergencyId: 'EMG2',
      ambulanceId: 'AMB1',
    });

    expect(first.distanceKm).toBe(second.distanceKm);
    expect(first.estimatedMinutes).toBe(second.estimatedMinutes);
    expect(first.provider).toBe('mock');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(routes.rows.every((route) => route.isLiveTraffic === false)).toBe(true);
    fetchSpy.mockRestore();
  });
});
