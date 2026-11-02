import { INCIDENT_TYPES, type IncidentType, type SystemEventRecord } from '@resus/core';
import type {
  LifecycleEventReference,
  Module10LifecycleFactKey,
  Module10LifecycleState,
  Module10LifecycleDiagnosticLogger,
} from './types';

const PAYLOAD_EMERGENCY_ID_REQUIRED = new Set([
  'CALL_CONNECTED',
  'NLP_EXTRACTION_COMPLETED',
  'AMBULANCE_ASSIGNED',
  'AMBULANCE_DISPATCHED',
  'HOSPITAL_SELECTED',
  'ROUTE_GENERATED',
  'CORRIDOR_ACTIVATED',
  'AMBULANCE_ARRIVED_SCENE',
  'PATIENT_ONBOARD',
  'AMBULANCE_ARRIVED_HOSPITAL',
  'EMERGENCY_COMPLETED',
]);

export interface MappedLifecycleEvent {
  emergencyId: string;
  eventId: string;
  sequence: number;
  state?: Module10LifecycleState;
  factKey: Module10LifecycleFactKey;
  fact: Record<string, unknown>;
}

export function eventReference(event: SystemEventRecord): LifecycleEventReference {
  return { eventId: event.id, sequence: event.sequence, timestamp: event.timestamp };
}

/** Maps only verified event contracts. Unknown and non-final transcript events are ignored. */
export function mapLifecycleEvent(
  event: SystemEventRecord,
  logger?: Module10LifecycleDiagnosticLogger,
): MappedLifecycleEvent | null {
  const emergencyId = typeof event.emergencyId === 'string' ? event.emergencyId : '';
  if (!emergencyId || emergencyId.trim() !== emergencyId) {
    logger?.warn(
      { eventId: event.id, eventType: event.type, sequence: event.sequence },
      'Module 10 lifecycle projection ignored event without canonical emergencyId',
    );
    return null;
  }
  if (!event.id || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return null;

  const payload = asRecord(event.payload);
  if (!payload) return null;
  const payloadEmergencyIdRequired = PAYLOAD_EMERGENCY_ID_REQUIRED.has(event.type);
  if (
    (payloadEmergencyIdRequired && payload.emergencyId !== emergencyId) ||
    (typeof payload.emergencyId === 'string' && payload.emergencyId !== emergencyId)
  ) {
    logger?.warn(
      { eventId: event.id, emergencyId, payloadEmergencyId: payload.emergencyId },
      'Module 10 lifecycle projection ignored event with missing or conflicting emergencyId',
    );
    return null;
  }
  const base = { emergencyId, eventId: event.id, sequence: event.sequence };

  switch (event.type) {
    case 'EMERGENCY_CREATED': {
      if (!isIncidentType(payload.incidentType) || !isString(payload.severity) || typeof payload.isSimulation !== 'boolean') return null;
      return { ...base, state: 'EMERGENCY_CREATED', factKey: 'emergencyCreated', fact: {
        incidentType: payload.incidentType, severity: payload.severity, isSimulation: payload.isSimulation,
      } };
    }
    case 'CALL_CONNECTED': {
      if (!isString(payload.callSessionId) || !isString(payload.channel) || !isString(payload.provider) ||
          !isString(payload.transport) || typeof payload.isLiveTransport !== 'boolean') return null;
      return { ...base, state: 'CALL_CONNECTED', factKey: 'callConnected', fact: {
        callSessionId: payload.callSessionId, isLiveTransport: payload.isLiveTransport,
      } };
    }
    case 'TRANSCRIPT_UPDATED': {
      if (payload.isFinal !== true) return null;
      if (!isString(payload.transcriptId) || !isString(payload.speaker) || !Number.isSafeInteger(payload.sequence)) return null;
      return { ...base, state: 'TRANSCRIPT_FINAL', factKey: 'finalTranscript', fact: {
        transcriptId: payload.transcriptId, sequence: payload.sequence, speaker: payload.speaker,
      } };
    }
    case 'NLP_EXTRACTION_COMPLETED': {
      if (!isString(payload.provider) || !isString(payload.model) || !isString(payload.incidentType) ||
          !isString(payload.severity) || typeof payload.confidence !== 'number' ||
          typeof payload.latencyMs !== 'number' || typeof payload.degraded !== 'boolean') return null;
      return { ...base, factKey: 'nlpExtraction', fact: {} };
    }
    case 'EMERGENCY_CLASSIFIED': {
      if (!isIncidentType(payload.incidentType) || !isString(payload.severity) || typeof payload.confidence !== 'number') return null;
      if (!['RULE', 'LLM', 'OPERATOR'].includes(String(payload.source))) return null;
      return { ...base, state: 'CLASSIFICATION_CONFIRMED', factKey: 'classification', fact: {
        incidentType: payload.incidentType, severity: payload.severity, confidence: payload.confidence,
        source: payload.source,
      } };
    }
    case 'AMBULANCE_ASSIGNED': {
      if (!isString(payload.assignmentId) || !isString(payload.ambulanceId)) return null;
      if (!['AUTOMATIC', 'MANUAL_OVERRIDE'].includes(String(payload.source))) return null;
      return { ...base, state: 'AMBULANCE_ASSIGNED', factKey: 'ambulanceAssignment', fact: {
        assignmentId: payload.assignmentId, ambulanceId: payload.ambulanceId, source: payload.source,
      } };
    }
    case 'AMBULANCE_DISPATCHED': {
      if (!isString(payload.ambulanceId)) return null;
      return { ...base, state: 'AMBULANCE_DISPATCHED', factKey: 'ambulanceDispatch', fact: { ambulanceId: payload.ambulanceId } };
    }
    case 'HOSPITAL_SELECTED': {
      if (!isString(payload.hospitalId)) return null;
      return { ...base, state: 'HOSPITAL_SELECTED', factKey: 'hospitalSelection', fact: { hospitalId: payload.hospitalId } };
    }
    case 'ROUTE_GENERATED': {
      if (!isString(payload.routeId) || !isString(payload.provider) || typeof payload.isLiveTraffic !== 'boolean') return null;
      return { ...base, state: 'ROUTE_GENERATED', factKey: 'route', fact: {
        routeId: payload.routeId, provider: payload.provider, isLiveTraffic: payload.isLiveTraffic,
      } };
    }
    case 'CORRIDOR_ACTIVATED': {
      if (!isString(payload.ambulanceId) || !isString(payload.hospitalId)) return null;
      return {
        ...base,
        state: 'CORRIDOR_ACTIVATED',
        factKey: 'corridor',
        fact: {
          ambulanceId: payload.ambulanceId,
          hospitalId: payload.hospitalId,
          simulationStatus: 'NOT_REPORTED_BY_EVENT',
          signalControlStatus: 'NOT_REPORTED_BY_EVENT',
        },
      };
    }
    case 'AMBULANCE_ARRIVED_SCENE': {
      if (!isString(payload.ambulanceId) || payload.evidenceSource !== 'OPERATOR_REPORTED' ||
          !isDataClassification(payload.dataClassification) || !isValidTimestamp(payload.observedAt) || typeof payload.responseTimeMin !== 'number' || payload.responseTimeMin < 0) return null;
      return { ...base, state: 'AMBULANCE_ARRIVED_SCENE', factKey: 'sceneArrival', fact: {
        ambulanceId: payload.ambulanceId, evidenceSource: 'OPERATOR_REPORTED', dataClassification: payload.dataClassification, observedAt: payload.observedAt, responseTimeMin: payload.responseTimeMin,
      } };
    }
    case 'PATIENT_ONBOARD': {
      if (!isString(payload.ambulanceId) || !(payload.hospitalId === null || isString(payload.hospitalId)) ||
          payload.evidenceSource !== 'OPERATOR_REPORTED' || !isDataClassification(payload.dataClassification) || !isValidTimestamp(payload.observedAt)) return null;
      return { ...base, state: 'PATIENT_ONBOARD', factKey: 'patientOnboard', fact: {
        ambulanceId: payload.ambulanceId, hospitalId: payload.hospitalId, evidenceSource: 'OPERATOR_REPORTED', dataClassification: payload.dataClassification, observedAt: payload.observedAt,
      } };
    }
    case 'AMBULANCE_ARRIVED_HOSPITAL': {
      if (!isString(payload.ambulanceId) || !isString(payload.hospitalId) || payload.evidenceSource !== 'OPERATOR_REPORTED' || !isDataClassification(payload.dataClassification) ||
          !isValidTimestamp(payload.observedAt)) return null;
      return { ...base, state: 'AMBULANCE_ARRIVED_HOSPITAL', factKey: 'hospitalArrival', fact: {
        ambulanceId: payload.ambulanceId, hospitalId: payload.hospitalId, evidenceSource: 'OPERATOR_REPORTED', dataClassification: payload.dataClassification, observedAt: payload.observedAt,
      } };
    }
    case 'EMERGENCY_COMPLETED': {
      if (!isString(payload.emergencyId) || !isNumberAtLeastZero(payload.totalDurationMin) || payload.status !== 'COMPLETED' ||
          typeof payload.isSimulation !== 'boolean' || payload.evidenceSource !== 'OPERATOR_REPORTED' || !isValidTimestamp(payload.observedAt)) return null;
      if (!isDataClassification(payload.dataClassification)) return null;
      return { ...base, state: 'OPERATIONAL_COMPLETION_RECORDED', factKey: 'operationalCompletion', fact: {
        status: 'COMPLETED', totalDurationMin: payload.totalDurationMin, isSimulation: payload.isSimulation,
        evidenceSource: 'OPERATOR_REPORTED', dataClassification: payload.dataClassification, observedAt: payload.observedAt,
      } };
    }
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNumberAtLeastZero(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isDataClassification(value: unknown): value is 'OPERATIONAL' | 'SIMULATION' | 'TEST' {
  return value === 'OPERATIONAL' || value === 'SIMULATION' || value === 'TEST';
}

function isIncidentType(value: unknown): value is IncidentType {
  return typeof value === 'string' && (INCIDENT_TYPES as readonly string[]).includes(value);
}
