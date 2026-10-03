/**
 * The append-only event vocabulary.
 *
 * Every major state transition in the system produces exactly one row in
 * `system_events` (Module 11). The payload map below is the contract shared by
 * the producer module, the persistence layer and the real-time consumers.
 */
import type { AmbulanceStatus, IncidentType } from './enums.js';
import type { DataProvenance } from './provenance.js';

export const SYSTEM_EVENT_TYPES = [
  // call + classification
  'EMERGENCY_CREATED',
  'CALL_STARTED',
  'TRANSCRIPT_UPDATED',
  'EMERGENCY_CLASSIFIED',
  'EMERGENCY_STATUS_CHANGED',

  // module 5 - protocol engine
  'PROTOCOL_STARTED',
  'PROTOCOL_STEP_PRESENTED',
  'CALLER_RESPONSE_RECEIVED',
  'PROTOCOL_STEP_COMPLETED',
  'PROTOCOL_CLARIFICATION_REQUESTED',
  'PROTOCOL_ESCALATED',
  'PROTOCOL_COMPLETED',
  'PROTOCOL_CANCELLED',
  'LLM_CALL_FAILED',

  // module 6 - ambulance
  'AMBULANCE_CREATED',
  'AMBULANCE_UPDATED',
  'AMBULANCE_ASSIGNMENT_REQUESTED',
  'AMBULANCE_ASSIGNED',
  'AMBULANCE_ASSIGNMENT_CANCELLED',
  'AMBULANCE_DISPATCHED',
  'AMBULANCE_LOCATION_UPDATED',
  'AMBULANCE_STATUS_CHANGED',
  'AMBULANCE_ARRIVED_SCENE',
  'PATIENT_ONBOARD',
  'HOSPITAL_SELECTED',
  'AMBULANCE_ARRIVED_HOSPITAL',
  'EMERGENCY_COMPLETED',

  // decision / outcome
  'DECISION_CREATED',
  'OUTCOME_RECORDED',
  'CORRIDOR_ACTIVATED',
  'ROUTE_UPDATED',

  // analytics
  'ANALYTICS_SNAPSHOT_CREATED',
  'LEARNING_MODEL_UPDATED',

  // ---------------------------------------------------------------------------
  // Additions for modules 1-4 and 7-9.
  //
  // Per docs/MODULE_DEPENDENCY_MAP.md section 11 the vocabulary is append-only:
  // these types are new, and no existing payload shape was altered, so every
  // producer and consumer written before them keeps working unchanged.
  // ---------------------------------------------------------------------------

  // module 1 - emergency call interface
  'CALL_CONNECTED',
  'CALL_DISCONNECTED',
  'CALL_FAILED',

  // module 2 - speech processing
  'TRANSCRIPT_PARTIAL',
  'SPEECH_SYNTHESIZED',

  // module 3 - emergency NLP
  'NLP_EXTRACTION_COMPLETED',
  'NLP_EXTRACTION_REJECTED',
  'FACT_EXTRACTED',

  // module 4 - conversation & question engine
  'QUESTION_REQUIRED',
  'ANSWER_RECEIVED',
  'CONVERSATION_TIMED_OUT',
  'CONVERSATION_ESCALATED',

  // module 7 - hospital intelligence
  'HOSPITAL_RESOURCE_UPDATED',
  'HOSPITAL_REJECTED',

  // module 8 - route optimization
  'ROUTE_GENERATED',
  'ROUTE_RECALCULATED',
  'ROUTE_FAILED',

  // module 9 - emergency corridor & alerts
  'CORRIDOR_RENEGOTIATED',
  'CORRIDOR_RELEASED',
  'NOTIFICATION_SENT',
] as const;

export type SystemEventType = (typeof SYSTEM_EVENT_TYPES)[number];

export interface SystemEventEnvelope<T extends SystemEventType = SystemEventType> {
  type: T;
  emergencyId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  payload: EventPayloadMap[T];
}

export interface EventPayloadMap {
  EMERGENCY_CREATED: {
    incidentType: IncidentType;
    severity: string;
    latitude: number;
    longitude: number;
    description?: string | null;
    isSimulation: boolean;
  };
  CALL_STARTED: { callSessionId: string; channel: string; callerId?: string | null };
  TRANSCRIPT_UPDATED: {
    transcriptId: string;
    speaker: string;
    text: string;
    isFinal: boolean;
    sequence: number;
  };
  EMERGENCY_CLASSIFIED: {
    incidentType: IncidentType;
    severity: string;
    confidence: number;
    source: 'RULE' | 'LLM' | 'OPERATOR';
  };
  /** Generic operator-driven status change that has no more specific event. */
  EMERGENCY_STATUS_CHANGED: {
    from: string;
    to: string;
    source: 'OPERATOR' | 'SYSTEM' | 'SIMULATION';
  };

  PROTOCOL_STARTED: {
    protocolSessionId: string;
    protocolId: string;
    protocolVersion: string;
    source: string;
  };
  PROTOCOL_STEP_PRESENTED: {
    protocolSessionId: string;
    stepId: string;
    orderIndex: number;
    instruction: string;
  };
  CALLER_RESPONSE_RECEIVED: {
    protocolSessionId: string;
    stepId: string;
    responseText?: string;
    matchedIntent?: string;
    confidence?: number;
  };
  PROTOCOL_STEP_COMPLETED: {
    protocolSessionId: string;
    stepId: string;
    nextStepId: string | null;
    durationMs: number;
  };
  PROTOCOL_CLARIFICATION_REQUESTED: {
    protocolSessionId: string;
    question: string;
    reason: string;
  };
  PROTOCOL_ESCALATED: {
    protocolSessionId: string;
    reason: string;
    rules: string[];
  };
  PROTOCOL_COMPLETED: {
    protocolSessionId: string;
    stepsCompleted: number;
    escalationRequired: boolean;
  };
  PROTOCOL_CANCELLED: { protocolSessionId: string; reason: string };
  LLM_CALL_FAILED: {
    provider: string;
    model: string;
    reason: string;
    degraded: boolean;
  };

  AMBULANCE_CREATED: { ambulanceId: string; vehicleNumber: string; isSimulation: boolean };
  AMBULANCE_UPDATED: { ambulanceId: string; changed: string[] };
  AMBULANCE_ASSIGNMENT_REQUESTED: {
    emergencyId: string;
    candidatesEvaluated: number;
    requiredEquipment: string[];
    requiredCapabilities: string[];
  };
  AMBULANCE_ASSIGNED: {
    ambulanceId: string;
    assignmentId: string;
    emergencyId: string;
    distanceKm: number;
    estimatedResponseTimeMin: number;
    matchingFactors: string[];
    score: number;
    source: 'AUTOMATIC' | 'MANUAL_OVERRIDE';
    overrideReason?: string | null;
    consideredCandidates: number;
  };
  AMBULANCE_ASSIGNMENT_CANCELLED: { assignmentId: string; reason: string };
  AMBULANCE_DISPATCHED: { ambulanceId: string; emergencyId: string };
  AMBULANCE_LOCATION_UPDATED: {
    ambulanceId: string;
    latitude: number;
    longitude: number;
    speedKmh?: number | null;
    headingDeg?: number | null;
    recordedAt: string;
    isSimulation: boolean;
  };
  AMBULANCE_STATUS_CHANGED: {
    ambulanceId: string;
    from: AmbulanceStatus;
    to: AmbulanceStatus;
  };
  AMBULANCE_ARRIVED_SCENE: { ambulanceId: string; emergencyId: string; responseTimeMin: number };
  PATIENT_ONBOARD: { ambulanceId: string; emergencyId: string; hospitalId: string | null };
  HOSPITAL_SELECTED: { hospitalId: string; emergencyId: string; distanceKm: number; reason: string };
  AMBULANCE_ARRIVED_HOSPITAL: { ambulanceId: string; emergencyId: string; hospitalId: string };
  EMERGENCY_COMPLETED: {
    emergencyId: string;
    totalDurationMin: number;
    status: string;
    isSimulation: boolean;
  };

  DECISION_CREATED: {
    decisionId: string;
    emergencyId: string;
    decisionType: string;
    optionsConsidered: unknown[];
    chosen: string;
    reasoning: string;
    confidence: number;
  };
  OUTCOME_RECORDED: {
    emergencyId: string;
    outcomeId: string;
    status: string;
    provenance: DataProvenance;
  };
  CORRIDOR_ACTIVATED: {
    emergencyId: string;
    ambulanceId: string;
    hospitalId: string;
    from: string;
    to: string;
    estimatedMinutes: number;
  };
  ROUTE_UPDATED: { routeId: string; emergencyId: string; progressPct: number };

  ANALYTICS_SNAPSHOT_CREATED: { snapshotId: string; windowDays: number };
  LEARNING_MODEL_UPDATED: {
    modelVersion: number;
    samples: number;
    outcomeStatuses: Record<string, number>;
  };

  // -- module 1 ---------------------------------------------------------------
  CALL_CONNECTED: {
    callSessionId: string;
    emergencyId: string;
    channel: string;
    provider: string;
    transport: string;
    callerId?: string | null;
    /** False when the session runs on a development provider, never on real telephony. */
    isLiveTransport: boolean;
  };
  CALL_DISCONNECTED: {
    callSessionId: string;
    emergencyId: string;
    durationMs: number;
    reason: string;
  };
  CALL_FAILED: {
    emergencyId: string;
    provider: string;
    reason: string;
    /** What the system fell back to, if anything. */
    fallback?: string | null;
  };

  // -- module 2 ---------------------------------------------------------------
  TRANSCRIPT_PARTIAL: {
    callSessionId: string;
    emergencyId: string;
    speaker: string;
    text: string;
    sequence: number;
    provider: string;
  };
  SPEECH_SYNTHESIZED: {
    callSessionId: string;
    emergencyId: string;
    provider: string;
    voice: string;
    language: string;
    characterCount: number;
    /**
     * True when the spoken text was the protocol's own wording. A false value
     * means the text passed the safety gate as an approved paraphrase.
     */
    verbatimProtocolText: boolean;
  };

  // -- module 3 ---------------------------------------------------------------
  NLP_EXTRACTION_COMPLETED: {
    emergencyId: string;
    provider: string;
    model: string;
    incidentType: string;
    severity: string;
    confidence: number;
    latencyMs: number;
    degraded: boolean;
  };
  /**
   * A model response that failed schema validation and was discarded.
   * Recorded rather than swallowed: an extraction failure is an operational
   * signal, and silently dropping it would hide a degrading provider.
   */
  NLP_EXTRACTION_REJECTED: {
    emergencyId: string;
    provider: string;
    reason: string;
    /** Present when the raw text is retained for diagnosis. */
    rawExcerpt?: string | null;
  };
  FACT_EXTRACTED: {
    emergencyId: string;
    fact: string;
    value: unknown;
    /** `LLM` outputs are advisory; `RULE`/`OPERATOR` facts are authoritative. */
    source: 'LLM' | 'RULE' | 'OPERATOR';
    confidence: number;
  };

  // -- module 4 ---------------------------------------------------------------
  QUESTION_REQUIRED: {
    emergencyId: string;
    questionId: string;
    fact: string;
    question: string;
    attempt: number;
    /** True when the protocol engine, not the conversation layer, chose the wording. */
    fromProtocolCatalogue: boolean;
  };
  ANSWER_RECEIVED: {
    emergencyId: string;
    questionId: string;
    fact: string;
    answered: boolean;
    /** How the answer was understood: understood, misunderstood, or silent. */
    outcome: 'UNDERSTOOD' | 'NOT_UNDERSTOOD' | 'NO_SPEECH';
  };
  CONVERSATION_TIMED_OUT: {
    emergencyId: string;
    questionId: string | null;
    waitedMs: number;
    /** What the engine did after the timeout, always deterministic. */
    nextAction: string;
  };
  CONVERSATION_ESCALATED: {
    emergencyId: string;
    reason: string;
    /** Why the conversation engine gave up asking. */
    trigger: 'RETRY_LIMIT' | 'SILENCE' | 'SAFETY' | 'OPERATOR';
  };

  // -- module 7 ---------------------------------------------------------------
  HOSPITAL_RESOURCE_UPDATED: {
    hospitalId: string;
    resourceType: string;
    code?: string | null;
    total: number;
    available: number;
  };
  HOSPITAL_REJECTED: {
    emergencyId: string;
    hospitalId: string;
    reason: string;
  };

  // -- module 8 ---------------------------------------------------------------
  ROUTE_GENERATED: {
    routeId: string;
    emergencyId: string;
    ambulanceId: string;
    hospitalId: string | null;
    distanceKm: number;
    estimatedMinutes: number;
    provider: string;
    /** False for the deterministic development provider. */
    isLiveTraffic: boolean;
  };
  ROUTE_RECALCULATED: {
    routeId: string;
    emergencyId: string;
    previousDistanceKm: number;
    distanceKm: number;
    previousEstimatedMinutes: number;
    estimatedMinutes: number;
    reason: string;
  };
  ROUTE_FAILED: {
    emergencyId: string;
    ambulanceId: string;
    provider: string;
    reason: string;
    /** Whether the failure was survivable by falling back to a straight-line estimate. */
    degradedToEstimate: boolean;
  };

  // -- module 9 ---------------------------------------------------------------
  CORRIDOR_RENEGOTIATED: {
    corridorId: string;
    emergencyId: string;
    from: string;
    to: string;
    reason: string;
  };
  CORRIDOR_RELEASED: {
    corridorId: string;
    emergencyId: string;
    durationMs: number;
    reason: string;
  };
  NOTIFICATION_SENT: {
    notificationId: string;
    emergencyId: string;
    channel: string;
    audience: string;
    status: string;
    provider: string;
    /** False when the notification was only recorded, not actually delivered. */
    delivered: boolean;
  };
}

export interface SystemEventRecord {
  id: string;
  sequence: number;
  type: SystemEventType;
  emergencyId: string | null;
  entityType: string | null;
  entityId: string | null;
  timestamp: string;
  actorType: string | null;
  actorId: string | null;
  payload: unknown;
  metadata: Record<string, unknown> | null;
}

export function isSystemEventType(value: unknown): value is SystemEventType {
  return (
    typeof value === 'string' &&
    (SYSTEM_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Type-safe constructor for a well-typed event envelope. */
export function defineEvent<T extends SystemEventType>(
  type: T,
  body: Omit<SystemEventEnvelope<T>, 'type'>,
): SystemEventEnvelope<T> {
  return { type, ...body };
}
