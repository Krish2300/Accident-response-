import { describe, expect, it } from 'vitest';
import { noopLogger } from '@resus/core';
import { AutoCorridorService } from '../src/autoCorridorService.js';
import {
  buildService,
  FakeBus,
  FakeRouteRead,
  makeEvent,
  makeRoute,
} from './support.js';

function build() {
  const { corridors, notifications, service } = buildService();
  const routes = new FakeRouteRead();
  const bus = new FakeBus();
  const auto = new AutoCorridorService({ events: bus, corridors: service, routes, logger: noopLogger });
  return { corridors, notifications, routes, bus, service, auto };
}

describe('Module 9 AutoCorridorService', () => {
  it('does nothing when a hospital is selected but no transport route exists yet', async () => {
    const { corridors, auto } = build();
    const outcome = await auto.handleEvent(makeEvent('HOSPITAL_SELECTED', { hospitalId: 'HSP-1' }));

    expect(outcome).toBeNull();
    expect(corridors.events).toEqual([]);
  });

  it('activates once a persisted transport route appears', async () => {
    const { corridors, routes, auto } = build();
    routes.routes.set('EMG-1', [makeRoute()]);

    const outcome = await auto.handleEvent(makeEvent('ROUTE_GENERATED', { routeId: 'RTE-1' }));
    expect(outcome?.outcome).toBe('ACTIVATED');
    expect(corridors.events).toEqual(['CORRIDOR_ACTIVATED']);
  });

  it('ignores a response-leg route (no destination hospital)', async () => {
    const { corridors, routes, auto } = build();
    routes.routes.set('EMG-1', [
      makeRoute({ destinationName: 'SCENE', hospitalId: null, originName: 'AMBULANCE' }),
    ]);

    const outcome = await auto.handleEvent(makeEvent('ROUTE_GENERATED', { routeId: 'RTE-1' }));
    expect(outcome).toBeNull();
    expect(corridors.events).toEqual([]);
  });

  it('ignores unrelated event types', async () => {
    const { routes, auto } = build();
    routes.routes.set('EMG-1', [makeRoute()]);
    expect(await auto.handleEvent(makeEvent('AMBULANCE_ASSIGNED', {}))).toBeNull();
  });

  it('collapses duplicate events into a single activation', async () => {
    const { corridors, routes, auto } = build();
    routes.routes.set('EMG-1', [makeRoute()]);

    await auto.handleEvent(makeEvent('ROUTE_GENERATED', { routeId: 'RTE-1' }));
    await auto.handleEvent(makeEvent('HOSPITAL_SELECTED', { hospitalId: 'HSP-1' }));
    await auto.handleEvent(makeEvent('ROUTE_GENERATED', { routeId: 'RTE-1' }));

    expect(corridors.events).toEqual(['CORRIDOR_ACTIVATED']);
  });

  it('collapses concurrent invocations for the same emergency', async () => {
    const { corridors, routes, auto } = build();
    routes.routes.set('EMG-1', [makeRoute()]);

    const [a, b] = await Promise.all([auto.coordinate('EMG-1'), auto.coordinate('EMG-1')]);
    expect(a?.outcome).toBe('ACTIVATED');
    expect(b?.outcome).toBe('ACTIVATED');
    expect(corridors.events).toEqual(['CORRIDOR_ACTIVATED']);
  });

  it('activates through the bus and stops after dispose()', async () => {
    const { corridors, routes, bus, auto } = build();
    routes.routes.set('EMG-1', [makeRoute()]);
    expect(bus.subscriberCount).toBe(1);

    bus.publish(makeEvent('ROUTE_GENERATED', { routeId: 'RTE-1' }));
    await auto.idle();
    expect(corridors.events).toEqual(['CORRIDOR_ACTIVATED']);

    auto.dispose();
    expect(bus.subscriberCount).toBe(0);

    // A later event is not delivered once unsubscribed.
    const outcome = await auto.handleEvent(makeEvent('ROUTE_GENERATED', { routeId: 'RTE-1' }));
    expect(outcome).toBeNull();
  });
});
