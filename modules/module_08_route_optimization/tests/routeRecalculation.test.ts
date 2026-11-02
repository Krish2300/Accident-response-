import { describe, expect, it } from 'vitest';
import {
  type Ambulance,
  type Emergency,
  type Hospital,
  type RoutingProvider,
  type SystemEventEnvelope,
  type SystemEventRecord,
  AppError,
} from '@resus/core';
import { loadModule8Config, type Module8Config } from '../src/config.js';
import { MockRoutingProvider } from '../src/providers/mockRoutingProvider.js';
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
  const publisher = {
    record,
    recordMany: async (events: SystemEventEnvelope[]) => Promise.all(events.map(record)),
    recordInTransaction: async () => {
      throw new Error('recordInTransaction is not used by the unit harness');
    },
  };
  return { envelopes, record, publisher };
}

function makeRoutes(recordEvent: (event: SystemEventEnvelope) => Promise<unknown>, options: { withReplacement?: boolean } = {}) {
  const rows: PlannedRoute[] = [];
  const created: RouteCreateInput[] = [];
  const replaced: Array<{ routeId: string; distanceKm: number }> = [];
  let counter = 0;
  const base: RouteWriterPort = {
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
        status: 'PLANNED',
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
  const writer: RouteWriterPort = options.withReplacement === false
    ? base
    : {
        ...base,
        async replaceRouteWithEvent(routeId, update, eventFor) {
          const index = rows.findIndex((route) => route.id === routeId);
          if (index < 0) throw new Error('route not found');
          const previous = rows[index]!;
          const updated: PlannedRoute = {
            ...previous,
            distanceKm: update.distanceKm,
            polyline: update.polyline ?? previous.polyline,
            estimatedMinutes: update.estimatedMinutes ?? previous.estimatedMinutes,
            provider: update.provider ?? previous.provider,
            isLiveTraffic: update.isLiveTraffic ?? previous.isLiveTraffic,
          };
          rows[index] = updated;
          replaced.push({ routeId, distanceKm: update.distanceKm });
          await recordEvent(eventFor(updated, {
            distanceKm: previous.distanceKm,
            estimatedMinutes: previous.estimatedMinutes,
          }));
          return updated;
        },
      };
  return { writer, rows, created, replaced };
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
    withReplacement?: boolean;
  } = {},
) {
  const events = makeEvents();
  const routes = makeRoutes(events.record, { withReplacement: options.withReplacement });
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
  return { service, events, routes, config, ambulanceRow: ambulance };
}

describe('RouteOptimizationService.recalculateRoute', () => {
  it('initial generation emits ROUTE_GENERATED only, never ROUTE_RECALCULATED', async () => {
    const { service, events } = harness();
    const generated = await service.generateForEmergency('EMG1', 'RESPONSE');
    expect(generated.outcome).toBe('GENERATED');
    expect(events.envelopes.map((event) => event.type)).toEqual(['ROUTE_GENERATED']);
  });

  it('replaces an established route and emits exactly one ROUTE_RECALCULATED with previous/new values', async () => {
    const { service, events, routes } = harness();
    await service.generateForEmergency('EMG1', 'RESPONSE');
    const routeId = routes.rows[0]!.id;
    const originalDistance = routes.rows[0]!.distanceKm;

    const result = await service.recalculateRoute(routeId, 'ambulance repositioned');

    expect(result.outcome).toBe('RECALCULATED');
    expect(result.provider).toBe('mock');
    expect(routes.rows).toHaveLength(1);
    expect(routes.rows[0]!.id).toBe(routeId);
    expect(routes.replaced).toHaveLength(1);

    const recalculated = events.envelopes.filter((event) => event.type === 'ROUTE_RECALCULATED');
    expect(recalculated).toHaveLength(1);
    expect(recalculated[0]).toMatchObject({
      emergencyId: 'EMG1',
      entityType: 'route',
      entityId: routeId,
      payload: {
        routeId,
        emergencyId: 'EMG1',
        previousDistanceKm: originalDistance,
        distanceKm: originalDistance,
        reason: 'ambulance repositioned',
      },
    });
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_GENERATED')).toHaveLength(1);
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_FAILED')).toHaveLength(0);
  });

  it('records previous and new distance on a recalculated route from a moved ambulance', async () => {
    const near = harness();
    await near.service.generateForEmergency('EMG1', 'RESPONSE');
    const nearDistance = near.routes.rows[0]!.distanceKm;

    const far = harness({ ambulance: makeAmbulance({ latitude: 12.90, longitude: 77.50 }) });
    await far.service.generateForEmergency('EMG1', 'RESPONSE');
    const farRouteId = far.routes.rows[0]!.id;
    const farDistance = far.routes.rows[0]!.distanceKm;
    expect(farDistance).not.toBe(nearDistance);

    const result = await far.service.recalculateRoute(farRouteId, 'repositioned');
    expect(result.outcome).toBe('RECALCULATED');
    const payload = far.events.envelopes.find((event) => event.type === 'ROUTE_RECALCULATED')!
      .payload as { previousDistanceKm: number; distanceKm: number };
    expect(payload.previousDistanceKm).toBe(farDistance);
    expect(far.routes.rows[0]!.id).toBe(farRouteId);
  });

  it('requires a non-empty recalculation reason', async () => {
    const { service, routes } = harness();
    await service.generateForEmergency('EMG1', 'RESPONSE');
    const routeId = routes.rows[0]!.id;
    await expect(service.recalculateRoute(routeId, '   ')).rejects.toBeInstanceOf(AppError);
  });

  it('skips an unknown route without emitting anything', async () => {
    const { service, events } = harness();
    const result = await service.recalculateRoute('RTE-UNKNOWN', 'traffic ahead');
    expect(result.outcome).toBe('SKIPPED_NOT_FOUND');
    expect(events.envelopes).toHaveLength(0);
  });

  it.each(['ARRIVED', 'ABANDONED', 'COMPLETED'])(
    'refuses to recalculate a %s route and emits nothing',
    async (status) => {
      const { service, events, routes } = harness();
      await service.generateForEmergency('EMG1', 'RESPONSE');
      routes.rows[0]!.status = status;
      const result = await service.recalculateRoute(routes.rows[0]!.id, 'any reason');
      expect(result.outcome).toBe('SKIPPED_STATUS');
      expect(events.envelopes.filter((event) => event.type === 'ROUTE_RECALCULATED')).toHaveLength(0);
    },
  );

  it('refuses when the persistence layer lacks atomic replacement, without a false success event', async () => {
    const { service, events, routes } = harness({ withReplacement: false });
    await service.generateForEmergency('EMG1', 'RESPONSE');
    const result = await service.recalculateRoute(routes.rows[0]!.id, 'any reason');
    expect(result.outcome).toBe('UNSUPPORTED');
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_RECALCULATED')).toHaveLength(0);
  });

  it('records ROUTE_FAILED and no ROUTE_RECALCULATED when every provider fails', async () => {
    const { service, events, routes } = harness({
      primary: throwingProvider('osrm'),
      fallback: throwingProvider('google'),
    });
    await routes.writer.createRoute({
      emergencyId: 'EMG1',
      ambulanceId: 'AMB1',
      destinationName: 'SCENE',
      originName: 'AMBULANCE',
      origin: { latitude: 12.95, longitude: 77.58 },
      destination: { latitude: 12.9716, longitude: 77.5946 },
      distanceKm: 2.5,
      estimatedMinutes: 5,
    });
    const before = routes.rows[0]!;

    const result = await service.recalculateRoute(before.id, 'provider outage');
    expect(result.outcome).toBe('FAILED');
    expect(routes.rows[0]!.distanceKm).toBe(2.5);
    expect(routes.replaced).toHaveLength(0);
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_RECALCULATED')).toHaveLength(0);
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_FAILED')).toHaveLength(1);
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_FAILED')[0]!.payload).toMatchObject({
      reason: 'primary (osrm) failed: osrm unavailable; fallback (google) failed: google unavailable',
    });
  });

  it('skips simulation emergencies by default', async () => {
    const { service, events, routes } = harness({ emergency: makeEmergency({ isSimulation: true }) });
    await routes.writer.createRoute({
      emergencyId: 'EMG1',
      ambulanceId: 'AMB1',
      destinationName: 'SCENE',
      originName: 'AMBULANCE',
      origin: { latitude: 12.95, longitude: 77.58 },
      destination: { latitude: 12.9716, longitude: 77.5946 },
      distanceKm: 2.5,
      estimatedMinutes: 5,
      isSimulation: true,
    });
    const result = await service.recalculateRoute(routes.rows[0]!.id, 'any reason');
    expect(result.outcome).toBe('SKIPPED_SIMULATION');
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_RECALCULATED')).toHaveLength(0);
  });

  it('skips when the emergency is terminal', async () => {
    const { service, events, routes } = harness({ emergency: makeEmergency({ status: 'COMPLETED' }) });
    await routes.writer.createRoute({
      emergencyId: 'EMG1',
      ambulanceId: 'AMB1',
      destinationName: 'SCENE',
      originName: 'AMBULANCE',
      origin: { latitude: 12.95, longitude: 77.58 },
      destination: { latitude: 12.9716, longitude: 77.5946 },
      distanceKm: 2.5,
      estimatedMinutes: 5,
    });
    const result = await service.recalculateRoute(routes.rows[0]!.id, 'any reason');
    expect(result.outcome).toBe('SKIPPED_STATUS');
    expect(events.envelopes.filter((event) => event.type === 'ROUTE_RECALCULATED')).toHaveLength(0);
  });
});
