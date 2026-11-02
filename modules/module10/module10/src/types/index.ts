/**
 * Module 10 – Autonomous Decision / State Engine
 * Type Definitions & JSON Schemas
 */

// ─────────────────────────────────────────────
// ENUMERATIONS
// ─────────────────────────────────────────────

export enum IncidentState {
  NEW                = 'NEW',
  CALL_ACTIVE        = 'CALL_ACTIVE',
  ANALYZING          = 'ANALYZING',
  CLASSIFIED         = 'CLASSIFIED',
  RESPONSE_INITIATED = 'RESPONSE_INITIATED',
  AMBULANCE_ASSIGNED = 'AMBULANCE_ASSIGNED',
  ROUTE_GENERATED    = 'ROUTE_GENERATED',
  CORRIDOR_ACTIVE    = 'CORRIDOR_ACTIVE',
  HOSPITAL_ARRIVAL   = 'HOSPITAL_ARRIVAL',
  COMPLETED          = 'COMPLETED',
  // Terminal error states
  FAILED             = 'FAILED',
  CANCELLED          = 'CANCELLED',
}

export enum IncidentSeverity {
  CRITICAL = 'CRITICAL',   // life-threatening, e.g. cardiac arrest
  HIGH     = 'HIGH',       // serious injury / stroke
  MEDIUM   = 'MEDIUM',     // moderate trauma
  LOW      = 'LOW',        // minor injury / wellness check
}

export enum IncidentType {
  CARDIAC_ARREST       = 'CARDIAC_ARREST',
  STROKE               = 'STROKE',
  TRAUMA               = 'TRAUMA',
  RESPIRATORY_DISTRESS = 'RESPIRATORY_DISTRESS',
  SEIZURE              = 'SEIZURE',
  ACCIDENT             = 'ACCIDENT',
  GENERAL_MEDICAL      = 'GENERAL_MEDICAL',
  UNKNOWN              = 'UNKNOWN',
}

export enum TransitionTrigger {
  CALL_RECEIVED           = 'CALL_RECEIVED',
  SPEECH_TRANSCRIBED      = 'SPEECH_TRANSCRIBED',
  NLP_CLASSIFICATION_DONE = 'NLP_CLASSIFICATION_DONE',
  RESPONSE_DECISION_MADE  = 'RESPONSE_DECISION_MADE',
  AMBULANCE_DISPATCHED    = 'AMBULANCE_DISPATCHED',
  ROUTE_CALCULATED        = 'ROUTE_CALCULATED',
  CORRIDOR_ACTIVATED      = 'CORRIDOR_ACTIVATED',
  PATIENT_ARRIVED         = 'PATIENT_ARRIVED',
  INCIDENT_RESOLVED       = 'INCIDENT_RESOLVED',
  // Error / override triggers
  MODULE_FAILURE          = 'MODULE_FAILURE',
  CANCEL_INCIDENT         = 'CANCEL_INCIDENT',
  TIMEOUT                 = 'TIMEOUT',
  RETRY                   = 'RETRY',
}

// ─────────────────────────────────────────────
// CORE CONTEXT INTERFACES
// ─────────────────────────────────────────────

export interface GeoLocation {
  latitude:  number;
  longitude: number;
  address?:  string;
  accuracy?: number;        // metres
}

export interface PatientInfo {
  consciousnessLevel: 'CONSCIOUS' | 'UNCONSCIOUS' | 'UNKNOWN';
  breathingNormally:  boolean | null;
  estimatedAge?:      number;
  knownConditions?:   string[];
  callerRelation?:    string;       // e.g. 'spouse', 'bystander'
}

export interface CallerInfo {
  callSessionId: string;
  phoneNumber?:  string;
  language:      string;            // BCP-47 e.g. 'en-IN', 'ml-IN'
  channel:       'WEBRTC' | 'SIP' | 'PSTN';
}

export interface AmbulanceAssignment {
  ambulanceId:  string;
  unitCallSign: string;
  driverId:     string;
  etaMinutes:   number;
  location:     GeoLocation;
}

export interface HospitalAssignment {
  hospitalId:   string;
  hospitalName: string;
  distanceKm:   number;
  hasICU:       boolean;
  specialty:    string[];
  bedsAvailable: number;
}

export interface RouteInfo {
  routePolyline: string;           // encoded polyline string (e.g. Google format)
  distanceKm:    number;
  etaMinutes:    number;
  provider:      'OSRM' | 'OPENROUTE' | 'GOOGLE';
  waypoints?:    GeoLocation[];
}

export interface CorridorInfo {
  corridorId:       string;
  geofencePolygon:  GeoLocation[];
  affectedSignalIds: string[];
  notifiedCount:    number;
  activatedAt:      string;        // ISO-8601
}

export interface RetryMeta {
  attempt:   number;
  maxRetries: number;
  lastError:  string;
  nextRetryAt?: string;            // ISO-8601
}

// ─────────────────────────────────────────────
// MAIN STATE CONTEXT
// ─────────────────────────────────────────────

/**
 * EmergencyContext – the single source of truth for an incident.
 * Persisted to Module 11 on every state change.
 */
export interface EmergencyContext {
  // Identity
  incidentId:    string;          // UUID v4
  callSessionId: string;

  // Lifecycle
  currentState:  IncidentState;
  previousState: IncidentState | null;
  createdAt:     string;          // ISO-8601
  updatedAt:     string;          // ISO-8601
  completedAt?:  string;

  // Classification (set by Module 3)
  incidentType:  IncidentType;
  severity:      IncidentSeverity;
  confidence:    number;           // 0-1

  // Extracted details
  location:      GeoLocation | null;
  patient:       PatientInfo;
  caller:        CallerInfo;
  transcript:    string;
  rawNlpData?:   Record<string, unknown>;

  // Response assignments (populated progressively)
  ambulance?:    AmbulanceAssignment;
  hospital?:     HospitalAssignment;
  route?:        RouteInfo;
  corridor?:     CorridorInfo;

  // Resilience
  retryMeta?:    RetryMeta;
  errorLog:      ErrorEntry[];

  // Metadata
  tags:          string[];
  priority:      number;           // computed priority score (higher = more urgent)
}

export interface ErrorEntry {
  timestamp: string;
  module:    string;
  message:   string;
  code?:     string;
}

// ─────────────────────────────────────────────
// STATE CHANGE EVENT (published to Module 11/12)
// ─────────────────────────────────────────────

export interface StateChangeEvent {
  eventId:       string;          // UUID v4
  incidentId:    string;
  trigger:       TransitionTrigger;
  fromState:     IncidentState;
  toState:       IncidentState;
  timestamp:     string;          // ISO-8601
  actorModule:   string;          // e.g. 'MODULE_3', 'MODULE_6'
  payload:       Partial<EmergencyContext>;
  meta?: {
    durationMs:   number;         // time spent in previous state
    retryAttempt?: number;
  };
}

// ─────────────────────────────────────────────
// MODULE API RESPONSE SHAPES
// ─────────────────────────────────────────────

export interface Module3Payload {
  incidentType: IncidentType;
  severity:     IncidentSeverity;
  confidence:   number;
  location:     GeoLocation | null;
  patient:      PatientInfo;
  transcript:   string;
  rawNlpData?:  Record<string, unknown>;
}

export interface Module6Payload {
  ambulance:    AmbulanceAssignment;
}

export interface Module7Payload {
  hospital:     HospitalAssignment;
}

export interface Module8Payload {
  route:        RouteInfo;
}

export interface Module9Payload {
  corridor:     CorridorInfo;
}

// ─────────────────────────────────────────────
// TRANSITION TABLE TYPE
// ─────────────────────────────────────────────

export type TransitionMap = {
  [fromState in IncidentState]?: {
    [trigger in TransitionTrigger]?: IncidentState;
  };
};

// ─────────────────────────────────────────────
// JSON SCHEMA (for validation / OpenAPI docs)
// ─────────────────────────────────────────────

export const EMERGENCY_CONTEXT_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'EmergencyContext',
  type: 'object',
  required: ['incidentId', 'callSessionId', 'currentState', 'createdAt', 'updatedAt'],
  properties: {
    incidentId:    { type: 'string', format: 'uuid' },
    callSessionId: { type: 'string' },
    currentState:  { type: 'string', enum: Object.values(IncidentState) },
    previousState: { type: ['string', 'null'], enum: [...Object.values(IncidentState), null] },
    createdAt:     { type: 'string', format: 'date-time' },
    updatedAt:     { type: 'string', format: 'date-time' },
    incidentType:  { type: 'string', enum: Object.values(IncidentType) },
    severity:      { type: 'string', enum: Object.values(IncidentSeverity) },
    confidence:    { type: 'number', minimum: 0, maximum: 1 },
    priority:      { type: 'number' },
    errorLog:      { type: 'array' },
    tags:          { type: 'array', items: { type: 'string' } },
  },
} as const;
