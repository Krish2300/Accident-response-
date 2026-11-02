import { EMERGENCY_SEVERITIES, INCIDENT_TYPES } from '@resus/core';

export const API_BASE = '/api';

export { EMERGENCY_SEVERITIES, INCIDENT_TYPES };
export type NormalizedIncidentType = (typeof INCIDENT_TYPES)[number];
export type NormalizedSeverity = (typeof EMERGENCY_SEVERITIES)[number];

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: string;
}

export interface LoginResponse {
  token: string;
  user: AuthenticatedUser;
}

export interface LiveEmergency {
  id: string;
  status: string;
  incidentType: string;
  severity: string;
  createdAt: string;
  isSimulation: boolean;
}

/** Authenticated Module 12 fleet read model. Coordinates and location time are nullable. */
export interface LiveAmbulance {
  id: string;
  vehicleNumber: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  lastLocationUpdate: string | null;
  currentEmergencyId: string | null;
  isSimulation: boolean;
  crewCount: number;
  equipment: string[];
}

export interface PersistedTranscript {
  id: string;
  sequence: number;
  speaker: string;
  text: string;
  isFinal: boolean;
  recordedAt: string;
}

/** Module 3 vocabulary is advisory and intentionally distinct from core enums. */
export interface NlpCandidate {
  emergencyId: string;
  sessionId: string;
  provider: string;
  model: string;
  category: string;
  severityLevel: string;
  severityScore: number;
  confidence: number;
  cprRequired: boolean;
  degraded: boolean;
  latencyMs: number;
  extractedAt: string;
  warnings: string[];
}

export interface ConfirmedClassification {
  id: string;
  incidentType: NormalizedIncidentType;
  severity: NormalizedSeverity;
  status: string;
}

export interface EmergencyDispatchDetails {
  id: string;
  latitude: number;
  longitude: number;
  status: string;
  assignedAmbulanceId: string | null;
}

export interface EmergencyTimelineEvent {
  id: string;
  sequence: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

/** One durable Module 11 operational event as returned by the authenticated event log. */
export interface OperationalEvent {
  id: string;
  sequence: number;
  type: 'HOSPITAL_RESOURCE_UPDATED' | 'ROUTE_RECALCULATED';
  emergencyId: string | null;
  entityType: string | null;
  entityId: string | null;
  timestamp: string;
  actorType: string | null;
  actorId: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
}

/**
 * The two Module 7/8 operational event types. Module 10 lifecycle history is a
 * separate projection: these events are durable operational history only.
 */
export const OPERATIONAL_EVENT_TYPES = ['HOSPITAL_RESOURCE_UPDATED', 'ROUTE_RECALCULATED'] as const;

export interface PlannedRoute {
  id: string;
  emergencyId: string;
  ambulanceId: string;
  hospitalId: string | null;
  originName: string;
  destinationName: string;
  distanceKm: number;
  estimatedMinutes: number | null;
  provider: string;
  isLiveTraffic: boolean;
  isSimulation: boolean;
  polyline: Array<[number, number]>;
}

export interface DriverAssignmentSnapshot {
  assigned: boolean;
  ambulance: (LiveAmbulance & { currentEmergencyId?: string | null }) | null;
  assignment: {
    id: string;
    emergencyId: string;
    status: string;
    expiresAt?: string | null;
  } | null;
}

export async function getDriverAssignment(token: string, signal?: AbortSignal): Promise<DriverAssignmentSnapshot> {
  return request<DriverAssignmentSnapshot>('/drivers/me/assignment', { token, ...(signal ? { signal } : {}) });
}

export async function decideDriverAssignment(token: string, assignmentId: string, decision: 'accept' | 'decline'): Promise<void> {
  await request(`/drivers/me/assignment/${encodeURIComponent(assignmentId)}/${decision}`, {
    method: 'POST', token, body: decision === 'decline' ? { reason: 'Declined in driver web portal' } : {},
  });
}

export async function getDriverRoutes(token: string, signal?: AbortSignal): Promise<{ emergencyId?: string; ambulanceId?: string; routes: PlannedRoute[] }> {
  return request('/drivers/me/routes', { token, ...(signal ? { signal } : {}) });
}

export interface PoliceRouteNotice {
  id: string;
  emergencyId: string;
  audience: string;
  status: string;
  provider: string;
  delivered: boolean;
  body: string;
  createdAt: string;
}

export interface CallerLocationEvent {
  id: string;
  sequence: number;
  type: 'EMERGENCY_LOCATION_CANDIDATE' | 'EMERGENCY_LOCATION_CONFIRMED';
  emergencyId: string;
  timestamp: string;
  actorId: string | null;
  payload: Record<string, unknown>;
}

export async function getCallerLocationResolutions(token: string, emergencyId: string, signal?: AbortSignal): Promise<CallerLocationEvent[]> {
  const result = await request<{ items?: CallerLocationEvent[] }>(`/emergencies/${encodeURIComponent(emergencyId)}/location-resolutions`, { token, ...(signal ? { signal } : {}) });
  if (!result || !Array.isArray(result.items)) throw new ApiError(502, 'INVALID_RESPONSE', 'Caller location resolution history was incomplete.');
  return result.items;
}

export async function retryCallerLocationResolution(token: string, emergencyId: string, resolutionId: string): Promise<CallerLocationEvent> {
  const result = await request<{ item?: CallerLocationEvent }>(`/emergencies/${encodeURIComponent(emergencyId)}/location-resolutions/${encodeURIComponent(resolutionId)}/retry`, { method: 'POST', token, body: {} });
  if (!result?.item || result.item.type !== 'EMERGENCY_LOCATION_CANDIDATE') throw new ApiError(502, 'INVALID_RESPONSE', 'The server did not return a caller location retry result.');
  return result.item;
}

export async function confirmCallerLocation(token: string, emergencyId: string, resolutionId: string, coordinates: { latitude: number; longitude: number }): Promise<void> {
  const result = await request<{ duplicate?: boolean; emergency?: { latitude: number; longitude: number }; event?: CallerLocationEvent }>(`/emergencies/${encodeURIComponent(emergencyId)}/location-resolutions/${encodeURIComponent(resolutionId)}/confirm`, { method: 'POST', token, body: coordinates });
  if (!result?.emergency || result.emergency.latitude !== coordinates.latitude || result.emergency.longitude !== coordinates.longitude || result.event?.type !== 'EMERGENCY_LOCATION_CONFIRMED') {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The server did not confirm the selected coordinates.');
  }
}

export interface LifecycleFactBase {
  event: { eventId: string; sequence: number; timestamp: string };
}

export interface LifecycleProjection {
  emergencyId: string;
  state: string;
  facts: {
    emergencyCreated?: LifecycleFactBase & { incidentType: string; severity: string; isSimulation: boolean };
    callConnected?: LifecycleFactBase & { callSessionId: string; isLiveTransport: boolean };
    finalTranscript?: LifecycleFactBase & { transcriptId: string; sequence: number; speaker: string };
    nlpExtraction?: LifecycleFactBase;
    classification?: LifecycleFactBase & {
      incidentType: string; severity: string; confidence: number; source: 'RULE' | 'LLM' | 'OPERATOR';
    };
    ambulanceAssignment?: LifecycleFactBase & {
      assignmentId: string; ambulanceId: string; source: 'AUTOMATIC' | 'MANUAL_OVERRIDE';
    };
    ambulanceDispatch?: LifecycleFactBase & { ambulanceId: string };
    hospitalSelection?: LifecycleFactBase & { hospitalId: string };
    route?: LifecycleFactBase & { routeId: string; provider: string; isLiveTraffic: boolean };
    corridor?: LifecycleFactBase & {
      ambulanceId: string;
      hospitalId: string;
      simulationStatus: 'NOT_REPORTED_BY_EVENT';
      signalControlStatus: 'NOT_REPORTED_BY_EVENT';
    };
    sceneArrival?: LifecycleFactBase & { ambulanceId: string; evidenceSource: 'OPERATOR_REPORTED'; dataClassification: 'OPERATIONAL' | 'SIMULATION' | 'TEST'; observedAt: string; responseTimeMin: number };
    patientOnboard?: LifecycleFactBase & { ambulanceId: string; hospitalId: string | null; evidenceSource: 'OPERATOR_REPORTED'; dataClassification: 'OPERATIONAL' | 'SIMULATION' | 'TEST'; observedAt: string };
    hospitalArrival?: LifecycleFactBase & { ambulanceId: string; hospitalId: string; evidenceSource: 'OPERATOR_REPORTED'; dataClassification: 'OPERATIONAL' | 'SIMULATION' | 'TEST'; observedAt: string };
    operationalCompletion?: LifecycleFactBase & { status: 'COMPLETED'; isSimulation: boolean; evidenceSource: 'OPERATOR_REPORTED'; dataClassification: 'OPERATIONAL' | 'SIMULATION' | 'TEST'; observedAt: string; totalDurationMin: number };
  };
}

export type LifecycleMilestone = 'scene-arrival' | 'patient-onboard' | 'hospital-arrival' | 'operational-completion';
export interface LifecycleMilestoneResponse {
  event: { id: string; type: string; timestamp: string };
  duplicate: boolean;
  evidenceSource: 'OPERATOR_REPORTED';
  operationalOnly: true;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorPayload = payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
    throw new ApiError(
      response.status,
      typeof errorPayload?.code === 'string' ? errorPayload.code : 'HTTP_ERROR',
      typeof errorPayload?.message === 'string' ? errorPayload.message : `Request failed (${response.status}).`,
    );
  }
  return payload as T;
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } }).then((result) => {
    if (!result || typeof result.token !== 'string' || !result.user || typeof result.user.role !== 'string') {
      throw new ApiError(502, 'INVALID_RESPONSE', 'The login response was incomplete.');
    }
    return result;
  });
}

export async function getLiveEmergencies(token: string): Promise<LiveEmergency[]> {
  const live = await request<{ emergencies?: LiveEmergency[] }>('/dashboard/live', { token });
  if (!live || !Array.isArray(live.emergencies)) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The live dashboard response did not contain an emergency list.');
  }
  return live.emergencies;
}

export async function getLiveAmbulances(token: string, signal?: AbortSignal): Promise<LiveAmbulance[]> {
  const live = await request<{ ambulances?: LiveAmbulance[] }>('/dashboard/ambulances', {
    token,
    ...(signal ? { signal } : {}),
  });
  if (!live || !Array.isArray(live.ambulances)) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The fleet response did not contain an ambulance list.');
  }
  return live.ambulances;
}

export async function getLifecycle(
  token: string,
  emergencyId: string,
  signal?: AbortSignal,
): Promise<LifecycleProjection> {
  const result = await request<{ projection?: LifecycleProjection }>(
    `/emergencies/${encodeURIComponent(emergencyId)}/lifecycle`,
    { token, ...(signal ? { signal } : {}) },
  );
  if (!result || !result.projection) throw new ApiError(502, 'INVALID_RESPONSE', 'The lifecycle response did not contain a projection.');
  return result.projection;
}

export async function recordLifecycleMilestone(
  token: string,
  emergencyId: string,
  milestone: LifecycleMilestone,
): Promise<LifecycleMilestoneResponse> {
  return request<LifecycleMilestoneResponse>(
    `/emergencies/${encodeURIComponent(emergencyId)}/lifecycle-milestones/${milestone}`,
    { method: 'POST', token, body: {} },
  );
}

export async function getEmergencyTranscripts(token: string, emergencyId: string, signal?: AbortSignal): Promise<PersistedTranscript[]> {
  const result = await request<{ emergencyId?: string; transcripts?: PersistedTranscript[] }>(
    `/emergencies/${encodeURIComponent(emergencyId)}/transcripts`,
    { token, ...(signal ? { signal } : {}) },
  );
  if (!result || result.emergencyId !== emergencyId || !Array.isArray(result.transcripts)) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The transcript response was incomplete.');
  }
  return result.transcripts;
}

export async function extractNlpCandidate(token: string, emergencyId: string, signal?: AbortSignal): Promise<NlpCandidate> {
  const result = await request<{ emergencyId?: string; extraction?: NlpCandidate }>(
    `/emergencies/${encodeURIComponent(emergencyId)}/classify`,
    { method: 'POST', token, body: {}, ...(signal ? { signal } : {}) },
  );
  if (!result || result.emergencyId !== emergencyId || !result.extraction) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The candidate extraction response was incomplete.');
  }
  return result.extraction;
}

export async function submitOperatorClassification(
  token: string,
  emergencyId: string,
  classification: { incidentType: NormalizedIncidentType; severity: NormalizedSeverity },
): Promise<ConfirmedClassification> {
  const result = await request<ConfirmedClassification>(`/emergencies/${encodeURIComponent(emergencyId)}`, {
    method: 'PATCH',
    token,
    body: { normalizedClassification: classification },
  });
  if (!result || result.id !== emergencyId || result.incidentType !== classification.incidentType || result.severity !== classification.severity) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The server did not confirm the selected classification.');
  }
  return result;
}

export async function getEmergencyDispatchDetails(token: string, emergencyId: string, signal?: AbortSignal): Promise<EmergencyDispatchDetails> {
  return request<EmergencyDispatchDetails>(`/emergencies/${encodeURIComponent(emergencyId)}`, { token, ...(signal ? { signal } : {}) });
}

export async function getEmergencyTimeline(token: string, emergencyId: string, signal?: AbortSignal): Promise<EmergencyTimelineEvent[]> {
  const types = ['AMBULANCE_ASSIGNED', 'AMBULANCE_ASSIGNMENT_OFFERED', 'AMBULANCE_ASSIGNMENT_ACCEPTED', 'AMBULANCE_ASSIGNMENT_DECLINED', 'AMBULANCE_ASSIGNMENT_EXPIRED', 'AMBULANCE_DISPATCHED'];
  const items: EmergencyTimelineEvent[] = [];
  let offset = 0;
  let total = 0;
  do {
    const query = new URLSearchParams({ emergencyId, types: types.join(','), limit: '500', offset: String(offset) });
    const page = await request<{ items?: EmergencyTimelineEvent[]; total?: number }>(`/events?${query.toString()}`, { token, ...(signal ? { signal } : {}) });
    if (!page || !Array.isArray(page.items) || typeof page.total !== 'number') throw new ApiError(502, 'INVALID_RESPONSE', 'The emergency event response was incomplete.');
    items.push(...page.items);
    total = page.total;
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);
  return items.sort((left, right) => left.sequence - right.sequence);
}

export async function getOperationalEvents(
  token: string,
  options: { limit?: number; emergencyId?: string; entityId?: string; signal?: AbortSignal } = {},
): Promise<OperationalEvent[]> {
  const query = new URLSearchParams({
    types: OPERATIONAL_EVENT_TYPES.join(','),
    limit: String(options.limit ?? 50),
  });
  if (options.emergencyId) query.set('emergencyId', options.emergencyId);
  if (options.entityId) query.set('entityId', options.entityId);
  const page = await request<{ items?: OperationalEvent[] }>(`/events?${query.toString()}`, {
    token,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!page || !Array.isArray(page.items)) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The operational event response was incomplete.');
  }
  return page.items.slice().sort((left, right) => right.sequence - left.sequence);
}

export async function getEmergencyRoutes(token: string, emergencyId: string, signal?: AbortSignal): Promise<PlannedRoute[]> {
  const result = await request<{ routes?: PlannedRoute[] }>(`/emergencies/${encodeURIComponent(emergencyId)}/routes`, { token, ...(signal ? { signal } : {}) });
  if (!result || !Array.isArray(result.routes)) throw new ApiError(502, 'INVALID_RESPONSE', 'The route response was incomplete.');
  return result.routes;
}

export async function generateResponseRoute(token: string, emergencyId: string): Promise<PlannedRoute> {
  const result = await request<{ route?: PlannedRoute }>(`/emergencies/${encodeURIComponent(emergencyId)}/routes`, { method: 'POST', token, body: { leg: 'RESPONSE' } });
  if (!result?.route) throw new ApiError(502, 'INVALID_RESPONSE', 'The route operation did not return a persisted route.');
  return result.route;
}

export async function getPoliceRouteNotices(token: string, emergencyId: string, signal?: AbortSignal): Promise<PoliceRouteNotice[]> {
  const result = await request<{ notifications?: PoliceRouteNotice[] }>(`/emergencies/${encodeURIComponent(emergencyId)}/police-notifications`, { token, ...(signal ? { signal } : {}) });
  if (!result || !Array.isArray(result.notifications)) throw new ApiError(502, 'INVALID_RESPONSE', 'The simulated notice response was incomplete.');
  return result.notifications;
}

export async function createPoliceRouteNotice(token: string, emergencyId: string, routeId: string): Promise<PoliceRouteNotice> {
  const result = await request<{ notification?: PoliceRouteNotice }>(`/emergencies/${encodeURIComponent(emergencyId)}/police-notifications`, { method: 'POST', token, body: { routeId } });
  if (!result?.notification) throw new ApiError(502, 'INVALID_RESPONSE', 'The simulated notice response was incomplete.');
  return result.notification;
}

export async function acknowledgePoliceRouteNotice(token: string, emergencyId: string, notificationId: string): Promise<PoliceRouteNotice> {
  const result = await request<{ notification?: PoliceRouteNotice }>(`/emergencies/${encodeURIComponent(emergencyId)}/police-notifications/${encodeURIComponent(notificationId)}/acknowledge`, { method: 'POST', token, body: {} });
  if (!result?.notification) throw new ApiError(502, 'INVALID_RESPONSE', 'The simulated acknowledgement response was incomplete.');
  return result.notification;
}

export async function assignNearestAmbulance(token: string, input: { emergencyId: string; latitude: number; longitude: number }): Promise<void> {
  await request('/ambulances/assign', { method: 'POST', token, body: input });
}

export async function dispatchAmbulance(token: string, ambulanceId: string, emergencyId: string): Promise<void> {
  await request(`/ambulances/${encodeURIComponent(ambulanceId)}/dispatch`, { method: 'POST', token, body: { emergencyId } });
}

export type OutcomeAccessCapability = 'SUBMIT' | 'REVIEW';

/** One current grant row as returned by the ADMIN outcome-grant endpoints. */
export interface OutcomeGrant {
  id: string;
  emergencyId: string;
  granteeUserId: string;
  capability: OutcomeAccessCapability;
  grantedByUserId: string;
  createdAt: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
}

/** One durable Module 11 grant lifecycle audit event. */
export interface OutcomeGrantEvent {
  id: string;
  sequence: number;
  type: 'OUTCOME_GRANTED' | 'OUTCOME_GRANT_REVOKED';
  emergencyId: string | null;
  entityType: string | null;
  entityId: string | null;
  timestamp: string;
  actorType: string | null;
  actorId: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
}

export async function getOutcomeGrants(token: string, emergencyId: string, signal?: AbortSignal): Promise<OutcomeGrant[]> {
  const result = await request<{ emergencyId?: string; items?: OutcomeGrant[] }>(
    `/emergencies/${encodeURIComponent(emergencyId)}/outcome-grants`,
    { token, ...(signal ? { signal } : {}) },
  );
  if (!result || result.emergencyId !== emergencyId || !Array.isArray(result.items)) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The outcome grant list response was incomplete.');
  }
  return result.items;
}

export async function grantOutcomeCapability(
  token: string,
  emergencyId: string,
  input: { granteeUserId: string; capability: OutcomeAccessCapability },
): Promise<OutcomeGrant> {
  const result = await request<OutcomeGrant>(`/emergencies/${encodeURIComponent(emergencyId)}/outcome-grants`, {
    method: 'POST',
    token,
    body: { granteeUserId: input.granteeUserId, capability: input.capability },
  });
  if (!result || typeof result.id !== 'string' || result.emergencyId !== emergencyId) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The grant response was incomplete.');
  }
  return result;
}

export async function revokeOutcomeGrant(
  token: string,
  emergencyId: string,
  grantId: string,
  revokeReason?: string,
): Promise<OutcomeGrant> {
  const trimmed = revokeReason?.trim();
  const result = await request<OutcomeGrant>(
    `/emergencies/${encodeURIComponent(emergencyId)}/outcome-grants/${encodeURIComponent(grantId)}`,
    { method: 'DELETE', token, ...(trimmed ? { body: { revokeReason: trimmed } } : {}) },
  );
  if (!result || typeof result.id !== 'string' || result.emergencyId !== emergencyId) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The revocation response was incomplete.');
  }
  return result;
}

export async function getOutcomeGrantEvents(token: string, emergencyId: string, signal?: AbortSignal): Promise<OutcomeGrantEvent[]> {
  const result = await request<{ emergencyId?: string; items?: OutcomeGrantEvent[]; total?: number }>(
    `/emergencies/${encodeURIComponent(emergencyId)}/outcome-grant-events?limit=50`,
    { token, ...(signal ? { signal } : {}) },
  );
  if (!result || result.emergencyId !== emergencyId || !Array.isArray(result.items)) {
    throw new ApiError(502, 'INVALID_RESPONSE', 'The grant audit history response was incomplete.');
  }
  return result.items;
}
