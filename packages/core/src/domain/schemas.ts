/**
 * Shared zod validators for enum-like columns.
 *
 * Used at every repository boundary so that a value written by one module is
 * guaranteed to be readable by the next. Single source of truth for the
 * `String`-backed status columns.
 */
import { z } from 'zod';
import {
  ACTOR_TYPES,
  AMBULANCE_STATUSES,
  ASSIGNMENT_DECISIONS,
  ASSIGNMENT_SOURCES,
  CALL_SESSION_STATUSES,
  CREW_CAPABILITIES,
  EMERGENCY_SEVERITIES,
  EMERGENCY_STATUSES,
  EQUIPMENT_CODES,
  HOSPITAL_CAPABILITIES,
  HOSPITAL_STATUSES,
  INCIDENT_TYPES,
  OUTCOME_STATUSES,
  PROTOCOL_SESSION_STATUSES,
  PROTOCOL_STEP_STATUSES,
  TRANSCRIPT_SPEAKERS,
  USER_ROLES,
} from './enums.js';

const enumFrom = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);

export const emergencyStatusSchema = enumFrom(EMERGENCY_STATUSES);
export const emergencySeveritySchema = enumFrom(EMERGENCY_SEVERITIES);
export const incidentTypeSchema = enumFrom(INCIDENT_TYPES);
export const ambulanceStatusSchema = enumFrom(AMBULANCE_STATUSES);
export const protocolSessionStatusSchema = enumFrom(PROTOCOL_SESSION_STATUSES);
export const protocolStepStatusSchema = enumFrom(PROTOCOL_STEP_STATUSES);
export const assignmentSourceSchema = enumFrom(ASSIGNMENT_SOURCES);
export const assignmentDecisionSchema = enumFrom(ASSIGNMENT_DECISIONS);
export const hospitalStatusSchema = enumFrom(HOSPITAL_STATUSES);
export const hospitalCapabilitySchema = enumFrom(HOSPITAL_CAPABILITIES);
export const equipmentCodeSchema = enumFrom(EQUIPMENT_CODES);
export const crewCapabilitySchema = enumFrom(CREW_CAPABILITIES);
export const outcomeStatusSchema = enumFrom(OUTCOME_STATUSES);
export const callSessionStatusSchema = enumFrom(CALL_SESSION_STATUSES);
export const transcriptSpeakerSchema = enumFrom(TRANSCRIPT_SPEAKERS);
export const actorTypeSchema = enumFrom(ACTOR_TYPES);
export const userRoleSchema = enumFrom(USER_ROLES);

export const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** ISO-8601 date-time string. */
export const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())
  .or(z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date'));

/** JSON stored in a `String` column (SQLite has no JSON scalar in Prisma). */
export const jsonColumn = z
  .union([z.array(z.unknown()), z.record(z.unknown())])
  .nullable()
  .optional();
