import {
  noopLogger,
  type DomainEventBusPort,
  type Emergency,
  type EmergencySeverity,
  type IncidentType,
  type Logger,
  type SystemEventRecord,
  INCIDENT_TYPES,
  EMERGENCY_SEVERITIES,
  EMERGENCY_STATUSES,
} from '@resus/core';
import { requiredEquipmentFor } from '@resus/fleet';
import { classifyTranscript, type TriageResult } from './triageClassifier.js';

/**
 * Module 10 — Autonomous Decision / State Engine.
 *
 * The other modules each react to one event and stop at a human gate (driver
 * acceptance, explicit dispatch, operator-reported milestones). This
 * orchestrator closes those gates for an unattended, end-to-end run:
 *
 *   caller speech -> classify (LLM or rule) -> EMERGENCY_CLASSIFIED
 *     -> Module 6 assigns the nearest unit, Module 7 selects a hospital
 *     -> (unstaffed crew) offer accepted + dispatched  -> Module 8 response route
 *     -> Module 9 corridor -> simulated drive to scene -> on scene -> onboard
 *     -> transport route -> simulated drive -> hospital arrival -> completed
 *
 * It only calls existing module services and repositories: every decision is
 * still written as the same event a human action would write, with
 * `actorType: 'MODULE'` / `actorId: 'MODULE_10'` so the audit trail shows the
 * system did it. An ambulance whose crew has a driver account is never driven
 * by the simulator: the driver app accepts the offer and reports real GPS;
 * the orchestrator then only performs the dispatch step.
 *
 * Everything is opt-in (`MODULE10_AUTONOMOUS_ENABLED=true`).
 */

export interface AutonomousConfig {
  enabled: boolean;
  /** Accept offers on behalf of ambulances that have no driver account. */
  autoAcceptUnstaffed: boolean;
  /** Dispatch automatically once an offer is accepted (by a driver or by us). */
  autoDispatch: boolean;
  /** Drive unstaffed ambulances along their planned routes. */
  simulateMovement: boolean;
  /** Real minutes are divided by this when animating a route (20 => 8 min ETA in 24 s). */
  timeCompression: number;
  tickMs: number;
  sceneDwellMs: number;
  hospitalDwellMs: number;
  /** How often idle unstaffed units re-report their station position (keeps them non-stale). */
  stationHeartbeatMs: number;
}

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined || value === '' ? fallback : value.toLowerCase() === 'true';
const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadAutonomousConfig(env: NodeJS.ProcessEnv = process.env): AutonomousConfig {
  return {
    enabled: bool(env.MODULE10_AUTONOMOUS_ENABLED, false),
    autoAcceptUnstaffed: bool(env.MODULE10_AUTO_ACCEPT_UNSTAFFED, true),
    autoDispatch: bool(env.MODULE10_AUTO_DISPATCH, true),
    simulateMovement: bool(env.MODULE10_SIMULATE_MOVEMENT, true),
    timeCompression: num(env.MODULE10_TIME_COMPRESSION, 20),
    tickMs: num(env.MODULE10_TICK_MS, 1500),
    sceneDwellMs: num(env.MODULE10_SCENE_DWELL_MS, 8000),
    hospitalDwellMs: num(env.MODULE10_HOSPITAL_DWELL_MS, 6000),
    stationHeartbeatMs: num(env.MODULE10_STATION_HEARTBEAT_MS, 120_000),
  };
}

// ---------------------------------------------------------------------------
// Ports: structural shapes of the module services used here, so this file does
// not take a build dependency on any module's internals.
// ---------------------------------------------------------------------------

interface RouteLike {
  id: string;
  destinationName: string;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  polyline: Array<[number, number]>;
  estimatedMinutes: number | null;
  distanceKm: number;
}

interface AmbulanceLike {
  id: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  isSimulation: boolean;
}

export interface AutonomousDeps {
  bus: DomainEventBusPort;
  emergencies: {
    findById(id: string): Promise<Emergency | null>;
    update(
      id: string,
      patch: Partial<{ status: string; incidentType: string; severity: string; selectedHospitalId: string | null }>,
      event?: { type: SystemEventRecord['type']; payload: Record<string, unknown> },
      actor?: { actorType?: string; actorId?: string | null },
    ): Promise<Emergency>;
    recordLifecycleMilestone(input: {
      emergencyId: string;
      milestone: 'AMBULANCE_ARRIVED_SCENE' | 'PATIENT_ONBOARD' | 'AMBULANCE_ARRIVED_HOSPITAL' | 'EMERGENCY_COMPLETED';
      actorId: string;
      actorRole: string;
    }): Promise<unknown>;
  };
  ambulances: {
    list(filter?: { includeSimulation?: boolean; statuses?: string[] }): Promise<AmbulanceLike[]>;
    findById(id: string): Promise<AmbulanceLike | null>;
    update(id: string, patch: { status?: string }): Promise<unknown>;
    acceptForUnstaffedCrew(input: { assignmentId: string; actorId: string }): Promise<unknown>;
    assignedDriverIdOf(ambulanceId: string): Promise<string | null>;
    releaseToAvailable(ambulanceId: string): Promise<void>;
  };
  routes: { routesForEmergency(emergencyId: string): Promise<RouteLike[]> };
  events: { record(event: unknown): Promise<unknown> };
  fleet: {
    dispatchAmbulance(ambulanceId: string, emergencyId: string, by?: string | null): Promise<void>;
    recordLocation(input: {
      ambulanceId: string; latitude: number; longitude: number; speedKmh?: number | null;
      headingDeg?: number | null; source?: string; isSimulation?: boolean;
    }): Promise<unknown>;
  };
  assignment: { selectAndAssign(criteria: { emergencyId: string; latitude: number; longitude: number; requiredEquipment?: string[] }): Promise<unknown> };
  hospitals: { selectForEmergency(emergencyId: string): Promise<unknown> };
  routing: { generateForEmergency(emergencyId: string, leg: 'RESPONSE' | 'TRANSPORT'): Promise<{ outcome: string }> };
  /** Optional: closes the caller's call once the patient is handed over. */
  calls?: { closeForEmergency(emergencyId: string, reason: string): Promise<unknown> };
  /** Optional LLM classification (Module 5 gateway); used when not degraded. */
  llm?: {
    resolve(): Promise<{ service: { providerName: string; classify(text: string): Promise<{ incident_type: string; severity: string; confidence: number }> }; degraded: boolean }>;
  };
  /** Optional Module 3 (Python NLP service) evidence recorder; never a gate. */
  module3?: { enabled: boolean; classify(emergencyId: string, body: { transcriptText: string; language?: string }): Promise<unknown> };
  config: AutonomousConfig;
  logger?: Logger;
}

export interface ClassificationResult {
  incidentType: IncidentType;
  severity: EmergencySeverity;
  confidence: number;
  source: 'RULE' | 'LLM';
  provider: string;
  matched: string[];
}

const ACTOR = { actorType: 'MODULE', actorId: 'MODULE_10' } as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function bearingDeg(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Point at fraction `t` (0..1) of the polyline's length. */
export function pointAlong(path: Array<[number, number]>, t: number): { point: [number, number]; heading: number } {
  if (path.length === 1) return { point: path[0]!, heading: 0 };
  const segments = path.slice(1).map((p, i) => haversineKm(path[i]!, p));
  const total = segments.reduce((sum, d) => sum + d, 0);
  let target = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < segments.length; i += 1) {
    const length = segments[i]!;
    const a = path[i]!;
    const b = path[i + 1]!;
    if (target <= length || i === segments.length - 1) {
      const f = length === 0 ? 1 : Math.min(target / length, 1);
      return { point: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearingDeg(a, b) };
    }
    target -= length;
  }
  return { point: path[path.length - 1]!, heading: 0 };
}

export class AutonomousOrchestrator {
  private readonly logger: Logger;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly running = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<unknown>>();
  /** Per-emergency queue so classification and progress writes never interleave. */
  private readonly statusQueues = new Map<string, Promise<unknown>>();
  private heartbeat: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly deps: AutonomousDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  get enabled(): boolean {
    return this.deps.config.enabled;
  }

  start(): void {
    if (!this.deps.config.enabled) return;
    const on = (types: SystemEventRecord['type'][], handler: (event: SystemEventRecord) => Promise<void>) => {
      this.unsubscribers.push(
        this.deps.bus.subscribe(types, (event) => {
          const task = handler(event).catch((error: unknown) =>
            this.logger.error({ type: event.type, emergencyId: event.emergencyId, error: (error as Error).message }, 'module 10 handler failed'),
          );
          this.tasks.add(task);
          void task.finally(() => this.tasks.delete(task));
        }),
      );
    };
    on(['AMBULANCE_ASSIGNMENT_OFFERED'], (event) => this.onOffered(event));
    on(['AMBULANCE_ASSIGNMENT_ACCEPTED'], (event) => this.onAccepted(event));
    on(['AMBULANCE_ASSIGNMENT_DECLINED', 'AMBULANCE_ASSIGNMENT_EXPIRED'], (event) => this.onReleased(event));
    on(['AMBULANCE_DISPATCHED'], (event) => this.onDispatched(event));

    void this.stationHeartbeat();
    this.heartbeat = setInterval(() => void this.stationHeartbeat(), this.deps.config.stationHeartbeatMs);
    this.heartbeat.unref?.();
    this.logger.info({ config: this.deps.config }, 'module 10 autonomous orchestrator started');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await Promise.allSettled([...this.tasks, ...this.running.values()]);
  }

  /** Waits for all in-flight handlers (tests). */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  // -- classification (Module 3 role) -----------------------------------------

  async classify(text: string): Promise<ClassificationResult> {
    const rule: TriageResult = classifyTranscript(text);
    if (this.deps.llm) {
      try {
        const resolved = await this.deps.llm.resolve();
        if (!resolved.degraded) {
          const out = await resolved.service.classify(text);
          const incidentType = (INCIDENT_TYPES as readonly string[]).includes(out.incident_type) ? (out.incident_type as IncidentType) : 'OTHER';
          const severity = (EMERGENCY_SEVERITIES as readonly string[]).includes(out.severity) ? (out.severity as EmergencySeverity) : 'HIGH';
          // A rule hit on a life threat is never overridden by a vaguer model answer.
          if (!(incidentType === 'OTHER' && rule.incidentType !== 'OTHER')) {
            return { incidentType, severity, confidence: out.confidence, source: 'LLM', provider: resolved.service.providerName, matched: [] };
          }
        }
      } catch (error) {
        this.logger.warn({ error: (error as Error).message }, 'LLM classification unavailable; using rule triage');
      }
    }
    return { ...rule, provider: 'rule-triage' };
  }

  /** Writes the classification as EMERGENCY_CLASSIFIED (which triggers Modules 6 and 7). */
  async recordClassification(emergencyId: string, result: ClassificationResult, transcript: string): Promise<void> {
    await this.serialised(emergencyId, () => this.writeClassification(emergencyId, result));
    if (this.deps.module3?.enabled) {
      // Evidence only: the Python Module 3 extraction is recorded as
      // NLP_EXTRACTION_COMPLETED / _REJECTED and never blocks the response.
      const task = this.deps.module3.classify(emergencyId, { transcriptText: transcript.slice(0, 4096) }).catch((error: unknown) =>
        this.logger.warn({ emergencyId, error: (error as Error).message }, 'module 3 extraction failed (non-blocking)'),
      );
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task));
    }
  }

  private async serialised<T>(emergencyId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.statusQueues.get(emergencyId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.statusQueues.set(emergencyId, next);
    try {
      return await next;
    } finally {
      if (this.statusQueues.get(emergencyId) === next) this.statusQueues.delete(emergencyId);
    }
  }

  private async writeClassification(emergencyId: string, result: ClassificationResult): Promise<void> {
    const current = await this.deps.emergencies.findById(emergencyId);
    if (!current) return;
    const markClassified = current.status === 'CREATED' || current.status === 'CALL_ACTIVE';
    await this.deps.emergencies.update(
      emergencyId,
      { incidentType: result.incidentType, severity: result.severity, ...(markClassified ? { status: 'CLASSIFIED' } : {}) },
      {
        type: 'EMERGENCY_CLASSIFIED',
        payload: { incidentType: result.incidentType, severity: result.severity, confidence: result.confidence, source: result.source },
      },
      ACTOR,
    );
  }

  // -- event handlers ---------------------------------------------------------

  private payload(event: SystemEventRecord): Record<string, string> {
    return (event.payload ?? {}) as Record<string, string>;
  }

  private async onOffered(event: SystemEventRecord): Promise<void> {
    if (!this.deps.config.autoAcceptUnstaffed) return;
    const { assignmentId, ambulanceId } = this.payload(event);
    if (!assignmentId || !ambulanceId) return;
    if (await this.deps.ambulances.assignedDriverIdOf(ambulanceId)) {
      this.logger.info({ ambulanceId, assignmentId }, 'offer waits for the driver app (crew has a driver account)');
      return;
    }
    await this.deps.ambulances.acceptForUnstaffedCrew({ assignmentId, actorId: ACTOR.actorId });
  }

  private async onAccepted(event: SystemEventRecord): Promise<void> {
    if (!this.deps.config.autoDispatch) return;
    const { ambulanceId, emergencyId } = this.payload(event);
    if (!ambulanceId || !emergencyId) return;
    await this.deps.fleet.dispatchAmbulance(ambulanceId, emergencyId, null);
  }

  private async onReleased(event: SystemEventRecord): Promise<void> {
    const emergencyId = event.emergencyId ?? this.payload(event).emergencyId;
    if (!emergencyId) return;
    const emergency = await this.deps.emergencies.findById(emergencyId);
    if (!emergency || ['COMPLETED', 'CANCELLED'].includes(emergency.status)) return;
    try {
      await this.deps.assignment.selectAndAssign({
        emergencyId, latitude: emergency.latitude, longitude: emergency.longitude,
        requiredEquipment: requiredEquipmentFor(emergency.incidentType),
      });
    } catch (error) {
      this.logger.warn({ emergencyId, error: (error as Error).message }, 'could not re-assign after decline/expiry');
    }
  }

  private async onDispatched(event: SystemEventRecord): Promise<void> {
    const { ambulanceId, emergencyId } = this.payload(event);
    if (!ambulanceId || !emergencyId) return;
    await this.setEmergencyStatus(emergencyId, 'EN_ROUTE');
    if (!this.deps.config.simulateMovement) return;
    if (await this.deps.ambulances.assignedDriverIdOf(ambulanceId)) return; // real driver reports GPS
    if (this.running.has(emergencyId)) return;
    const run = this.runMission(emergencyId, ambulanceId).finally(() => this.running.delete(emergencyId));
    this.running.set(emergencyId, run);
  }

  // -- mission simulation -----------------------------------------------------

  private async runMission(emergencyId: string, ambulanceId: string): Promise<void> {
    const milestone = (name: 'AMBULANCE_ARRIVED_SCENE' | 'PATIENT_ONBOARD' | 'AMBULANCE_ARRIVED_HOSPITAL' | 'EMERGENCY_COMPLETED') =>
      this.deps.emergencies.recordLifecycleMilestone({ emergencyId, milestone: name, actorId: ACTOR.actorId, actorRole: ACTOR.actorType });

    const response = await this.awaitRoute(emergencyId, 'RESPONSE');
    if (!response || this.disposed) return;
    await this.drive(ambulanceId, response);
    if (!(await this.stillActive(emergencyId))) return;

    await this.setAmbulanceStatus(ambulanceId, 'AT_SCENE');
    await milestone('AMBULANCE_ARRIVED_SCENE');
    await this.setEmergencyStatus(emergencyId, 'ON_SCENE');
    await sleep(this.deps.config.sceneDwellMs);
    if (!(await this.stillActive(emergencyId))) return;

    const emergency = await this.deps.emergencies.findById(emergencyId);
    if (emergency && !emergency.selectedHospitalId) await this.deps.hospitals.selectForEmergency(emergencyId);
    await this.setAmbulanceStatus(ambulanceId, 'PATIENT_ONBOARD');
    await milestone('PATIENT_ONBOARD');
    await this.setEmergencyStatus(emergencyId, 'PATIENT_ONBOARD');

    const transport = await this.awaitRoute(emergencyId, 'TRANSPORT');
    if (!transport || this.disposed) return;
    await this.setAmbulanceStatus(ambulanceId, 'TRANSPORTING');
    await this.setEmergencyStatus(emergencyId, 'TRANSPORTING');
    await this.drive(ambulanceId, transport);
    if (!(await this.stillActive(emergencyId))) return;

    await this.setAmbulanceStatus(ambulanceId, 'AT_HOSPITAL');
    await milestone('AMBULANCE_ARRIVED_HOSPITAL');
    await this.setEmergencyStatus(emergencyId, 'AT_HOSPITAL');
    await sleep(this.deps.config.hospitalDwellMs);

    await milestone('EMERGENCY_COMPLETED');
    await this.setEmergencyStatus(emergencyId, 'COMPLETED');
    await this.deps.ambulances.releaseToAvailable(ambulanceId);
    try {
      await this.deps.calls?.closeForEmergency(emergencyId, 'Patient handed over at hospital.');
    } catch (error) {
      this.logger.debug({ emergencyId, error: (error as Error).message }, 'call already closed');
    }
    this.logger.info({ emergencyId, ambulanceId }, 'module 10: emergency completed autonomously');
  }

  private async stillActive(emergencyId: string): Promise<boolean> {
    if (this.disposed) return false;
    const emergency = await this.deps.emergencies.findById(emergencyId);
    return Boolean(emergency && !['COMPLETED', 'CANCELLED'].includes(emergency.status));
  }

  private async awaitRoute(emergencyId: string, leg: 'RESPONSE' | 'TRANSPORT'): Promise<RouteLike | null> {
    const destination = leg === 'RESPONSE' ? 'SCENE' : 'HOSPITAL';
    for (let attempt = 0; attempt < 10 && !this.disposed; attempt += 1) {
      const routes = await this.deps.routes.routesForEmergency(emergencyId);
      const found = [...routes].reverse().find((route) => route.destinationName === destination);
      if (found) return found;
      // Module 8's own subscriber normally plans the leg; ask explicitly if it has not.
      if (attempt >= 1) {
        const result = await this.deps.routing.generateForEmergency(emergencyId, leg);
        if (!['GENERATED', 'SKIPPED_ALREADY_EXISTS'].includes(result.outcome)) {
          this.logger.warn({ emergencyId, leg, outcome: result.outcome }, 'route not yet available');
        }
      }
      await sleep(1000);
    }
    this.logger.error({ emergencyId, leg }, 'module 10 gave up waiting for a route');
    return null;
  }

  private async drive(ambulanceId: string, route: RouteLike): Promise<void> {
    const path: Array<[number, number]> = route.polyline.length >= 2
      ? route.polyline
      : [[route.originLat, route.originLng], [route.destLat, route.destLng]];
    const minutes = route.estimatedMinutes ?? (route.distanceKm / 40) * 60;
    const durationMs = Math.min(Math.max((minutes * 60_000) / this.deps.config.timeCompression, 8000), 90_000);
    const ticks = Math.max(2, Math.round(durationMs / this.deps.config.tickMs));
    const speedKmh = minutes > 0 ? Math.round((route.distanceKm / minutes) * 60) : 40;
    for (let i = 1; i <= ticks && !this.disposed; i += 1) {
      await sleep(this.deps.config.tickMs);
      const { point, heading } = pointAlong(path, i / ticks);
      await this.deps.fleet.recordLocation({
        ambulanceId, latitude: point[0], longitude: point[1], speedKmh, headingDeg: Math.round(heading),
        source: 'MODULE10_SIMULATED_CREW', isSimulation: true,
      });
    }
  }

  private async setEmergencyStatus(emergencyId: string, to: string): Promise<void> {
    await this.serialised(emergencyId, () => this.writeStatus(emergencyId, to));
  }

  private async writeStatus(emergencyId: string, to: string): Promise<void> {
    const current = await this.deps.emergencies.findById(emergencyId);
    if (!current || current.status === to || ['COMPLETED', 'CANCELLED'].includes(current.status)) return;
    // Forward-only: a late write can never move the emergency back a stage.
    const order = EMERGENCY_STATUSES as readonly string[];
    if (to !== 'CANCELLED' && order.indexOf(to) < order.indexOf(current.status)) return;
    await this.deps.emergencies.update(
      emergencyId,
      { status: to },
      { type: 'EMERGENCY_STATUS_CHANGED', payload: { from: current.status, to, source: 'SYSTEM' } },
      ACTOR,
    );
  }

  private async setAmbulanceStatus(ambulanceId: string, to: string): Promise<void> {
    const current = await this.deps.ambulances.findById(ambulanceId);
    if (!current || current.status === to) return;
    await this.deps.ambulances.update(ambulanceId, { status: to });
    await this.deps.events.record({
      type: 'AMBULANCE_STATUS_CHANGED',
      entityType: 'ambulance',
      entityId: ambulanceId,
      actorType: ACTOR.actorType,
      actorId: ACTOR.actorId,
      payload: { ambulanceId, from: current.status, to },
    });
  }

  /**
   * Simulated crews have no GPS device. Re-reporting their station position
   * keeps them eligible for Module 6 assignment, which (correctly) ignores
   * units whose last fix is stale. Units with a driver account are skipped:
   * their phone reports real positions.
   */
  private async stationHeartbeat(): Promise<void> {
    if (this.disposed) return;
    try {
      const idle = await this.deps.ambulances.list({ includeSimulation: true, statuses: ['AVAILABLE'] });
      for (const ambulance of idle) {
        if (ambulance.latitude === null || ambulance.longitude === null) continue;
        if (await this.deps.ambulances.assignedDriverIdOf(ambulance.id)) continue;
        await this.deps.fleet.recordLocation({
          ambulanceId: ambulance.id, latitude: ambulance.latitude, longitude: ambulance.longitude, speedKmh: 0,
          source: 'MODULE10_STATION_HEARTBEAT', isSimulation: true,
        });
      }
    } catch (error) {
      this.logger.warn({ error: (error as Error).message }, 'station heartbeat failed');
    }
  }
}
