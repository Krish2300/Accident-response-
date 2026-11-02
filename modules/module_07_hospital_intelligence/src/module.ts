import {
  type DomainEventBusPort,
  type EventPublisherPort,
  type Logger,
  type RouteTable,
  noopLogger,
} from '@resus/core';
import { loadModule7Config, type Module7Config } from './config.js';
import {
  HospitalSelectionService,
  type EmergencySelectionPort,
  type HospitalCandidatePort,
} from './hospitalSelectionService.js';
import type { HospitalResourceWriterPort } from './hospitalResourceService.js';
import { AutoSelectService } from './autoSelectService.js';
import { createModule7Routes } from './api/routes.js';

export interface Module7Deps {
  /** Hospitals with their resource rows (Module 11 repository). */
  hospitals: HospitalCandidatePort;
  /**
   * Optional write port for hospital resource availability updates. When
   * supplied, Module 7 exposes an explicit operator endpoint that persists
   * the change and records `HOSPITAL_RESOURCE_UPDATED` atomically. Omitted
   * by tests that do not exercise resource writes.
   */
  hospitalResources?: HospitalResourceWriterPort;
  /** Emergency read/write port; only `selectedHospitalId` is ever written. */
  emergencies: EmergencySelectionPort;
  events: EventPublisherPort;
  /**
   * Optional in-process bus. When supplied together with
   * `config.autoSelect.enabled`, Module 7 subscribes to `EMERGENCY_CLASSIFIED`
   * and selects automatically. Omitted by tests and the simulation harness,
   * which keeps the default behaviour unchanged.
   */
  bus?: DomainEventBusPort;
  config?: Module7Config;
  logger?: Logger;
}

/**
 * Module 7 - Hospital Intelligence.
 *
 * Owns hospital suitability scoring and the choice of receiving hospital. The
 * only persistence it touches is `Hospital`/`HospitalResource` reads and the
 * emergency's `selectedHospitalId`; it never changes emergency status, protocol
 * state or ambulance assignment.
 */
export class Module7 {
  readonly selection: HospitalSelectionService;
  readonly autoSelect: AutoSelectService | undefined;
  readonly config: Module7Config;
  private readonly logger: Logger;
  private readonly hospitalResources: HospitalResourceWriterPort | undefined;

  constructor(deps: Module7Deps) {
    this.config = deps.config ?? loadModule7Config();
    this.logger = deps.logger ?? noopLogger;
    this.hospitalResources = deps.hospitalResources;

    this.selection = new HospitalSelectionService({
      hospitals: deps.hospitals,
      emergencies: deps.emergencies,
      events: deps.events,
      config: this.config,
      logger: this.logger,
    });

    const autoSelectEnabled = this.config.autoSelect?.enabled ?? false;
    this.autoSelect =
      deps.bus && autoSelectEnabled
        ? new AutoSelectService({
            events: deps.bus,
            selection: this.selection,
            logger: this.logger,
          })
        : undefined;
  }

  dispose(): void {
    this.autoSelect?.dispose();
  }

  routes() {
    return createModule7Routes(this.selection, this.hospitalResources);
  }

  register(table: RouteTable): void {
    table.addAll(this.routes());
  }
}
