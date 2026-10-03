/**
 * Enum-like constant arrays.
 *
 * The persistence layer (Module 11) stores these as `String` columns rather
 * than database enums so the exact same schema runs on SQLite (zero-setup
 * development) and PostgreSQL (production). Zod validators derived from these
 * arrays are the single source of truth, enforced at every repository boundary.
 */

export const EMERGENCY_STATUSES = [
  'CREATED',
  'CALL_ACTIVE',
  'CLASSIFIED',
  'PROTOCOL_ACTIVE',
  'AWAITING_AMBULANCE',
  'AMBULANCE_ASSIGNED',
  'EN_ROUTE',
  'ON_SCENE',
  'PATIENT_ONBOARD',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'COMPLETED',
  'CANCELLED',
] as const;
export type EmergencyStatus = (typeof EMERGENCY_STATUSES)[number];

export const EMERGENCY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type EmergencySeverity = (typeof EMERGENCY_SEVERITIES)[number];

export const INCIDENT_TYPES = [
  'CARDIAC_ARREST',
  'CHOKING',
  'UNCONSCIOUS',
  'SEVERE_BREATHING_DIFFICULTY',
  'SEVERE_BLEEDING',
  'TRAUMA',
  'OVERDOSE',
  'SEIZURE',
  'ALLERGIC_REACTION',
  'STROKE',
  'CHEST_PAIN',
  'UNSAFE_SCENE',
  'OTHER',
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const AMBULANCE_STATUSES = [
  'AVAILABLE',
  'DISPATCHED',
  'EN_ROUTE',
  'AT_SCENE',
  'PATIENT_ONBOARD',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'UNAVAILABLE',
  'MAINTENANCE',
] as const;
export type AmbulanceStatus = (typeof AMBULANCE_STATUSES)[number];

export const PROTOCOL_SESSION_STATUSES = [
  'ACTIVE',
  'WAITING_FOR_RESPONSE',
  'ACTION_REQUIRED',
  'ESCALATED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ProtocolSessionStatus = (typeof PROTOCOL_SESSION_STATUSES)[number];

export const PROTOCOL_STEP_STATUSES = [
  'PENDING',
  'ACTIVE',
  'COMPLETED',
  'SKIPPED',
] as const;
export type ProtocolStepStatus = (typeof PROTOCOL_STEP_STATUSES)[number];

export const ASSIGNMENT_SOURCES = ['AUTOMATIC', 'MANUAL_OVERRIDE'] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

export const ASSIGNMENT_DECISIONS = ['ASSIGNED', 'DECLINED', 'CANCELLED'] as const;
export type AssignmentDecisionType = (typeof ASSIGNMENT_DECISIONS)[number];

export const HOSPITAL_STATUSES = ['OPEN', 'BUSY', 'DIVERTING', 'CLOSED'] as const;
export type HospitalStatus = (typeof HOSPITAL_STATUSES)[number];

export const HOSPITAL_CAPABILITIES = [
  'ED_TRAUMA',
  'ED_CARDIAC',
  'CARDIAC_CATHETERISATION',
  'NEUROSURGERY',
  'BURN_CENTRE',
  'POISON_CONTROL',
  'RESPIRATORY',
  'GENERAL',
] as const;
export type HospitalCapability = (typeof HOSPITAL_CAPABILITIES)[number];

export const EQUIPMENT_CODES = [
  'DEFIBRILLATOR',
  'ADVANCED_AIRWAY',
  'OXYGEN',
  'TRAUMA_KIT',
  'HAEMORRHAGE_KIT',
  'CARDIAC_MONITOR',
  'ECG',
  'NEONATAL_KIT',
  'BURN_KIT',
  'POISON_KIT',
  'SALT_DROP_KIT',
  'SPINAL_BOARD',
] as const;
export type EquipmentCode = (typeof EQUIPMENT_CODES)[number];

export const CREW_CAPABILITIES = [
  'PARAMEDIC',
  'ADVANCED_LIFE_SUPPORT',
  'BLS_TRANSPORT',
  'CRITICAL_CARE',
  'TRAUMA_SPECIALIST',
  'HAEMORRHAGE_TRANSPORT',
  'PEDIATRIC_CARE',
  'MENTAL_HEALTH',
] as const;
export type CrewCapability = (typeof CREW_CAPABILITIES)[number];

export const OUTCOME_STATUSES = [
  'STABILISED',
  'TRANSPORTED',
  'SURVIVED_TO_DISCHARGE',
  'DECEASED',
  'HANDED_OVER_OTHER_SERVICE',
  'CANCELLED_BEFORE_ARRIVAL',
  'UNKNOWN',
] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export const CALL_SESSION_STATUSES = ['ACTIVE', 'ENDED'] as const;
export type CallSessionStatus = (typeof CALL_SESSION_STATUSES)[number];

/** Module 8 — route lifecycle. */
export const ROUTE_STATUSES = [
  'PLANNED',
  'ACTIVE',
  'PAUSED',
  'RECALCULATING',
  'ARRIVED',
  'ABANDONED',
] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];

/** Module 9 — emergency corridor lifecycle. */
export const CORRIDOR_STATUSES = [
  'REQUESTED',
  'ACTIVE',
  'RENEGOTIATING',
  'RELEASED',
  'FAILED',
] as const;
export type CorridorStatus = (typeof CORRIDOR_STATUSES)[number];

/**
 * Module 9 — how far a corridor actually got.
 *
 * `SIMULATED` is the default in development because no traffic-signal or
 * road-user integration exists yet. It is a distinct value rather than a boolean
 * so that no consumer can read a simulated priority request as an observed one.
 */
export const CORRIDOR_PRIORITY_MODES = [
  'SIMULATED',
  'NOTIFY_ONLY',
  'INTEGRATED',
] as const;
export type CorridorPriorityMode = (typeof CORRIDOR_PRIORITY_MODES)[number];

export const NOTIFICATION_CHANNELS = ['PUSH', 'SMS', 'VOICE', 'WEB', 'IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = [
  'QUEUED',
  'SENT',
  'DELIVERED',
  'FAILED',
  'SUPPRESSED',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Module 7 — the resource kinds a hospital's suitability is scored against. */
export const HOSPITAL_RESOURCE_TYPES = [
  'ICU_BED',
  'EMERGENCY_BED',
  'OPERATION_THEATRE',
  'SPECIALIST',
  'EQUIPMENT',
] as const;
export type HospitalResourceType = (typeof HOSPITAL_RESOURCE_TYPES)[number];

export const PATIENT_CONSCIOUSNESS = [
  'ALERT',
  'RESPONDS_TO_VOICE',
  'RESPONDS_TO_PAIN',
  'UNRESPONSIVE',
  'UNKNOWN',
] as const;
export type PatientConsciousness = (typeof PATIENT_CONSCIOUSNESS)[number];

export const PATIENT_BREATHING = [
  'NORMAL',
  'LABOURED',
  'GASPNING',
  'AGONISTIC',
  'NOT_BREATHING',
  'UNKNOWN',
] as const;
export type PatientBreathing = (typeof PATIENT_BREATHING)[number];

export const TRANSCRIPT_SPEAKERS = ['CALLER', 'SYSTEM', 'BYSTANDER', 'OPERATOR'] as const;
export type TranscriptSpeaker = (typeof TRANSCRIPT_SPEAKERS)[number];

export const ACTOR_TYPES = ['SYSTEM', 'OPERATOR', 'CALLER', 'AMBULANCE', 'MODULE', 'SIMULATION'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const USER_ROLES = [
  'OPERATOR',
  'DISPATCHER',
  'CLINICAL_SUPERVISOR',
  'ADMIN',
] as const;
export type UserRole = (typeof USER_ROLES)[number];
