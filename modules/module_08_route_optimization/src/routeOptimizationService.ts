import {
  AppError,
  defineEvent,
  isValidCoordinate,
  noopLogger,
  type Ambulance,
  type Coordinate,
  type Emergency,
  type EventPublisherPort,
  type Hospital,
  type Logger,
  type RouteResult,
  type RoutingProvider,
  type SystemEventEnvelope,
} from '@resus/core';
import type { Module8Config } from './config.js';
import { RoutingProviderError } from './providers/index.js';

/**
 * A route as this module reads and writes it.
 *
 * Declared here rather than importing Module 11's record type, so Module 8
 * depends on a shape, not on the persistence module. Module 11's `RouteRecord`
 * satisfies it structurally.
 */
export interface PlannedRoute {
  id: string;
  emergencyId: string;
  ambulanceId: string;
  hospitalId: string | null;
  originName: string;
  destinationName: string;
  distanceKm: number;
  polyline: Array<[number, number]>;
  estimatedMinutes: number | null;
  provider: string;
  isLiveTraffic: boolean;
  isSimulation: boolean;
  /** Lifecycle status; recalculation refuses terminal routes when present. */
  status?: string;
}

export interface RouteCreateInput {
  emergencyId: string;
  ambulanceId: string;
  hospitalId?: string | null;
  originName?: string;
  destinationName: string;
  origin: Coordinate;
  destination: Coordinate;
  distanceKm: number;
  polyline?: Array<[number, number]>;
  estimatedMinutes?: number | null;
  isSimulation?: boolean;
  provider?: string;
  isLiveTraffic?: boolean;
  trafficFactor?: number | null;
  alternatives?: unknown[];
  selectionReason?: Record<string, unknown> | null;
}

/** The persistence side Module 8 needs to record a route and read it back. */
export interface RouteWriterPort {
  createRoute(input: RouteCreateInput): Promise<PlannedRoute>;
  /** Optional atomic Module 11 capability; mocks may fall back to the event port. */
  createRouteWithEvent?(
    input: RouteCreateInput,
    eventFor: (route: PlannedRoute) => SystemEventEnvelope,
  ): Promise<PlannedRoute>;
  /**
   * Optional atomic Module 11 capability: replace an established route's
   * geometry/ETA and record the recalculation event in one transaction.
   * When absent, recalculation is refused rather than half-done.
   */
  replaceRouteWithEvent?(
    routeId: string,
    update: {
      distanceKm: number;
      polyline?: Array<[number, number]>;
      estimatedMinutes?: number | null;
      provider?: string;
      isLiveTraffic?: boolean;
      trafficFactor?: number | null;
      alternatives?: unknown[];
      selectionReason?: Record<string, unknown> | null;
    },
    eventFor: (
      route: PlannedRoute,
      previous: { distanceKm: number; estimatedMinutes: number | null },
    ) => SystemEventEnvelope,
  ): Promise<PlannedRoute>;
  routesForEmergency(emergencyId: string): Promise<PlannedRoute[]>;
  findById(id: string): Promise<PlannedRoute | null>;
}

/** The read side Module 8 needs to resolve a route's endpoints. */
export interface EmergencyRoutePort {
  findById(id: string): Promise<Emergency | null>;
}
export interface AmbulanceRoutePort {
  findById(id: string): Promise<Ambulance | null>;
  getAssignedAmbulanceForDriver?(driverId: string): Promise<Ambulance | null>;
}
export interface HospitalRoutePort {
  findById(id: string): Promise<Hospital | null>;
}

export interface RouteOptimizationDeps {
  /** Configured provider. */
  primary: RoutingProvider;
  /** Deterministic provider used when the primary fails. */
  fallback: RoutingProvider;
  routes: RouteWriterPort;
  emergencies: EmergencyRoutePort;
  ambulances: AmbulanceRoutePort;
  hospitals: HospitalRoutePort;
  events: EventPublisherPort;
  config: Module8Config;
  logger?: Logger;
}

export type RouteLeg = 'RESPONSE' | 'TRANSPORT';

/**
 * Leg labels, written as the route's `originName`/`destinationName`.
 *
 * They double as the idempotency key: an emergency never gets two routes with
 * the same destination, so a redelivered event cannot plan the same leg twice.
 */
export const LEG_LABELS: Record<RouteLeg, { originName: string; destinationName: string }> = {
  RESPONSE: { originName: 'AMBULANCE', destinationName: 'SCENE' },
  TRANSPORT: { originName: 'SCENE', destinationName: 'HOSPITAL' },
};

export type RouteGenerationOutcome =
  | 'GENERATED'
  | 'SKIPPED_NOT_FOUND'
  | 'SKIPPED_SIMULATION'
  | 'SKIPPED_STATUS'
  | 'SKIPPED_NO_AMBULANCE'
  | 'SKIPPED_NO_HOSPITAL'
  | 'SKIPPED_NO_POSITION'
  | 'SKIPPED_INVALID_LOCATION'
  | 'SKIPPED_ALREADY_EXISTS'
  | 'FAILED';

export interface RouteGenerationResult {
  emergencyId: string;
  leg: RouteLeg;
  outcome: RouteGenerationOutcome;
  routeId?: string;
  provider?: string;
  reason?: string;
}

export type RouteRecalculationOutcome =
  | 'RECALCULATED'
  | 'SKIPPED_NOT_FOUND'
  | 'SKIPPED_SIMULATION'
  | 'SKIPPED_STATUS'
  | 'SKIPPED_NO_AMBULANCE'
  | 'SKIPPED_NO_HOSPITAL'
  | 'SKIPPED_NO_POSITION'
  | 'SKIPPED_INVALID_LOCATION'
  | 'UNSUPPORTED'
  | 'FAILED';

export interface RouteRecalculationResult {
  routeId: string;
  emergencyId: string;
  outcome: RouteRecalculationOutcome;
  provider?: string;
  reason?: string;
}

/**
 * Trusted actor context for a recalculation, derived server-side from the
 * authenticated request (never from caller-supplied body fields). When omitted
 * the event records the system-initiated default (`SYSTEM` / null).
 */
export interface RecalculationActorContext {
  actorType?: string | null;
  actorId?: string | null;
}

/** Statuses after which planning another leg no longer makes sense. */
const TERMINAL_STATUSES = new Set<string>(['COMPLETED', 'CANCELLED']);

/** Route statuses after which replacing geometry no longer makes sense. */
const TERMINAL_ROUTE_STATUSES = new Set<string>(['COMPLETED', 'ARRIVED', 'ABANDONED']);

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Module 8's route planning algorithm.
 *
 * `generateForEmergency` resolves an emergency's endpoints and plans one leg:
 *
 *  - RESPONSE: ambulance's current position -> the incident scene, triggered by
 *    an ambulance assignment.
 *  - TRANSPORT: the incident scene -> the selected hospital, triggered by a
 *    hospital selection.
 *
 * It records exactly one `Route` row per leg (with its provider provenance) and
 * the matching `ROUTE_GENERATED` event, and it never changes emergency status,
 * protocol state or ambulance assignment. When the configured provider fails it
 * falls back to the deterministic provider and records a `ROUTE_FAILED` with
 * `degradedToEstimate: true` so the downgrade is visible rather than silent.
 */
export class RouteOptimizationService {
  private readonly primary: RoutingProvider;
  private readonly fallback: RoutingProvider;
  private readonly routes: RouteWriterPort;
  private readonly emergencies: EmergencyRoutePort;
  private readonly ambulances: AmbulanceRoutePort;
  private readonly hospitals: HospitalRoutePort;
  private readonly events: EventPublisherPort;
  private readonly config: Module8Config;
  private readonly logger: Logger;
  private readonly inFlight = new Map<string, Promise<RouteGenerationResult>>();

  constructor(deps: RouteOptimizationDeps) {
    this.primary = deps.primary;
    this.fallback = deps.fallback;
    this.routes = deps.routes;
    this.emergencies = deps.emergencies;
    this.ambulances = deps.ambulances;
    this.hospitals = deps.hospitals;
    this.events = deps.events;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  /** Read-only prerequisite for the HTTP contract; it performs no route action. */
  async getEmergencyForDispatchCheck(emergencyId: string): Promise<Emergency | null> {
    return this.emergencies.findById(emergencyId);
  }

  /** Plans one leg for an emergency, if its inputs are known. */
  async generateForEmergency(emergencyId: string, leg: RouteLeg): Promise<RouteGenerationResult> {
    const key = `${emergencyId}:${leg}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const generation = this.generateOnce(emergencyId, leg);
    this.inFlight.set(key, generation);
    try {
      return await generation;
    } finally {
      if (this.inFlight.get(key) === generation) this.inFlight.delete(key);
    }
  }

  private async generateOnce(emergencyId: string, leg: RouteLeg): Promise<RouteGenerationResult> {
    const labels = LEG_LABELS[leg];

    const emergency = await this.emergencies.findById(emergencyId);
    if (!emergency) {
      return { emergencyId, leg, outcome: 'SKIPPED_NOT_FOUND', reason: 'emergency not found' };
    }
    if (emergency.isSimulation && !(this.config.generation?.includeSimulation ?? false)) {
      return { emergencyId, leg, outcome: 'SKIPPED_SIMULATION' };
    }
    if (TERMINAL_STATUSES.has(emergency.status)) {
      return { emergencyId, leg, outcome: 'SKIPPED_STATUS', reason: `status ${emergency.status}` };
    }
    if (!emergency.assignedAmbulanceId) {
      return { emergencyId, leg, outcome: 'SKIPPED_NO_AMBULANCE', reason: 'no ambulance assigned' };
    }

    const existing = await this.routes.routesForEmergency(emergencyId);
    const existingRoute = [...existing].reverse().find((route) => route.destinationName === labels.destinationName);
    if (existingRoute) {
      return {
        emergencyId,
        leg,
        outcome: 'SKIPPED_ALREADY_EXISTS',
        routeId: existingRoute.id,
        provider: existingRoute.provider,
        reason: `${labels.destinationName} route already planned`,
      };
    }

    const ambulance = await this.ambulances.findById(emergency.assignedAmbulanceId);
    if (!ambulance) {
      return { emergencyId, leg, outcome: 'SKIPPED_NO_AMBULANCE', reason: 'assigned ambulance not found' };
    }

    const endpoints = await this.resolveEndpoints(emergency, ambulance, leg);
    if ('outcome' in endpoints) {
      return { emergencyId, leg, ...endpoints };
    }

    try {
      const route = await this.planAndRecord({
        emergencyId,
        ambulanceId: ambulance.id,
        hospitalId: endpoints.hospitalId,
        originName: labels.originName,
        destinationName: labels.destinationName,
        from: endpoints.from,
        to: endpoints.to,
        isSimulation: emergency.isSimulation,
      });
      return {
        emergencyId,
        leg,
        outcome: 'GENERATED',
        routeId: route.id,
        provider: route.provider,
      };
    } catch (error) {
      const reason = messageOf(error);
      await this.recordFailed({
        emergencyId,
        ambulanceId: ambulance.id,
        provider: this.primary.providerName,
        reason,
        degradedToEstimate: false,
      });
      this.logger.error({ emergencyId, leg, error: reason }, 'route generation failed');
      return { emergencyId, leg, outcome: 'FAILED', reason };
    }
  }

  /**
   * Replaces an established route with a newly computed one.
   *
   * A recalculation only happens when a previously persisted route is replaced
   * by a newly accepted route: initial creation stays `ROUTE_GENERATED`-only,
   * and provider failure, terminal routes, or a persistence refusal produce no
   * `ROUTE_RECALCULATED` event. The replacement write and its event commit
    * atomically through Module 11. `reason` is a required, operator-supplied
    * explanation carried verbatim into the event payload. `actor` carries the
    * authenticated caller identity (from trusted auth context only); when it is
    * omitted, the event records the system-initiated default (`SYSTEM`).
    */
  async recalculateRoute(
    routeId: string,
    reason: string,
    actor?: RecalculationActorContext,
  ): Promise<RouteRecalculationResult> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw AppError.validation('A recalculation reason is required.');
    }

    const existing = await this.routes.findById(routeId);
    if (!existing) {
      return {
        routeId,
        emergencyId: '',
        outcome: 'SKIPPED_NOT_FOUND',
        reason: 'route not found',
      };
    }
    const emergencyId = existing.emergencyId;

    if (TERMINAL_ROUTE_STATUSES.has(existing.status ?? '')) {
      return {
        routeId,
        emergencyId,
        outcome: 'SKIPPED_STATUS',
        reason: `route status ${existing.status}`,
      };
    }
    if (!this.routes.replaceRouteWithEvent) {
      return {
        routeId,
        emergencyId,
        outcome: 'UNSUPPORTED',
        reason: 'route persistence does not support atomic replacement',
      };
    }

    const emergency = await this.emergencies.findById(emergencyId);
    if (!emergency) {
      return {
        routeId,
        emergencyId,
        outcome: 'SKIPPED_NOT_FOUND',
        reason: 'emergency not found',
      };
    }
    if (emergency.isSimulation && !(this.config.generation?.includeSimulation ?? false)) {
      return { routeId, emergencyId, outcome: 'SKIPPED_SIMULATION' };
    }
    if (TERMINAL_STATUSES.has(emergency.status)) {
      return {
        routeId,
        emergencyId,
        outcome: 'SKIPPED_STATUS',
        reason: `status ${emergency.status}`,
      };
    }
    if (!emergency.assignedAmbulanceId) {
      return {
        routeId,
        emergencyId,
        outcome: 'SKIPPED_NO_AMBULANCE',
        reason: 'no ambulance assigned',
      };
    }

    const ambulance = await this.ambulances.findById(emergency.assignedAmbulanceId);
    if (!ambulance) {
      return {
        routeId,
        emergencyId,
        outcome: 'SKIPPED_NO_AMBULANCE',
        reason: 'assigned ambulance not found',
      };
    }

    // Re-resolve endpoints from the current state rather than the stored
    // coordinates: a recalculation exists precisely because positions moved.
    const leg: RouteLeg | null =
      existing.destinationName === LEG_LABELS.RESPONSE.destinationName
        ? 'RESPONSE'
        : existing.destinationName === LEG_LABELS.TRANSPORT.destinationName
          ? 'TRANSPORT'
          : null;
    let from: Coordinate;
    let to: Coordinate;
    if (leg) {
      const endpoints = await this.resolveEndpoints(emergency, ambulance, leg);
      if ('outcome' in endpoints) {
        // resolveEndpoints only ever returns skip outcomes for these three cases.
        const skipped: RouteRecalculationOutcome =
          endpoints.outcome === 'SKIPPED_NO_POSITION'
            ? 'SKIPPED_NO_POSITION'
            : endpoints.outcome === 'SKIPPED_NO_HOSPITAL'
              ? 'SKIPPED_NO_HOSPITAL'
              : 'SKIPPED_INVALID_LOCATION';
        return { routeId, emergencyId, outcome: skipped, reason: endpoints.reason };
      }
      from = endpoints.from;
      to = endpoints.to;
    } else {
      // Non-leg routes (generic optimizeRoute rows) keep their stored endpoints.
      const first = existing.polyline[0];
      const last = existing.polyline[existing.polyline.length - 1];
      if (!first || !last) {
        return {
          routeId,
          emergencyId,
          outcome: 'SKIPPED_INVALID_LOCATION',
          reason: 'route has no stored endpoints to recalculate',
        };
      }
      from = { latitude: first[0], longitude: first[1] };
      to = { latitude: last[0], longitude: last[1] };
    }

    if (!isValidCoordinate(from) || !isValidCoordinate(to)) {
      return {
        routeId,
        emergencyId,
        outcome: 'SKIPPED_INVALID_LOCATION',
        reason: 'recalculation endpoints are out of range',
      };
    }

    try {
      const { result } = await this.compute(from, to, { emergencyId, ambulanceId: ambulance.id });
      const candidate = result.selected;
      const distanceKm = round(candidate.distanceKm, 4);
      const estimatedMinutes = round(candidate.estimatedMinutes, 2);

      const route = await this.routes.replaceRouteWithEvent(
        routeId,
        {
          distanceKm,
          polyline: candidate.geometry,
          estimatedMinutes,
          provider: result.providerName,
          isLiveTraffic: result.isLiveTraffic,
          trafficFactor: candidate.trafficFactor,
          alternatives: result.alternatives.map((alternative) => ({
            distanceKm: alternative.distanceKm,
            estimatedMinutes: alternative.estimatedMinutes,
            trafficFactor: alternative.trafficFactor,
          })),
          selectionReason: { reason: result.selectionReason, recalculation: trimmedReason },
        },
        (updated, previous) =>
          defineEvent('ROUTE_RECALCULATED', {
            emergencyId,
            entityType: 'route',
            entityId: routeId,
            actorType: actor?.actorType ?? 'SYSTEM',
            actorId: actor?.actorId ?? null,
            payload: {
              routeId,
              emergencyId,
              previousDistanceKm: previous.distanceKm,
              distanceKm: updated.distanceKm,
              previousEstimatedMinutes: previous.estimatedMinutes ?? 0,
              estimatedMinutes: updated.estimatedMinutes ?? 0,
              reason: trimmedReason,
            },
          }),
      );

      this.logger.info(
        {
          emergencyId,
          routeId,
          distanceKm: route.distanceKm,
          estimatedMinutes: route.estimatedMinutes,
          provider: route.provider,
          isLiveTraffic: route.isLiveTraffic,
          reason: trimmedReason,
        },
        'recalculated route',
      );

      return {
        routeId,
        emergencyId,
        outcome: 'RECALCULATED',
        provider: route.provider,
      };
    } catch (error) {
      const failureReason = messageOf(error);
      await this.recordFailed({
        emergencyId,
        ambulanceId: ambulance.id,
        provider: this.primary.providerName,
        reason: failureReason,
        degradedToEstimate: false,
      });
      this.logger.error({ emergencyId, routeId, error: failureReason }, 'route recalculation failed');
      return { routeId, emergencyId, outcome: 'FAILED', reason: failureReason };
    }
  }

  /**
   * Generic compute-and-record entry point (Module 8 `RouteOptimizationPort`).
   *
   * Requires `emergencyId` and `ambulanceId`: a route row is meaningless without
   * them, so a call missing either is a programming error, not a runtime one.
   */
  async optimizeRoute(input: {
    from: Coordinate;
    to: Coordinate;
    ambulanceId?: string;
    emergencyId?: string;
    isSimulation?: boolean;
  }): Promise<{
    routeId: string;
    distanceKm: number;
    estimatedMinutes: number;
    polyline: Array<[number, number]>;
    provider: string;
    isLiveTraffic: boolean;
  }> {
    if (!input.emergencyId || !input.ambulanceId) {
      throw AppError.validation(
        'optimizeRoute requires emergencyId and ambulanceId so the route can be recorded.',
      );
    }
    if (!isValidCoordinate(input.from) || !isValidCoordinate(input.to)) {
      throw AppError.validation('optimizeRoute endpoints are out of range.');
    }

    let route: PlannedRoute;
    try {
      route = await this.planAndRecord({
        emergencyId: input.emergencyId,
        ambulanceId: input.ambulanceId,
        hospitalId: null,
        originName: 'ORIGIN',
        destinationName: 'DESTINATION',
        from: input.from,
        to: input.to,
        isSimulation: input.isSimulation ?? false,
      });
    } catch (error) {
      await this.recordFailed({
        emergencyId: input.emergencyId,
        ambulanceId: input.ambulanceId,
        provider: this.primary.providerName,
        reason: messageOf(error),
        degradedToEstimate: false,
      });
      throw error;
    }

    return {
      routeId: route.id,
      distanceKm: route.distanceKm,
      estimatedMinutes: route.estimatedMinutes ?? 0,
      polyline: route.polyline,
      provider: route.provider,
      isLiveTraffic: route.isLiveTraffic,
    };
  }
  private async resolveEndpoints(
    emergency: Emergency,
    ambulance: Ambulance,
    leg: RouteLeg,
  ): Promise<
    | { from: Coordinate; to: Coordinate; hospitalId: string | null }
    | { outcome: RouteGenerationOutcome; reason?: string }
  > {
    if (!isValidCoordinate({ latitude: emergency.latitude, longitude: emergency.longitude })) {
      return { outcome: 'SKIPPED_INVALID_LOCATION', reason: 'emergency has no valid location' };
    }
    const scene: Coordinate = { latitude: emergency.latitude, longitude: emergency.longitude };

    if (leg === 'RESPONSE') {
      if (!isValidCoordinate({ latitude: ambulance.latitude, longitude: ambulance.longitude })) {
        return { outcome: 'SKIPPED_NO_POSITION', reason: 'ambulance has no reported position' };
      }
      return {
        from: { latitude: ambulance.latitude as number, longitude: ambulance.longitude as number },
        to: scene,
        hospitalId: emergency.selectedHospitalId ?? null,
      };
    }

    if (!emergency.selectedHospitalId) {
      return { outcome: 'SKIPPED_NO_HOSPITAL', reason: 'no hospital selected' };
    }
    const hospital = await this.hospitals.findById(emergency.selectedHospitalId);
    if (!hospital) {
      return { outcome: 'SKIPPED_NO_HOSPITAL', reason: 'selected hospital not found' };
    }
    if (!isValidCoordinate({ latitude: hospital.latitude, longitude: hospital.longitude })) {
      return { outcome: 'SKIPPED_INVALID_LOCATION', reason: 'hospital has no valid location' };
    }
    return {
      from: scene,
      to: { latitude: hospital.latitude, longitude: hospital.longitude },
      hospitalId: hospital.id,
    };
  }

  /** Computes a route, writes the row and emits `ROUTE_GENERATED`. Throws on total failure. */
  private async planAndRecord(input: {
    emergencyId: string;
    ambulanceId: string;
    hospitalId: string | null;
    originName: string;
    destinationName: string;
    from: Coordinate;
    to: Coordinate;
    isSimulation: boolean;
  }  ): Promise<PlannedRoute> {
    const { result, degraded } = await this.compute(input.from, input.to, input);
    const candidate = result.selected;
    const distanceKm = round(candidate.distanceKm, 4);
    const estimatedMinutes = round(candidate.estimatedMinutes, 2);

    const routeInput: RouteCreateInput = {
      emergencyId: input.emergencyId,
      ambulanceId: input.ambulanceId,
      hospitalId: input.hospitalId,
      originName: input.originName,
      destinationName: input.destinationName,
      origin: input.from,
      destination: input.to,
      distanceKm,
      polyline: candidate.geometry,
      estimatedMinutes,
      isSimulation: input.isSimulation,
      provider: result.providerName,
      isLiveTraffic: result.isLiveTraffic,
      trafficFactor: candidate.trafficFactor,
      alternatives: result.alternatives.map((alternative) => ({
        distanceKm: alternative.distanceKm,
        estimatedMinutes: alternative.estimatedMinutes,
        trafficFactor: alternative.trafficFactor,
      })),
      selectionReason: { reason: result.selectionReason, degraded },
    };
    const routeEvent = (route: PlannedRoute) => defineEvent('ROUTE_GENERATED', {
        emergencyId: input.emergencyId,
        entityType: 'route',
        entityId: route.id,
        payload: {
          routeId: route.id,
          emergencyId: input.emergencyId,
          ambulanceId: input.ambulanceId,
          hospitalId: input.hospitalId,
          distanceKm,
          estimatedMinutes,
          provider: result.providerName,
          isLiveTraffic: result.isLiveTraffic,
        },
      });
    const route = this.routes.createRouteWithEvent
      ? await this.routes.createRouteWithEvent(routeInput, routeEvent)
      : await this.routes.createRoute(routeInput);
    if (!this.routes.createRouteWithEvent) await this.events.record(routeEvent(route));

    this.logger.info(
      {
        emergencyId: input.emergencyId,
        routeId: route.id,
        destinationName: input.destinationName,
        distanceKm,
        estimatedMinutes,
        provider: result.providerName,
        isLiveTraffic: result.isLiveTraffic,
        degraded,
      },
      'planned route',
    );

    return route;
  }

  /** Runs the configured provider, falling back to the deterministic one on failure. */
  private async compute(
    from: Coordinate,
    to: Coordinate,
    ctx: { emergencyId: string; ambulanceId: string },
  ): Promise<{ result: RouteResult; degraded: boolean }> {
    try {
      const result = await this.primary.route({
        origin: from,
        destination: to,
        averageSpeedKmh: this.config.averageSpeedKmh,
      });
      return { result, degraded: false };
    } catch (primaryError) {
      const primaryReason = messageOf(primaryError);
      let fallbackResult: RouteResult;
      try {
        fallbackResult = await this.fallback.route({
          origin: from,
          destination: to,
          averageSpeedKmh: this.config.averageSpeedKmh,
        });
      } catch (fallbackError) {
        throw new RoutingProviderError(
          `primary (${this.primary.providerName}) failed: ${primaryReason}; ` +
            `fallback (${this.fallback.providerName}) failed: ${messageOf(fallbackError)}`,
          this.primary.providerName,
        );
      }
      // The fallback route is usable, so record the downgrade and continue.
      await this.recordFailed({
        emergencyId: ctx.emergencyId,
        ambulanceId: ctx.ambulanceId,
        provider: this.primary.providerName,
        reason: primaryReason,
        degradedToEstimate: true,
      });
      this.logger.warn(
        { emergencyId: ctx.emergencyId, provider: this.primary.providerName, error: primaryReason },
        'primary routing provider failed; used deterministic fallback',
      );
      return { result: fallbackResult, degraded: true };
    }
  }

  /** Records a `ROUTE_FAILED`; never lets a diagnostic event mask the real error. */
  private async recordFailed(input: {
    emergencyId: string;
    ambulanceId: string;
    provider: string;
    reason: string;
    degradedToEstimate: boolean;
  }): Promise<void> {
    try {
      await this.events.record(
        defineEvent('ROUTE_FAILED', {
          emergencyId: input.emergencyId,
          entityType: 'route',
          entityId: input.ambulanceId,
          payload: {
            emergencyId: input.emergencyId,
            ambulanceId: input.ambulanceId,
            provider: input.provider,
            reason: input.reason,
            degradedToEstimate: input.degradedToEstimate,
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        { emergencyId: input.emergencyId, error: messageOf(error) },
        'failed to record route failure event',
      );
    }
  }
}
