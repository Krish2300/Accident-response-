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
