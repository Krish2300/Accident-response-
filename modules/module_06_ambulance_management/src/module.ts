import { noopLogger, type Logger, type RouteDefinition, type RouteTable } from '@resus/core';
import type { AmbulanceRepository } from '@resus/module_11_database_event_system';
import type { EventPublisherPort } from '@resus/core';
import { loadModule6Config, type Module6Config } from './config.js';
import { FleetService } from './fleetService.js';
import { AssignmentService } from './assignment/assignmentService.js';
import { TrackingService } from './tracking/trackingService.js';
import { createModule6Routes } from './api/routes.js';

export interface Module6Deps {
  ambulances: AmbulanceRepository;
  events: EventPublisherPort;
  config?: Module6Config;
  logger?: Logger;
}

export class Module6 {
  readonly fleet: FleetService;
  readonly assignment: AssignmentService;
  readonly tracking: TrackingService;
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
  }

  routes(): RouteDefinition<any>[] {
    return createModule6Routes(this.fleet, this.assignment, this.tracking);
  }

  register(table: RouteTable): void {
    table.addAll(this.routes());
  }
}
