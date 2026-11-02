import { describe, expect, it, vi } from 'vitest';
import type { DomainEventBusPort, EventQueryPort, HttpReply, SystemEventRecord, SystemEventType } from '@resus/core';
import { MODULE10_LIFECYCLE_EVENT_TYPES, MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE, Module10LifecycleObserver } from '../src/lifecycle/observer';
import { createModule10LifecycleRoutes } from '../src/lifecycle/routes';

type EventFilter = Parameters<EventQueryPort['list']>[0];

class InMemoryEventBus implements DomainEventBusPort {
  subscribedTypes: SystemEventType[] = [];
  private handler: ((event: SystemEventRecord) => void | Promise<void>) | undefined;
  private activeSubscriptions = 0;

  subscribe<T extends SystemEventType>(
    types: T[],
    handler: (event: SystemEventRecord) => void | Promise<void>,
  ): () => void {
    this.subscribedTypes = [...types];
    this.handler = handler;
    this.activeSubscriptions += 1;
    return () => {
      if (this.handler === handler) this.handler = undefined;
      this.activeSubscriptions -= 1;
    };
  }

  publish(event: SystemEventRecord): void {
    if (this.subscribedTypes.includes(event.type)) void this.handler?.(event);
  }

  get subscriptionCount(): number {
    return this.activeSubscriptions;
  }
}

class InMemoryEventQuery {
  records: SystemEventRecord[] = [];
  readonly filters: EventFilter[] = [];
  failuresRemaining = 0;
  beforeList: (() => Promise<void>) | undefined;

  async list(filter: EventFilter): Promise<{ items: SystemEventRecord[]; total: number; latestSequence: number }> {
    this.filters.push({ ...filter });
    if (this.beforeList) await this.beforeList();
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('in-memory event query failure');
    }
    const matching = this.records
      .filter((event) => !filter.types?.length || filter.types.includes(event.type))
      .filter((event) => filter.sinceSequence === undefined || !Number.isSafeInteger(event.sequence) || event.sequence > filter.sinceSequence)
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    return {
      items: matching.slice(offset, offset + limit),
      total: matching.length,
      latestSequence: this.records.reduce((max, event) => Number.isSafeInteger(event.sequence) ? Math.max(max, event.sequence) : max, 0),
    };
  }
}

function record(
  type: SystemEventType,
  payload: Record<string, unknown>,
  overrides: Partial<SystemEventRecord> = {},
): SystemEventRecord {
  return {
    id: `EVT-${type}`,
    sequence: 1,
    type,
    emergencyId: 'EMG-observer-test',
    entityType: 'EMERGENCY',
    entityId: 'EMG-observer-test',
    timestamp: '2026-10-17T10:00:00.000Z',
    actorType: 'SYSTEM',
    actorId: null,
    payload,
    metadata: null,
    ...overrides,
  };
}

function created(id: string, sequence: number, emergencyId = 'EMG-observer-test'): SystemEventRecord {
  return record('EMERGENCY_CREATED', {
    incidentType: 'TRAUMA', severity: 'HIGH', latitude: 1, longitude: 2, isSimulation: true,
  }, { id, sequence, emergencyId, entityId: emergencyId });
}

function callConnected(id: string, sequence: number): SystemEventRecord {
  return record('CALL_CONNECTED', {
    callSessionId: 'CALL-1', emergencyId: 'EMG-observer-test', channel: 'SIP',
    provider: 'fake', transport: 'fake', isLiveTransport: false,
  }, { id, sequence });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForProjection(observer: Module10LifecycleObserver, expectedState: string): Promise<void> {
  await vi.waitFor(() => {
    expect(observer.getProjection('EMG-observer-test')?.state).toBe(expectedState);
  });
}

describe('Module 10 lifecycle observer event-log replay', () => {
  it('rebuilds historical lifecycle facts before becoming ready', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    events.records = [created('EVT-created', 1), callConnected('EVT-connected', 2)];
    const observer = new Module10LifecycleObserver({ bus, events });

    await observer.start();

    expect(observer.isReady).toBe(true);
    expect(observer.getProjection('EMG-observer-test')).toMatchObject({
      emergencyId: 'EMG-observer-test', state: 'CALL_CONNECTED', lastSequence: 2,
      processedEventIds: ['EVT-created', 'EVT-connected'],
    });
    expect(events.filters[0]).toMatchObject({ sinceSequence: 0, offset: 0, limit: MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE });
    await observer.dispose();
  });

  it('buffers live events during replay and drains them after historical events', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    const gate = deferred();
    events.beforeList = () => gate.promise;
    const observer = new Module10LifecycleObserver({ bus, events });
    const starting = observer.start();

    bus.publish(created('EVT-live', 2));
    expect(observer.isReady).toBe(false);
    expect(observer.getProjection('EMG-observer-test')).toBeNull();
    gate.resolve();
    await starting;

    expect(observer.getProjection('EMG-observer-test')?.state).toBe('EMERGENCY_CREATED');
    expect(observer.getProjection('EMG-observer-test')?.lastSequence).toBe(2);
    await observer.dispose();
  });

  it('deduplicates the same persisted event delivered in history and live', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    const existing = created('EVT-shared', 1);
    const gate = deferred();
    events.records = [existing];
    events.beforeList = () => gate.promise;
    const observer = new Module10LifecycleObserver({ bus, events });
    const starting = observer.start();
    bus.publish(existing);
    gate.resolve();
    await starting;

    expect(observer.getProjection('EMG-observer-test')?.processedEventIds).toEqual(['EVT-shared']);
    await observer.dispose();
  });

  it('replays every page in sequence order with strict sinceSequence cursors', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    events.records = Array.from({ length: MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE + 1 }, (_, index) =>
      created(`EVT-${String(index + 1).padStart(4, '0')}`, index + 1));
    const observer = new Module10LifecycleObserver({ bus, events });

    await observer.start();

    expect(events.filters.map((filter) => filter.sinceSequence)).toEqual([0, MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE]);
    const projection = observer.getProjection('EMG-observer-test');
    expect(projection?.processedEventIds).toHaveLength(MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE + 1);
    expect(projection?.processedEventIds[0]).toBe('EVT-0001');
    expect(projection?.processedEventIds.at(-1)).toBe(`EVT-${String(MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE + 1).padStart(4, '0')}`);
    await observer.dispose();
  });

  it('does not report recovery ready after query failure and supports an explicit retry', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    events.records = [created('EVT-created', 1)];
    events.failuresRemaining = 1;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const observer = new Module10LifecycleObserver({ bus, events, logger });

    await expect(observer.start()).rejects.toThrow('in-memory event query failure');
    expect(observer.isReady).toBe(false);
    expect(observer.getProjection('EMG-observer-test')).toBeNull();
    expect(bus.subscriptionCount).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining('replay failed'));

    await observer.start();
    expect(observer.isReady).toBe(true);
    expect(observer.getProjection('EMG-observer-test')?.state).toBe('EMERGENCY_CREATED');
    await observer.dispose();
  });

  it('fails safely on malformed replay pages instead of silently completing recovery', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    events.records = [{ ...created('EVT-malformed', 1), sequence: Number.NaN }];
    const observer = new Module10LifecycleObserver({ bus, events });

    await expect(observer.start()).rejects.toThrow('malformed lifecycle replay event record');
    expect(observer.isReady).toBe(false);
    await observer.dispose();
  });

  it('serializes concurrent same-emergency deliveries and ignores duplicate IDs', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    const observer = new Module10LifecycleObserver({ bus, events });
    await observer.start();
    bus.publish(callConnected('EVT-connected', 2));
    bus.publish(created('EVT-created', 1));
    bus.publish(created('EVT-created', 1));

    await waitForProjection(observer, 'CALL_CONNECTED');
    await vi.waitFor(() => expect(observer.getProjection('EMG-observer-test')?.processedEventIds).toHaveLength(2));
    expect(observer.getProjection('EMG-observer-test')?.lastSequence).toBe(2);
    await observer.dispose();
  });

  it('disposes safely during replay, rejects startup and removes the subscription', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    const gate = deferred();
    events.beforeList = () => gate.promise;
    const observer = new Module10LifecycleObserver({ bus, events });
    const starting = observer.start();
    const disposing = observer.dispose();

    await expect(starting).rejects.toThrow('interrupted');
    await disposing;
    gate.resolve();
    await Promise.resolve();
    expect(observer.isReady).toBe(false);
    expect(bus.subscriptionCount).toBe(0);
    expect(observer.getProjection('EMG-observer-test')).toBeNull();
  });

  it('drains/rejects pending event work on shutdown and drops the in-memory projection', async () => {
    const bus = new InMemoryEventBus();
    const observer = new Module10LifecycleObserver({ bus, events: new InMemoryEventQuery() });
    await observer.start();
    bus.publish(created('EVT-pending', 1));

    await observer.dispose();

    expect(bus.subscriptionCount).toBe(0);
    expect(observer.getProjection('EMG-observer-test')).toBeNull();
  });

  it('marks empty event history ready and returns no projection for an unobserved emergency', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    const observer = new Module10LifecycleObserver({ bus, events });
    await observer.start();

    expect(observer.isReady).toBe(true);
    expect(observer.getProjection('EMG-never-seen')).toBeNull();
    expect(events.filters).toHaveLength(1);
    await observer.dispose();
  });

  it('subscribes only to verified event types and exposes an authenticated read-only route', async () => {
    const bus = new InMemoryEventBus();
    const events = new InMemoryEventQuery();
    events.records = [created('EVT-created', 1)];
    const observer = new Module10LifecycleObserver({ bus, events });
    await observer.start();
    const [route] = createModule10LifecycleRoutes(observer);
    const send = vi.fn();

    expect(bus.subscribedTypes).toEqual([...MODULE10_LIFECYCLE_EVENT_TYPES]);
    expect(bus.subscribedTypes).not.toContain('TRANSCRIPT_PARTIAL');
    expect(route.method).toBe('GET');
    expect(route.url).toBe('/api/emergencies/:id/lifecycle');
    expect(route.auth?.roles).toContain('OPERATOR');
    await route.handler(
      { params: { id: 'EMG-observer-test' }, query: {}, body: undefined, headers: {}, server: { now: () => new Date() } },
      { status: vi.fn(), header: vi.fn(), send } as unknown as HttpReply,
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      projection: expect.objectContaining({ emergencyId: 'EMG-observer-test', state: 'EMERGENCY_CREATED' }),
    }));
    await observer.dispose();
  });
});
