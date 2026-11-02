import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, {
  CandidateReview,
  CallerLocationPanel,
  DispatchWorkflow,
  deriveAssignmentObservation,
  FleetPanel,
  LifecyclePanel,
  OperationalEventHistory,
  OperationalEventTable,
  OutcomeAccessSectionForRole,
  OutcomeAuditTable,
  OutcomeGrantTable,
  canManageOutcomeAccess,
  describeOperationalEvent,
  describeOutcomeGrantEvent,
  findPriorOutcomeGrant,
  canReviewClassification,
  createNonOverlappingRefresh,
  getLocationFreshness,
  initialOperatorClassificationState,
  operatorClassificationReducer,
  revokeOutcomeGrantAndReload,
  submitOutcomeGrantAndReload,
} from '../frontend/src/App';
import { DashboardRoutes } from '../frontend/src/DashboardRouter';
import {
  EMERGENCY_SEVERITIES,
  INCIDENT_TYPES,
  OPERATIONAL_EVENT_TYPES,
  extractNlpCandidate,
  getEmergencyTranscripts,
  getLifecycle,
  getCallerLocationResolutions,
  retryCallerLocationResolution,
  confirmCallerLocation,
  getLiveAmbulances,
  getLiveEmergencies,
  getEmergencyDispatchDetails,
  getEmergencyTimeline,
  getEmergencyRoutes,
  getDriverAssignment,
  getDriverRoutes,
  decideDriverAssignment,
  getOperationalEvents,
  getOutcomeGrantEvents,
  getOutcomeGrants,
  getPoliceRouteNotices,
  generateResponseRoute,
  createPoliceRouteNotice,
  acknowledgePoliceRouteNotice,
  grantOutcomeCapability,
  login,
  recordLifecycleMilestone,
  revokeOutcomeGrant,
  submitOperatorClassification,
  type LifecycleProjection,
  type NlpCandidate,
  type OperationalEvent,
  type OutcomeGrant,
  type OutcomeGrantEvent,
} from '../frontend/src/api';

afterEach(() => vi.unstubAllGlobals());

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Module 12 dashboard API client', () => {
  it('keeps /driver on the driver portal and / on the operations dashboard', () => {
    const renderAt = (location: string) => renderToStaticMarkup(React.createElement(
      StaticRouter,
      { location },
      React.createElement(DashboardRoutes),
    ));

    const driverHtml = renderAt('/driver');
    expect(driverHtml).toContain('RESUS Driver Portal');
    expect(driverHtml).toContain('Driver sign in');
    expect(driverHtml).not.toContain('Emergency Operations Dashboard');

    const dispatcherHtml = renderAt('/');
    expect(dispatcherHtml).toContain('Emergency Operations Dashboard');
    expect(dispatcherHtml).not.toContain('RESUS Driver Portal');
  });

  it('loads the authenticated driver offer and submits accept/reject decisions through Module 6', async () => {
    const assignment = { assigned: true, ambulance: { id: 'AMB-1', vehicleNumber: 'AMB-1' }, assignment: { id: 'ASG-1', emergencyId: 'EMG-1', status: 'OFFERED' } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(assignment))
      .mockResolvedValueOnce(response({ assignment: { ...assignment.assignment, status: 'ACCEPTED' } }))
      .mockResolvedValueOnce(response({ assignment: { ...assignment.assignment, status: 'DECLINED' } }))
      .mockResolvedValueOnce(response({ emergencyId: 'EMG-1', ambulanceId: 'AMB-1', routes: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDriverAssignment('driver-jwt')).resolves.toMatchObject({ assignment: { id: 'ASG-1', status: 'OFFERED' } });
    await decideDriverAssignment('driver-jwt', 'ASG/1', 'accept');
    await decideDriverAssignment('driver-jwt', 'ASG/1', 'decline');
    await expect(getDriverRoutes('driver-jwt')).resolves.toMatchObject({ emergencyId: 'EMG-1', routes: [] });

    const requestedUrls = fetchMock.mock.calls.map(([url]) => url);
    expect(requestedUrls).toEqual([
      '/api/drivers/me/assignment',
      '/api/drivers/me/assignment/ASG%2F1/accept',
      '/api/drivers/me/assignment/ASG%2F1/decline',
      '/api/drivers/me/routes',
    ]);
    expect(requestedUrls).not.toContain('/api/dashboard/live');
    expect(requestedUrls).not.toContain('/api/ambulances');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer driver-jwt' }, body: '{}' });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ reason: 'Declined in driver web portal' }) });
  });

  it('reads caller location provenance and sends explicit operator retry and confirmation actions', async () => {
    const candidate = { id: 'LOC-1', sequence: 1, type: 'EMERGENCY_LOCATION_CANDIDATE', emergencyId: 'EMG-1', timestamp: '2026-10-27T00:00:00.000Z', actorId: null, payload: { outcome: 'AMBIGUOUS' } };
    const confirmed = { id: 'LOCCONF-1', sequence: 2, type: 'EMERGENCY_LOCATION_CONFIRMED', emergencyId: 'EMG-1', timestamp: '2026-10-27T00:00:01.000Z', actorId: 'OP-1', payload: {} };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ emergencyId: 'EMG-1', items: [candidate] }))
      .mockResolvedValueOnce(response({ item: candidate }))
      .mockResolvedValueOnce(response({ emergency: { latitude: 10, longitude: 20 }, event: confirmed, duplicate: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCallerLocationResolutions('jwt', 'EMG-1')).resolves.toEqual([candidate]);
    await expect(retryCallerLocationResolution('jwt', 'EMG-1', 'LOC-1')).resolves.toEqual(candidate);
    await confirmCallerLocation('jwt', 'EMG-1', 'LOC-1', { latitude: 10, longitude: 20 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/emergencies/EMG-1/location-resolutions',
      '/api/emergencies/EMG-1/location-resolutions/LOC-1/retry',
      '/api/emergencies/EMG-1/location-resolutions/LOC-1/confirm',
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer jwt' } });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ latitude: 10, longitude: 20 }) });
  });

  it('renders the caller-location review as an explicit operator action', () => {
    const html = renderToStaticMarkup(React.createElement(CallerLocationPanel, { token: 'jwt', emergencyId: 'EMG-1' }));
    expect(html).toContain('Caller-stated location review');
    expect(html).toContain('Coordinates change only after an authenticated operator confirms them');
    expect(html).toContain('confirmation does not trigger dispatch or routing');
  });
  it('uses the existing login route and credential format without persisting the token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      token: 'ephemeral-jwt',
      user: { userId: 'USR-1', email: 'operator@example.test', role: 'OPERATOR' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await login('operator@example.test', 'existing-password');

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'operator@example.test', password: 'existing-password' }),
    }));
    expect(result.token).toBe('ephemeral-jwt');
    expect(result.user.role).toBe('OPERATOR');
  });

  it('loads Module 12 live emergencies and Module 10 lifecycle with the bearer token', async () => {
    const projection: LifecycleProjection = {
      emergencyId: 'EMG/1',
      state: 'ROUTE_GENERATED',
      facts: {},
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ emergencies: [{ id: 'EMG/1', status: 'OPEN' }] }))
      .mockResolvedValueOnce(response({ projection }));
    vi.stubGlobal('fetch', fetchMock);

    const emergencies = await getLiveEmergencies('ephemeral-jwt');
    const lifecycle = await getLifecycle('ephemeral-jwt', 'EMG/1');

    expect(emergencies).toEqual([{ id: 'EMG/1', status: 'OPEN' }]);
    expect(lifecycle).toEqual(projection);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/dashboard/live');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer ephemeral-jwt' } });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/emergencies/EMG%2F1/lifecycle');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { authorization: 'Bearer ephemeral-jwt' } });
  });

  it('preserves the backend not-found status and error envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      error: { code: 'NOT_FOUND', message: 'Lifecycle projection not found.' },
    }, 404)));

    await expect(getLifecycle('ephemeral-jwt', 'EMG-missing')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Lifecycle projection not found.',
    });
  });

  it('loads only from the persisted transcript endpoint and requests advisory extraction explicitly', async () => {
    const candidate: NlpCandidate = {
      emergencyId: 'EMG-1', sessionId: 'CALL-1', provider: 'local', model: 'candidate-v1',
      category: 'CARDIAC', severityLevel: 'P1', severityScore: 10, confidence: 0.9,
      cprRequired: true, degraded: false, latencyMs: 20,
      extractedAt: '2026-10-17T10:00:00.000Z', warnings: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ emergencyId: 'EMG-1', transcripts: [{ id: 'TR-1', sequence: 1, speaker: 'CALLER', text: 'help', isFinal: true, recordedAt: '2026-10-17T10:00:00.000Z' }] }))
      .mockResolvedValueOnce(response({ emergencyId: 'EMG-1', extraction: candidate }));
    vi.stubGlobal('fetch', fetchMock);

    const transcripts = await getEmergencyTranscripts('jwt', 'EMG-1');
    const extraction = await extractNlpCandidate('jwt', 'EMG-1');

    expect(transcripts[0]?.text).toBe('help');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/emergencies/EMG-1/transcripts');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer jwt' } });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/emergencies/EMG-1/classify');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{}', headers: { authorization: 'Bearer jwt' } });
    expect(extraction.category).toBe('CARDIAC');
  });

  it('submits only explicit normalized choices to the existing PATCH contract and surfaces API errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 'EMG-1', incidentType: 'TRAUMA', severity: 'HIGH', status: 'CLASSIFIED' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitOperatorClassification('jwt', 'EMG-1', { incidentType: 'TRAUMA', severity: 'HIGH' });

    expect(result).toMatchObject({ incidentType: 'TRAUMA', severity: 'HIGH' });
    expect(fetchMock).toHaveBeenCalledWith('/api/emergencies/EMG-1', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ normalizedClassification: { incidentType: 'TRAUMA', severity: 'HIGH' } }),
      headers: expect.objectContaining({ authorization: 'Bearer jwt' }),
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'NLP disabled' } }, 503)));
    await expect(extractNlpCandidate('jwt', 'EMG-1')).rejects.toMatchObject({ status: 503, code: 'PROVIDER_NOT_CONFIGURED' });
  });
});

describe('Module 12 operator review workflow', () => {
  it('shows Module 3 output as unconfirmed advisory candidate facts', () => {
    const candidate: NlpCandidate = {
      emergencyId: 'EMG-1', sessionId: 'CALL-1', provider: 'local', model: 'candidate-v1',
      category: 'CARDIAC', severityLevel: 'P1', severityScore: 10, confidence: 0.9,
      cprRequired: true, degraded: false, latencyMs: 20,
      extractedAt: '2026-10-17T10:00:00.000Z', warnings: ['Check caller location'],
    };
    const html = renderToStaticMarkup(React.createElement(CandidateReview, { candidate }));
    expect(html).toContain('Unconfirmed candidate');
    expect(html).toContain('Module 3 category');
    expect(html).toContain('CARDIAC');
    expect(html).toContain('P1');
    expect(html).toContain('not converted to repository enums');
    expect(INCIDENT_TYPES).toContain('CARDIAC_ARREST');
    expect(EMERGENCY_SEVERITIES).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  });

  it('requires explicit choices and confirmation, serializes submission and retains errors for correction', () => {
    let state = initialOperatorClassificationState;
    expect(canReviewClassification(state.incidentType, state.severity)).toBe(false);
    state = operatorClassificationReducer(state, { type: 'SELECT_INCIDENT', value: 'TRAUMA' });
    state = operatorClassificationReducer(state, { type: 'REVIEW' });
    expect(state.confirming).toBe(false);
    state = operatorClassificationReducer(state, { type: 'SELECT_SEVERITY', value: 'HIGH' });
    expect(canReviewClassification(state.incidentType, state.severity)).toBe(true);
    state = operatorClassificationReducer(state, { type: 'REVIEW' });
    expect(state.confirming).toBe(true);
    state = operatorClassificationReducer(state, { type: 'SUBMIT' });
    expect(state.pending).toBe(true);
    expect(operatorClassificationReducer(state, { type: 'SUBMIT' })).toBe(state);
    expect(operatorClassificationReducer(state, { type: 'SELECT_SEVERITY', value: 'LOW' })).toBe(state);
    state = operatorClassificationReducer(state, { type: 'FAILURE', message: 'Forbidden' });
    expect(state).toMatchObject({ pending: false, confirming: true, error: 'Forbidden' });
    state = operatorClassificationReducer(state, { type: 'SELECT_SEVERITY', value: 'MEDIUM' });
    expect(state).toMatchObject({ confirming: false, error: null, incidentType: 'TRAUMA', severity: 'MEDIUM' });
    state = operatorClassificationReducer(state, { type: 'REVIEW' });
    state = operatorClassificationReducer(state, { type: 'SUBMIT' });
    state = operatorClassificationReducer(state, { type: 'SUCCESS', result: { id: 'EMG-1', incidentType: 'TRAUMA', severity: 'MEDIUM', status: 'CLASSIFIED' } });
    expect(state).toMatchObject({ pending: false, confirming: false, confirmed: { incidentType: 'TRAUMA', severity: 'MEDIUM', status: 'CLASSIFIED' } });
  });
});

describe('Module 12 lifecycle panel', () => {
  it('starts with the existing-account sign-in form', () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain('Sign in with your existing operator account');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
  });

  it('shows observed milestones, missing milestones and verified traffic/corridor caveats', () => {
    const event = { eventId: 'EVT-1', sequence: 1, timestamp: '2026-10-17T10:00:00.000Z' };
    const projection: LifecycleProjection = {
      emergencyId: 'EMG-1',
      state: 'ROUTE_GENERATED',
      facts: {
        emergencyCreated: { event, incidentType: 'TRAUMA', severity: 'HIGH', isSimulation: true },
        classification: { event, incidentType: 'TRAUMA', severity: 'HIGH', confidence: 0.8, source: 'OPERATOR' },
        route: { event, routeId: 'RTE-1', provider: 'deterministic', isLiveTraffic: false },
        corridor: {
          event,
          ambulanceId: 'AMB-1',
          hospitalId: 'HSP-1',
          simulationStatus: 'NOT_REPORTED_BY_EVENT',
          signalControlStatus: 'NOT_REPORTED_BY_EVENT',
        },
      },
    };

    const html = renderToStaticMarkup(React.createElement(LifecyclePanel, {
      token: 'jwt', role: 'DISPATCHER', emergencyId: 'EMG-1', projection, loading: false, notFound: false, error: null,
    }));

    expect(html).toContain('Emergency created');
    expect(html).toContain('Observed');
    expect(html).toContain('Call connected');
    expect(html).toContain('Not observed');
    expect(html).toContain('Normalized classification confirmed');
    expect(html).toContain('Live traffic: no (isLiveTraffic=false; non-live traffic data)');
    expect(html).toContain('does not confirm real traffic-signal control');
    expect(html).toContain('successful real-world notification delivery');
    expect(html).not.toContain('transcript text');
  });

  it('renders loading, not-found, error and empty-projection states explicitly', () => {
    const render = (props: Parameters<typeof LifecyclePanel>[0]) =>
      renderToStaticMarkup(React.createElement(LifecyclePanel, props));

    expect(render({ token: 'jwt', role: 'OPERATOR', emergencyId: 'EMG-1', projection: null, loading: true, notFound: false, error: null }))
      .toContain('Loading lifecycle');
    expect(render({ token: 'jwt', role: 'OPERATOR', emergencyId: 'EMG-1', projection: null, loading: false, notFound: true, error: null }))
      .toContain('No lifecycle projection is available');
    expect(render({ token: 'jwt', role: 'OPERATOR', emergencyId: 'EMG-1', projection: null, loading: false, notFound: false, error: 'Service unavailable' }))
      .toContain('Service unavailable');
    expect(render({ token: 'jwt', role: 'OPERATOR', emergencyId: 'EMG-1', projection: null, loading: false, notFound: false, error: null }))
      .toContain('Lifecycle details have not loaded');
  });

  it('shows operator-reported milestone provenance and operational-only completion language', () => {
    const event = { eventId: 'EVT-2', sequence: 2, timestamp: '2026-10-17T10:30:00.000Z' };
    const projection: LifecycleProjection = {
      emergencyId: 'EMG-1', state: 'OPERATIONAL_COMPLETION_RECORDED', facts: {
        ambulanceDispatch: { event, ambulanceId: 'AMB-1' },
        sceneArrival: { event, ambulanceId: 'AMB-1', evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'TEST', observedAt: '2026-10-17T10:10:00.000Z', responseTimeMin: 10 },
        patientOnboard: { event, ambulanceId: 'AMB-1', hospitalId: 'HSP-1', evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'TEST', observedAt: '2026-10-17T10:15:00.000Z' },
        hospitalArrival: { event, ambulanceId: 'AMB-1', hospitalId: 'HSP-1', evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'TEST', observedAt: '2026-10-17T10:25:00.000Z' },
        operationalCompletion: { event, status: 'COMPLETED', totalDurationMin: 30, isSimulation: true, evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'TEST', observedAt: '2026-10-17T10:30:00.000Z' },
      },
    };
    const html = renderToStaticMarkup(React.createElement(LifecyclePanel, {
      token: 'jwt', role: 'DISPATCHER', emergencyId: 'EMG-1', projection, loading: false, notFound: false, error: null,
    }));
    expect(html).toContain('Operator-reported milestones');
    expect(html).toContain('OPERATOR_REPORTED');
    expect(html).toContain('They do not independently verify location');
    expect(html).toContain('does not establish survival');
    expect(html).toContain('Operational completion (operator reported)');
  });
});

describe('Module 12 lifecycle milestone API client', () => {
  it('uses the authenticated explicit operator-report endpoint and surfaces validation/authorization errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      event: { id: 'M10M-1', type: 'PATIENT_ONBOARD', timestamp: '2026-10-17T10:15:00.000Z' },
      duplicate: false, evidenceSource: 'OPERATOR_REPORTED', operationalOnly: true,
    }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await expect(recordLifecycleMilestone('jwt', 'EMG/1', 'patient-onboard')).resolves.toMatchObject({ duplicate: false, evidenceSource: 'OPERATOR_REPORTED' });
    expect(fetchMock).toHaveBeenCalledWith('/api/emergencies/EMG%2F1/lifecycle-milestones/patient-onboard', expect.objectContaining({
      method: 'POST', body: '{}', headers: expect.objectContaining({ authorization: 'Bearer jwt' }),
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'CONFLICT', message: 'Dispatch required' } }, 409)));
    await expect(recordLifecycleMilestone('jwt', 'EMG-1', 'scene-arrival')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403)));
    await expect(recordLifecycleMilestone('driver-jwt', 'EMG-1', 'scene-arrival')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('Module 12 authenticated fleet view', () => {
  const currentTime = Date.parse('2026-10-17T10:00:00.000Z');
  const ambulance = {
    id: 'AMB-1', vehicleNumber: 'KA-01-1234', status: 'EN_ROUTE',
    latitude: 12.9716, longitude: 77.5946,
    lastLocationUpdate: '2026-10-17T09:59:30.000Z',
    currentEmergencyId: 'EMG-1', isSimulation: false, crewCount: 2, equipment: [],
  };

  it('uses the existing authenticated Module 12 ambulance endpoint and validates its list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ambulances: [ambulance] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getLiveAmbulances('dispatcher-jwt')).resolves.toEqual([ambulance]);
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/ambulances', expect.objectContaining({
      headers: { accept: 'application/json', authorization: 'Bearer dispatcher-jwt' },
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403)));
    await expect(getLiveAmbulances('operator-jwt')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'UNAUTHORIZED', message: 'Sign in again' } }, 401)));
    await expect(getLiveAmbulances('expired-jwt')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('coalesces simultaneous manual and polling refreshes and permits a later refresh', async () => {
    let finish: ((value: string[]) => void) | undefined;
    const operation = vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve; }));
    const refresh = createNonOverlappingRefresh(operation);
    const first = refresh();
    const overlapping = refresh();
    expect(operation).toHaveBeenCalledTimes(1);
    finish?.(['AMB-1']);
    await expect(Promise.all([first, overlapping])).resolves.toEqual([['AMB-1'], ['AMB-1']]);

    const later = refresh();
    expect(operation).toHaveBeenCalledTimes(2);
    finish?.(['AMB-2']);
    await expect(later).resolves.toEqual(['AMB-2']);
  });

  it('distinguishes current, stale, missing and invalid timestamp data without treating zero coordinates as absent', () => {
    expect(getLocationFreshness(ambulance, currentTime)).toBe('CURRENT');
    expect(getLocationFreshness({ ...ambulance, lastLocationUpdate: '2026-10-17T09:57:59.000Z' }, currentTime)).toBe('STALE');
    expect(getLocationFreshness({ ...ambulance, latitude: null, longitude: null }, currentTime)).toBe('MISSING');
    expect(getLocationFreshness({ ...ambulance, latitude: 0, longitude: 0 }, currentTime)).toBe('CURRENT');
    expect(getLocationFreshness({ ...ambulance, lastLocationUpdate: 'not-a-time' }, currentTime)).toBe('UNKNOWN');
  });

  it('renders fleet status, assignment, coordinates, timestamp and stale/missing distinctions', () => {
    const html = renderToStaticMarkup(React.createElement(FleetPanel, {
      ambulances: [
        ambulance,
        { ...ambulance, id: 'AMB-2', vehicleNumber: 'KA-01-0002', status: 'AVAILABLE', currentEmergencyId: null, latitude: null, longitude: null, lastLocationUpdate: null },
        { ...ambulance, id: 'AMB-3', vehicleNumber: 'KA-01-0003', lastLocationUpdate: '2026-10-17T09:57:59.000Z' },
      ], loading: false, error: null, now: currentTime,
    }));

    expect(html).toContain('Ambulance fleet');
    expect(html).toContain('EN_ROUTE');
    expect(html).toContain('AVAILABLE');
    expect(html).toContain('EMG-1');
    expect(html).toContain('Unassigned');
    expect(html).toContain('12.9716, 77.5946');
    expect(html).toContain('Location unavailable');
    expect(html).toContain('No location update recorded');
    expect(html).toContain(new Date(ambulance.lastLocationUpdate).toLocaleString());
    expect(html).toContain('Current (updated within 2 minutes)');
    expect(html).toContain('Stale (last update over 2 minutes ago)');
    expect(html).toContain('Missing location data');
    expect(html).toContain('Refresh fleet');
  });

  it('renders loading, empty and API/authorization error states without hiding the fleet panel', () => {
    const render = (props: Parameters<typeof FleetPanel>[0]) => renderToStaticMarkup(React.createElement(FleetPanel, props));
    expect(render({ ambulances: [], loading: true, error: null })).toContain('Loading fleet');
    expect(render({ ambulances: [], loading: false, error: null })).toContain('No ambulances are available');
    expect(render({ ambulances: [], loading: false, error: 'Forbidden' })).toContain('Forbidden');
    expect(render({ ambulances: [ambulance], loading: false, error: 'Session expired' })).toContain('KA-01-1234');
    expect(render({ ambulances: [ambulance], loading: false, refreshing: true, error: null })).toContain('Refreshing…');
  });
});

describe('Module 12 dispatcher workflow client and projection', () => {
  it('uses the existing authenticated emergency, route, event and simulated notice APIs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: 'EMG-1', latitude: 12, longitude: 77, assignedAmbulanceId: 'AMB-1' }))
      .mockResolvedValueOnce(response({ items: [], total: 0 }))
      .mockResolvedValueOnce(response({ routes: [] }))
      .mockResolvedValueOnce(response({ notifications: [] }))
      .mockResolvedValueOnce(response({ emergencyId: 'EMG-1', outcome: 'GENERATED', route: { id: 'RTE-1' } }))
      .mockResolvedValueOnce(response({ emergencyId: 'EMG-1', notification: { id: 'NTF-1' } }))
      .mockResolvedValueOnce(response({ emergencyId: 'EMG-1', notification: { id: 'NTF-1', status: 'ACKNOWLEDGED_SIMULATED' } }));
    vi.stubGlobal('fetch', fetchMock);

    await getEmergencyDispatchDetails('jwt', 'EMG-1');
    await getEmergencyTimeline('jwt', 'EMG-1');
    await getEmergencyRoutes('jwt', 'EMG-1');
    await getPoliceRouteNotices('jwt', 'EMG-1');
    await generateResponseRoute('jwt', 'EMG-1');
    await createPoliceRouteNotice('jwt', 'EMG-1', 'RTE-1');
    await acknowledgePoliceRouteNotice('jwt', 'EMG-1', 'NTF-1');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/emergencies/EMG-1', expect.stringContaining('/api/events?'), '/api/emergencies/EMG-1/routes',
      '/api/emergencies/EMG-1/police-notifications', '/api/emergencies/EMG-1/routes',
      '/api/emergencies/EMG-1/police-notifications', '/api/emergencies/EMG-1/police-notifications/NTF-1/acknowledge',
    ]);
    for (const call of fetchMock.mock.calls) expect(call[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer jwt' }) });
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ leg: 'RESPONSE' }) });
  });

  it('shows only assignment decisions and dispatch events ordered after the current assignment', () => {
    const events = [
      { id: 'EVT-D-OLD', sequence: 2, type: 'AMBULANCE_DISPATCHED', timestamp: 'old', payload: { ambulanceId: 'AMB-1' } },
      { id: 'EVT-A', sequence: 3, type: 'AMBULANCE_ASSIGNED', timestamp: 'assigned', payload: { ambulanceId: 'AMB-1', assignmentId: 'ASG-2' } },
      { id: 'EVT-OFFER', sequence: 3.5, type: 'AMBULANCE_ASSIGNMENT_OFFERED', timestamp: 'offered', payload: { ambulanceId: 'AMB-1', assignmentId: 'ASG-2', expiresAt: '2026-10-27T12:01:00.000Z' } },
      { id: 'EVT-ACCEPT', sequence: 4, type: 'AMBULANCE_ASSIGNMENT_ACCEPTED', timestamp: 'accepted', payload: { ambulanceId: 'AMB-1', assignmentId: 'ASG-2' } },
    ];
    expect(deriveAssignmentObservation(events as never)).toMatchObject({ assignmentId: 'ASG-2', status: 'ACCEPTED', changedAt: 'accepted' });
    expect(deriveAssignmentObservation(events.slice(0, 2).concat(events[2]!) as never)).toMatchObject({ status: 'OFFERED', expiresAt: '2026-10-27T12:01:00.000Z' });
    events.push({ id: 'EVT-D-NEW', sequence: 5, type: 'AMBULANCE_DISPATCHED', timestamp: 'dispatched', payload: { ambulanceId: 'AMB-1' } });
    expect(deriveAssignmentObservation(events as never)).toMatchObject({ status: 'DISPATCHED' });
  });

  it('labels all generated notices as mock-only and does not imply real traffic or police contact', () => {
    const html = renderToStaticMarkup(React.createElement(DispatchWorkflow, { token: 'jwt', emergencyId: 'EMG-1' }));
    expect(html).toContain('explicit button');
    expect(html).toContain('No police recipient is contacted');
    expect(html).toContain('signals received priority');
  });
});

describe('Module 12 operational event history client and panel', () => {
  const hospitalEvent: OperationalEvent = {
    id: 'EVT-OPS-2',
    sequence: 12,
    type: 'HOSPITAL_RESOURCE_UPDATED',
    emergencyId: null,
    entityType: 'hospital',
    entityId: 'HSP-1',
    timestamp: '2026-10-17T10:05:00.000Z',
    actorType: 'DISPATCHER',
    actorId: 'USR-1',
    payload: { hospitalId: 'HSP-1', resourceType: 'ICU_BED', code: '', total: 12, available: 5 },
    metadata: null,
  };
  const routeEvent: OperationalEvent = {
    id: 'EVT-OPS-3',
    sequence: 20,
    type: 'ROUTE_RECALCULATED',
    emergencyId: 'EMG-1',
    entityType: 'route',
    entityId: 'RTE-1',
    timestamp: '2026-10-17T10:10:00.000Z',
    actorType: 'SYSTEM',
    actorId: null,
    payload: {
      routeId: 'RTE-1', emergencyId: 'EMG-1',
      previousDistanceKm: 2.6, distanceKm: 0.78,
      previousEstimatedMinutes: 39, estimatedMinutes: 11.7,
      reason: 'ambulance repositioned after traffic hold',
    },
    metadata: null,
  };

  it('queries the durable event log with both operational types and the bearer token', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(response({ items: [routeEvent, hospitalEvent], total: 2 })));
    vi.stubGlobal('fetch', fetchMock);

    const events = await getOperationalEvents('dispatcher-jwt');

    expect(OPERATIONAL_EVENT_TYPES).toEqual(['HOSPITAL_RESOURCE_UPDATED', 'ROUTE_RECALCULATED']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/events?types=HOSPITAL_RESOURCE_UPDATED%2CROUTE_RECALCULATED&limit=50');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer dispatcher-jwt' } });
    expect(events.map((event) => event.type)).toEqual(['ROUTE_RECALCULATED', 'HOSPITAL_RESOURCE_UPDATED']);

    const filtered = await getOperationalEvents('dispatcher-jwt', { entityId: 'HSP-1', limit: 10 });
    expect(filtered).toHaveLength(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/events?types=HOSPITAL_RESOURCE_UPDATED%2CROUTE_RECALCULATED&limit=10&entityId=HSP-1');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ items: null })));
    await expect(getOperationalEvents('dispatcher-jwt')).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403)));
    await expect(getOperationalEvents('driver-jwt')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('renders event type, timestamp, entity, actor and reason while separating history from Module 10 lifecycle', () => {
    const html = renderToStaticMarkup(React.createElement(OperationalEventTable, { events: [routeEvent, hospitalEvent] }));

    expect(html).toContain('ROUTE_RECALCULATED');
    expect(html).toContain('HOSPITAL_RESOURCE_UPDATED');
    expect(html).toContain('sequence 20');
    expect(html).toContain('2026-10-17T10:10:00.000Z');
    expect(html).toContain('route RTE-1');
    expect(html).toContain('hospital HSP-1');
    expect(html).toContain('None (system-wide)');
    expect(html).toContain('SYSTEM');
    expect(html).toContain('DISPATCHER · USR-1');
    expect(html).toContain('2.6 km → 0.78 km');
    expect(html).toContain('39 → 11.7 min');
    expect(html).toContain('ambulance repositioned after traffic hold');
    expect(html).toContain('ICU_BED · 5 of 12 available');
  });

  it('displays the real authenticated actor on recalculation events for each initiating role', () => {
    const dispatcherRecalc: OperationalEvent = { ...routeEvent, id: 'EVT-OPS-4', sequence: 21, actorType: 'DISPATCHER', actorId: 'USR-9' };
    const adminRecalc: OperationalEvent = { ...routeEvent, id: 'EVT-OPS-5', sequence: 22, actorType: 'ADMIN', actorId: 'USR-4' };
    const html = renderToStaticMarkup(React.createElement(OperationalEventTable, { events: [dispatcherRecalc, adminRecalc] }));
    expect(html).toContain('DISPATCHER · USR-9');
    expect(html).toContain('ADMIN · USR-4');
  });

  it('describes both operational event types from their durable payloads', () => {
    expect(describeOperationalEvent(hospitalEvent)).toBe('ICU_BED · 5 of 12 available');
    expect(describeOperationalEvent(routeEvent))
      .toBe('2.6 km → 0.78 km · 39 → 11.7 min · reason: ambulance repositioned after traffic hold');
    expect(describeOperationalEvent({ ...hospitalEvent, payload: { ...hospitalEvent.payload, code: 'ICU-A' } }))
      .toBe('ICU_BED/ICU-A · 5 of 12 available');
  });

  it('labels the panel as durable Module 11 history distinct from the Module 10 lifecycle and renders its states', () => {
    const render = (props: Parameters<typeof OperationalEventHistory>[0]) =>
      renderToStaticMarkup(React.createElement(OperationalEventHistory, props));

    const loadingHtml = render({ token: 'jwt' });
    expect(loadingHtml).toContain('Operational event history');
    expect(loadingHtml).toContain('Durable Module 11 event log');
    expect(loadingHtml).toContain('separate from the Module 10 observed lifecycle');
    expect(loadingHtml).toContain('not lifecycle milestones');
    expect(loadingHtml).toContain('Loading operational events');
    expect(loadingHtml).toContain('Refresh events');
  });
});

describe('Module 12 outcome access management client, role gate and panels', () => {
  const activeGrant: OutcomeGrant = {
    id: 'OGT-UI-1', emergencyId: 'EMG-1', granteeUserId: 'USR-2', capability: 'SUBMIT',
    grantedByUserId: 'USR-ADMIN', createdAt: '2026-10-21T10:00:00.000Z',
    revokedAt: null, revokedByUserId: null, revokeReason: null,
  };
  const revokedGrant: OutcomeGrant = {
    id: 'OGT-UI-0', emergencyId: 'EMG-1', granteeUserId: 'USR-2', capability: 'SUBMIT',
    grantedByUserId: 'USR-ADMIN', createdAt: '2026-10-21T09:00:00.000Z',
    revokedAt: '2026-10-21T09:30:00.000Z', revokedByUserId: 'USR-ADMIN', revokeReason: 'Rotating cover',
  };
  const grantedEvent: OutcomeGrantEvent = {
    id: 'EVT-G1', sequence: 3, type: 'OUTCOME_GRANTED', emergencyId: 'EMG-1',
    entityType: 'emergency_outcome_grant', entityId: 'OGT-UI-1',
    timestamp: '2026-10-21T10:00:00.000Z', actorType: 'OPERATOR', actorId: 'USR-ADMIN',
    payload: { contractVersion: 1, grantId: 'OGT-UI-1', granteeUserId: 'USR-2', capability: 'SUBMIT', action: 'GRANTED', active: true, reactivatedAt: null },
    metadata: null,
  };
  const reactivatedEvent: OutcomeGrantEvent = {
    ...grantedEvent, id: 'EVT-G2', sequence: 5, entityId: 'OGT-UI-1',
    timestamp: '2026-10-21T10:05:00.000Z',
    payload: { ...grantedEvent.payload, action: 'REACTIVATED', reactivatedAt: '2026-10-21T10:05:00.000Z' },
  };
  const revokedEvent: OutcomeGrantEvent = {
    id: 'EVT-G3', sequence: 4, type: 'OUTCOME_GRANT_REVOKED', emergencyId: 'EMG-1',
    entityType: 'emergency_outcome_grant', entityId: 'OGT-UI-0',
    timestamp: '2026-10-21T09:30:00.000Z', actorType: 'OPERATOR', actorId: 'USR-ADMIN',
    payload: { contractVersion: 1, grantId: 'OGT-UI-0', granteeUserId: 'USR-2', capability: 'SUBMIT', revokedAt: '2026-10-21T09:30:00.000Z', revokeReason: 'Rotating cover' },
    metadata: null,
  };

  function grantListResponse(items: OutcomeGrant[]) {
    return response({ emergencyId: 'EMG-1', items, total: items.length, limit: 50, offset: 0 });
  }
  function grantEventsResponse(items: OutcomeGrantEvent[]) {
    return response({ emergencyId: 'EMG-1', items, total: items.length, limit: 50, offset: 0 });
  }

  it('shows the grant-management interface only for ADMIN and never for other roles', () => {
    expect(canManageOutcomeAccess('ADMIN')).toBe(true);
    for (const role of ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'OUTCOME_SUBMITTER', 'OUTCOME_REVIEWER', 'DRIVER', '']) {
      expect(canManageOutcomeAccess(role)).toBe(false);
      const html = renderToStaticMarkup(React.createElement(OutcomeAccessSectionForRole, { role, token: 'jwt', emergencyId: 'EMG-1' }));
      expect(html).toBe('');
    }
    const adminHtml = renderToStaticMarkup(React.createElement(OutcomeAccessSectionForRole, {
      role: 'ADMIN', token: 'jwt', emergencyId: 'EMG-1',
    }));
    expect(adminHtml).toContain('Outcome Access Management');
    expect(adminHtml).toContain('ADMIN only');
    expect(adminHtml).toContain('Grantee user ID');
    expect(adminHtml).toContain('Loading outcome access grants');
    const noEmergencyHtml = renderToStaticMarkup(React.createElement(OutcomeAccessSectionForRole, {
      role: 'ADMIN', token: 'jwt', emergencyId: '',
    }));
    expect(noEmergencyHtml).toBe('');
  });

  it('submits the exact grant request to the real API and reloads lists and history', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(activeGrant, 201))
      .mockResolvedValueOnce(grantListResponse([activeGrant]))
      .mockResolvedValueOnce(grantEventsResponse([grantedEvent]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitOutcomeGrantAndReload('admin-jwt', 'EMG-1', { granteeUserId: 'USR-2', capability: 'SUBMIT' }, []);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/emergencies/EMG-1/outcome-grants');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer admin-jwt', 'content-type': 'application/json' }),
      body: JSON.stringify({ granteeUserId: 'USR-2', capability: 'SUBMIT' }),
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/emergencies/EMG-1/outcome-grants',
      '/api/emergencies/EMG-1/outcome-grants',
      '/api/emergencies/EMG-1/outcome-grant-events?limit=50',
    ]);
    expect(result.grant).toEqual(activeGrant);
    expect(result.grants).toEqual([activeGrant]);
    expect(result.events).toEqual([grantedEvent]);
    expect(result.notice).toContain('Granted SUBMIT to USR-2');
    expect(result.notice).not.toContain('Reactivated');
  });

  it('explains reactivation only when the server reused the previously revoked grant row', async () => {
    const reactivated: OutcomeGrant = { ...revokedGrant, revokedAt: null, revokedByUserId: null, revokeReason: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(reactivated, 201))
      .mockResolvedValueOnce(grantListResponse([reactivated]))
      .mockResolvedValueOnce(grantEventsResponse([reactivatedEvent, grantedEvent]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitOutcomeGrantAndReload('admin-jwt', 'EMG-1', { granteeUserId: 'USR-2', capability: 'SUBMIT' }, [revokedGrant]);

    expect(result.grant).toEqual(reactivated);
    expect(result.notice).toContain('Reactivated the existing grant OGT-UI-0');
    expect(result.notice).toContain('reused the original grant record');
    expect(findPriorOutcomeGrant([revokedGrant], 'USR-2', 'SUBMIT')).toEqual(revokedGrant);
    expect(findPriorOutcomeGrant([revokedGrant], 'USR-2', 'REVIEW')).toBeNull();
  });

  it('revokes with the optional reason and reloads state, omitting an empty reason from the request', async () => {
    const afterRevoke: OutcomeGrant = { ...activeGrant, revokedAt: '2026-10-21T11:00:00.000Z', revokedByUserId: 'USR-ADMIN', revokeReason: 'Policy updated' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(afterRevoke))
      .mockResolvedValueOnce(grantListResponse([afterRevoke]))
      .mockResolvedValueOnce(grantEventsResponse([revokedEvent, grantedEvent]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await revokeOutcomeGrantAndReload('admin-jwt', 'EMG-1', 'OGT-UI-1', '  Policy updated  ');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/emergencies/EMG-1/outcome-grants/OGT-UI-1');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({ authorization: 'Bearer admin-jwt', 'content-type': 'application/json' }),
      body: JSON.stringify({ revokeReason: 'Policy updated' }),
    });
    expect(result.grant.revokedAt).toBe('2026-10-21T11:00:00.000Z');
    expect(result.grants).toEqual([afterRevoke]);
    expect(result.events).toHaveLength(2);

    const emptyFetch = vi.fn()
      .mockResolvedValueOnce(response(afterRevoke))
      .mockResolvedValueOnce(grantListResponse([afterRevoke]))
      .mockResolvedValueOnce(grantEventsResponse([]));
    vi.stubGlobal('fetch', emptyFetch);
    await revokeOutcomeGrantAndReload('admin-jwt', 'EMG-1', 'OGT-UI-1', '   ');
    expect(emptyFetch.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
    expect((emptyFetch.mock.calls[0]?.[1] as { body?: string }).body).toBeUndefined();
  });

  it('surfaces API failures without faking success or refreshing local state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(response({
      error: { code: 'FORBIDDEN', message: "Role 'OPERATOR' may not call this endpoint." },
    }, 403))));
    await expect(submitOutcomeGrantAndReload('operator-jwt', 'EMG-1', { granteeUserId: 'USR-2', capability: 'SUBMIT' }, [activeGrant]))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(revokeOutcomeGrantAndReload('operator-jwt', 'EMG-1', 'OGT-UI-1'))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(activeGrant, 201))
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(grantEventsResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitOutcomeGrantAndReload('admin-jwt', 'EMG-1', { granteeUserId: 'USR-2', capability: 'SUBMIT' }, []))
      .rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('validates grant and audit client responses and preserves backend error envelopes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ unexpected: true })));
    await expect(getOutcomeGrants('jwt', 'EMG-1')).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ emergencyId: 'EMG-OTHER', items: [] })));
    await expect(getOutcomeGrants('jwt', 'EMG-1')).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ items: [] })));
    await expect(getOutcomeGrantEvents('jwt', 'EMG-1')).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'NOT_FOUND', message: "Emergency 'EMG-1' was not found." } }, 404)));
    await expect(grantOutcomeCapability('jwt', 'EMG-1', { granteeUserId: 'USR-2', capability: 'REVIEW' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'NOT_FOUND', message: 'Outcome access grant was not found.' } }, 404)));
    await expect(revokeOutcomeGrant('jwt', 'EMG-1', 'OGT-missing')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('renders current grant state separately from the durable audit history', () => {
    const tableHtml = renderToStaticMarkup(React.createElement(OutcomeGrantTable, {
      grants: [activeGrant, { ...revokedGrant, id: 'OGT-UI-9' }],
      mutating: false,
      confirmingRevokeId: null,
      revokeReason: '',
      onRevokeReasonChange: () => {},
      onRevokeStart: () => {},
      onRevokeCancel: () => {},
      onRevokeConfirm: () => {},
    }));
    expect(tableHtml).toContain('OGT-UI-1');
    expect(tableHtml).toContain('Active');
    expect(tableHtml).toContain('Revoked');
    expect(tableHtml).toContain('USR-2');
    expect(tableHtml).toContain('SUBMIT');
    expect(tableHtml).toContain('USR-ADMIN');
    expect(tableHtml).toContain('2026-10-21T10:00:00.000Z');
    expect(tableHtml).toContain('Rotating cover');
    expect(tableHtml).toContain('Regranting reactivates this record');
    expect(tableHtml).toContain('Revoke…');

    const confirmingHtml = renderToStaticMarkup(React.createElement(OutcomeGrantTable, {
      grants: [activeGrant],
      mutating: false,
      confirmingRevokeId: 'OGT-UI-1',
      revokeReason: '',
      onRevokeReasonChange: () => {},
      onRevokeStart: () => {},
      onRevokeCancel: () => {},
      onRevokeConfirm: () => {},
    }));
    expect(confirmingHtml).toContain('Confirm revoke');
    expect(confirmingHtml).toContain('Cancel');
    expect(confirmingHtml).toContain('Reason (optional)');

    const auditHtml = renderToStaticMarkup(React.createElement(OutcomeAuditTable, { events: [reactivatedEvent, revokedEvent, grantedEvent] }));
    expect(auditHtml).toContain('OUTCOME_GRANTED');
    expect(auditHtml).toContain('OUTCOME_GRANT_REVOKED');
    expect(auditHtml).toContain('sequence 5');
    expect(auditHtml).toContain('OPERATOR · USR-ADMIN');
    expect(auditHtml).toContain('reactivated SUBMIT for USR-2');
    expect(auditHtml).toContain('granted SUBMIT for USR-2');
    expect(auditHtml).toContain('revoked SUBMIT for USR-2 · reason: Rotating cover');

    expect(describeOutcomeGrantEvent(revokedEvent)).toBe('revoked SUBMIT for USR-2 · reason: Rotating cover');
    expect(describeOutcomeGrantEvent({ ...revokedEvent, payload: { ...revokedEvent.payload, revokeReason: null } }))
      .toBe('revoked SUBMIT for USR-2 · no reason recorded');
  });
});
