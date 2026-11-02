import { describe, expect, it } from 'vitest';
import { noopLogger, type SystemEventRecord, type SystemEventType } from '@resus/core';
import { DomainEventBus } from '@resus/data';
import type { RouteGenerationResult, RouteLeg, RouteOptimizationService } from '../src/routeOptimizationService.js';
import { AUTO_ROUTE_EVENT_TYPES, AutoRouteService } from '../src/autoRouteService.js';

let sequence = 0;

function record(
  type: SystemEventType,
  emergencyId?: string | null,
  payload: Record<string, unknown> = {},
): SystemEventRecord {
  sequence += 1;
  return {
    id: `EVT${sequence}`,
    sequence,
    type,
    emergencyId: emergencyId ?? null,
    entityType: 'emergency',
    entityId: emergencyId ?? null,
    timestamp: new Date().toISOString(),
    actorType: null,
    actorId: null,
    payload,
    metadata: null,
  };
}

function bus() {
  return new DomainEventBus({ logger: noopLogger });
}

interface Stub {
  calls: Array<{ emergencyId: string; leg: RouteLeg }>;
  optimization: RouteOptimizationService;
}

function stub(
  run: (emergencyId: string, leg: RouteLeg) => Promise<RouteGenerationResult>,
): Stub {
  const calls: Array<{ emergencyId: string; leg: RouteLeg }> = [];
  const optimization = {
    async generateForEmergency(emergencyId: string, leg: RouteLeg) {
      calls.push({ emergencyId, leg });
      return run(emergencyId, leg);
    },
  } as unknown as RouteOptimizationService;
  return { calls, optimization };
}

const generated = (emergencyId: string, leg: RouteLeg): RouteGenerationResult => ({
  emergencyId,
  leg,
  outcome: 'GENERATED',
  routeId: 'RTE1',
});

describe('AUTO_ROUTE_EVENT_TYPES', () => {
  it('subscribes only to the two planning triggers', () => {
    expect([...AUTO_ROUTE_EVENT_TYPES]).toEqual(['AMBULANCE_DISPATCHED', 'HOSPITAL_SELECTED']);
  });
});

describe('AutoRouteService', () => {
  it('maps explicit ambulance dispatch to the response leg and hospital selection to transport', async () => {
    const events = bus();
    const { calls, optimization } = stub(async (id, leg) => generated(id, leg));
    const autoRoute = new AutoRouteService({ events, optimization });

    events.publish(record('AMBULANCE_ASSIGNED', 'EMG1'));
    await autoRoute.idle();
    expect(calls).toEqual([]);

    events.publish(record('AMBULANCE_DISPATCHED', 'EMG1'));
    events.publish(record('HOSPITAL_SELECTED', 'EMG1'));
    await autoRoute.idle();

    expect(calls).toEqual([
      { emergencyId: 'EMG1', leg: 'RESPONSE' },
      { emergencyId: 'EMG1', leg: 'TRANSPORT' },
    ]);
    autoRoute.dispose();
  });

  it('collapses concurrent events for the same emergency and leg into one planning run', async () => {
    const events = bus();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, optimization } = stub(async (id, leg) => {
      await gate;
      return generated(id, leg);
    });
    const autoRoute = new AutoRouteService({ events, optimization });

    events.publish(record('AMBULANCE_DISPATCHED', 'EMG1'));
    events.publish(record('AMBULANCE_DISPATCHED', 'EMG1'));
    expect(calls).toHaveLength(1);

    release();
    await autoRoute.idle();
    expect(calls).toHaveLength(1);
    autoRoute.dispose();
  });

  it('stops reacting to events once disposed', async () => {
    const events = bus();
    const { calls, optimization } = stub(async (id, leg) => generated(id, leg));
    const autoRoute = new AutoRouteService({ events, optimization });

    autoRoute.dispose();
    events.publish(record('AMBULANCE_DISPATCHED', 'EMG1'));
    await autoRoute.idle();

    expect(calls).toHaveLength(0);
    expect((await autoRoute.generate('EMG1', 'RESPONSE')).outcome).toBe('SKIPPED_STATUS');
  });

  it('ignores events without an emergency identifier and unrelated event types', async () => {
    const { optimization } = stub(async (id, leg) => generated(id, leg));
    const autoRoute = new AutoRouteService({ events: bus(), optimization });

    expect(await autoRoute.handleEvent(record('AMBULANCE_DISPATCHED', null))).toBeNull();
    expect(await autoRoute.handleEvent(record('ROUTE_GENERATED', 'EMG1'))).toBeNull();
    autoRoute.dispose();
  });
});
