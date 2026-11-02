import {
  noopLogger,
  type DomainEventBusPort,
  type Logger,
  type SystemEventRecord,
  type SystemEventType,
} from '@resus/core';
import type { RouteGenerationResult, RouteLeg, RouteOptimizationService } from './routeOptimizationService.js';

/**
 * Events that mean "one leg of this emergency's journey can now be planned".
 *
 *  - `AMBULANCE_DISPATCHED` confirms an explicit dispatch, so the response leg
 *    (ambulance -> scene) becomes plannable.
 *  - `HOSPITAL_SELECTED` supplies the destination, so the transport leg
 *    (scene -> hospital) becomes plannable.
 *
 * The service re-checks both prerequisites, so an event that arrives before its
 * counterpart is simply skipped and the later event still produces the route.
 */
export const AUTO_ROUTE_EVENT_TYPES: SystemEventType[] = ['AMBULANCE_DISPATCHED', 'HOSPITAL_SELECTED'];

const EVENT_TO_LEG: Partial<Record<SystemEventType, RouteLeg>> = {
  AMBULANCE_DISPATCHED: 'RESPONSE',
  HOSPITAL_SELECTED: 'TRANSPORT',
};

export interface AutoRouteDeps {
  /** In-process bus owned by Module 11. */
  events: DomainEventBusPort;
  optimization: RouteOptimizationService;
  logger?: Logger;
}

/**
 * Event-driven automatic route generation.
 *
 * Subscribes to the Module 11 bus and runs the same
 * `RouteOptimizationService.generateForEmergency` an operator call would use. It
 * decides *when* to plan, and the service decides *how*. It never changes
 * emergency status, protocol state or ambulance assignment.
 *
 * Safety properties:
 *  - Idempotent per leg: concurrent events for the same emergency+leg are
 *    collapsed, and the service skips a leg whose route already exists, so a
 *    retried or duplicated event cannot plan twice.
 *  - Simulation is excluded unless explicitly enabled.
 *  - A failure is logged and returned as an outcome, never emitted as a route.
 */
export class AutoRouteService {
  private readonly optimization: RouteOptimizationService;
  private readonly logger: Logger;
  private readonly unsubscribe: () => void;
  private readonly inFlight = new Map<string, Promise<RouteGenerationResult>>();
  private readonly inFlightEvents = new Set<Promise<void>>();
  private disposed = false;

  constructor(deps: AutoRouteDeps) {
    this.optimization = deps.optimization;
    this.logger = deps.logger ?? noopLogger;
    this.unsubscribe = deps.events.subscribe(AUTO_ROUTE_EVENT_TYPES, (event) =>
      this.onEvent(event),
    );
  }

  /** Awaits every event the bus has handed to this subscriber that is still running. */
  async idle(): Promise<void> {
    while (this.inFlightEvents.size > 0) {
      await Promise.allSettled([...this.inFlightEvents]);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  /** Handles one event record. Exposed so tests can drive it without a bus. */
  async handleEvent(event: SystemEventRecord): Promise<RouteGenerationResult | null> {
    const leg = EVENT_TO_LEG[event.type];
    if (!leg) return null;
    const emergencyId = this.emergencyIdFrom(event);
    if (!emergencyId) return null;
    return this.generate(emergencyId, leg);
  }

  /**
   * Runs planning for one emergency+leg.
   *
   * The in-flight map is keyed by emergency+leg and set synchronously before the
   * first `await`, so two events arriving back-to-back cannot both reach the
   * routing provider.
   */
  async generate(emergencyId: string, leg: RouteLeg): Promise<RouteGenerationResult> {
    if (this.disposed) {
      return { emergencyId, leg, outcome: 'SKIPPED_STATUS', reason: 'auto-route disposed' };
    }
    const key = `${emergencyId}:${leg}`;
    const inFlight = this.inFlight.get(key);
    if (inFlight) return inFlight;

    const run = this.optimization.generateForEmergency(emergencyId, leg);
    this.inFlight.set(key, run);
    try {
      const result = await run;
      this.logResult(result);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private onEvent(event: SystemEventRecord): void {
    const task = this.handleEvent(event)
      .then(
        () => undefined,
        (error: unknown) => {
          this.logger.error(
            {
              eventId: event.id,
              eventType: event.type,
              error: error instanceof Error ? error.message : String(error),
            },
            'auto-route subscriber threw',
          );
        },
      )
      .finally(() => {
        this.inFlightEvents.delete(task);
      });
    this.inFlightEvents.add(task);
  }

  private emergencyIdFrom(event: SystemEventRecord): string | null {
    if (event.emergencyId) return event.emergencyId;
    const payload = event.payload as { emergencyId?: unknown } | null;
    return typeof payload?.emergencyId === 'string' ? payload.emergencyId : null;
  }

  private logResult(result: RouteGenerationResult): void {
    if (result.outcome === 'GENERATED') return;
    if (result.outcome === 'FAILED') {
      this.logger.warn({ ...result }, 'auto-route could not plan a route');
      return;
    }
    this.logger.debug({ ...result }, 'auto-route skipped');
  }
}
