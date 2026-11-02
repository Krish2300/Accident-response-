import {
  type DomainEventBusPort,
  type Logger,
  type SystemEventRecord,
  type SystemEventType,
  noopLogger,
} from '@resus/core';
import type { HospitalSelectionResult, HospitalSelectionService } from './hospitalSelectionService.js';

/**
 * Events that mean "an emergency now has a classification we can select for".
 *
 * Only `EMERGENCY_CLASSIFIED` is subscribed. `EMERGENCY_CREATED` fires before a
 * classification exists, and hospital choice is a function of `incidentType`, so
 * selecting on creation would score against a placeholder. Deduplication below
 * makes a repeated classification harmless.
 */
export const AUTO_SELECT_EVENT_TYPES: SystemEventType[] = ['EMERGENCY_CLASSIFIED'];

export interface AutoSelectDeps {
  /** In-process bus owned by Module 11. */
  events: DomainEventBusPort;
  selection: HospitalSelectionService;
  logger?: Logger;
}

/**
 * Event-driven automatic hospital selection.
 *
 * Subscribes to the Module 11 bus and, on classification, runs the same
 * `HospitalSelectionService.selectForEmergency` an operator route would use. It
 * is deliberately thin: it decides *when* to select, and the service decides
 * *which* hospital. It never changes emergency status, protocols or ambulance
 * assignment; the only write is `selectedHospitalId`, committed with the
 * `HOSPITAL_SELECTED` event.
 *
 * Safety properties:
 *  - Idempotent: an emergency that already has a `selectedHospitalId` is
 *    skipped, and concurrent events for one emergency are collapsed, so a
 *    retried or duplicated event cannot select twice.
 *  - Never reports false success: a failure to select is logged and returned as
 *    an outcome, never swallowed and never emitted as selected.
 *  - Simulation is excluded unless explicitly enabled.
 */
export class AutoSelectService {
  private readonly selection: HospitalSelectionService;
  private readonly logger: Logger;
  private readonly unsubscribe: () => void;
  private readonly inFlightEmergencies = new Map<string, Promise<HospitalSelectionResult>>();
  private readonly inFlightEvents = new Set<Promise<void>>();
  private disposed = false;

  constructor(deps: AutoSelectDeps) {
    this.selection = deps.selection;
    this.logger = deps.logger ?? noopLogger;
    this.unsubscribe = deps.events.subscribe(AUTO_SELECT_EVENT_TYPES, (event) =>
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
  async handleEvent(event: SystemEventRecord): Promise<HospitalSelectionResult> {
    const emergencyId = this.emergencyIdFrom(event);
    if (!emergencyId) {
      return { emergencyId: '', outcome: 'SKIPPED_NOT_FOUND', reason: 'event carried no emergency id' };
    }
    return this.selectForEmergency(emergencyId);
  }

  /**
   * Runs the selection decision for one emergency.
   *
   * The in-flight map is keyed by emergency id and set synchronously before the
   * first `await`, so two events arriving back-to-back cannot both reach the
   * selection engine.
   */
  async selectForEmergency(emergencyId: string): Promise<HospitalSelectionResult> {
    if (this.disposed) {
      return { emergencyId, outcome: 'SKIPPED_STATUS', reason: 'auto-select disposed' };
    }
    if (this.inFlightEmergencies.has(emergencyId)) {
      return { emergencyId, outcome: 'SKIPPED_ALREADY_SELECTED', reason: 'selection already in flight' };
    }
    const run = this.selection.selectForEmergency(emergencyId);
    this.inFlightEmergencies.set(emergencyId, run);
    try {
      const result = await run;
      this.logResult(result);
      return result;
    } finally {
      this.inFlightEmergencies.delete(emergencyId);
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
            'auto hospital selection subscriber threw',
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

  private logResult(result: HospitalSelectionResult): void {
    if (result.outcome === 'SELECTED') return;
    if (result.outcome === 'NO_CANDIDATE' || result.outcome === 'FAILED') {
      this.logger.warn({ ...result }, 'auto hospital selection could not select a hospital');
      return;
    }
    this.logger.debug({ ...result }, 'auto hospital selection skipped');
  }
}
