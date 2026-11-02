/**
 * Module 10 – Main Orchestrator
 * Drives the FSM lifecycle by calling downstream module APIs.
 * Wires event hooks → Module 11 (DB) and Module 12 (Dashboard).
 */

import {
  EmergencyStateMachine,
} from '../state/machine';
import {
  IncidentState,
  TransitionTrigger,
  EmergencyContext,
  StateChangeEvent,
  CallerInfo,
} from '../types';
import { moduleApiClient } from './moduleApiClient';
import { eventBus } from '../integrations/eventBus';
import { dbPersistence } from '../integrations/dbPersistence';
import { dashboardPublisher } from '../integrations/dashboardPublisher';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';

// ─────────────────────────────────────────────
// INCIDENT REGISTRY (in-memory; back-filled from DB on boot)
// ─────────────────────────────────────────────

const activeIncidents = new Map<string, EmergencyStateMachine>();

// ─────────────────────────────────────────────
// ORCHESTRATOR
// ─────────────────────────────────────────────

export class EmergencyOrchestrator {
  private static instance: EmergencyOrchestrator;

  static getInstance(): EmergencyOrchestrator {
    if (!EmergencyOrchestrator.instance) {
      EmergencyOrchestrator.instance = new EmergencyOrchestrator();
    }
    return EmergencyOrchestrator.instance;
  }

  // ── Lifecycle entry point ─────────────────

  /**
   * Called by Module 1 (WebRTC/SIP) when a new emergency call arrives.
   * Creates FSM, wires all event handlers, persists initial state.
   */
  async handleNewCall(callerInfo: CallerInfo): Promise<string> {
    const fsm = new EmergencyStateMachine(callerInfo);
    activeIncidents.set(fsm.id, fsm);

    // Wire all state-driven side effects
    this.wireEventHandlers(fsm);

    // Trigger first transition: NEW → CALL_ACTIVE
    const ok = await fsm.send(TransitionTrigger.CALL_RECEIVED, 'MODULE_1');
    if (!ok) {
      logger.error(`[Orchestrator] Failed to activate incident ${fsm.id}`);
      fsm.destroy();
      activeIncidents.delete(fsm.id);
      throw new Error('Failed to initialize incident state machine');
    }

    logger.info(`[Orchestrator] Incident ${fsm.id} started for session ${callerInfo.callSessionId}`);
    return fsm.id;
  }

  // ── Cancel / override ─────────────────────

  async cancelIncident(incidentId: string, reason: string): Promise<void> {
    const fsm = activeIncidents.get(incidentId);
    if (!fsm) throw new Error(`Incident ${incidentId} not found`);
    fsm.patchContext({ tags: [`cancel-reason:${reason}`] });
    await fsm.send(TransitionTrigger.CANCEL_INCIDENT, 'MODULE_10_OPERATOR');
    this.cleanup(incidentId);
  }

  // ── External module result ingestion ──────

  /**
   * Called by Module 2 (STT) when transcription is complete.
   */
  async onSpeechTranscribed(incidentId: string, transcript: string): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    fsm.patchContext({ transcript });
    await fsm.send(TransitionTrigger.SPEECH_TRANSCRIBED, 'MODULE_2');
    // Kick off NLP classification (Module 3) asynchronously
    this.runNLPClassification(incidentId, transcript).catch(this.fsmErrorHandler(incidentId, 'MODULE_3'));
  }

  /**
   * Called by Module 3 (NLP/LLM) when classification is ready.
   */
  async onNLPDone(incidentId: string, payload: Parameters<EmergencyStateMachine['applyNLPClassification']>[0]): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    fsm.applyNLPClassification(payload);
    const ok = await fsm.send(TransitionTrigger.NLP_CLASSIFICATION_DONE, 'MODULE_3');
    if (!ok) throw new Error(`State transition failed for incident ${incidentId}`);
    // Autonomous decision to initiate response
    await this.makeResponseDecision(incidentId);
  }

  /**
   * Called by Module 6 (Ambulance) when unit is dispatched.
   */
  async onAmbulanceDispatched(incidentId: string, payload: Parameters<EmergencyStateMachine['applyAmbulanceAssignment']>[0]): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    fsm.applyAmbulanceAssignment(payload);
    await fsm.send(TransitionTrigger.AMBULANCE_DISPATCHED, 'MODULE_6');
    // Kick off hospital selection + route in parallel
    await this.runHospitalAndRoute(incidentId);
  }

  /**
   * Called by Module 9 (Corridor) when geofence is live.
   */
  async onCorridorActivated(incidentId: string, payload: Parameters<EmergencyStateMachine['applyCorridorInfo']>[0]): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    fsm.applyCorridorInfo(payload);
    await fsm.send(TransitionTrigger.CORRIDOR_ACTIVATED, 'MODULE_9');
  }

  /**
   * Called by ambulance GPS / hospital reception when patient arrives.
   */
  async onPatientArrived(incidentId: string): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    await fsm.send(TransitionTrigger.PATIENT_ARRIVED, 'MODULE_6_GPS');
  }

  /**
   * Called by hospital staff to mark incident as resolved.
   */
  async onIncidentResolved(incidentId: string): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    await fsm.send(TransitionTrigger.INCIDENT_RESOLVED, 'MODULE_7_RECEPTION');
    this.cleanup(incidentId);
  }

  // ── Internal orchestration steps ──────────

  /**
   * Calls Module 3 API to perform NLP classification.
   */
  private async runNLPClassification(incidentId: string, transcript: string): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    const ctx = fsm.snapshot;

    const result = await withRetry(
      () => moduleApiClient.classifyIncident({ transcript, callSessionId: ctx.callSessionId, language: ctx.caller.language }),
      { maxAttempts: 3, baseDelayMs: 1000, module: 'MODULE_3' },
    );

    await this.onNLPDone(incidentId, result);
  }

  /**
   * Autonomous decision: evaluate severity and decide response type.
   */
  private async makeResponseDecision(incidentId: string): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    const ctx = fsm.snapshot;

    logger.info(`[Orchestrator:${incidentId}] Decision: type=${ctx.incidentType} severity=${ctx.severity} priority=${ctx.priority}`);

    // Dispatch Module 6 for ambulance assignment
    const ok = await fsm.send(TransitionTrigger.RESPONSE_DECISION_MADE, 'MODULE_10');
    if (!ok) {
      logger.error(`[Orchestrator:${incidentId}] Could not initiate response – guard failed`);
      return;
    }

    // Call Module 6 API
    this.dispatchAmbulance(incidentId).catch(this.fsmErrorHandler(incidentId, 'MODULE_6'));
  }

  private async dispatchAmbulance(incidentId: string): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    const ctx = fsm.snapshot;

    const result = await withRetry(
      () => moduleApiClient.assignAmbulance({
        incidentId,
        location: ctx.location!,
        severity: ctx.severity,
        incidentType: ctx.incidentType,
      }),
      { maxAttempts: 3, baseDelayMs: 2000, module: 'MODULE_6' },
    );

    await this.onAmbulanceDispatched(incidentId, result);
  }

  /**
   * Parallel: select hospital (Module 7) + calculate route (Module 8) → activate corridor (Module 9).
   */
  private async runHospitalAndRoute(incidentId: string): Promise<void> {
    const fsm = this.getOrThrow(incidentId);
    const ctx = fsm.snapshot;

    // Step 1: Hospital selection (Module 7)
    const hospital = await withRetry(
      () => moduleApiClient.selectHospital({
        incidentId,
        location: ctx.location!,
        incidentType: ctx.incidentType,
        severity: ctx.severity,
      }),
      { maxAttempts: 3, baseDelayMs: 1500, module: 'MODULE_7' },
    );
    fsm.applyHospitalSelection(hospital);

    // Step 2: Route calculation (Module 8)
    const route = await withRetry(
      () => moduleApiClient.calculateRoute({
        incidentId,
        origin: ctx.ambulance!.location,
        destination: { latitude: 0, longitude: 0 }, // filled from hospital
        hospitalId: hospital.hospital.hospitalId,
      }),
      { maxAttempts: 3, baseDelayMs: 1500, module: 'MODULE_8' },
    );
    fsm.applyRouteInfo(route);

    // Transition: AMBULANCE_ASSIGNED → ROUTE_GENERATED
    const routeOk = await fsm.send(TransitionTrigger.ROUTE_CALCULATED, 'MODULE_8', {
      hospital: hospital.hospital,
      route: route.route,
    });
    if (!routeOk) return;

    // Step 3: Corridor activation (Module 9)
    const corridor = await withRetry(
      () => moduleApiClient.activateCorridor({
        incidentId,
        routePolyline: route.route.routePolyline,
        ambulanceId: ctx.ambulance!.ambulanceId,
        severity: ctx.severity,
      }),
      { maxAttempts: 2, baseDelayMs: 1000, module: 'MODULE_9' },
    );

    await this.onCorridorActivated(incidentId, corridor);
  }

  // ── FSM Event Wiring ──────────────────────

  private wireEventHandlers(fsm: EmergencyStateMachine): void {
    // Forward every state change to DB + Dashboard
    fsm.on('state:changed', async (event: StateChangeEvent) => {
      try {
        // Module 11: Persist state
        await dbPersistence.upsertIncident(event.payload as EmergencyContext);
        await dbPersistence.appendEvent(event);

        // Module 12: Push real-time update
        await dashboardPublisher.publishStateChange(event);

        // Event bus (Redis / Kafka): fan-out to other subscribers
        await eventBus.publish('emergency.state_changed', event);
      } catch (err) {
        logger.error(`[Orchestrator] Post-transition side effects failed for ${event.incidentId}: ${err}`);
      }
    });

    fsm.on('state:timeout', (state: IncidentState, ctx: EmergencyContext) => {
      dashboardPublisher.publishAlert({
        incidentId: ctx.incidentId,
        alertType: 'TIMEOUT',
        message: `State ${state} timed out for incident ${ctx.incidentId}`,
        severity: ctx.severity,
      });
    });

    fsm.on('incident:failed', (ctx: EmergencyContext, reason: string) => {
      logger.error(`[Orchestrator] Incident ${ctx.incidentId} FAILED: ${reason}`);
      dashboardPublisher.publishAlert({
        incidentId: ctx.incidentId,
        alertType: 'INCIDENT_FAILED',
        message: reason,
        severity: ctx.severity,
      });
      this.cleanup(ctx.incidentId);
    });

    fsm.on('incident:completed', (ctx: EmergencyContext) => {
      logger.info(`[Orchestrator] Incident ${ctx.incidentId} COMPLETED`);
      // Trigger ML learning pipeline (Module 12 Bayesian engine)
      eventBus.publish('emergency.outcome', ctx).catch(logger.error);
      this.cleanup(ctx.incidentId);
    });

    fsm.on('context:updated', async (ctx: EmergencyContext) => {
      // Lightweight partial update – only patches to DB/dashboard
      await dbPersistence.patchIncidentContext(ctx.incidentId, {
        location:  ctx.location,
        patient:   ctx.patient,
        ambulance: ctx.ambulance,
        priority:  ctx.priority,
        updatedAt: ctx.updatedAt,
      });
      await dashboardPublisher.publishContextPatch(ctx);
    });
  }

  // ── Helpers ───────────────────────────────

  private getOrThrow(incidentId: string): EmergencyStateMachine {
    const fsm = activeIncidents.get(incidentId);
    if (!fsm) throw new Error(`Incident ${incidentId} not found in active registry`);
    return fsm;
  }

  private cleanup(incidentId: string): void {
    const fsm = activeIncidents.get(incidentId);
    if (fsm) {
      fsm.destroy();
      activeIncidents.delete(incidentId);
    }
  }

  private fsmErrorHandler(incidentId: string, module: string) {
    return async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[Orchestrator:${incidentId}] Error from ${module}: ${message}`);
      const fsm = activeIncidents.get(incidentId);
      if (fsm) {
        fsm.patchContext({ errorLog: [{ timestamp: new Date().toISOString(), module, message }] });
        await fsm.send(TransitionTrigger.MODULE_FAILURE, module);
      }
    };
  }

  /** Returns a snapshot of all currently active incidents */
  getActiveIncidents(): ReadonlyArray<EmergencyContext> {
    return [...activeIncidents.values()].map(fsm => fsm.snapshot);
  }
}

// Export singleton
export const orchestrator = EmergencyOrchestrator.getInstance();
