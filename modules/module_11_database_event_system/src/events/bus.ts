import {
  type DomainEventBusPort,
  type Logger,
  type RealtimePublisherPort,
  type SystemEventRecord,
  type SystemEventType,
  createConsoleLogger,
} from '@resus/core';

type Handler = (event: SystemEventRecord) => void | Promise<void>;

interface Subscription {
  types: SystemEventType[] | null;
  handler: Handler;
}

/**
 * In-process pub/sub over the persisted event log.
 *
 * Module 5, 6 and 12 subscribe here; they never reach into each other. Every
 * published event is additionally forwarded to the real-time hub (WebSocket) so
 * that the dashboard sees the exact same ordering the database recorded.
 */
export class DomainEventBus implements DomainEventBusPort {
  private readonly subscriptions = new Set<Subscription>();
  private readonly realtime?: RealtimePublisherPort;
  private readonly logger: Logger;

  constructor(options: { realtime?: RealtimePublisherPort; logger?: Logger } = {}) {
    this.realtime = options.realtime;
    this.logger = options.logger ?? createConsoleLogger('info', 'module_11.bus');
  }

  subscribe<T extends SystemEventType>(
    types: T[],
    handler: (event: SystemEventRecord) => void | Promise<void>,
  ): () => void {
    const subscription: Subscription = { types: types as SystemEventType[], handler };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /** Subscribes to every event type. */
  subscribeAll(handler: Handler): () => void {
    const subscription: Subscription = { types: null, handler };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
  }
  }

  publish(event: SystemEventRecord): void {
    for (const subscription of this.subscriptions) {
      if (subscription.types && !subscription.types.includes(event.type)) continue;
      try {
        const result = subscription.handler(event);
        if (result instanceof Promise) {
          result.catch((error: unknown) =>
            this.logger.error(
              { error: error instanceof Error ? error.message : String(error), eventId: event.id },
              'event subscriber failed',
            ),
          );
        }
      } catch (error) {
        this.logger.error(
          { error: error instanceof Error ? error.message : String(error), eventId: event.id },
          'event subscriber failed',
        );
      }
    }

    this.realtime?.publish('events', {
      kind: 'event',
      eventType: event.type,
      channel: 'events',
      payload: event,
      sequence: event.sequence,
      timestamp: event.timestamp,
      isSimulation: Boolean((event.payload as { isSimulation?: boolean } | null)?.isSimulation),
    });
  }
}
