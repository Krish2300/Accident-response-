/**
 * Module 9 - event-driven corridor activation.
 *
 * Subscribes to the Module 11 bus and coordinates a corridor once an emergency
 * has a transport route to a selected hospital.
 *
 *  - `HOSPITAL_SELECTED` means the destination is known, so a transport route
 *    *may* already exist.
 *  - `ROUTE_GENERATED` means a route was just persisted, which may be the
 *    transport leg.
 *
 * The handler is deliberately route-driven: on either event it re-reads the
 * emergency's persisted routes and only acts if a transport route (destination
 * `HOSPITAL`) actually exists. Both events therefore funnel into one path, and
 * because Module 11's activation is idempotent per emergency, a duplicate or
 * re-delivered event cannot create a second active corridor.
 */

import {
  noopLogger,
  type DomainEventBusPort,
  type Logger,
  type SystemEventRecord,
  type SystemEventType,
} from '@resus/core';
import type { CorridorService, CorridorActivationOutcome } from './corridorService.js';
import type { CorridorRoute, CorridorRouteReadPort } from './ports.js';

export const AUTO_CORRIDOR_EVENT_TYPES: SystemEventType[] = [
  'HOSPITAL_SELECTED',
  'ROUTE_GENERATED',
];

export interface AutoCorridorDeps {
  /** In-process bus owned by Module 11. */
  events: DomainEventBusPort;
  corridors: CorridorService;
  routes: CorridorRouteReadPort;
  logger?: Logger;
}

export class AutoCorridorService {
  private readonly corridors: CorridorService;
  private readonly routes: CorridorRouteReadPort;
  private readonly logger: Logger;
  private readonly unsubscribe: () => void;
  private readonly inFlight = new Map<string, Promise<CorridorActivationOutcome | null>>();
  private readonly inFlightEvents = new Set<Promise<void>>();
  private disposed = false;

  constructor(deps: AutoCorridorDeps) {
    this.corridors = deps.corridors;
    this.routes = deps.routes;
    this.logger = deps.logger ?? noopLogger;
    this.unsubscribe = deps.events.subscribe(AUTO_CORRIDOR_EVENT_TYPES, (event) =>
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
  async handleEvent(event: SystemEventRecord): Promise<CorridorActivationOutcome | null> {
    if (!AUTO_CORRIDOR_EVENT_TYPES.includes(event.type)) return null;
    const emergencyId = this.emergencyIdFrom(event);
    if (!emergencyId) return null;
    return this.coordinate(emergencyId);
  }

  /**
   * Coordinates the corridor for one emergency.
   *
   * The in-flight map is keyed by emergency and set synchronously before the
   * first `await`, so two events arriving back-to-back cannot both activate.
   */
  async coordinate(emergencyId: string): Promise<CorridorActivationOutcome | null> {
    if (this.disposed) return null;
    const existing = this.inFlight.get(emergencyId);
    if (existing) return existing;

    const run = this.run(emergencyId);
    this.inFlight.set(emergencyId, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(emergencyId);
    }
  }

  private async run(emergencyId: string): Promise<CorridorActivationOutcome | null> {
    const route = await this.resolveTransportRoute(emergencyId);
    if (!route) return null;

    const outcome = await this.corridors.activateForRoute(route);
    if (outcome.outcome === 'FAILED') {
      this.logger.warn({ emergencyId }, 'auto-corridor could not activate');
    } else {
      this.logger.debug({ emergencyId, outcome: outcome.outcome }, 'auto-corridor evaluated');
    }
    return outcome;
  }

  /** The most recent persisted transport route (destination `HOSPITAL`). */
  private async resolveTransportRoute(emergencyId: string): Promise<CorridorRoute | null> {
    const routes = await this.routes.routesForEmergency(emergencyId);
    const transport = routes.filter(
      (route) => route.destinationName === 'HOSPITAL' && route.hospitalId !== null,
    );
    return transport.length > 0 ? transport[transport.length - 1]! : null;
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
            'auto-corridor subscriber threw',
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
}
