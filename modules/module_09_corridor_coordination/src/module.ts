/**
 * Module 9 - Corridor Coordination.
 *
 * Owns the corridor lifecycle and its notification intents for an emergency. It
 * derives a corridor geofence from a persisted planned route, records the
 * corridor and (simulated) road users through Module 11, and is the only writer
 * of corridor + notification rows.
 *
 * What it is not: there is no traffic-signal controller, no live road-user feed
 * and no messaging provider in this repository. Every corridor is therefore
 * stored with `priorityMode: SIMULATED`, and every notification with
 * `delivered: false`. Nothing here can change emergency status, protocol state,
 * dispatch or hospital selection.
 */

import {
  noopLogger,
  type DomainEventBusPort,
  type EventQueryPort,
  type Logger,
  type RouteDefinition,
  type RouteTable,
} from '@resus/core';
import { loadModule9Config, type Module9Config } from './config.js';
import { CorridorService } from './corridorService.js';
import { CorridorIntegrationAdapter } from './corridorIntegration.js';
import { AutoCorridorService } from './autoCorridorService.js';
import { MockRoadUserProvider } from './providers/roadUserProvider.js';
import { MockNotificationProvider } from './providers/notificationProvider.js';
import { createModule9Routes } from './api/routes.js';
import { SimulatedPoliceNotificationService } from './policeNotificationService.js';
import type { CorridorRouteReadPort, CorridorWriterPort, NotificationWriterPort } from './ports.js';

export interface Module9Deps {
  /** Corridor persistence (Module 11 `RouteRepository`). */
  corridors: CorridorWriterPort;
  /** Notification persistence (Module 11 `NotificationRepository`). */
  notifications: NotificationWriterPort;
  /** Route read port, to derive corridor geometry from a persisted route. */
  routes: CorridorRouteReadPort;
  /**
   * Optional in-process bus. When supplied together with `config.enabled`,
   * Module 9 subscribes to `HOSPITAL_SELECTED` and `ROUTE_GENERATED` and
   * coordinates the corridor automatically. Omitted by tests.
   */
  bus?: DomainEventBusPort;
  /** Read-only Module 11 event log used to require persisted explicit dispatch evidence. */
  dispatchEvents?: EventQueryPort;
  config?: Module9Config;
  logger?: Logger;
}

export class Module9 {
  readonly service: CorridorService;
  readonly integration: CorridorIntegrationAdapter;
  readonly autoCorridor: AutoCorridorService | undefined;
  readonly policeNotifications: SimulatedPoliceNotificationService | undefined;
  readonly config: Module9Config;

  constructor(deps: Module9Deps) {
    this.config = deps.config ?? loadModule9Config();
    const logger = deps.logger ?? noopLogger;

    this.service = new CorridorService({
      corridors: deps.corridors,
      notifications: deps.notifications,
      roadUsers: new MockRoadUserProvider({ maxUsers: this.config.maxSimulatedRoadUsers }),
      notificationProvider: new MockNotificationProvider(),
      config: this.config,
      logger,
    });

    this.integration = new CorridorIntegrationAdapter({
      corridors: this.service,
      routes: deps.routes,
    });
    this.policeNotifications = deps.dispatchEvents && deps.notifications.createPoliceRouteNotification && deps.notifications.acknowledgePoliceRouteNotification
      ? new SimulatedPoliceNotificationService({
          routes: deps.routes,
          dispatchEvents: deps.dispatchEvents,
          notifications: deps.notifications,
          logger,
        })
      : undefined;

    this.autoCorridor =
      deps.bus && this.config.enabled
        ? new AutoCorridorService({
            events: deps.bus,
            corridors: this.service,
            routes: deps.routes,
            logger,
          })
        : undefined;
  }

  routes(): RouteDefinition<Record<string, unknown>>[] {
    return createModule9Routes(this.service, this.integration, this.policeNotifications);
  }

  register(table: RouteTable): void {
    table.addAll(this.routes());
  }

  dispose(): void {
    this.autoCorridor?.dispose();
  }
}
