/**
 * Module 10 – Emergency State Machine
 * Core FSM class with full lifecycle management.
 */

import { EventEmitter } from 'events';
import { randomUUID as uuidv4 } from 'node:crypto';
import {
  IncidentState,
  IncidentSeverity,
  IncidentType,
  TransitionTrigger,
  EmergencyContext,
  StateChangeEvent,
  CallerInfo,
  ErrorEntry,
  Module3Payload,
  Module6Payload,
  Module7Payload,
  Module8Payload,
  Module9Payload,
} from '../types';
import {
  TRANSITION_TABLE,
  TRANSITION_GUARDS,
  computePriority,
  STATE_TIMEOUT_MS,
  MAX_RETRIES_PER_STATE,
} from './transitions';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// EVENTS EMITTED BY THE FSM
// ─────────────────────────────────────────────

export interface FSMEvents {
  'state:changed':    (event: StateChangeEvent)       => void;
  'state:entered':    (state: IncidentState, ctx: EmergencyContext) => void;
  'state:exited':     (state: IncidentState, ctx: EmergencyContext) => void;
  'state:timeout':    (state: IncidentState, ctx: EmergencyContext) => void;
  'context:updated':  (ctx: EmergencyContext)         => void;
  'incident:failed':  (ctx: EmergencyContext, reason: string) => void;
  'incident:completed': (ctx: EmergencyContext)       => void;
}

// ─────────────────────────────────────────────
// STATE MACHINE CLASS
// ─────────────────────────────────────────────

export class EmergencyStateMachine extends EventEmitter {
  private context: EmergencyContext;
  private stateEnteredAt: number;
  private timeoutHandle: NodeJS.Timeout | null = null;

  constructor(callerInfo: CallerInfo) {
    super();
    const now = new Date().toISOString();
    this.stateEnteredAt = Date.now();

    this.context = {
      incidentId:    uuidv4(),
      callSessionId: callerInfo.callSessionId,
      currentState:  IncidentState.NEW,
      previousState: null,
      createdAt:     now,
      updatedAt:     now,
      incidentType:  IncidentType.UNKNOWN,
      severity:      IncidentSeverity.MEDIUM,
      confidence:    0,
      location:      null,
      patient: {
        consciousnessLevel: 'UNKNOWN',
        breathingNormally:  null,
      },
      caller:   callerInfo,
      transcript: '',
      errorLog: [],
      tags:     [],
      priority: 50,
    };
  }

  // ─── Public API ───────────────────────────

  get id(): string { return this.context.incidentId; }
  get state(): IncidentState { return this.context.currentState; }
  get snapshot(): Readonly<EmergencyContext> { return Object.freeze({ ...this.context }); }

  /**
   * Send a trigger to attempt a state transition.
   * Returns true on success, false if transition is invalid or guard fails.
   */
  async send(
    trigger: TransitionTrigger,
    actorModule: string,
    payload?: Partial<EmergencyContext>,
  ): Promise<boolean> {
    const fromState = this.context.currentState;
    const allowedTransitions = TRANSITION_TABLE[fromState];

    if (!allowedTransitions) {
      logger.warn(`[FSM:${this.id}] No transitions defined for state ${fromState}`);
      return false;
    }

    const toState = allowedTransitions[trigger];
    if (!toState) {
      logger.warn(`[FSM:${this.id}] Invalid trigger ${trigger} in state ${fromState}`);
      return false;
    }

    // Run guard if applicable
    const guardKey = `${fromState}->${toState}` as `${IncidentState}->${IncidentState}`;
    const guard = TRANSITION_GUARDS[guardKey];
    if (guard) {
      // Merge payload into context snapshot for guard evaluation
      const ctxForGuard = payload ? { ...this.context, ...payload } : this.context;
      const guardResult = guard(ctxForGuard as EmergencyContext);
      if (guardResult !== true) {
        const reason = typeof guardResult === 'string' ? guardResult : 'Guard rejected transition';
        logger.warn(`[FSM:${this.id}] Guard blocked ${fromState}->${toState}: ${reason}`);
        this.appendError(actorModule, reason);
        return false;
      }
    }

    // Apply payload to context
    if (payload) {
      this.mergeContext(payload);
    }

    // Execute transition
    await this.doTransition(fromState, toState, trigger, actorModule);
    return true;
  }

  /**
   * Patch context data without triggering a state transition.
   * Used by modules to feed incremental data (e.g. live GPS updates).
   */
  patchContext(partial: Partial<EmergencyContext>): void {
    this.mergeContext(partial);
    this.emit('context:updated', this.snapshot);
  }

  // ─── Internal Transition Logic ────────────

  private async doTransition(
    fromState: IncidentState,
    toState: IncidentState,
    trigger: TransitionTrigger,
    actorModule: string,
  ): Promise<void> {
    const durationMs = Date.now() - this.stateEnteredAt;

    // Clear pending timeout
    this.clearTimeout();

    // Emit exited
    this.emit('state:exited', fromState, this.snapshot);

    // Update context
    const now = new Date().toISOString();
    this.context = {
      ...this.context,
      previousState: fromState,
      currentState:  toState,
      updatedAt:     now,
      ...(toState === IncidentState.COMPLETED ? { completedAt: now } : {}),
    };
    this.context.priority = computePriority(this.context);
    this.stateEnteredAt = Date.now();

    // Build and emit StateChangeEvent
    const event: StateChangeEvent = {
      eventId:     uuidv4(),
      incidentId:  this.context.incidentId,
      trigger,
      fromState,
      toState,
      timestamp:   now,
      actorModule,
      payload:     this.context,
      meta: { durationMs },
    };
    this.emit('state:changed', event);
    this.emit('state:entered', toState, this.snapshot);

    logger.info(`[FSM:${this.id}] ${fromState} → ${toState} (trigger: ${trigger}, actor: ${actorModule}, ${durationMs}ms)`);

    // Schedule state timeout
    this.scheduleTimeout(toState);

    // Emit terminal events
    if (toState === IncidentState.COMPLETED) {
      this.emit('incident:completed', this.snapshot);
    } else if (toState === IncidentState.FAILED || toState === IncidentState.CANCELLED) {
      const reason = toState === IncidentState.CANCELLED ? 'Incident cancelled' : 'Incident failed';
      this.emit('incident:failed', this.snapshot, reason);
    }
  }

  // ─── Timeout Management ───────────────────

  private scheduleTimeout(state: IncidentState): void {
    const ms = STATE_TIMEOUT_MS[state];
    if (!ms) return;

    this.timeoutHandle = setTimeout(async () => {
      logger.error(`[FSM:${this.id}] Timeout in state ${state}`);
      this.emit('state:timeout', state, this.snapshot);

      const maxRetries = MAX_RETRIES_PER_STATE[state] ?? 0;
      const currentAttempts = this.context.retryMeta?.attempt ?? 0;

      if (currentAttempts < maxRetries) {
        // Retry: stay in same state, bump retry counter
        this.context.retryMeta = {
          attempt:   currentAttempts + 1,
          maxRetries,
          lastError: `Timeout in ${state}`,
          nextRetryAt: new Date().toISOString(),
        };
        logger.info(`[FSM:${this.id}] Retry ${currentAttempts + 1}/${maxRetries} in state ${state}`);
        this.scheduleTimeout(state); // reschedule
      } else {
        // Escalate to FAILED
        await this.send(TransitionTrigger.TIMEOUT, 'MODULE_10_WATCHDOG');
      }
    }, ms);
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  // ─── Helpers ──────────────────────────────

  private mergeContext(partial: Partial<EmergencyContext>): void {
    this.context = {
      ...this.context,
      ...partial,
      // Preserve identity & state fields
      incidentId:    this.context.incidentId,
      callSessionId: this.context.callSessionId,
      currentState:  this.context.currentState,
      previousState: this.context.previousState,
      createdAt:     this.context.createdAt,
      updatedAt:     new Date().toISOString(),
      // Merge arrays
      errorLog: [...this.context.errorLog, ...(partial.errorLog ?? [])],
      tags:     [...new Set([...this.context.tags, ...(partial.tags ?? [])])],
    };
  }

  private appendError(module: string, message: string, code?: string): void {
    const entry: ErrorEntry = {
      timestamp: new Date().toISOString(),
      module,
      message,
      code,
    };
    this.context.errorLog.push(entry);
  }

  /** Convenience method: apply Module 3 NLP output */
  applyNLPClassification(payload: Module3Payload): void {
    this.patchContext({
      incidentType: payload.incidentType,
      severity:     payload.severity,
      confidence:   payload.confidence,
      location:     payload.location,
      patient:      payload.patient,
      transcript:   payload.transcript,
      rawNlpData:   payload.rawNlpData,
    });
  }

  /** Convenience method: apply ambulance assignment */
  applyAmbulanceAssignment(payload: Module6Payload): void {
    this.patchContext({ ambulance: payload.ambulance });
  }

  /** Convenience method: apply hospital selection */
  applyHospitalSelection(payload: Module7Payload): void {
    this.patchContext({ hospital: payload.hospital });
  }

  /** Convenience method: apply route info */
  applyRouteInfo(payload: Module8Payload): void {
    this.patchContext({ route: payload.route });
  }

  /** Convenience method: apply corridor info */
  applyCorridorInfo(payload: Module9Payload): void {
    this.patchContext({ corridor: payload.corridor });
  }

  /** Clean shutdown (remove all timers) */
  destroy(): void {
    this.clearTimeout();
    this.removeAllListeners();
  }
}
