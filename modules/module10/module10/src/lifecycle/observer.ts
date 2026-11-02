import type {
  DomainEventBusPort,
  EventQueryPort,
  Logger,
  SystemEventRecord,
  SystemEventType,
} from '@resus/core';
import { reduceLifecycleProjection } from './reducer';
import type { Module10LifecycleProjection } from './types';

/** Events whose producer contracts were verified for the Module 10 projection. */
export const MODULE10_LIFECYCLE_EVENT_TYPES = [
  'EMERGENCY_CREATED',
  'CALL_CONNECTED',
  'TRANSCRIPT_UPDATED',
  'NLP_EXTRACTION_COMPLETED',
  'EMERGENCY_CLASSIFIED',
  'AMBULANCE_ASSIGNED',
  'AMBULANCE_DISPATCHED',
  'HOSPITAL_SELECTED',
  'ROUTE_GENERATED',
  'CORRIDOR_ACTIVATED',
  'AMBULANCE_ARRIVED_SCENE',
  'PATIENT_ONBOARD',
  'AMBULANCE_ARRIVED_HOSPITAL',
  'EMERGENCY_COMPLETED',
] as const satisfies readonly SystemEventType[];

export const MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE = 500;

const eventTypeSet = new Set<SystemEventType>(MODULE10_LIFECYCLE_EVENT_TYPES);

export interface Module10LifecycleObserverDeps {
  bus: Pick<DomainEventBusPort, 'subscribe'>;
  events: Pick<EventQueryPort, 'list'>;
  logger?: Logger;
}

type ObserverState = 'idle' | 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';

/** In-memory, read-only observer over Module 11's post-commit event bus and event log. */
export class Module10LifecycleObserver {
  private readonly projections = new Map<string, Module10LifecycleProjection>();
  private readonly processedEventIds = new Set<string>();
  private readonly bufferedEvents: SystemEventRecord[] = [];
  private readonly processingByEmergency = new Map<string, Promise<void>>();
  private readonly bus: Pick<DomainEventBusPort, 'subscribe'>;
  private readonly events: Pick<EventQueryPort, 'list'>;
  private readonly logger?: Logger;
  private unsubscribe: (() => void) | undefined;
  private state: ObserverState = 'idle';
  private startPromise: Promise<void> | undefined;
  private interruptStartup: (() => void) | undefined;

  constructor(deps: Module10LifecycleObserverDeps) {
    this.bus = deps.bus;
    this.events = deps.events;
    this.logger = deps.logger;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /**
   * Subscribe first, replay the committed event log to a captured high-water
   * sequence, then drain live events buffered during replay. A failed replay
   * rejects startup; callers must not advertise this observer as recovered.
   */
  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'starting' && this.startPromise) return this.startPromise;
    if (this.state === 'stopping' || this.state === 'stopped') {
      return Promise.reject(new Error('Module 10 lifecycle observer has been disposed'));
    }

    this.clearState();
    this.state = 'starting';
    this.unsubscribe = this.bus.subscribe(
      [...MODULE10_LIFECYCLE_EVENT_TYPES],
      (event) => this.receive(event),
    );

    let rejectInterrupted!: (reason: Error) => void;
    const interrupted = new Promise<void>((_resolve, reject) => { rejectInterrupted = reject; });
    this.interruptStartup = () => rejectInterrupted(new Error('Module 10 lifecycle observer startup was interrupted'));
    const startPromise = Promise.race([this.replayAndDrain(), interrupted])
      .then(() => {
        if (this.state !== 'starting') {
          throw new Error('Module 10 lifecycle observer startup was interrupted');
        }
        this.state = 'ready';
      })
      .catch((error: unknown) => {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.bufferedEvents.length = 0;
        if (this.state !== 'stopping' && this.state !== 'stopped') {
          this.clearState();
          this.state = 'failed';
        }
        this.logger?.error(
          { error: error instanceof Error ? error.message : String(error) },
          'Module 10 lifecycle observer replay failed; startup is not ready',
        );
        throw error;
      })
      .finally(() => {
        if (this.startPromise === startPromise) {
          this.startPromise = undefined;
          this.interruptStartup = undefined;
        }
      });
    this.startPromise = startPromise;
    return startPromise;
  }

  getProjection(emergencyId: string): Module10LifecycleProjection | null {
    if (!this.isReady || !emergencyId || emergencyId.trim() !== emergencyId) return null;
    const projection = this.projections.get(emergencyId);
    return projection ? structuredClone(projection) : null;
  }

  /** Stop accepting records, detach from the bus and drain queued work. */
  async dispose(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.bufferedEvents.length = 0;
    this.interruptStartup?.();
    const startup = this.startPromise;
    if (startup) await startup.catch(() => undefined);
    await Promise.all([...this.processingByEmergency.values()]);
    this.clearState();
    this.state = 'stopped';
  }

  private receive(event: SystemEventRecord): Promise<void> | void {
    if (this.state === 'stopping' || this.state === 'stopped' || this.state === 'failed') return;
    if (!eventTypeSet.has(event.type)) {
      this.logger?.debug(
        { eventId: event.id, eventType: event.type },
        'Module 10 lifecycle observer ignored unsupported event type',
      );
      return;
    }
    if (this.state === 'starting') {
      this.bufferedEvents.push(event);
      return;
    }
    return this.enqueue(event);
  }

  private async replayAndDrain(): Promise<void> {
    const highWaterSequence = await this.replayHistory();
    this.ensureStarting();
    this.logger?.info(
      { highWaterSequence },
      'Module 10 lifecycle event history replayed; draining buffered live events',
    );

    // Events may arrive while an awaited queued item is being processed. Drain
    // sorted batches until the synchronous state transition to `ready` is safe.
    while (this.bufferedEvents.length > 0) {
      this.ensureStarting();
      const batch = this.bufferedEvents.splice(0).sort(compareEvents);
      for (const event of batch) {
        this.ensureStarting();
        await this.enqueue(event);
      }
    }
  }

  private async replayHistory(): Promise<number> {
    let cursor = 0;
    let highWaterSequence: number | undefined;
    let firstPage = true;

    while (true) {
      this.ensureStarting();
      const page = await this.events.list({
        types: [...MODULE10_LIFECYCLE_EVENT_TYPES],
        sinceSequence: cursor,
        limit: MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE,
        offset: 0,
      });
      this.ensureStarting();

      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.latestSequence) || page.latestSequence < 0) {
        throw new Error('Module 11 returned an invalid lifecycle replay page');
      }
      if (page.items.length > MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE) {
        throw new Error('Module 11 returned more lifecycle replay records than requested');
      }
      if (page.items.some((event) =>
        !Number.isSafeInteger(event.sequence) || event.sequence <= 0 ||
        typeof event.id !== 'string' || event.id.length === 0 || event.id.trim() !== event.id,
      )) {
        throw new Error('Module 11 returned a malformed lifecycle replay event record');
      }
      if (firstPage) {
        highWaterSequence = page.latestSequence;
        firstPage = false;
      }

      const ordered = [...page.items].sort(compareEvents);
      const eligible = ordered.filter((event) =>
        Number.isSafeInteger(event.sequence) && event.sequence > cursor && event.sequence <= highWaterSequence!,
      );
      for (const event of eligible) {
        this.ensureStarting();
        await this.enqueue(event);
        cursor = Math.max(cursor, event.sequence);
      }

      // The query is strictly `sequence > cursor` and ordered ascending. Once
      // the first row exceeds the captured high-water mark, no later history
      // row can belong to the startup snapshot.
      if (ordered.some((event) => Number.isSafeInteger(event.sequence) && event.sequence > highWaterSequence!)) {
        break;
      }
      if (ordered.length === 0) break;
      if (ordered.length < MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE) break;
      if (eligible.length === 0) {
        throw new Error('Module 11 lifecycle replay page made no sequence progress');
      }
    }

    return highWaterSequence ?? 0;
  }

  private enqueue(event: SystemEventRecord): Promise<void> {
    const emergencyId = event.emergencyId;
    if (typeof emergencyId !== 'string' || emergencyId.trim() !== emergencyId || emergencyId.length === 0) {
      this.apply(event);
      return Promise.resolve();
    }
    if (event.id && this.processedEventIds.has(event.id)) return Promise.resolve();

    const previous = this.processingByEmergency.get(emergencyId) ?? Promise.resolve();
    const queued = previous
      .then(() => {
        if (this.state === 'stopping' || this.state === 'stopped') return;
        this.apply(event);
      })
      .catch((error: unknown) => {
        this.logger?.error(
          { eventId: event.id, emergencyId, error: error instanceof Error ? error.message : String(error) },
          'Module 10 lifecycle event processing failed',
        );
      });
    this.processingByEmergency.set(emergencyId, queued);
    void queued.then(() => {
      if (this.processingByEmergency.get(emergencyId) === queued) {
        this.processingByEmergency.delete(emergencyId);
      }
    });
    return queued;
  }

  private apply(event: SystemEventRecord): void {
    if (event.id && this.processedEventIds.has(event.id)) return;
    const current = typeof event.emergencyId === 'string'
      ? this.projections.get(event.emergencyId)
      : undefined;
    const next = reduceLifecycleProjection(current, event, this.logger);
    if (next) {
      this.projections.set(next.emergencyId, next);
      if (event.id && next.processedEventIds.includes(event.id)) this.processedEventIds.add(event.id);
      else this.logger?.debug(
        { eventId: event.id, eventType: event.type, emergencyId: event.emergencyId },
        'Module 10 lifecycle observer ignored malformed projection input',
      );
    }
  }

  private ensureStarting(): void {
    if (this.state !== 'starting') throw new Error('Module 10 lifecycle observer startup was interrupted');
  }

  private clearState(): void {
    this.projections.clear();
    this.processedEventIds.clear();
    this.bufferedEvents.length = 0;
    this.processingByEmergency.clear();
  }
}

function compareEvents(left: SystemEventRecord, right: SystemEventRecord): number {
  const leftSequence = Number.isSafeInteger(left.sequence) ? left.sequence : Number.MAX_SAFE_INTEGER;
  const rightSequence = Number.isSafeInteger(right.sequence) ? right.sequence : Number.MAX_SAFE_INTEGER;
  const leftId = typeof left.id === 'string' ? left.id : '';
  const rightId = typeof right.id === 'string' ? right.id : '';
  return leftSequence - rightSequence || leftId.localeCompare(rightId);
}
