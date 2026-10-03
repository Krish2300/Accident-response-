/**
 * Row -> domain mappers.
 *
 * Every repository returns these types, never raw Prisma rows. This is what
 * keeps modules 5, 6 and 12 independent of the ORM: they import `@resus/core`
 * domain types, and the JSON-in-String columns are decoded here and nowhere else.
 */
import {
  type Ambulance,
  type AmbulanceAssignment,
  type AmbulanceCrewMember,
  type AmbulanceLocation,
  type Decision,
  type Emergency,
  type Hospital,
  type Outcome,
  type ProtocolSession,
  type ProtocolStepRecord,
  type SystemEventRecord,
  ambulanceStatusSchema,
  assignmentSourceSchema,
  crewCapabilitySchema,
  emergencySeveritySchema,
  emergencyStatusSchema,
  equipmentCodeSchema,
  hospitalCapabilitySchema,
  hospitalStatusSchema,
  incidentTypeSchema,
  outcomeStatusSchema,
  protocolSessionStatusSchema,
  protocolStepStatusSchema,
} from '@resus/core';

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** Decodes a JSON string column, returning `fallback` on absent/invalid data. */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    const parsed = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function parseStringArray(value: unknown): string[] {
  const parsed = parseJsonColumn<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export function parseRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJsonColumn<unknown>(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Validates a list of enum values, dropping unknown ones rather than crashing. */
function parseEnumList<T extends string>(value: unknown, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): T[] {
  return parseStringArray(value).filter((item): item is T => {
    const result = schema.safeParse(item);
    return result.success;
  });
}

export function mapEmergency(row: Row): Emergency {
  return {
    id: String(row.id),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    status: emergencyStatusSchema.parse(row.status),
    incidentType: incidentTypeSchema.parse(row.incidentType),
    severity: emergencySeveritySchema.parse(row.severity),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    description: str(row.description),
    callerId: str(row.callerId),
    assignedAmbulanceId: str(row.assignedAmbulanceId),
    selectedHospitalId: str(row.selectedHospitalId),
    isSimulation: Boolean(row.isSimulation),
  };
}

export function mapAmbulance(
  row: Row,
  crewRows: Row[] = [],
): Ambulance {
  const equipment = parseEnumList(row.equipmentJson, equipmentCodeSchema);
  const crew: AmbulanceCrewMember[] = crewRows.map((member) => ({
    id: String(member.id),
    ambulanceId: String(member.ambulanceId),
    name: String(member.name),
    role: String(member.role),
    capabilities: parseEnumList(member.capabilitiesJson, crewCapabilitySchema),
    isOnDuty: Boolean(member.isOnDuty),
  }));
  return {
    id: String(row.id),
    vehicleNumber: String(row.vehicleNumber),
    status: ambulanceStatusSchema.parse(row.status),
    latitude: numOrNull(row.latitude),
    longitude: numOrNull(row.longitude),
    lastLocationUpdate: isoOrNull(row.lastLocationUpdate),
    equipment,
    crew,
    currentEmergencyId: str(row.currentEmergencyId),
    assignedAt: isoOrNull(row.assignedAt),
    availableAt: isoOrNull(row.availableAt),
    isSimulation: Boolean(row.isSimulation),
    stationName: str(row.stationName),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapAmbulanceLocation(row: Row): AmbulanceLocation {
  return {
    id: String(row.id),
    ambulanceId: String(row.ambulanceId),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    speedKmh: numOrNull(row.speedKmh),
    headingDeg: numOrNull(row.headingDeg),
    accuracyM: numOrNull(row.accuracyM),
    recordedAt: iso(row.recordedAt),
    source: String(row.source ?? 'GPS'),
    isSimulation: Boolean(row.isSimulation),
  };
}

export function mapAssignment(row: Row): AmbulanceAssignment {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    ambulanceId: String(row.ambulanceId),
    status: String(row.status) as AmbulanceAssignment['status'],
    source: assignmentSourceSchema.parse(row.source),
    distanceKm: Number(row.distanceKm),
    estimatedResponseTimeMin: Number(row.estimatedResponseTimeMin),
    score: Number(row.score),
    matchingFactors: parseStringArray(row.matchingFactorsJson),
    rejectedReasons: parseRecord(row.rejectedReasonsJson) as Record<string, string>,
    overrideReason: str(row.overrideReason),
    decidedByUserId: str(row.decidedByUserId),
    decidedAt: iso(row.decidedAt),
    createdAt: iso(row.createdAt),
  };
}

export function mapHospital(row: Row): Hospital {
  return {
    id: String(row.id),
    name: String(row.name),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    status: hospitalStatusSchema.parse(row.status),
    capabilities: parseEnumList(row.capabilitiesJson, hospitalCapabilitySchema),
    traumaLevel: Number(row.traumaLevel),
    acceptingEmergencies: Boolean(row.acceptingEmergencies),
    contactPhone: str(row.contactPhone),
    address: str(row.address),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapProtocolSession(row: Row): ProtocolSession {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    protocolId: String(row.protocolId),
    protocolVersion: String(row.protocolVersion),
    protocolSource: String(row.protocolSource),
    currentStep: String(row.currentStep),
    status: protocolSessionStatusSchema.parse(row.status),
    startedAt: iso(row.startedAt),
    updatedAt: iso(row.updatedAt),
    completedAt: isoOrNull(row.completedAt),
    escalationRequired: Boolean(row.escalationRequired),
    escalationReason: str(row.escalationReason),
    clarificationCount: Number(row.clarificationCount ?? 0),
    collectedFacts: parseRecord(row.collectedFactsJson),
    initiatedBy: String(row.initiatedBy ?? 'SYSTEM'),
  };
}

export function mapProtocolStep(row: Row): ProtocolStepRecord {
  return {
    id: String(row.id),
    protocolSessionId: String(row.protocolSessionId),
    stepId: String(row.stepId),
    orderIndex: Number(row.orderIndex),
    status: protocolStepStatusSchema.parse(row.status),
    presentedAt: isoOrNull(row.presentedAt),
    completedAt: isoOrNull(row.completedAt),
    result: Object.keys(parseRecord(row.resultJson)).length > 0 ? parseRecord(row.resultJson) : null,
  };
}

export function mapDecision(row: Row): Decision {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    decisionType: String(row.decisionType),
    ambulanceId: str(row.ambulanceId),
    hospitalId: str(row.hospitalId),
    optionsConsidered: parseJsonColumn<unknown[]>(row.optionsConsideredJson, []),
    chosen: String(row.chosen),
    reasoning: String(row.reasoning),
    confidence: Number(row.confidence),
    actorType: String(row.actorType),
    actorId: str(row.actorId),
    createdAt: iso(row.createdAt),
  };
}

export function mapOutcome(row: Row): Outcome {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    status: outcomeStatusSchema.parse(row.status),
    provenance: String(row.provenance),
    survivalToDischarge: row.survivalToDischarge == null ? null : Boolean(row.survivalToDischarge),
    notes: str(row.notes),
    recordedAt: iso(row.recordedAt),
    recordedByUserId: str(row.recordedByUserId),
  };
}

export function mapSystemEvent(row: Row): SystemEventRecord {
  return {
    id: String(row.id),
    sequence: Number(row.seq),
    type: String(row.type) as SystemEventRecord['type'],
    emergencyId: str(row.emergencyId),
    entityType: str(row.entityType),
    entityId: str(row.entityId),
    timestamp: iso(row.recordedAt),
    actorType: str(row.actorType),
    actorId: str(row.actorId),
    payload: parseJsonColumn<unknown>(row.payloadJson, {}),
    metadata: Object.keys(parseRecord(row.metadataJson)).length > 0 ? parseRecord(row.metadataJson) : null,
  };
}
