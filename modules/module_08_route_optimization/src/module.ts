import {
  noopLogger,
  type DomainEventBusPort,
  type EventPublisherPort,
  type EventQueryPort,
  type Logger,
  type RouteDefinition,
  type RouteTable,
  type RoutingProvider,
} from '@resus/core';
import { loadModule8Config, type Module8Config } from './config.js';
import { GoogleRoutesProvider, MockRoutingProvider, OsrmRoutingProvider } from './providers/index.js';
import {
  RouteOptimizationService,
  type AmbulanceRoutePort,
  type EmergencyRoutePort,
  type HospitalRoutePort,
  type RouteWriterPort,
} from './routeOptimizationService.js';
import { AutoRouteService } from './autoRouteService.js';
import { createModule8Routes } from './api/routes.js';

export interface Module8Deps {
  /** Route persistence (Module 11 repository). */
  routes: RouteWriterPort;
  /** Emergency read port, to resolve the scene and assignment. */
  emergencies: EmergencyRoutePort;
  /** Ambulance read port, to resolve the response-leg origin. */
  ambulances: AmbulanceRoutePort;
  /** Hospital read port, to resolve the transport-leg destination. */
  hospitals: HospitalRoutePort;
  events: EventPublisherPort;
  /** Read-only log used to require explicit dispatch before route generation. */
  dispatchEvents?: EventQueryPort;
  /**
   * Optional in-process bus. When supplied together with
   * `config.generation.enabled`, Module 8 subscribes to `AMBULANCE_ASSIGNED`
   * and `HOSPITAL_SELECTED` and plans the corresponding leg automatically.
   * Omitted by tests and the simulation harness.
   */
  bus?: DomainEventBusPort;
  config?: Module8Config;
  /** Optional provider overrides for isolated composition tests. */
  primaryProvider?: RoutingProvider;
  fallbackProvider?: RoutingProvider;
  logger?: Logger;
}

/**
 * Module 8 - Route Optimization.
 *
 * Owns route planning: it resolves each leg's endpoints from Module 11 reads,
 * asks a routing provider for the geometry/distance/ETA, and records the route
 * with its provenance. It never changes emergency status, protocol state or
 * ambulance assignment, and it never presents a deterministic estimate as
 * traffic-aware (`isLiveTraffic` is carried from the provider unchanged).
 */
export class Module8 {
  readonly optimization: RouteOptimizationService;
  readonly autoRoute: AutoRouteService | undefined;
  readonly config: Module8Config;
  private readonly routeWriter: RouteWriterPort;
  private readonly ambulanceReader: AmbulanceRoutePort;
  private readonly logger: Logger;
  private readonly dispatchEvents: EventQueryPort | undefined;

  constructor(deps: Module8Deps) {
    this.config = deps.config ?? loadModule8Config();
    this.logger = deps.logger ?? noopLogger;
    this.dispatchEvents = deps.dispatchEvents;
    this.routeWriter = deps.routes;
    this.ambulanceReader = deps.ambulances;

    // The deterministic provider is always available; it is the primary by
    // default and the fallback whenever a real provider is configured.
    const mock = new MockRoutingProvider(this.config.averageSpeedKmh);
    const primary = deps.primaryProvider ?? (
      this.config.provider === 'osrm'
        ? new OsrmRoutingProvider({
            baseUrl: this.config.osrm.baseUrl,
            timeoutMs: this.config.osrm.timeoutMs,
          })
        : this.config.provider === 'google'
          ? new GoogleRoutesProvider({
              apiKey: this.config.google.apiKey ?? '',
              timeoutMs: this.config.google.timeoutMs,
            })
          : mock
    );
    const fallback = deps.fallbackProvider ?? mock;

    this.optimization = new RouteOptimizationService({
      primary,
      fallback,
      routes: deps.routes,
      emergencies: deps.emergencies,
      ambulances: deps.ambulances,
      hospitals: deps.hospitals,
      events: deps.events,
      config: this.config,
      logger: this.logger,
    });

    const generationEnabled = this.config.generation?.enabled ?? false;
    this.autoRoute =
      deps.bus && generationEnabled
        ? new AutoRouteService({
            events: deps.bus,
            optimization: this.optimization,
            logger: this.logger,
          })
        : undefined;
  }

  routes(): RouteDefinition<Record<string, unknown>>[] {
    return createModule8Routes(this.optimization, this.routeWriter, this.ambulanceReader, this.dispatchEvents);
  }

  register(table: RouteTable): void {
    table.addAll(this.routes());
  }

  dispose(): void {
    this.autoRoute?.dispose();
  }
}
