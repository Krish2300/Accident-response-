import type {
  AmbulanceStatus,
  AssignmentSource,
  CrewCapability,
  EmergencySeverity,
  EmergencyStatus,
  EquipmentCode,
  HospitalCapability,
  IncidentType,
  OutcomeStatus,
  ProtocolSessionStatus,
} from './enums.js';
import type { Coordinate } from '../geo.js';

export interface Emergency {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: EmergencyStatus;
  incidentType: IncidentType;
  severity: EmergencySeverity;
  latitude: number;
  longitude: number;
  description: string | null;
  callerId: string | null;
  assignedAmbulanceId: string | null;
  selectedHospitalId: string | null;
  isSimulation: boolean;
}

export interface Ambulance {
  id: string;
  vehicleNumber: string;
  status: AmbulanceStatus;
  latitude: number | null;
  longitude: number | null;
  lastLocationUpdate: string | null;
  equipment: EquipmentCode[];
  crew: AmbulanceCrewMember[];
  currentEmergencyId: string | null;
  assignedAt: string | null;
  availableAt: string | null;
  isSimulation: boolean;
  stationName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AmbulanceCrewMember {
  id: string;
  ambulanceId: string;
  name: string;
  role: string;
  capabilities: CrewCapability[];
  isOnDuty: boolean;
}

export interface AmbulanceLocation {
  id: string;
  ambulanceId: string;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
  recordedAt: string;
  source: string;
  isSimulation: boolean;
}

export interface AmbulanceAssignment {
  id: string;
  emergencyId: string;
  ambulanceId: string;
  status: 'ASSIGNED' | 'DECLINED' | 'CANCELLED';
  source: AssignmentSource;
  distanceKm: number;
  estimatedResponseTimeMin: number;
  score: number;
  matchingFactors: string[];
  rejectedReasons: Record<string, string>;
  overrideReason: string | null;
  decidedByUserId: string | null;
  decidedAt: string;
  createdAt: string;
}

export interface Hospital {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  status: 'OPEN' | 'BUSY' | 'DIVERTING' | 'CLOSED';
  capabilities: HospitalCapability[];
  traumaLevel: number;
  acceptingEmergencies: boolean;
  contactPhone: string | null;
  address: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProtocolSession {
  id: string;
  emergencyId: string;
  protocolId: string;
  protocolVersion: string;
  protocolSource: string;
  currentStep: string;
  status: ProtocolSessionStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  escalationRequired: boolean;
  escalationReason: string | null;
  clarificationCount: number;
  collectedFacts: Record<string, unknown>;
  initiatedBy: string;
}

export interface ProtocolStepRecord {
  id: string;
  protocolSessionId: string;
  stepId: string;
  orderIndex: number;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'SKIPPED';
  presentedAt: string | null;
  completedAt: string | null;
  result: Record<string, unknown> | null;
}

export interface Decision {
  id: string;
  emergencyId: string;
  decisionType: string;
  ambulanceId: string | null;
  hospitalId: string | null;
  optionsConsidered: unknown[];
  chosen: string;
  reasoning: string;
  confidence: number;
  actorType: string;
  actorId: string | null;
  createdAt: string;
}

export interface Outcome {
  id: string;
  emergencyId: string;
  status: OutcomeStatus;
  provenance: string;
  survivalToDischarge: boolean | null;
  notes: string | null;
  recordedAt: string;
  recordedByUserId: string | null;
}

export interface AmbulanceWithPosition extends Ambulance {
  position: Coordinate | null;
  etaMin: number | null;
}

export interface CallSession {
  id: string;
  emergencyId: string;
  channel: string;
  callerId: string | null;
  status: string;
  language: string;
  startedAt: string;
  endedAt: string | null;
  isSimulation: boolean;
}

export interface Transcript {
  id: string;
  callSessionId: string;
  emergencyId: string;
  sequence: number;
  speaker: string;
  text: string;
  isFinal: boolean;
  intent: string | null;
  confidence: number | null;
  recordedAt: string;
  isSimulation: boolean;
}
