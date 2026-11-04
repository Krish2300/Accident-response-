import {
  type DomainEventBusPort,
  type Emergency,
  ErrorCode,
  type Logger,
  type SystemEventRecord,
  type SystemEventType,
  isAppError,
  isValidCoordinate,
  noopLogger,
} from '@resus/core';
import { requiredEquipmentFor, type AssignmentService } from '../assignment/assignmentService.js';
import type { FleetService } from '../fleetService.js';
import type { Module6Config } from '../config.js';

/**
 * The only thing this service needs from persistence: read one emergency by id.
 *
 * Declared here rather than importing Module 11's repository type, so Module 6
 * still depends on a shape, not on the persistence module.
 */
export interface EmergencyLookupPort {
  findById(id: string): Promise<Emergency | null>;
}

export interface AutoDispatchDeps {
  /** In-process bus owned by Module 11. */
  events: DomainEventBusPort;
  assignment: AssignmentService;
  fleet: FleetService;
  emergencies: EmergencyLookupPort;
  config: Module6Config;
  logger?: Logger;
}

export type AutoDispatchOutcome =
  | 'ASSIGNED'
  | 'SKIPPED_NOT_FOUND'
  | 'SKIPPED_SIMULATION'
  | 'SKIPPED_STATUS'
  | 'SKIPPED_INVALID_LOCATION'
  | 'SKIPPED_ALREADY_ASSIGNED'
  | 'SKIPPED_IN_FLIGHT'
  | 'NO_AMBULANCE'
  | 'FAILED';

export interface AutoDispatchResult {
  emergencyId: string;
  outcome: AutoDispatchOutcome;
  ambulanceId?: string;
  assignmentId?: string;
  reason?: string;
}

/**
 * Events that mean "an emergency exists and may need a unit".
 *
 * `EMERGENCY_CREATED` is the trigger that fires on every real creation path
 * (live call via Module 1, operator via Module 11). `EMERGENCY_CLASSIFIED` is
 * subscribed too so a later classification still dispatches — but it is not
 * relied upon, because in this build it is only emitted by the operator route,
 * never by the call or protocol flow. Deduplication below makes the second
 * event harmless.
 */
export const AUTO_DISPATCH_EVENT_TYPES: SystemEventType[] = [
  'EMERGENCY_CREATED',
  'EMERGENCY_CLASSIFIED',
];

/**
 * Statuses an emergency can be in when a unit is first needed. Anything later
 * than `AWAITING_AMBULANCE` already has a unit, and terminal states never do.
 */
const DISPATCHABLE_STATUSES = new Set<string>([
  'CREATED',
  'CALL_ACTIVE',
  'CLASSIFIED',
  'PROTOCOL_ACTIVE',
  'AWAITING_AMBULANCE',
]);

/**
 * Event-driven automatic assignment (the legacy class name is retained).
 *
 * Subscribes to the Module 11 bus and, for an eligible emergency, runs the same
 * `AssignmentService.selectAndAssign` the manual `/api/ambulances/assign` route
 * uses. It is deliberately thin: it decides *whether* to assign, and reuses
 * the existing engine to choose an ambulance. It never dispatches the ambulance
 * or mutates the emergency —
 * exactly like the manual path, the assignment row and the `AMBULANCE_ASSIGNED`
 * event are the record of what happened.
 *
 * Safety properties:
 *  - Idempotent: an emergency that already has an `ASSIGNED` row is skipped, and
 *    concurrent events for one emergency are collapsed, so a retried or
 *    duplicated event cannot produce a second unit.
 *  - Never reports false success: a failure to find or assign a unit is logged
 *    and returned as an outcome, never swallowed and never emitted as assigned.
 *  - Simulation is excluded unless explicitly enabled, so it does not race the
 *    simulation harness's own assignment flow.
 */
export class AutoDispatchService {
  private readonly assignment: AssignmentService;
  private readonly fleet: FleetService;
  private readonly emergencies: EmergencyLookupPort;
  private readonly config: Module6Config;
  private readonly logger: Logger;
  private readonly unsubscribe: () => void;
  private readonly inFlightEmergencies = new Map<string, Promise<AutoDispatchResult>>();
  private readonly inFlightEvents = new Set<Promise<void>>();
  private disposed = false;

  constructor(deps: AutoDispatchDeps) {
    this.assignment = deps.assignment;
    this.fleet = deps.fleet;
    this.emergencies = deps.emergencies;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
    this.unsubscribe = deps.events.subscribe(AUTO_DISPATCH_EVENT_TYPES, (event) =>
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
  async handleEvent(event: SystemEventRecord): Promise<AutoDispatchResult> {
    const emergencyId = this.emergencyIdFrom(event);
    if (!emergencyId) {
      return { emergencyId: '', outcome: 'SKIPPED_NOT_FOUND', reason: 'event carried no emergency id' };
    }
    return this.dispatchForEmergency(emergencyId);
  }

  /**
   * Runs an automatic assignment decision for one emergency. Assignment does
   * not emit `AMBULANCE_DISPATCHED`; dispatch remains an explicit operation.
   *
   * The in-flight map is keyed by emergency id and set synchronously before the
   * first `await`, so two events arriving back-to-back cannot both reach the
   * assignment engine.
   */
  async dispatchForEmergency(emergencyId: string): Promise<AutoDispatchResult> {
    if (this.disposed) {
      return { emergencyId, outcome: 'SKIPPED_STATUS', reason: 'automatic assignment disposed' };
    }
    if (this.inFlightEmergencies.has(emergencyId)) {
      return { emergencyId, outcome: 'SKIPPED_IN_FLIGHT' };
    }
    const run = this.run(emergencyId);
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
            'automatic assignment subscriber threw',
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

  private async run(emergencyId: string): Promise<AutoDispatchResult> {
    const emergency = await this.emergencies.findById(emergencyId);
    if (!emergency) {
      return { emergencyId, outcome: 'SKIPPED_NOT_FOUND', reason: 'emergency not found' };
    }
    if (emergency.isSimulation && !(this.config.autoDispatch?.includeSimulation ?? false)) {
      return { emergencyId, outcome: 'SKIPPED_SIMULATION' };
    }
    if (!DISPATCHABLE_STATUSES.has(emergency.status)) {
      return { emergencyId, outcome: 'SKIPPED_STATUS', reason: `status ${emergency.status}` };
    }
    if (!isValidCoordinate({ latitude: emergency.latitude, longitude: emergency.longitude })) {
      return { emergencyId, outcome: 'SKIPPED_INVALID_LOCATION' };
    }

    const assignments = await this.fleet.getAssignmentsForEmergency(emergencyId);
    const active = assignments.find((assignment) => ['OFFERED', 'ASSIGNED'].includes(assignment.status));
    if (active) {
      return {
        emergencyId,
        outcome: 'SKIPPED_ALREADY_ASSIGNED',
        ambulanceId: active.ambulanceId,
        assignmentId: active.id,
      };
    }

    try {
      const result = await this.assignment.selectAndAssign({
        emergencyId,
        latitude: emergency.latitude,
        longitude: emergency.longitude,
        requiredEquipment: requiredEquipmentFor(emergency.incidentType),
      });
      return {
        emergencyId,
        outcome: 'ASSIGNED',
        ambulanceId: result.ambulanceId,
        assignmentId: result.assignmentId,
      };
    } catch (error) {
      return this.toFailure(emergencyId, error);
    }
  }

  private toFailure(emergencyId: string, error: unknown): AutoDispatchResult {
    const reason = error instanceof Error ? error.message : String(error);
    const code = isAppError(error) ? error.code : undefined;
    const noCandidate =
      code === ErrorCode.AMBULANCE_NOT_AVAILABLE ||
      code === ErrorCode.AMBULANCE_ALREADY_ASSIGNED ||
      code === ErrorCode.AMBULANCE_NO_CANDIDATE ||
      code === ErrorCode.CONFLICT ||
      /no (available|candidate|suitable)/i.test(reason);
    return { emergencyId, outcome: noCandidate ? 'NO_AMBULANCE' : 'FAILED', reason };
  }

  private logResult(result: AutoDispatchResult): void {
    if (result.outcome === 'ASSIGNED') {
      this.logger.info(
        {
          emergencyId: result.emergencyId,
          ambulanceId: result.ambulanceId,
          assignmentId: result.assignmentId,
        },
        'automatic assignment selected an ambulance',
      );
      return;
    }
    if (result.outcome === 'NO_AMBULANCE' || result.outcome === 'FAILED') {
      this.logger.warn({ ...result }, 'automatic assignment could not assign an ambulance');
      return;
    }
    this.logger.debug({ ...result }, 'automatic assignment skipped');
  }
}
