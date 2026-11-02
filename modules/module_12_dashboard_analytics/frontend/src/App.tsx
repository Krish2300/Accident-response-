import React, { useEffect, useReducer, useRef, useState } from 'react';
import {
  ApiError,
  EMERGENCY_SEVERITIES,
  INCIDENT_TYPES,
  extractNlpCandidate,
  getEmergencyTranscripts,
  getLifecycle,
  getLiveAmbulances,
  getLiveEmergencies,
  getEmergencyDispatchDetails,
  getEmergencyTimeline,
  getEmergencyRoutes,
  getOperationalEvents,
  getPoliceRouteNotices,
  getCallerLocationResolutions,
  retryCallerLocationResolution,
  confirmCallerLocation,
  assignNearestAmbulance,
  dispatchAmbulance,
  generateResponseRoute,
  createPoliceRouteNotice,
  acknowledgePoliceRouteNotice,
  getOutcomeGrants,
  grantOutcomeCapability,
  revokeOutcomeGrant,
  getOutcomeGrantEvents,
  login,
  recordLifecycleMilestone,
  submitOperatorClassification,
  type LifecycleProjection,
  type LifecycleMilestone,
  type LiveEmergency,
  type LiveAmbulance,
  type NlpCandidate,
  type NormalizedIncidentType,
  type NormalizedSeverity,
  type PersistedTranscript,
  type ConfirmedClassification,
  type EmergencyTimelineEvent,
  type EmergencyDispatchDetails,
  type PlannedRoute,
  type PoliceRouteNotice,
  type CallerLocationEvent,
  type OperationalEvent,
  type OutcomeAccessCapability,
  type OutcomeGrant,
  type OutcomeGrantEvent,
} from './api.js';
import { Suspense, lazy } from 'react';

const ResponseRouteMap = lazy(() => import('./ResponseRouteMap.js'));

const pageStyle: React.CSSProperties = {
  minHeight: '100vh', background: '#f3f6f8', color: '#17242e',
  fontFamily: 'system-ui, sans-serif', padding: '2rem', boxSizing: 'border-box',
};
const cardStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #d9e1e7', borderRadius: 12,
  padding: '1.25rem', margin: '1rem 0', boxShadow: '0 2px 8px #17242e0a',
};
const mutedStyle: React.CSSProperties = { color: '#566873' };

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [emergencies, setEmergencies] = useState<LiveEmergency[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [projection, setProjection] = useState<LifecycleProjection | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleNotFound, setLifecycleNotFound] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    setLiveLoading(true);
    setLiveError(null);
    getLiveEmergencies(token)
      .then((items) => {
        if (!active) return;
        setEmergencies(items);
        setSelectedId((current) => items.some((emergency) => emergency.id === current)
          ? current
          : items[0]?.id ?? '');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLiveError(messageFor(error));
        if (error instanceof ApiError && error.status === 401) setToken(null);
      })
      .finally(() => { if (active) setLiveLoading(false); });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (!token || !selectedId) {
      setProjection(null);
      setLifecycleNotFound(false);
      setLifecycleError(null);
      setLifecycleLoading(false);
      return;
    }
    const controller = new AbortController();
    setProjection(null);
    setLifecycleNotFound(false);
    setLifecycleError(null);
    setLifecycleLoading(true);
    getLifecycle(token, selectedId, controller.signal)
      .then((value) => setProjection(value))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) setLifecycleNotFound(true);
        else setLifecycleError(messageFor(error));
        if (error instanceof ApiError && error.status === 401) setToken(null);
      })
      .finally(() => { if (!controller.signal.aborted) setLifecycleLoading(false); });
    return () => controller.abort();
  }, [token, selectedId]);

  async function submitLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginLoading(true);
    setLoginError(null);
    try {
      const result = await login(email, password);
      setToken(result.token);
      setRole(result.user.role);
      setPassword('');
    } catch (error) {
      // On the sign-in screen the server's own message ("Invalid email or
      // password.") is the honest report; the generic session-expiry wording
      // belongs to authenticated views that lose their token mid-session.
      setLoginError(error instanceof ApiError && error.message ? error.message : messageFor(error));
    } finally {
      setLoginLoading(false);
    }
  }

  function signOut() {
    setToken(null);
    setRole(null);
    setEmergencies([]);
    setSelectedId('');
    setProjection(null);
    setPassword('');
  }

  if (!token) {
    return (
      <main style={pageStyle}>
        <section style={{ ...cardStyle, maxWidth: 440, margin: '8vh auto' }}>
          <h1>Emergency Operations Dashboard</h1>
          <p style={mutedStyle}>Sign in with your existing operator account to view emergency lifecycle observations.</p>
          <form onSubmit={submitLogin}>
            <label style={fieldStyle}>
              Email
              <input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label style={fieldStyle}>
              Password
              <input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            {loginError && <p role="alert" style={errorStyle}>{loginError}</p>}
            <button type="submit" disabled={loginLoading}>{loginLoading ? 'Signing in…' : 'Sign in'}</button>
          </form>
          <p style={smallStyle}>Your access token stays in memory for this page session.</p>
        </section>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Emergency Operations Dashboard</h1>
          <p style={{ ...mutedStyle, marginTop: 0 }}>Module 12 live view · Module 10 observed lifecycle</p>
        </div>
        <button type="button" onClick={signOut}>Sign out</button>
      </header>

      <section style={cardStyle} aria-labelledby="emergency-heading">
        <h2 id="emergency-heading">Active emergencies</h2>
        {liveLoading && <p role="status">Loading emergencies…</p>}
        {liveError && <p role="alert" style={errorStyle}>{liveError}</p>}
        {!liveLoading && !liveError && emergencies.length === 0 && (
          <p style={mutedStyle}>No active emergencies are available in the live view.</p>
        )}
        {emergencies.length > 0 && (
          <label style={fieldStyle}>
            Select emergency
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {emergencies.map((emergency) => (
                <option key={emergency.id} value={emergency.id}>
                  {emergency.id} · {emergency.incidentType} · {emergency.severity}{emergency.isSimulation ? ' · simulation' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {role && ['DISPATCHER', 'ADMIN'].includes(role) && token && (
        <FleetSection token={token} />
      )}

      {role && ['DISPATCHER', 'ADMIN'].includes(role) && token && selectedId && (
        <DispatchWorkflow key={`${selectedId}:${token}`} token={token} emergencyId={selectedId} />
      )}

      {role && ['OPERATOR', 'DISPATCHER', 'ADMIN'].includes(role) && token && selectedId && (
        <CallerLocationPanel key={`caller-location:${selectedId}:${token}`} token={token} emergencyId={selectedId} />
      )}

      {selectedId && (
        <>
          {role && ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'].includes(role) && (
            <OperatorReview key={`${selectedId}:${token}`} token={token} emergencyId={selectedId} role={role} />
          )}
          <LifecyclePanel
            token={token}
            role={role ?? ''}
            emergencyId={selectedId}
            projection={projection}
            onProjectionUpdate={setProjection}
            loading={lifecycleLoading}
            notFound={lifecycleNotFound}
            error={lifecycleError}
          />
        </>
      )}

      {token && (
        <OutcomeAccessSectionForRole role={role ?? ''} token={token} emergencyId={selectedId} />
      )}

      {role && ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'].includes(role) && token && (
        <OperationalEventHistory key={`ops-events:${token}`} token={token} />
      )}
    </main>
  );
}

type AssignmentObservation = { ambulanceId: string; assignmentId: string; status: 'OFFERED' | 'ASSIGNED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'DISPATCHED'; reason?: string; changedAt?: string; expiresAt?: string };

export function DispatchWorkflow({ token, emergencyId }: { token: string; emergencyId: string }) {
  const [emergency, setEmergency] = useState<EmergencyDispatchDetails | null>(null);
  const [events, setEvents] = useState<EmergencyTimelineEvent[]>([]);
  const [routes, setRoutes] = useState<PlannedRoute[]>([]);
  const [notices, setNotices] = useState<PoliceRouteNotice[]>([]);
  const [fleet, setFleet] = useState<LiveAmbulance[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const actionLock = useRef(false);
  const hasLoaded = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (!active || pending) return;
      pending = true;
      if (hasLoaded.current) setRefreshing(true); else setLoading(true);
      const results = await Promise.allSettled([
        getEmergencyDispatchDetails(token, emergencyId, controller.signal),
        getEmergencyTimeline(token, emergencyId, controller.signal),
        getEmergencyRoutes(token, emergencyId, controller.signal),
        getPoliceRouteNotices(token, emergencyId, controller.signal),
        getLiveAmbulances(token, controller.signal),
      ]);
      if (active) {
        const failures = results.flatMap((result) => result.status === 'rejected' ? [messageFor(result.reason)] : []);
        setError(failures.length ? `Some workflow details could not be refreshed: ${failures.join(' · ')}` : null);
        if (results[0].status === 'fulfilled') setEmergency(results[0].value);
        if (results[1].status === 'fulfilled') setEvents(results[1].value);
        if (results[2].status === 'fulfilled') setRoutes(results[2].value);
        if (results[3].status === 'fulfilled') setNotices(results[3].value);
        if (results[4].status === 'fulfilled') setFleet(results[4].value);
        setLoading(false);
        setRefreshing(false);
        hasLoaded.current = true;
      }
      pending = false;
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [token, emergencyId]);

  async function perform(name: string, operation: () => Promise<unknown>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setAction(name);
    setActionError(null);
    try {
      await operation();
      await refreshRef.current();
    } catch (cause) {
      setActionError(messageFor(cause));
    } finally {
      setAction(null);
      actionLock.current = false;
    }
  }

  const assignment = deriveAssignmentObservation(events);
  const ambulance = assignment ? fleet.find((item) => item.id === assignment.ambulanceId) : undefined;
  const dispatched = assignment?.status === 'DISPATCHED';
  const responseRoutes = routes.filter((route) => route.originName === 'AMBULANCE' && route.destinationName === 'SCENE');
  const latestNotice = notices.at(-1);

  return <section style={cardStyle} aria-labelledby="dispatch-workflow-heading">
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
      <div><h2 id="dispatch-workflow-heading">Dispatch, route and simulated police notice</h2>
        <p style={mutedStyle}>Read-only status refreshes every 15 seconds. Operational actions require an explicit button and dispatcher authorization.</p></div>
      <button type="button" disabled={loading || refreshing} onClick={() => { void refreshRef.current(); }}>{refreshing ? 'Refreshing…' : 'Refresh workflow'}</button>
    </div>
    {loading && <p role="status">Loading dispatch workflow…</p>}
    {error && <p role="alert" style={errorStyle}>{error}</p>}
    {actionError && <p role="alert" style={errorStyle}>{actionError}</p>}
    {assignment ? <>
      <h3>Assignment and dispatch</h3>
      <p>Ambulance {ambulance?.vehicleNumber ?? assignment.ambulanceId} · assignment {assignment.status}{assignment.status === 'OFFERED' && assignment.expiresAt ? ` · offer expires ${formatLocationTime(assignment.expiresAt)}` : ''}{dispatched ? ' · explicit dispatch observed' : ''}{assignment.changedAt ? ` · recorded ${formatLocationTime(assignment.changedAt)}` : ''}</p>
      {!ambulance && <p style={mutedStyle}>Ambulance fleet details are currently unavailable.</p>}
      {ambulance && <p style={mutedStyle}>Latest location: {ambulance.latitude == null || ambulance.longitude == null ? 'missing' : `${ambulance.latitude}, ${ambulance.longitude}`} · {ambulance.lastLocationUpdate ? formatLocationTime(ambulance.lastLocationUpdate) : 'no update recorded'}{ambulance.isSimulation ? ' · simulation' : ''}</p>}
      {assignment.status === 'EXPIRED' && <p role="status" style={noticeStyle}>The driver offer expired. Dispatcher reassignment is required; no automatic reassignment occurred.</p>}
      {assignment.status === 'DECLINED' && <>
        <p role="status" style={noticeStyle}>Driver declined. Dispatcher reassignment is required; no automatic reassignment occurred.</p>
        {emergency && <button type="button" disabled={Boolean(action)} onClick={() => void perform('assign', () => assignNearestAmbulance(token, { emergencyId, latitude: emergency.latitude, longitude: emergency.longitude }))}>{action === 'assign' ? 'Assigning…' : 'Explicitly assign a replacement ambulance'}</button>}
      </>}
      {!dispatched && ['ACCEPTED', 'ASSIGNED'].includes(assignment.status) && <button type="button" disabled={Boolean(action)} onClick={() => void perform('dispatch', () => dispatchAmbulance(token, assignment.ambulanceId, emergencyId))}>{action === 'dispatch' ? 'Dispatching…' : 'Explicitly dispatch ambulance'}</button>}
    </> : <>
      <h3>Assignment</h3>
      <p style={mutedStyle}>No current assignment was observed.</p>
      {emergency && <button type="button" disabled={Boolean(action)} onClick={() => void perform('assign', () => assignNearestAmbulance(token, { emergencyId, latitude: emergency.latitude, longitude: emergency.longitude }))}>{action === 'assign' ? 'Assigning…' : 'Assign nearest available ambulance'}</button>}
    </>}
    <h3>Response route</h3>
    {responseRoutes.length === 0 ? <p style={mutedStyle}>No persisted response route is available. Route generation requires a recorded explicit dispatch.</p> : responseRoutes.map((route) => <article key={route.id} style={transcriptStyle}>
      <p><strong>Route {route.id}</strong> · {route.distanceKm} km · {route.estimatedMinutes == null ? 'ETA unavailable' : `${route.estimatedMinutes} min estimate`} · provider {route.provider}{route.isSimulation ? ' · simulation' : ''}</p>
      <p style={mutedStyle}>isLiveTraffic: {String(route.isLiveTraffic)}{route.isLiveTraffic ? '' : ' · non-live/simulated traffic provenance'}</p>
      <p style={mutedStyle}>{route.polyline.length} persisted geometry points</p>
      {emergency && ambulance?.latitude != null && ambulance.longitude != null && emergency.latitude != null && emergency.longitude != null && route.polyline.length >= 2 && <Suspense fallback={<p style={mutedStyle}>Loading interactive route map…</p>}><ResponseRouteMap route={route} ambulance={{ latitude: ambulance.latitude, longitude: ambulance.longitude }} pickup={{ latitude: emergency.latitude, longitude: emergency.longitude }} /></Suspense>}
    </article>)}
    {dispatched && responseRoutes.length === 0 && <button type="button" disabled={Boolean(action)} onClick={() => void perform('route', () => generateResponseRoute(token, emergencyId))}>{action === 'route' ? 'Generating route…' : 'Generate response route'}</button>}
    <h3>Mock police control-room notice</h3>
    <p style={noticeStyle}>Simulation only. No police recipient is contacted; acknowledgement does not mean police acknowledged, traffic was cleared, or signals received priority.</p>
    {notices.length === 0 && <p style={mutedStyle}>No simulated notice recorded.</p>}
    {notices.map((notice) => <article key={notice.id} style={transcriptStyle}>
      <p><strong>{notice.status}</strong> · mock recipient {notice.audience} · recorded {formatLocationTime(notice.createdAt)}</p>
      <p style={mutedStyle}>Delivered: {String(notice.delivered)} · {describePoliceNotice(notice.body)}</p>
      {notice.status === 'SIMULATED_SENT' && <button type="button" disabled={Boolean(action)} onClick={() => void perform(`ack:${notice.id}`, () => acknowledgePoliceRouteNotice(token, emergencyId, notice.id))}>{action === `ack:${notice.id}` ? 'Recording…' : 'Record simulated acknowledgement'}</button>}
    </article>)}
    {latestNotice && !responseRoutes.some((route) => route.id === policeNoticeRouteId(latestNotice.body)) && <p style={noticeStyle}>The latest notice refers to an older route and may be superseded when a replacement route notice is explicitly created.</p>}
    {responseRoutes.length > 0 && <label style={fieldStyle}>Route for simulated notice
      <select id="police-notice-route" defaultValue={responseRoutes[responseRoutes.length - 1]?.id}>
        {responseRoutes.map((route) => <option key={route.id} value={route.id}>{route.id} · {route.provider}</option>)}
      </select>
    </label>}
    {dispatched && responseRoutes.length > 0 && <button type="button" disabled={Boolean(action)} onClick={() => {
      const select = document.getElementById('police-notice-route') as HTMLSelectElement | null;
      const routeId = select?.value;
      if (routeId) void perform('notice', () => createPoliceRouteNotice(token, emergencyId, routeId));
    }}>{action === 'notice' ? 'Recording simulated notice…' : 'Create simulated police notice'}</button>}
  </section>;
}

export function deriveAssignmentObservation(events: EmergencyTimelineEvent[]): AssignmentObservation | null {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const assigned = ordered.filter((event) => event.type === 'AMBULANCE_ASSIGNED').at(-1);
  if (!assigned || typeof assigned.payload.ambulanceId !== 'string' || typeof assigned.payload.assignmentId !== 'string') return null;
  const assignmentId = assigned.payload.assignmentId;
  const decision = ordered.filter((event) => event.payload.assignmentId === assignmentId && ['AMBULANCE_ASSIGNMENT_ACCEPTED', 'AMBULANCE_ASSIGNMENT_DECLINED', 'AMBULANCE_ASSIGNMENT_EXPIRED'].includes(event.type)).at(-1);
  const dispatch = ordered.some((event) => event.type === 'AMBULANCE_DISPATCHED' && event.payload.ambulanceId === assigned.payload.ambulanceId && event.sequence > assigned.sequence);
  const offer = ordered.find((event) => event.type === 'AMBULANCE_ASSIGNMENT_OFFERED' && event.payload.assignmentId === assignmentId);
  return {
    ambulanceId: assigned.payload.ambulanceId,
    assignmentId,
    status: dispatch ? 'DISPATCHED' : decision?.type === 'AMBULANCE_ASSIGNMENT_ACCEPTED' ? 'ACCEPTED' : decision?.type === 'AMBULANCE_ASSIGNMENT_DECLINED' ? 'DECLINED' : decision?.type === 'AMBULANCE_ASSIGNMENT_EXPIRED' ? 'EXPIRED' : offer ? 'OFFERED' : 'ASSIGNED',
    ...(typeof offer?.payload.expiresAt === 'string' ? { expiresAt: offer.payload.expiresAt } : {}),
    ...(decision ? { changedAt: decision.timestamp } : {}),
    ...(typeof decision?.payload.reason === 'string' ? { reason: decision.payload.reason } : {}),
  };
}

export function CallerLocationPanel({ token, emergencyId }: { token: string; emergencyId: string }) {
  const [items, setItems] = useState<CallerLocationEvent[]>([]);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async (signal?: AbortSignal) => {
    const result = await getCallerLocationResolutions(token, emergencyId, signal);
    setItems(result);
    const confirmed = new Set(result.filter((event) => event.type === 'EMERGENCY_LOCATION_CONFIRMED').map((event) => String(event.payload.resolutionId)));
    const pending = [...result].reverse().find((event) => event.type === 'EMERGENCY_LOCATION_CANDIDATE' && !confirmed.has(event.id));
    const candidateLatitude = pending?.payload.candidateLatitude;
    const candidateLongitude = pending?.payload.candidateLongitude;
    setLatitude(typeof candidateLatitude === 'number' ? String(candidateLatitude) : '');
    setLongitude(typeof candidateLongitude === 'number' ? String(candidateLongitude) : '');
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void refresh(controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(messageFor(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, emergencyId]);

  const confirmed = new Set(items.filter((event) => event.type === 'EMERGENCY_LOCATION_CONFIRMED').map((event) => String(event.payload.resolutionId)));
  const candidates = items.filter((event) => event.type === 'EMERGENCY_LOCATION_CANDIDATE');
  const pending = [...candidates].reverse().find((event) => !confirmed.has(event.id));
  const pendingPayload = pending?.payload;

  async function retry() {
    if (!pending) return;
    setSaving(true); setError(null); setMessage(null);
    try {
      await retryCallerLocationResolution(token, emergencyId, pending.id);
      await refresh();
      setMessage('A new lookup attempt was recorded. Review it before confirming coordinates.');
    } catch (cause) { setError(messageFor(cause)); }
    finally { setSaving(false); }
  }

  async function confirm() {
    if (!pending) return;
    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);
    if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude) || parsedLatitude < -90 || parsedLatitude > 90 || parsedLongitude < -180 || parsedLongitude > 180) {
      setError('Enter a valid latitude and longitude that an operator has verified.');
      return;
    }
    setSaving(true); setError(null); setMessage(null);
    try {
      await confirmCallerLocation(token, emergencyId, pending.id, { latitude: parsedLatitude, longitude: parsedLongitude });
      await refresh();
      setMessage('Coordinates saved with operator confirmation and source provenance.');
    } catch (cause) { setError(messageFor(cause)); }
    finally { setSaving(false); }
  }

  return <section style={cardStyle} aria-labelledby="caller-location-heading">
    <h2 id="caller-location-heading">Caller-stated location review</h2>
    <p style={mutedStyle}>Caller text and provider candidates are advisory. Coordinates change only after an authenticated operator confirms them; confirmation does not trigger dispatch or routing.</p>
    {loading && <p role="status">Loading location-resolution history…</p>}
    {error && <p role="alert" style={errorStyle}>{error}</p>}
    {message && <p role="status" style={noticeStyle}>{message}</p>}
    {!loading && candidates.length === 0 && <p style={mutedStyle}>No caller-stated location candidate has been recorded.</p>}
    {candidates.map((event) => {
      const payload = event.payload;
      const isConfirmed = confirmed.has(event.id);
      return <article key={event.id} style={transcriptStyle}>
        <p><strong>{String(payload.outcome)}</strong> · provider {String(payload.provider)} · attempt {String(payload.attempt ?? 1)}{isConfirmed ? ' · operator confirmed' : ' · pending review'}</p>
        <p>Caller said: {String(payload.callerLocationText)}{typeof payload.confidence === 'number' ? ` · confidence ${payload.confidence}` : ''}</p>
        <p style={mutedStyle}>Candidate: {typeof payload.candidateLatitude === 'number' && typeof payload.candidateLongitude === 'number' ? `${payload.candidateLatitude}, ${payload.candidateLongitude}` : 'no coordinates returned'} · {payload.isSimulation === true ? 'simulation' : 'non-simulation'}</p>
        {isConfirmed && <p style={mutedStyle}>Confirmed coordinates: {String(items.find((item) => item.type === 'EMERGENCY_LOCATION_CONFIRMED' && item.payload.resolutionId === event.id)?.payload.confirmedLatitude)}, {String(items.find((item) => item.type === 'EMERGENCY_LOCATION_CONFIRMED' && item.payload.resolutionId === event.id)?.payload.confirmedLongitude)}</p>}
      </article>;
    })}
    {pending && <>
      <p style={noticeStyle}>{pendingPayload?.outcome === 'CANDIDATE' || pendingPayload?.outcome === 'AMBIGUOUS' ? 'Review the candidate against an authorized source before confirming.' : 'No usable provider coordinates are available. Enter coordinates only after independent operator verification.'}</p>
      <label style={fieldStyle}>Latitude<input inputMode="decimal" value={latitude} onChange={(event) => setLatitude(event.target.value)} /></label>
      <label style={fieldStyle}>Longitude<input inputMode="decimal" value={longitude} onChange={(event) => setLongitude(event.target.value)} /></label>
      <button type="button" disabled={saving} onClick={() => void confirm()}>{saving ? 'Saving…' : 'Confirm coordinates'}</button>
      {['AMBIGUOUS', 'NOT_FOUND', 'UNAVAILABLE', 'INVALID_RESULT'].includes(String(pendingPayload?.outcome)) && <button type="button" disabled={saving} onClick={() => void retry()}>{saving ? 'Retrying…' : 'Retry location lookup'}</button>}
    </>}
  </section>;
}

function policeNoticeRouteId(body: string): string | null {
  const routeId = policeNoticeDetails(body)?.routeId;
  return typeof routeId === 'string' ? routeId : null;
}

function describePoliceNotice(body: string): string {
  const details = policeNoticeDetails(body);
  if (!details) return 'route details unavailable';
  const provenance = typeof details.isLiveTraffic === 'boolean'
    ? `isLiveTraffic: ${String(details.isLiveTraffic)}${details.isLiveTraffic ? '' : ' (non-live traffic)'}`
    : 'traffic provenance unavailable';
  return `route ${details.routeId} · provider ${typeof details.provider === 'string' ? details.provider : 'unknown'} · ${provenance} · route simulation: ${String(details.routeIsSimulation === true)}`;
}

function policeNoticeDetails(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

const LOCATION_FRESHNESS_MS = 2 * 60 * 1000;

export type LocationFreshness = 'CURRENT' | 'STALE' | 'MISSING' | 'UNKNOWN';

export function getLocationFreshness(ambulance: LiveAmbulance, now = Date.now()): LocationFreshness {
  if (ambulance.latitude === null || ambulance.longitude === null || !ambulance.lastLocationUpdate) return 'MISSING';
  const recordedAt = Date.parse(ambulance.lastLocationUpdate);
  if (!Number.isFinite(recordedAt) || recordedAt > now) return 'UNKNOWN';
  return now - recordedAt <= LOCATION_FRESHNESS_MS ? 'CURRENT' : 'STALE';
}

export function createNonOverlappingRefresh<T>(operation: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    pending = operation().finally(() => { pending = null; });
    return pending;
  };
}

export function FleetSection({ token }: { token: string }) {
  const [ambulances, setAmbulances] = useState<LiveAmbulance[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoaded = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const requestFleet = createNonOverlappingRefresh(() => getLiveAmbulances(token, controller.signal));
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (hasLoaded.current) setRefreshing(true);
      try {
        const rows = await requestFleet();
        if (!active) return;
        setAmbulances(rows);
        setError(null);
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        setError(messageFor(cause));
      } finally {
        if (active) {
          setLoading(false);
          setRefreshing(false);
          hasLoaded.current = true;
        }
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [token]);

  return (
    <FleetPanel
      ambulances={ambulances}
      loading={loading}
      error={error}
      refreshing={refreshing}
      onRefresh={() => { void refreshRef.current(); }}
    />
  );
}

export function FleetPanel(props: {
  ambulances: LiveAmbulance[];
  loading: boolean;
  refreshing?: boolean;
  error: string | null;
  now?: number;
  onRefresh?: () => void;
}) {
  const { ambulances, loading, refreshing = false, error, now = Date.now(), onRefresh } = props;
  return (
    <section style={cardStyle} aria-labelledby="fleet-heading">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
        <div>
          <h2 id="fleet-heading">Ambulance fleet</h2>
          <p style={mutedStyle}>Authenticated fleet snapshot · refreshes every 30 seconds.</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading || refreshing}>{refreshing ? 'Refreshing…' : 'Refresh fleet'}</button>
      </div>
      {loading && <p role="status">Loading fleet…</p>}
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      {!loading && !error && ambulances.length === 0 && <p style={mutedStyle}>No ambulances are available.</p>}
      {ambulances.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead><tr>
              <th style={fleetCellStyle}>Ambulance</th><th style={fleetCellStyle}>Operational status</th>
              <th style={fleetCellStyle}>Assignment</th><th style={fleetCellStyle}>Latest coordinates</th>
              <th style={fleetCellStyle}>Last location update</th><th style={fleetCellStyle}>Location freshness</th>
            </tr></thead>
            <tbody>{ambulances.map((ambulance) => {
              const freshness = getLocationFreshness(ambulance, now);
              const coordinates = ambulance.latitude === null || ambulance.longitude === null
                ? 'Location unavailable'
                : `${ambulance.latitude}, ${ambulance.longitude}`;
              return <tr key={ambulance.id}>
                <td style={fleetCellStyle}>{ambulance.vehicleNumber} <small style={mutedStyle}>({ambulance.id})</small>{ambulance.isSimulation ? ' · simulation' : ''}</td>
                <td style={fleetCellStyle}>{ambulance.status}</td>
                <td style={fleetCellStyle}>{ambulance.currentEmergencyId ?? 'Unassigned'}</td>
                <td style={fleetCellStyle}>{coordinates}</td>
                <td style={fleetCellStyle}>{ambulance.lastLocationUpdate ? formatLocationTime(ambulance.lastLocationUpdate) : 'No location update recorded'}</td>
                <td style={fleetCellStyle}>{freshnessLabel(freshness)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function freshnessLabel(freshness: LocationFreshness): string {
  switch (freshness) {
    case 'CURRENT': return 'Current (updated within 2 minutes)';
    case 'STALE': return 'Stale (last update over 2 minutes ago)';
    case 'MISSING': return 'Missing location data';
    case 'UNKNOWN': return 'Freshness unknown (invalid timestamp)';
  }
}

function formatLocationTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? `Invalid timestamp: ${value}` : parsed.toLocaleString();
}

export function OperatorReview(props: { token: string; emergencyId: string; role: string }) {
  const { token, emergencyId, role } = props;
  const [transcripts, setTranscripts] = useState<PersistedTranscript[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(true);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<NlpCandidate | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [classification, dispatchClassification] = useReducer(operatorClassificationReducer, initialOperatorClassificationState);
  const { incidentType, severity, confirming, pending: classificationLoading, error: classificationError, confirmed } = classification;
  const extractionRequest = React.useRef(0);
  const extractionController = React.useRef<AbortController | null>(null);
  const classificationInFlight = React.useRef(false);
  const mayClassify = ['OPERATOR', 'DISPATCHER', 'ADMIN'].includes(role);

  useEffect(() => {
    const controller = new AbortController();
    setTranscriptLoading(true);
    setTranscriptError(null);
    const refresh = () => getEmergencyTranscripts(token, emergencyId, controller.signal)
      .then((items) => { if (!controller.signal.aborted) { setTranscripts(items); setTranscriptError(null); } })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setTranscriptError(messageFor(error));
      })
      .finally(() => { if (!controller.signal.aborted) setTranscriptLoading(false); });
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      extractionController.current?.abort();
      extractionRequest.current += 1;
    };
  }, [token, emergencyId]);

  async function requestCandidate() {
    if (candidateLoading) return;
    const currentRequest = ++extractionRequest.current;
    const controller = new AbortController();
    extractionController.current?.abort();
    extractionController.current = controller;
    setCandidateLoading(true);
    setCandidateError(null);
    setCandidate(null);
    try {
      const result = await extractNlpCandidate(token, emergencyId, controller.signal);
      if (currentRequest === extractionRequest.current) setCandidate(result);
    } catch (error) {
      if (currentRequest === extractionRequest.current) setCandidateError(messageFor(error));
    } finally {
      if (currentRequest === extractionRequest.current) setCandidateLoading(false);
    }
  }

  async function confirmClassification() {
    if (!mayClassify || !incidentType || !severity || classificationLoading || classificationInFlight.current || !confirming) return;
    classificationInFlight.current = true;
    dispatchClassification({ type: 'SUBMIT' });
    try {
      const result = await submitOperatorClassification(token, emergencyId, { incidentType, severity });
      dispatchClassification({ type: 'SUCCESS', result });
    } catch (error) {
      dispatchClassification({ type: 'FAILURE', message: messageFor(error) });
    } finally {
      classificationInFlight.current = false;
    }
  }

  const finalTranscripts = transcripts.filter((transcript) => transcript.isFinal);
  const partialCount = transcripts.filter((transcript) => !transcript.isFinal).length;
  return (
    <section style={cardStyle} aria-labelledby="operator-review-heading">
      <h2 id="operator-review-heading">Transcript and operator review</h2>
      <h3>Persisted final transcript</h3>
      {transcriptLoading && <p role="status">Loading transcript…</p>}
      {transcriptError && <p role="alert" style={errorStyle}>{transcriptError}</p>}
      {!transcriptLoading && !transcriptError && finalTranscripts.length === 0 && (
        <p style={mutedStyle}>No persisted final transcript is available. Partial transcript text is not substituted.</p>
      )}
      {!transcriptLoading && !transcriptError && finalTranscripts.map((transcript) => (
        <article key={transcript.id} style={transcriptStyle}>
          <p><strong>{transcript.speaker}</strong> · Final transcript · sequence {transcript.sequence}</p>
          <blockquote style={{ margin: '0.5rem 0' }}>{transcript.text}</blockquote>
          <small style={mutedStyle}>Recorded: {transcript.recordedAt}</small>
        </article>
      ))}
      {partialCount > 0 && <p style={mutedStyle}>{partialCount} partial/interim transcript record(s) are not shown or used as final evidence.</p>}

      <h3>Advisory NLP candidate extraction</h3>
      <p style={noticeStyle}>Unconfirmed Module 3 candidate information. It does not set normalized classification or trigger clinical or operational actions.</p>
      <button type="button" onClick={requestCandidate} disabled={candidateLoading || transcriptLoading || finalTranscripts.length === 0}>
        {candidateLoading ? 'Extracting candidate…' : 'Request candidate extraction'}
      </button>
      {candidateLoading && <p role="status">Requesting advisory extraction…</p>}
      {candidateError && <p role="alert" style={errorStyle}>{candidateError} Manual operator review remains available.</p>}
      {candidate && <CandidateReview candidate={candidate} />}

      <h3>Explicit normalized classification</h3>
      {confirmed ? (
        <p role="status" style={successStyle}>Server confirmed: {confirmed.incidentType} · {confirmed.severity} · status {confirmed.status}.</p>
      ) : (
        <>
          {!mayClassify && <p style={mutedStyle}>Your role can review this emergency but cannot submit normalized classification.</p>}
          <label style={fieldStyle}>
            Normalized incident type
            <select aria-label="Normalized incident type" value={incidentType} disabled={!mayClassify || classificationLoading} onChange={(event) => {
              dispatchClassification({ type: 'SELECT_INCIDENT', value: event.target.value as NormalizedIncidentType | '' });
            }}>
              <option value="">Choose an incident type</option>
              {INCIDENT_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label style={fieldStyle}>
            Normalized severity
            <select aria-label="Normalized severity" value={severity} disabled={!mayClassify || classificationLoading} onChange={(event) => {
              dispatchClassification({ type: 'SELECT_SEVERITY', value: event.target.value as NormalizedSeverity | '' });
            }}>
              <option value="">Choose a severity</option>
              {EMERGENCY_SEVERITIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {classificationError && <p role="alert" style={errorStyle}>{classificationError}</p>}
          {!confirming ? (
            <button type="button" disabled={!mayClassify || !canReviewClassification(incidentType, severity) || classificationLoading} onClick={() => dispatchClassification({ type: 'REVIEW' })}>
              Review classification
            </button>
          ) : (
            <div role="group" aria-label="Confirm operator classification">
              <p>Confirm operator classification: <strong>{incidentType} · {severity}</strong></p>
              <button type="button" disabled={classificationLoading} onClick={confirmClassification}>
                {classificationLoading ? 'Submitting…' : 'Confirm and submit classification'}
              </button>
              <button type="button" disabled={classificationLoading} onClick={() => dispatchClassification({ type: 'CANCEL' })}>Cancel</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function CandidateReview({ candidate }: { candidate: NlpCandidate }) {
  return (
    <div style={candidateStyle} aria-label="Unconfirmed NLP candidate">
      <strong>Unconfirmed candidate · {candidate.degraded ? 'degraded fallback' : 'provider result'}</strong>
      <dl>
        <dt>Module 3 category</dt><dd>{candidate.category}</dd>
        <dt>Module 3 severity level</dt><dd>{candidate.severityLevel} · score {candidate.severityScore}</dd>
        <dt>Extraction confidence</dt><dd>{candidate.confidence}</dd>
        <dt>CPR candidate flag</dt><dd>{candidate.cprRequired ? 'yes' : 'no'}</dd>
        <dt>Provider / model</dt><dd>{candidate.provider} / {candidate.model}</dd>
      </dl>
      {candidate.warnings.length > 0 && <p>Warnings: {candidate.warnings.join('; ')}</p>}
      <p style={mutedStyle}>Candidate values are not converted to repository enums and are not clinical instructions.</p>
    </div>
  );
}

export interface OperatorClassificationState {
  incidentType: NormalizedIncidentType | '';
  severity: NormalizedSeverity | '';
  confirming: boolean;
  pending: boolean;
  error: string | null;
  confirmed: ConfirmedClassification | null;
}

export type OperatorClassificationAction =
  | { type: 'SELECT_INCIDENT'; value: NormalizedIncidentType | '' }
  | { type: 'SELECT_SEVERITY'; value: NormalizedSeverity | '' }
  | { type: 'REVIEW' }
  | { type: 'CANCEL' }
  | { type: 'SUBMIT' }
  | { type: 'SUCCESS'; result: ConfirmedClassification }
  | { type: 'FAILURE'; message: string };

export const initialOperatorClassificationState: OperatorClassificationState = {
  incidentType: '', severity: '', confirming: false, pending: false, error: null, confirmed: null,
};

export function canReviewClassification(incidentType: string, severity: string): boolean {
  return incidentType.length > 0 && severity.length > 0;
}

export function operatorClassificationReducer(
  state: OperatorClassificationState,
  action: OperatorClassificationAction,
): OperatorClassificationState {
  if (state.pending && action.type !== 'SUCCESS' && action.type !== 'FAILURE') return state;
  switch (action.type) {
    case 'SELECT_INCIDENT': return { ...state, incidentType: action.value, confirming: false, error: null };
    case 'SELECT_SEVERITY': return { ...state, severity: action.value, confirming: false, error: null };
    case 'REVIEW': return canReviewClassification(state.incidentType, state.severity)
      ? { ...state, confirming: true, error: null }
      : state;
    case 'CANCEL': return { ...state, confirming: false };
    case 'SUBMIT': return state.confirming && canReviewClassification(state.incidentType, state.severity)
      ? { ...state, pending: true, error: null }
      : state;
    case 'SUCCESS': return { ...state, pending: false, confirming: false, confirmed: action.result, error: null };
    case 'FAILURE': return { ...state, pending: false, error: action.message };
  }
}

export function LifecyclePanel(props: {
  token: string;
  role: string;
  emergencyId: string;
  projection: LifecycleProjection | null;
  onProjectionUpdate?: (projection: LifecycleProjection) => void;
  loading: boolean;
  notFound: boolean;
  error: string | null;
}) {
  const { token, role, emergencyId, projection, onProjectionUpdate, loading, notFound, error } = props;
  const [recording, setRecording] = useState<LifecycleMilestone | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordMessage, setRecordMessage] = useState<string | null>(null);
  const canRecord = ['OPERATOR', 'DISPATCHER', 'ADMIN'].includes(role);
  async function recordMilestone(milestone: LifecycleMilestone, factKey: keyof LifecycleProjection['facts']) {
    if (recording) return;
    setRecording(milestone);
    setRecordError(null);
    setRecordMessage(null);
    try {
      const result = await recordLifecycleMilestone(token, emergencyId, milestone);
      // The event is persisted before the post-commit bus publishes it. Give
      // the read-only observer a short bounded window to update its projection.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const refreshed = await getLifecycle(token, emergencyId);
        if (refreshed.facts[factKey]?.event.eventId === result.event.id) {
          onProjectionUpdate?.(refreshed);
          setRecordMessage(result.duplicate ? 'This operator-reported milestone was already recorded.' : 'Operator-reported milestone recorded.');
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      throw new Error('The event was saved, but the lifecycle projection has not observed it yet. Refresh the lifecycle view shortly.');
    } catch (cause) {
      setRecordError(messageFor(cause));
    } finally {
      setRecording(null);
    }
  }
  return (
    <section style={cardStyle} aria-labelledby="lifecycle-heading">
      <h2 id="lifecycle-heading">Observed lifecycle</h2>
      <p style={mutedStyle}>Emergency {emergencyId} · Facts shown here are read-only event observations.</p>
      {loading && <p role="status">Loading lifecycle…</p>}
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      {notFound && <p style={mutedStyle}>No lifecycle projection is available for this emergency yet.</p>}
      {!loading && !error && !notFound && projection && (
        <>
          {milestones.every(({ key }) => !projection.facts[key]) && (
            <p style={mutedStyle}>No listed lifecycle milestone has been observed yet.</p>
          )}
          <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {milestones.map(({ key, label }) => {
              const fact = projection.facts[key];
              return (
                <li key={key} style={milestoneStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                    <strong>{label}</strong>
                    <span aria-label={fact ? 'Observed' : 'Not observed'} style={fact ? observedStyle : missingStyle}>
                      {fact ? 'Observed' : 'Not observed'}
                    </span>
                  </div>
                  {fact && <p style={{ margin: '0.5rem 0 0' }}>{describeMilestone(key, projection.facts)}</p>}
                  {fact && <small style={mutedStyle}>Event time: {fact.event.timestamp}</small>}
                  {key === 'corridor' && fact && (
                    <p style={noticeStyle}>
                      Corridor activation alone does not confirm real traffic-signal control or successful real-world notification delivery.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          {projection.facts.nlpExtraction && !projection.facts.classification && (
            <p style={noticeStyle}>NLP extraction was observed; normalized classification has not been confirmed.</p>
          )}
          <section aria-label="Operator-reported lifecycle milestones" style={{ marginTop: '1rem' }}>
            <h3>Operator-reported milestones</h3>
            <p style={noticeStyle}>These actions record an authenticated operator's report. They do not independently verify location, patient handover, treatment, or outcome. Completion is operational only and does not establish survival.</p>
            {canRecord && projection.facts.ambulanceDispatch && !projection.facts.sceneArrival && (
              <button type="button" disabled={recording !== null} onClick={() => void recordMilestone('scene-arrival', 'sceneArrival')}>
                {recording === 'scene-arrival' ? 'Recording…' : 'Record scene arrival'}
              </button>
            )}
            {canRecord && projection.facts.sceneArrival && !projection.facts.patientOnboard && (
              <button type="button" disabled={recording !== null} onClick={() => void recordMilestone('patient-onboard', 'patientOnboard')}>
                {recording === 'patient-onboard' ? 'Recording…' : 'Record patient onboard'}
              </button>
            )}
            {canRecord && projection.facts.patientOnboard && projection.facts.hospitalSelection && !projection.facts.hospitalArrival && (
              <button type="button" disabled={recording !== null} onClick={() => void recordMilestone('hospital-arrival', 'hospitalArrival')}>
                {recording === 'hospital-arrival' ? 'Recording…' : 'Record hospital arrival'}
              </button>
            )}
            {canRecord && projection.facts.hospitalArrival && !projection.facts.operationalCompletion && (
              <button type="button" disabled={recording !== null} onClick={() => void recordMilestone('operational-completion', 'operationalCompletion')}>
                {recording === 'operational-completion' ? 'Recording…' : 'Record operational completion'}
              </button>
            )}
            {recording && <p role="status">Saving operator report…</p>}
            {recordMessage && <p role="status" style={successStyle}>{recordMessage}</p>}
            {recordError && <p role="alert" style={errorStyle}>{recordError}</p>}
            {!canRecord && <p style={mutedStyle}>Your role can view lifecycle evidence but cannot record operational milestones.</p>}
          </section>
        </>
      )}
      {!loading && !error && !notFound && !projection && (
        <p style={mutedStyle}>Lifecycle details have not loaded.</p>
      )}
    </section>
  );
}

/**
 * Durable operational event history (Module 11 event log). This is deliberately
 * separate from the Module 10 observed lifecycle: hospital resource updates and
 * route recalculations are operational history, not lifecycle milestones.
 */
export function OperationalEventHistory(props: { token: string }) {
  const { token } = props;
  const [events, setEvents] = useState<OperationalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getOperationalEvents(token)
      .then((items) => {
        if (!active) return;
        setEvents(items);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(messageFor(cause));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      setEvents(await getOperationalEvents(token));
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section style={cardStyle} aria-labelledby="operational-events-heading">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 id="operational-events-heading" style={{ marginBottom: 4 }}>Operational event history</h2>
        <button type="button" disabled={loading || refreshing} onClick={() => void refresh()}>
          {refreshing ? 'Refreshing…' : 'Refresh events'}
        </button>
      </div>
      <p style={mutedStyle}>
        Durable Module 11 event log · read roles enforced by the server: OPERATOR, DISPATCHER, CLINICAL_SUPERVISOR, ADMIN.
        This is operational event history and is separate from the Module 10 observed lifecycle; operational events are not lifecycle milestones.
      </p>
      {loading && <p role="status">Loading operational events…</p>}
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      {!loading && !error && events.length === 0 && (
        <p style={mutedStyle}>No hospital resource updates or route recalculations have been recorded.</p>
      )}
      {!loading && !error && events.length > 0 && <OperationalEventTable events={events} />}
    </section>
  );
}

export function OperationalEventTable(props: { events: OperationalEvent[] }) {
  const headerCell: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid #d9e1e7', padding: '0.4rem 0.5rem' };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92rem' }}>
      <thead>
        <tr>
          <th style={headerCell}>Recorded</th>
          <th style={headerCell}>Event</th>
          <th style={headerCell}>Entity</th>
          <th style={headerCell}>Emergency</th>
          <th style={headerCell}>Actor</th>
          <th style={headerCell}>Details</th>
        </tr>
      </thead>
      <tbody>
        {props.events.map((event) => (
          <tr key={event.id}>
            <td style={fleetCellStyle}>{event.timestamp}</td>
            <td style={fleetCellStyle}>
              <strong>{event.type}</strong>{' '}
              <small style={mutedStyle}>sequence {event.sequence}</small>
            </td>
            <td style={fleetCellStyle}>{event.entityType ?? '—'}{event.entityId ? ` ${event.entityId}` : ''}</td>
            <td style={fleetCellStyle}>{event.emergencyId ?? 'None (system-wide)'}</td>
            <td style={fleetCellStyle}>{event.actorType ?? '—'}{event.actorId ? ` · ${event.actorId}` : ''}</td>
            <td style={fleetCellStyle}>{describeOperationalEvent(event)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function describeOperationalEvent(event: OperationalEvent): string {
  if (event.type === 'HOSPITAL_RESOURCE_UPDATED') {
    const payload = event.payload as { resourceType?: unknown; code?: unknown; total?: unknown; available?: unknown };
    const code = typeof payload.code === 'string' && payload.code ? `/${payload.code}` : '';
    return `${String(payload.resourceType)}${code} · ${String(payload.available)} of ${String(payload.total)} available`;
  }
  const payload = event.payload as {
    previousDistanceKm?: unknown;
    distanceKm?: unknown;
    previousEstimatedMinutes?: unknown;
    estimatedMinutes?: unknown;
    reason?: unknown;
  };
  return `${String(payload.previousDistanceKm)} km → ${String(payload.distanceKm)} km · ${String(payload.previousEstimatedMinutes)} → ${String(payload.estimatedMinutes)} min · reason: ${String(payload.reason)}`;
}

// ---------------------------------------------------------------------------
// Outcome access management (ADMIN) — current grant rows + durable audit history
// ---------------------------------------------------------------------------

export function canManageOutcomeAccess(role: string): boolean {
  return role === 'ADMIN';
}

export function findPriorOutcomeGrant(
  grants: OutcomeGrant[],
  granteeUserId: string,
  capability: OutcomeAccessCapability,
): OutcomeGrant | null {
  return grants.find((grant) => grant.granteeUserId === granteeUserId && grant.capability === capability) ?? null;
}

export interface OutcomeAccessSnapshot {
  grants: OutcomeGrant[];
  events: OutcomeGrantEvent[];
}

/** Reloads the current grant rows and the durable audit history for one emergency. */
export async function loadOutcomeAccess(token: string, emergencyId: string, signal?: AbortSignal): Promise<OutcomeAccessSnapshot> {
  const [grants, events] = await Promise.all([
    getOutcomeGrants(token, emergencyId, signal),
    getOutcomeGrantEvents(token, emergencyId, signal),
  ]);
  return { grants, events };
}

/**
 * Creates (or reactivates) a grant through the real API, then reloads both
 * lists so the UI always reflects server state. A revoked grant for the same
 * emergency/user/capability is reactivated by the server's one-row-per-triple
 * rule; the notice says so only when the pre-mutation snapshot confirms it.
 */
export async function submitOutcomeGrantAndReload(
  token: string,
  emergencyId: string,
  input: { granteeUserId: string; capability: OutcomeAccessCapability },
  priorGrants: OutcomeGrant[],
): Promise<OutcomeAccessSnapshot & { grant: OutcomeGrant; notice: string }> {
  const grant = await grantOutcomeCapability(token, emergencyId, input);
  const prior = findPriorOutcomeGrant(priorGrants, input.granteeUserId, input.capability);
  const reactivated = prior !== null && prior.id === grant.id && prior.revokedAt !== null && grant.revokedAt === null;
  const snapshot = await loadOutcomeAccess(token, emergencyId);
  return {
    ...snapshot,
    grant,
    notice: reactivated
      ? `Reactivated the existing grant ${grant.id} (${grant.capability} for ${grant.granteeUserId}). The server reused the original grant record rather than creating a second grant.`
      : `Granted ${grant.capability} to ${grant.granteeUserId} on this emergency.`,
  };
}

/** Revokes through the real API with the optional trimmed reason, then reloads both lists. */
export async function revokeOutcomeGrantAndReload(
  token: string,
  emergencyId: string,
  grantId: string,
  revokeReason?: string,
): Promise<OutcomeAccessSnapshot & { grant: OutcomeGrant }> {
  const grant = await revokeOutcomeGrant(token, emergencyId, grantId, revokeReason);
  const snapshot = await loadOutcomeAccess(token, emergencyId);
  return { ...snapshot, grant };
}

export function describeOutcomeGrantEvent(event: OutcomeGrantEvent): string {
  const payload = event.payload as {
    action?: unknown; capability?: unknown; granteeUserId?: unknown; revokeReason?: unknown;
  };
  const capability = typeof payload.capability === 'string' ? payload.capability : '—';
  const grantee = typeof payload.granteeUserId === 'string' ? payload.granteeUserId : '—';
  if (event.type === 'OUTCOME_GRANTED') {
    const action = payload.action === 'REACTIVATED' ? 'reactivated' : 'granted';
    return `${action} ${capability} for ${grantee}`;
  }
  const reason = typeof payload.revokeReason === 'string' && payload.revokeReason
    ? ` · reason: ${payload.revokeReason}`
    : ' · no reason recorded';
  return `revoked ${capability} for ${grantee}${reason}`;
}

/** Role gate used by the dashboard shell; the server enforces ADMIN independently. */
export function OutcomeAccessSectionForRole(props: { role: string; token: string; emergencyId: string }) {
  if (!canManageOutcomeAccess(props.role) || !props.token || !props.emergencyId) return null;
  return <OutcomeAccessManagement token={props.token} emergencyId={props.emergencyId} />;
}

export function OutcomeAccessManagement(props: { token: string; emergencyId: string }) {
  const { token, emergencyId } = props;
  const [grants, setGrants] = useState<OutcomeGrant[]>([]);
  const [events, setEvents] = useState<OutcomeGrantEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [granteeUserId, setGranteeUserId] = useState('');
  const [capability, setCapability] = useState<OutcomeAccessCapability>('SUBMIT');
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loadOutcomeAccess(token, emergencyId)
      .then((snapshot) => {
        if (!active) return;
        setGrants(snapshot.grants);
        setEvents(snapshot.events);
      })
      .catch((cause: unknown) => { if (active) setError(messageFor(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, emergencyId]);

  async function submitGrant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const grantee = granteeUserId.trim();
    if (!grantee) return;
    setMutating(true);
    setError(null);
    setNotice(null);
    try {
      const result = await submitOutcomeGrantAndReload(token, emergencyId, { granteeUserId: grantee, capability }, grants);
      setGrants(result.grants);
      setEvents(result.events);
      setNotice(result.notice);
      setGranteeUserId('');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setMutating(false);
    }
  }

  async function confirmRevoke() {
    if (!confirmingRevokeId) return;
    setMutating(true);
    setError(null);
    setNotice(null);
    try {
      const result = await revokeOutcomeGrantAndReload(token, emergencyId, confirmingRevokeId, revokeReason.trim() || undefined);
      setGrants(result.grants);
      setEvents(result.events);
      setNotice(`Revoked grant ${result.grant.id}${result.grant.revokeReason ? ` · reason: ${result.grant.revokeReason}` : ' · no reason recorded'}.`);
      setConfirmingRevokeId(null);
      setRevokeReason('');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setMutating(false);
    }
  }

  return (
    <section style={cardStyle} aria-labelledby="outcome-access-heading">
      <h2 id="outcome-access-heading" style={{ marginBottom: 4 }}>Outcome Access Management</h2>
      <p style={mutedStyle}>
        ADMIN only · enforced by the server for emergency {emergencyId}.
        Grant rows below are the current access state; the audit history is the durable Module 11 event log of past
        changes and is separate from the Module 10 observed lifecycle. One grant row exists per emergency, user and
        capability: regranting a revoked permission reactivates that row.
      </p>

      <form onSubmit={submitGrant} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap', margin: '0.75rem 0' }}>
        <label style={{ ...fieldStyle, margin: 0, minWidth: 260 }}>
          Grantee user ID
          <input
            required
            value={granteeUserId}
            onChange={(event) => setGranteeUserId(event.target.value)}
            placeholder="USR-…"
            autoComplete="off"
          />
        </label>
        <label style={{ ...fieldStyle, margin: 0, minWidth: 140 }}>
          Capability
          <select value={capability} onChange={(event) => setCapability(event.target.value as OutcomeAccessCapability)}>
            <option value="SUBMIT">SUBMIT</option>
            <option value="REVIEW">REVIEW</option>
          </select>
        </label>
        <button type="submit" disabled={mutating || loading}>{mutating ? 'Working…' : 'Grant capability'}</button>
      </form>

      {notice && <p role="status" style={successStyle}>{notice}</p>}
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      {loading && <p role="status">Loading outcome access grants…</p>}

      {!loading && (
        <>
          <h3 style={{ marginTop: '1rem' }}>Current grant records</h3>
          {grants.length === 0
            ? <p style={mutedStyle}>No outcome access grants exist for this emergency.</p>
            : (
              <OutcomeGrantTable
                grants={grants}
                mutating={mutating}
                confirmingRevokeId={confirmingRevokeId}
                revokeReason={revokeReason}
                onRevokeReasonChange={setRevokeReason}
                onRevokeStart={(grantId) => { setConfirmingRevokeId(grantId); setRevokeReason(''); setError(null); setNotice(null); }}
                onRevokeCancel={() => { setConfirmingRevokeId(null); setRevokeReason(''); }}
                onRevokeConfirm={() => void confirmRevoke()}
              />
            )}

          <h3 style={{ marginTop: '1.25rem' }}>Grant audit history</h3>
          <p style={smallStyle}>
            Durable Module 11 grant lifecycle events, newest first. These record past changes; the table above shows
            the current state of each grant.
          </p>
          {events.length === 0
            ? <p style={mutedStyle}>No grant lifecycle events have been recorded for this emergency.</p>
            : <OutcomeAuditTable events={events} />}
        </>
      )}
    </section>
  );
}

export function OutcomeGrantTable(props: {
  grants: OutcomeGrant[];
  mutating: boolean;
  confirmingRevokeId: string | null;
  revokeReason: string;
  onRevokeReasonChange: (value: string) => void;
  onRevokeStart: (grantId: string) => void;
  onRevokeCancel: () => void;
  onRevokeConfirm: () => void;
}) {
  const headerCell: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid #d9e1e7', padding: '0.4rem 0.5rem' };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92rem' }}>
      <thead>
        <tr>
          <th style={headerCell}>Grant</th>
          <th style={headerCell}>Grantee</th>
          <th style={headerCell}>Capability</th>
          <th style={headerCell}>State</th>
          <th style={headerCell}>Granted by</th>
          <th style={headerCell}>Created</th>
          <th style={headerCell}>Revocation</th>
          <th style={headerCell}>Action</th>
        </tr>
      </thead>
      <tbody>
        {props.grants.map((grant) => {
          const active = grant.revokedAt === null;
          const confirming = props.confirmingRevokeId === grant.id;
          return (
            <tr key={grant.id}>
              <td style={fleetCellStyle}>{grant.id}</td>
              <td style={fleetCellStyle}>{grant.granteeUserId}</td>
              <td style={fleetCellStyle}>{grant.capability}</td>
              <td style={fleetCellStyle}>
                {active
                  ? <strong style={{ color: '#145a32' }}>Active</strong>
                  : <span style={mutedStyle}>Revoked</span>}
              </td>
              <td style={fleetCellStyle}>{grant.grantedByUserId}</td>
              <td style={fleetCellStyle}>{grant.createdAt}</td>
              <td style={fleetCellStyle}>
                {active
                  ? '—'
                  : `${grant.revokedByUserId ?? '—'} · ${grant.revokedAt}${grant.revokeReason ? ` · ${grant.revokeReason}` : ' · no reason recorded'}`}
              </td>
              <td style={fleetCellStyle}>
                {!active && <span style={mutedStyle}>Regranting reactivates this record</span>}
                {active && !confirming && (
                  <button type="button" disabled={props.mutating} onClick={() => props.onRevokeStart(grant.id)}>Revoke…</button>
                )}
                {active && confirming && (
                  <span style={{ display: 'grid', gap: 6, minWidth: 220 }}>
                    <label style={{ ...fieldStyle, margin: 0 }}>
                      Reason (optional)
                      <input
                        value={props.revokeReason}
                        onChange={(event) => props.onRevokeReasonChange(event.target.value)}
                        placeholder="e.g. rotating on-call cover"
                        autoComplete="off"
                      />
                    </label>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button type="button" disabled={props.mutating} onClick={props.onRevokeConfirm}>
                        {props.mutating ? 'Revoking…' : 'Confirm revoke'}
                      </button>
                      <button type="button" disabled={props.mutating} onClick={props.onRevokeCancel}>Cancel</button>
                    </span>
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function OutcomeAuditTable(props: { events: OutcomeGrantEvent[] }) {
  const headerCell: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid #d9e1e7', padding: '0.4rem 0.5rem' };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92rem' }}>
      <thead>
        <tr>
          <th style={headerCell}>Recorded</th>
          <th style={headerCell}>Event</th>
          <th style={headerCell}>Capability</th>
          <th style={headerCell}>Grantee</th>
          <th style={headerCell}>Actor</th>
          <th style={headerCell}>Details</th>
        </tr>
      </thead>
      <tbody>
        {props.events.map((event) => {
          const payload = event.payload as { capability?: unknown; granteeUserId?: unknown };
          return (
            <tr key={event.id}>
              <td style={fleetCellStyle}>{event.timestamp}</td>
              <td style={fleetCellStyle}>
                <strong>{event.type}</strong>{' '}
                <small style={mutedStyle}>sequence {event.sequence}</small>
              </td>
              <td style={fleetCellStyle}>{typeof payload.capability === 'string' ? payload.capability : '—'}</td>
              <td style={fleetCellStyle}>{typeof payload.granteeUserId === 'string' ? payload.granteeUserId : '—'}</td>
              <td style={fleetCellStyle}>{event.actorType ?? '—'}{event.actorId ? ` · ${event.actorId}` : ''}</td>
              <td style={fleetCellStyle}>{describeOutcomeGrantEvent(event)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type MilestoneKey = Exclude<keyof LifecycleProjection['facts'], 'nlpExtraction'>;
const milestones: Array<{ key: MilestoneKey; label: string }> = [
  { key: 'emergencyCreated', label: 'Emergency created' },
  { key: 'callConnected', label: 'Call connected' },
  { key: 'finalTranscript', label: 'Final transcript observed' },
  { key: 'classification', label: 'Normalized classification confirmed' },
  { key: 'ambulanceAssignment', label: 'Ambulance assigned' },
  { key: 'ambulanceDispatch', label: 'Ambulance dispatched' },
  { key: 'hospitalSelection', label: 'Hospital selected' },
  { key: 'route', label: 'Route generated' },
  { key: 'corridor', label: 'Corridor activated' },
  { key: 'sceneArrival', label: 'Ambulance arrival at scene (operator reported)' },
  { key: 'patientOnboard', label: 'Patient onboard (operator reported)' },
  { key: 'hospitalArrival', label: 'Ambulance arrival at hospital (operator reported)' },
  { key: 'operationalCompletion', label: 'Operational completion (operator reported)' },
];

function describeMilestone(key: MilestoneKey, facts: LifecycleProjection['facts']): string {
  switch (key) {
    case 'emergencyCreated': {
      const fact = facts.emergencyCreated!;
      return `${fact.incidentType} · ${fact.severity}${fact.isSimulation ? ' · simulation' : ''}`;
    }
    case 'callConnected': {
      const fact = facts.callConnected!;
      return `Call ${fact.callSessionId} · live transport: ${fact.isLiveTransport ? 'yes' : 'no'}`;
    }
    case 'finalTranscript': return `Speaker: ${facts.finalTranscript!.speaker}`;
    case 'classification': {
      const fact = facts.classification!;
      return `${fact.incidentType} · ${fact.severity} · ${fact.source} · confidence ${fact.confidence}`;
    }
    case 'ambulanceAssignment': {
      const fact = facts.ambulanceAssignment!;
      return `${fact.ambulanceId} · ${fact.source}`;
    }
    case 'ambulanceDispatch': return facts.ambulanceDispatch!.ambulanceId;
    case 'hospitalSelection': return facts.hospitalSelection!.hospitalId;
    case 'route': {
      const fact = facts.route!;
      return `Route ${fact.routeId} · provider ${fact.provider} · Live traffic: ${fact.isLiveTraffic ? 'yes (isLiveTraffic=true)' : 'no (isLiveTraffic=false; non-live traffic data)'}`;
    }
    case 'corridor': {
      const fact = facts.corridor!;
      return `Ambulance ${fact.ambulanceId} · hospital ${fact.hospitalId}`;
    }
    case 'sceneArrival': {
      const fact = facts.sceneArrival!;
      return `${fact.ambulanceId} · ${fact.evidenceSource} · ${fact.dataClassification} data · reported ${fact.observedAt} · dispatch-to-report interval ${fact.responseTimeMin} minutes`;
    }
    case 'patientOnboard': {
      const fact = facts.patientOnboard!;
      return `${fact.ambulanceId} · ${fact.evidenceSource} · ${fact.dataClassification} data · reported ${fact.observedAt}${fact.hospitalId ? ` · hospital ${fact.hospitalId}` : ''}`;
    }
    case 'hospitalArrival': {
      const fact = facts.hospitalArrival!;
      return `${fact.ambulanceId} · hospital ${fact.hospitalId} · ${fact.evidenceSource} · ${fact.dataClassification} data · reported ${fact.observedAt}`;
    }
    case 'operationalCompletion': {
      const fact = facts.operationalCompletion!;
      return `${fact.status} · ${fact.evidenceSource} · ${fact.dataClassification} data · reported ${fact.observedAt} · ${fact.isSimulation ? 'simulation' : 'non-simulation record'} · this is not a patient outcome`;
    }
  }
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Your session is not authorized. Sign in again.';
  if (error instanceof Error) return error.message;
  return 'The request could not be completed.';
}

const fieldStyle: React.CSSProperties = { display: 'grid', gap: 6, margin: '1rem 0', maxWidth: 560 };
const smallStyle: React.CSSProperties = { ...mutedStyle, fontSize: '0.85rem' };
const transcriptStyle: React.CSSProperties = { borderLeft: '3px solid #8295a1', paddingLeft: '0.75rem', margin: '0.75rem 0' };
const noticeStyle: React.CSSProperties = { color: '#704800', background: '#fff6df', padding: '0.75rem', borderRadius: 6 };
const candidateStyle: React.CSSProperties = { ...noticeStyle, marginTop: '0.75rem' };
const successStyle: React.CSSProperties = { color: '#145a32', background: '#e6f5ec', padding: '0.75rem', borderRadius: 6 };
const errorStyle: React.CSSProperties = { color: '#a32020' };
const milestoneStyle: React.CSSProperties = { borderTop: '1px solid #e2e8ec', padding: '0.9rem 0' };
const fleetCellStyle: React.CSSProperties = { borderBottom: '1px solid #e2e8ec', padding: '0.65rem 0.5rem', verticalAlign: 'top' };
const observedStyle: React.CSSProperties = { color: '#145a32', background: '#e6f5ec', borderRadius: 999, padding: '0.2rem 0.6rem', fontSize: '0.85rem' };
const missingStyle: React.CSSProperties = { ...mutedStyle, background: '#eef1f3', borderRadius: 999, padding: '0.2rem 0.6rem', fontSize: '0.85rem' };
