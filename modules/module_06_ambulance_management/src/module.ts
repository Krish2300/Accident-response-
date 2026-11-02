import {
  noopLogger,
  type DomainEventBusPort,
  type Logger,
  type RouteDefinition,
  type RouteTable,
} from '@resus/core';
import type { AmbulanceRepository } from '@resus/module_11_database_event_system';
import type { EventPublisherPort } from '@resus/core';
import { loadModule6Config, type Module6Config } from './config.js';
import { FleetService } from './fleetService.js';
import { AssignmentService } from './assignment/assignmentService.js';
import { TrackingService } from './tracking/trackingService.js';
import { AutoDispatchService, type EmergencyLookupPort } from './dispatch/autoDispatchService.js';
import { createModule6Routes } from './api/routes.js';

export interface Module6Deps {
  ambulances: AmbulanceRepository;
  events: EventPublisherPort;
  /**
   * Optional in-process bus. When supplied together with `emergencies` and
   * `config.autoDispatch.enabled`, Module 6 subscribes to emergency lifecycle
   * events and assigns automatically. Omitted by tests and the simulation
   * harness, which keeps the default behaviour unchanged.
   */
  bus?: DomainEventBusPort;
  /** Optional emergency read port used only by automatic assignment. */
  emergencies?: EmergencyLookupPort;
  config?: Module6Config;
  logger?: Logger;
}

export class Module6 {
  readonly fleet: FleetService;
  readonly assignment: AssignmentService;
  readonly tracking: TrackingService;
  readonly autoDispatch: AutoDispatchService | undefined;
  readonly config: Module6Config;
  private readonly logger: Logger;
  private readonly deps: Module6Deps;

  constructor(deps: Module6Deps) {
    this.config = deps.config ?? loadModule6Config();
    this.logger = deps.logger ?? noopLogger;
    this.deps = deps;

    this.fleet = new FleetService({
      ambulances: deps.ambulances,
      events: deps.events,
      config: this.config,
      logger: this.logger,
    });
    this.assignment = new AssignmentService({
      fleet: this.fleet,
      config: this.config,
      logger: this.logger,
    });
    this.tracking = new TrackingService({
      fleet: this.fleet,
      logger: this.logger,
    });

    // Fail closed if a caller supplies an incomplete legacy config.
    const autoDispatchEnabled = this.config.autoDispatch?.enabled ?? false;
    this.autoDispatch =
      deps.bus && deps.emergencies && autoDispatchEnabled
        ? new AutoDispatchService({
            events: deps.bus,
            assignment: this.assignment,
            fleet: this.fleet,
            emergencies: deps.emergencies,
            config: this.config,
            logger: this.logger,
          })
        : undefined;
  }

  routes(): RouteDefinition<any>[] {
    return createModule6Routes(this.fleet, this.assignment, this.tracking);
  }

  register(table: RouteTable): void {
    table.addAll(this.routes());
  }
}
