/**
 * Module 9 - corridor integration adapter.
 *
 * Implements the core `CorridorIntegrationPort` used by other modules to request
 * a corridor. It exists so a caller describes *what* it wants (an emergency,
 * ambulance and hospital) without having to know which route/geometry to use;
 * the adapter resolves the persisted transport route and delegates to the
 * corridor service. It never fabricates geometry: with no persisted transport
 * route it reports `ok: false`.
 */

import type { CorridorIntegrationPort } from '@resus/core';
import type { CorridorActivationOutcome, CorridorService } from './corridorService.js';
import type { CorridorRouteReadPort } from './ports.js';

export type EmergencyCorridorActivationResult =
  | { outcome: 'NO_TRANSPORT_ROUTE'; routeId?: never; activation?: never }
  | {
      outcome: CorridorActivationOutcome['outcome'];
      routeId: string;
      activation: CorridorActivationOutcome;
    };

export interface CorridorIntegrationDeps {
  corridors: CorridorService;
  routes: CorridorRouteReadPort;
}

export class CorridorIntegrationAdapter implements CorridorIntegrationPort {
  private readonly corridors: CorridorService;
  private readonly routes: CorridorRouteReadPort;

  constructor(deps: CorridorIntegrationDeps) {
    this.corridors = deps.corridors;
    this.routes = deps.routes;
  }

  /** Activates only from the latest persisted hospital-bound route. */
  async activateForEmergency(emergencyId: string): Promise<EmergencyCorridorActivationResult> {
    const routes = await this.routes.routesForEmergency(emergencyId);
    const transport = routes.filter(
      (route) =>
        route.emergencyId === emergencyId &&
        route.destinationName === 'HOSPITAL' &&
        route.hospitalId !== null,
    );
    const route = transport.at(-1);
    if (!route) return { outcome: 'NO_TRANSPORT_ROUTE' };

    const activation = await this.corridors.activateForRoute(route);
    return { outcome: activation.outcome, routeId: route.id, activation };
  }

  async activateCorridor(input: {
    emergencyId: string;
    ambulanceId: string;
    hospitalId: string;
    from: string;
    to: string;
  }): Promise<{ ok: boolean }> {
    const routes = await this.routes.routesForEmergency(input.emergencyId);
    const transport = routes.filter(
      (route) =>
        route.destinationName === 'HOSPITAL' && route.hospitalId === input.hospitalId,
    );
    const route = transport.length > 0 ? transport[transport.length - 1]! : null;
    if (!route) return { ok: false };

    const outcome = await this.corridors.activateForRoute(route);
    return { ok: outcome.outcome === 'ACTIVATED' || outcome.outcome === 'ALREADY_ACTIVE' };
  }
}
