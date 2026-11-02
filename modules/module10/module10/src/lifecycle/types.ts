import type { IncidentType, Logger, SystemEventRecord } from '@resus/core';

export type Module10LifecycleState =
  | 'NO_LIFECYCLE_EVENT'
  | 'EMERGENCY_CREATED'
  | 'CALL_CONNECTED'
  | 'TRANSCRIPT_FINAL'
  | 'CLASSIFICATION_CONFIRMED'
  | 'AMBULANCE_ASSIGNED'
  | 'AMBULANCE_DISPATCHED'
  | 'HOSPITAL_SELECTED'
  | 'ROUTE_GENERATED'
  | 'CORRIDOR_ACTIVATED'
  | 'AMBULANCE_ARRIVED_SCENE'
  | 'PATIENT_ONBOARD'
  | 'AMBULANCE_ARRIVED_HOSPITAL'
  | 'OPERATIONAL_COMPLETION_RECORDED';

export type Module10LifecycleFactKey =
  | 'emergencyCreated'
  | 'callConnected'
  | 'finalTranscript'
  | 'nlpExtraction'
  | 'classification'
  | 'ambulanceAssignment'
  | 'ambulanceDispatch'
  | 'hospitalSelection'
  | 'route'
  | 'corridor'
  | 'sceneArrival'
  | 'patientOnboard'
  | 'hospitalArrival'
  | 'operationalCompletion';

export interface LifecycleEventReference {
  eventId: string;
  sequence: number;
  timestamp: string;
}

interface LifecycleFactBase {
  event: LifecycleEventReference;
}

export interface Module10LifecycleFacts {
  emergencyCreated?: LifecycleFactBase & {
    incidentType: IncidentType;
    severity: string;
    isSimulation: boolean;
  };
  callConnected?: LifecycleFactBase & {
    callSessionId: string;
    isLiveTransport: boolean;
  };
  finalTranscript?: LifecycleFactBase & {
    transcriptId: string;
    sequence: number;
    speaker: string;
  };
  /** Extraction is advisory input only; it is not normalized classification. */
  nlpExtraction?: LifecycleFactBase;
  classification?: LifecycleFactBase & {
    incidentType: IncidentType;
    severity: string;
    confidence: number;
    source: 'RULE' | 'LLM' | 'OPERATOR';
  };
  ambulanceAssignment?: LifecycleFactBase & {
    assignmentId: string;
    ambulanceId: string;
    source: 'AUTOMATIC' | 'MANUAL_OVERRIDE';
  };
  ambulanceDispatch?: LifecycleFactBase & { ambulanceId: string };
  hospitalSelection?: LifecycleFactBase & { hospitalId: string };
  route?: LifecycleFactBase & {
    routeId: string;
    provider: string;
    isLiveTraffic: boolean;
  };
  corridor?: LifecycleFactBase & {
    ambulanceId: string;
    hospitalId: string;
    /** CORRIDOR_ACTIVATED does not report simulation or signal-control status. */
    simulationStatus: 'NOT_REPORTED_BY_EVENT';
    signalControlStatus: 'NOT_REPORTED_BY_EVENT';
  };
  sceneArrival?: LifecycleFactBase & { ambulanceId: string; evidenceSource: 'OPERATOR_REPORTED'; dataClassification: 'OPERATIONAL' | 'SIMULATION' | 'TEST'; observedAt: string; responseTimeMin: number };
  patientOnboard?: LifecycleFactBase & { ambulanceId: string; hospitalId: string | null; evidenceSource: 'OPERATOR_REPORTED'; dataClassification: 'OPERATIONAL' | 'SIMULATION' | 'TEST'; observedAt: string };
  hospitalArrival?: LifecycleFactBase & { ambulanceId: string; hospitalId: string; evidenceSource: 'OPERATOR_REPORTED'; dataClassification: 'OPERATIONAL' | 'SIMULATION' | 'TEST'; observedAt: string };
  operationalCompletion?: LifecycleFactBase & { status: 'COMPLETED'; isSimulation: boolean; evidenceSource: 'OPERATOR_REPORTED'; dataClassification: 'OPERATIONAL' | 'SIMULATION' | 'TEST'; observedAt: string; totalDurationMin: number };
}

export interface Module10LifecycleAnomaly {
  code: 'MISSING_PREDECESSOR';
  eventId: string;
  missingFact: 'route' | 'ambulanceDispatch' | 'sceneArrival' | 'patientOnboard' | 'hospitalArrival';
}

/** Read-only operational projection; identity is always Module 11's emergencyId. */
export interface Module10LifecycleProjection {
  emergencyId: string;
  state: Module10LifecycleState;
  facts: Module10LifecycleFacts;
  /** Persisted event IDs support delivery deduplication. */
  processedEventIds: string[];
  lastEventId: string;
  lastSequence: number;
  anomalies: Module10LifecycleAnomaly[];
}

export type Module10LifecycleDiagnosticLogger = Pick<Logger, 'warn'>;

export type Module10LifecycleEvent = SystemEventRecord;
