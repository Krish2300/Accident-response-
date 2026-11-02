/**
 * Stage 4.19 live demo verification.
 *
 * Verifies the dashboard integration against a *listening* backend that was
 * started by `scripts/demo-server.ts`:
 *
 *   1. HTTP checks against the real socket (authentication, authorization
 *      failures, invalid/duplicate requests, lifecycle projection, fleet
 *      freshness, learning isolation).
 *   2. Browser checks driven through the Chrome DevTools Protocol of the
 *      already-installed Microsoft Edge — no browser tooling is downloaded or
 *      installed. The browser loads the Vite dashboard, signs in, selects the
 *      demo emergency and asserts the rendered lifecycle evidence.
 *
 * Set DEMO_SKIP_BROWSER=true to run only the HTTP checks.
 * Set DEMO_AUTH_ONLY=true to run non-mutating login, role, token and browser checks only.
 *
 * Required environment (credentials are printed once by the demo server):
 *   DEMO_DISPATCHER_EMAIL, DEMO_DISPATCHER_PASSWORD
 *   DEMO_DRIVER_EMAIL, DEMO_DRIVER_PASSWORD
 * Optional:
 *   DEMO_BASE_URL (http://127.0.0.1:4000), DEMO_DASHBOARD_URL (http://127.0.0.1:5173)
 *   DEMO_EMERGENCY_ID, DEMO_SKIP_BROWSER, DEMO_EDGE_PATH
 */
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const baseUrl = (process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const dashboardUrl = (process.env.DEMO_DASHBOARD_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const authOnly = process.env.DEMO_AUTH_ONLY === 'true';
let dispatcherEmail = process.env.DEMO_DISPATCHER_EMAIL ?? 'dispatcher@demo.test';
let dispatcherPassword = process.env.DEMO_DISPATCHER_PASSWORD ?? '';
let driverEmail = process.env.DEMO_DRIVER_EMAIL ?? 'driver@demo.test';
let driverPassword = process.env.DEMO_DRIVER_PASSWORD ?? '';

/**
 * The demo server prints its generated credentials exactly once. Reading them
 * from that log keeps them out of shell history, source control and documents.
 */
function hydrateFromServerLog(): void {
  const logPath = process.env.DEMO_SERVER_LOG;
  if (!logPath || !existsSync(logPath)) return;
  const bytes = readFileSync(logPath);
  // PowerShell Start-Process redirection commonly writes UTF-16LE, while
  // ordinary npm redirection writes UTF-8. Decode in memory only; credentials
  // are never logged by this verifier.
  const hasUtf16LeBom = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const hasUtf16BeBom = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  const oddByteNulls = bytes.filter((value, index) => index % 2 === 1 && value === 0).length;
  const evenByteNulls = bytes.filter((value, index) => index % 2 === 0 && value === 0).length;
  let content: string;
  if (hasUtf16LeBom) {
    content = bytes.subarray(2).toString('utf16le');
  } else if (hasUtf16BeBom) {
    const swapped = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      const current = swapped[index]!;
      swapped[index] = swapped[index + 1]!;
      swapped[index + 1] = current;
    }
    content = swapped.toString('utf16le');
  } else if (oddByteNulls > bytes.length / 8 && evenByteNulls < oddByteNulls / 4) {
    content = bytes.toString('utf16le');
  } else {
    content = bytes.toString('utf8');
  }
  const pattern = /\[demo-server\]\s+(DISPATCHER|DRIVER|OPERATOR)\s+(\S+)\s+\/\s+(\S+)/g;
  for (const match of content.matchAll(pattern)) {
    const [, role, email, password] = match;
    if (role === 'DISPATCHER') {
      dispatcherEmail = process.env.DEMO_DISPATCHER_EMAIL ?? email ?? dispatcherEmail;
      dispatcherPassword = process.env.DEMO_DISPATCHER_PASSWORD ?? password ?? dispatcherPassword;
    }
    if (role === 'DRIVER') {
      driverEmail = process.env.DEMO_DRIVER_EMAIL ?? email ?? driverEmail;
      driverPassword = process.env.DEMO_DRIVER_PASSWORD ?? password ?? driverPassword;
    }
  }
}
hydrateFromServerLog();

const skipBrowser = process.env.DEMO_SKIP_BROWSER === 'true';
const defaultEdgePath = join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
const edgePath = process.env.DEMO_EDGE_PATH ?? (existsSync(defaultEdgePath) ? defaultEdgePath : '');

const results: CheckResult[] = [];
let fatal: string | null = null;
let pendingOfferEmergencyId: string | undefined;

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function http(
  method: 'GET' | 'POST',
  path: string,
  options: { token?: string; payload?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.payload !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function login(email: string, password: string): Promise<string | null> {
  const { status, body } = await http('POST', '/api/auth/login', { payload: { email, password } });
  return status === 200 && typeof body?.token === 'string' ? (body.token as string) : null;
}

async function runAuthOnlyHttpChecks(): Promise<void> {
  if (!dispatcherPassword || !driverPassword) {
    fatal = 'DEMO_DISPATCHER_PASSWORD / DEMO_DRIVER_PASSWORD are required.';
    return;
  }

  const health = await http('GET', '/api/health');
  record('live backend health', health.status === 200 && health.body?.status === 'ok', `HTTP ${health.status}, routes=${health.body?.routes ?? '?'}`);
  const anonymous = await http('GET', '/api/dashboard/live');
  record('anonymous dashboard request rejected', anonymous.status === 401, `HTTP ${anonymous.status}`);

  const wrongDispatcher = await http('POST', '/api/auth/login', { payload: { email: dispatcherEmail, password: `${dispatcherPassword}-wrong` } });
  const wrongDriver = await http('POST', '/api/auth/login', { payload: { email: driverEmail, password: `${driverPassword}-wrong` } });
  record('invalid dispatcher password rejected', wrongDispatcher.status === 401, `HTTP ${wrongDispatcher.status}`);
  record('invalid driver password rejected', wrongDriver.status === 401, `HTTP ${wrongDriver.status}`);

  const [dispatcherLogin, driverLogin] = await Promise.all([
    http('POST', '/api/auth/login', { payload: { email: dispatcherEmail, password: dispatcherPassword } }),
    http('POST', '/api/auth/login', { payload: { email: driverEmail, password: driverPassword } }),
  ]);
  const dispatcherToken = dispatcherLogin.body?.token as string | undefined;
  const driverToken = driverLogin.body?.token as string | undefined;
  record('dispatcher authenticates with DISPATCHER role', dispatcherLogin.status === 200 && dispatcherLogin.body?.user?.role === 'DISPATCHER', `HTTP ${dispatcherLogin.status}, role=${dispatcherLogin.body?.user?.role ?? '?'}`);
  record('driver authenticates with DRIVER role', driverLogin.status === 200 && driverLogin.body?.user?.role === 'DRIVER', `HTTP ${driverLogin.status}, role=${driverLogin.body?.user?.role ?? '?'}`);
  if (!dispatcherToken || !driverToken) return;

  const [dispatcherMe, driverMe, invalidToken, dispatcherLive, driverLive, driverAssignment, adminOnly] = await Promise.all([
    http('GET', '/api/auth/me', { token: dispatcherToken }),
    http('GET', '/api/auth/me', { token: driverToken }),
    http('GET', '/api/auth/me', { token: 'invalid-token' }),
    http('GET', '/api/dashboard/live', { token: dispatcherToken }),
    http('GET', '/api/dashboard/live', { token: driverToken }),
    http('GET', '/api/drivers/me/assignment', { token: driverToken }),
    http('GET', '/api/emergencies/AUTHZ_CHECK/outcome-grants?limit=1', { token: dispatcherToken }),
  ]);
  record('dispatcher JWT session validated', dispatcherMe.status === 200 && dispatcherMe.body?.role === 'DISPATCHER', `HTTP ${dispatcherMe.status}, role=${dispatcherMe.body?.role ?? '?'}`);
  record('driver JWT session validated', driverMe.status === 200 && driverMe.body?.role === 'DRIVER', `HTTP ${driverMe.status}, role=${driverMe.body?.role ?? '?'}`);
  record('malformed JWT rejected', invalidToken.status === 401, `HTTP ${invalidToken.status}`);
  record('dispatcher dashboard read allowed', dispatcherLive.status === 200, `HTTP ${dispatcherLive.status}`);
  record('driver dashboard read denied', driverLive.status === 403, `HTTP ${driverLive.status}`);
  record('driver assignment read allowed', driverAssignment.status === 200, `HTTP ${driverAssignment.status}`);
  record('dispatcher admin-only grants read denied', adminOnly.status === 403, `HTTP ${adminOnly.status}`);

  const driverDispatch = await http('POST', '/api/ambulances/AUTHZ_CHECK/dispatch', {
    token: driverToken,
    payload: { emergencyId: 'AUTHZ_CHECK' },
  });
  const dispatcherDriverAccept = await http('POST', '/api/drivers/me/assignment/AUTHZ_CHECK/accept', {
    token: dispatcherToken,
    payload: {},
  });
  record('driver dispatcher-only dispatch denied', driverDispatch.status === 403, `HTTP ${driverDispatch.status}`);
  record('dispatcher driver-only accept denied', dispatcherDriverAccept.status === 403, `HTTP ${dispatcherDriverAccept.status}`);

  const dispatcherClaims = JSON.parse(Buffer.from(dispatcherToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
  const driverClaims = JSON.parse(Buffer.from(driverToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
  const now = Math.floor(Date.now() / 1000);
  record('both JWTs have a future expiry', Boolean(dispatcherClaims.exp && dispatcherClaims.exp > now && driverClaims.exp && driverClaims.exp > now), 'expiry claims present; token values suppressed');
}

async function runHttpChecks(): Promise<void> {
  if (authOnly) {
    await runAuthOnlyHttpChecks();
    return;
  }
  if (!dispatcherPassword || !driverPassword) {
    fatal = 'DEMO_DISPATCHER_PASSWORD / DEMO_DRIVER_PASSWORD are required: the demo server prints them once on stdout.';
    return;
  }

  const health = await http('GET', '/api/health');
  record('backend health endpoint on the real socket', health.status === 200 && health.body?.status === 'ok', `HTTP ${health.status}, env=${health.body?.env ?? '?'}`);

  const anonymous = await http('GET', '/api/dashboard/live');
  record('unauthenticated dashboard read is rejected', anonymous.status === 401, `HTTP ${anonymous.status}`);

  const badLogin = await http('POST', '/api/auth/login', { payload: { email: dispatcherEmail, password: `${dispatcherPassword}-wrong` } });
  record('invalid credentials are rejected', badLogin.status === 401, `HTTP ${badLogin.status}`);

  const dispatcherToken = await login(dispatcherEmail, dispatcherPassword);
  const driverToken = await login(driverEmail, driverPassword);
  record('demo accounts authenticate', Boolean(dispatcherToken && driverToken), `${dispatcherEmail}, ${driverEmail}`);
  if (!dispatcherToken || !driverToken) return;

  const live = await http('GET', '/api/dashboard/live', { token: dispatcherToken });
  const emergencies: any[] = live.body?.emergencies ?? [];
  const ambulances: any[] = live.body?.ambulances ?? [];
  record('live dashboard projection returns the demo emergency', live.status === 200 && emergencies.length > 0, `HTTP ${live.status}, ${emergencies.length} emergency/ies`);

  const emergencyId = process.env.DEMO_EMERGENCY_ID ?? emergencies[0]?.id ?? '';
  record('demo emergency identifier resolved', Boolean(emergencyId), emergencyId || 'none');
  if (!emergencyId) return;

  const driverAssignment = await http('GET', '/api/drivers/me/assignment', { token: driverToken });
  const driverAmbulanceId = driverAssignment.body?.ambulance?.id;
  const demoAmbulance = typeof driverAmbulanceId === 'string'
    ? ambulances.find((item: any) => item.id === driverAmbulanceId)
    : undefined;
  record('demo ambulance present in the live fleet', Boolean(demoAmbulance?.id), demoAmbulance ? `${demoAmbulance.vehicleNumber} (${demoAmbulance.id})` : 'none');
  if (demoAmbulance?.id) {
    // Fleet freshness is verified the way the driver app reports: an authorized
    // driver-role GPS write, then a re-read of the dashboard projection.
    const gps = await http('POST', `/api/ambulances/${encodeURIComponent(demoAmbulance.id)}/location`, {
      token: driverToken,
      payload: {
        latitude: 12.9721,
        longitude: 77.5951,
        speedKmh: 24,
        headingDeg: 91,
        accuracyM: 8,
        source: 'SPOOFED',
        isSimulation: true,
      },
    });
    record('authorized driver GPS update is accepted', gps.status === 200, `HTTP ${gps.status}, source=${gps.body?.location?.source ?? '?'}`);
    const refreshed = await http('GET', '/api/dashboard/live', { token: dispatcherToken });
    const updated = (refreshed.body?.ambulances ?? []).find((item: any) => item.id === demoAmbulance.id);
    const lastUpdate = updated?.lastLocationUpdate ? Date.parse(updated.lastLocationUpdate) : Number.NaN;
    const ageMs = Number.isFinite(lastUpdate) ? Date.now() - lastUpdate : Number.NaN;
    const fresh = Number.isFinite(ageMs) && ageMs >= -60_000 && ageMs < 60_000;
    record(
      'fleet freshness reflects the authorized update',
      fresh,
      `${updated?.vehicleNumber ?? '?'} lastLocationUpdate=${updated?.lastLocationUpdate ?? 'missing'} ageMs=${Number.isFinite(ageMs) ? ageMs : 'unparsed'}`,
    );
  }

  const lifecycle = await http('GET', `/api/emergencies/${encodeURIComponent(emergencyId)}/lifecycle`, { token: dispatcherToken });
  const facts = lifecycle.body?.projection?.facts ?? {};
  record('lifecycle projection is served authenticated', lifecycle.status === 200 && Boolean(lifecycle.body?.projection), `HTTP ${lifecycle.status}, state=${lifecycle.body?.projection?.state ?? '?'}`);
  record(
    'final transcript and operator classification observed',
    Boolean(facts.finalTranscript && facts.classification && facts.classification.source === 'OPERATOR'),
    `transcript=${Boolean(facts.finalTranscript)}, classification=${facts.classification ? `${facts.classification.incidentType}/${facts.classification.source}` : 'missing'}`,
  );
  const milestoneEvidence = ['sceneArrival', 'patientOnboard', 'hospitalArrival', 'operationalCompletion'] as const;
  const reportedAll = milestoneEvidence.every((key) => facts[key]?.evidenceSource === 'OPERATOR_REPORTED');
  record('all four lifecycle milestones are operator-reported', reportedAll, milestoneEvidence.map((key) => `${key}=${facts[key]?.evidenceSource ?? 'missing'}`).join(', '));
  record(
    'completion carries no survival claim',
    Boolean(facts.operationalCompletion) && !('survivalToDischarge' in (facts.operationalCompletion ?? {})),
    facts.operationalCompletion ? `status=${facts.operationalCompletion.status}, evidence=${facts.operationalCompletion.evidenceSource}` : 'missing',
  );

  const duplicate = await http('POST', `/api/emergencies/${encodeURIComponent(emergencyId)}/lifecycle-milestones/scene-arrival`, { token: dispatcherToken, payload: {} });
  record('duplicate milestone request is idempotent', duplicate.status === 200 && duplicate.body?.duplicate === true, `HTTP ${duplicate.status}, duplicate=${duplicate.body?.duplicate ?? '?'}`);

  const forbidden = await http('POST', `/api/emergencies/${encodeURIComponent(emergencyId)}/lifecycle-milestones/scene-arrival`, { token: driverToken, payload: {} });
  record('driver role cannot record operational milestones', forbidden.status === 403, `HTTP ${forbidden.status}`);

  const missing = await http('GET', '/api/emergencies/EMG-DOES-NOT-EXIST/lifecycle', { token: dispatcherToken });
  record('unknown emergency returns a structured 404', missing.status === 404 && missing.body?.error?.code === 'NOT_FOUND', `HTTP ${missing.status}, code=${missing.body?.error?.code ?? '?'}`);

  const unknownMilestone = await http('POST', `/api/emergencies/${encodeURIComponent(emergencyId)}/lifecycle-milestones/not-a-milestone`, { token: dispatcherToken, payload: {} });
  record('unknown milestone is rejected', [400, 404, 422].includes(unknownMilestone.status), `HTTP ${unknownMilestone.status}`);

  const learning = await http('GET', '/api/analytics/learning/samples', { token: dispatcherToken });
  record('learning sample reads stay restricted to admin', learning.status === 403, `HTTP ${learning.status}`);

  // Build a fresh simulated pending offer for the browser view. It uses only
  // the already documented synthetic demo-site coordinates and the isolated
  // demo database; no driver notification or dispatch operation is invoked.
  const demoSite = { latitude: 12.9716, longitude: 77.5946 };
  const offerEmergency = await http('POST', '/api/emergencies', {
    token: dispatcherToken,
    payload: {
      incidentType: 'OTHER', severity: 'LOW', ...demoSite,
      description: 'Synthetic offer-expiry browser check', isSimulation: true,
    },
  });
  const offerEmergencyId = offerEmergency.body?.emergency?.id;
  if (offerEmergency.status !== 201 || typeof offerEmergencyId !== 'string') {
    record('synthetic pending offer fixture created', false, `HTTP ${offerEmergency.status}`);
    return;
  }
  const ambulance = await http('POST', '/api/ambulances', {
    token: dispatcherToken,
    payload: {
      vehicleNumber: `DEMO-OFFER-${randomBytes(4).toString('hex').toUpperCase()}`,
      ...demoSite, status: 'AVAILABLE', isSimulation: true,
    },
  });
  const ambulanceId = ambulance.body?.ambulance?.id;
  if (ambulance.status !== 201 || typeof ambulanceId !== 'string') {
    record('synthetic pending offer fixture created', false, `HTTP ${ambulance.status}`);
    return;
  }
  const location = await http('POST', `/api/ambulances/${encodeURIComponent(ambulanceId)}/location`, {
    token: dispatcherToken,
    payload: { ...demoSite, source: 'SPOOFED', isSimulation: true },
  });
  if (location.status !== 200) {
    record('synthetic pending offer fixture created', false, `location HTTP ${location.status}`);
    return;
  }
  const offer = await http('POST', '/api/ambulances/assign', {
    token: dispatcherToken,
    payload: { emergencyId: offerEmergencyId, ...demoSite },
  });
  const expiresAt = offer.body?.expiresAt;
  const expiryIsFuture = typeof expiresAt === 'string' && Date.parse(expiresAt) > Date.now();
  if (offer.status !== 200 || !expiryIsFuture || typeof offer.body?.assignmentId !== 'string') {
    record('synthetic pending offer fixture created', false, `assignment HTTP ${offer.status}, future expiry=${expiryIsFuture}`);
    return;
  }
  pendingOfferEmergencyId = offerEmergencyId;
  const offerEvents = await http('GET', `/api/events?emergencyId=${encodeURIComponent(offerEmergencyId)}&limit=50`, { token: dispatcherToken });
  const offerEventItems = Array.isArray(offerEvents.body?.items)
    ? offerEvents.body.items as Array<{ type: string; payload?: { isSimulation?: unknown } }>
    : [];
  const offerEvent = offerEventItems.find((event) => event.type === 'AMBULANCE_ASSIGNMENT_OFFERED');
  const simulatedProvenance = offerEvent?.payload?.isSimulation === true;
  record('synthetic pending offer fixture created', simulatedProvenance, `HTTP ${offer.status}, simulated=${simulatedProvenance}, future expiry=${expiryIsFuture}`);
}

/* ---------------------------------- browser ---------------------------------- */

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Per-request evidence captured from the Chrome DevTools Protocol so that a
 * failed or cancelled load can be attributed to a URL, a resource type and the
 * script that initiated it, instead of being counted as an undifferentiated
 * "network error".
 */
interface TrackedRequest {
  path: string;
  resourceType: string;
  initiator: string;
  startedAt: number;
}

interface RequestFailure {
  path: string;
  resourceType: string;
  initiator: string;
  errorText: string;
  canceled: boolean;
  startedAt: number;
  failedAt: number;
}

interface RequestCompletion {
  path: string;
  status: number;
  at: number;
}

interface ConsoleErrorEntry {
  path: string;
  text: string;
}

class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  private readonly ws: WebSocket;
  readonly browserIssueCounts = { javascript: 0, console: 0, network: 0, http5xx: 0 };
  readonly requestFailures: RequestFailure[] = [];
  readonly requestCompletions: RequestCompletion[] = [];
  readonly requestStarts: Array<{ path: string; at: number }> = [];
  readonly consoleErrors: ConsoleErrorEntry[] = [];
  private readonly trackedRequests = new Map<string, TrackedRequest>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let message: {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: {
          requestId?: string;
          request?: { url?: string };
          entry?: { level?: string; text?: string; url?: string };
          response?: { status?: number };
          exceptionDetails?: unknown;
          errorText?: string;
          timestamp?: number;
          type?: string;
          canceled?: boolean;
          initiator?: { type?: string; stack?: { callFrames?: Array<{ url?: string }> } };
        };
      };
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message.method === 'Network.requestWillBeSent' && message.params?.requestId && message.params.request?.url) {
        const path = safeBrowserRequestPath(message.params.request.url);
        const frame = message.params.initiator?.stack?.callFrames?.[0];
        const initiatorLabel = message.params.initiator?.type
          ? `${message.params.initiator.type}${frame?.url ? `@${safeBrowserRequestPath(frame.url)}` : ''}`
          : 'unknown';
        this.trackedRequests.set(message.params.requestId, {
          path,
          resourceType: String(message.params.type ?? 'unknown'),
          initiator: initiatorLabel,
          startedAt: Number(message.params.timestamp ?? 0),
        });
        this.requestStarts.push({ path, at: Number(message.params.timestamp ?? 0) });
      }
      if (message.method === 'Runtime.exceptionThrown') this.browserIssueCounts.javascript += 1;
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        this.browserIssueCounts.console += 1;
        this.consoleErrors.push({
          path: message.params.entry.url ? safeBrowserRequestPath(message.params.entry.url) : '',
          text: sanitizeBrowserDiagnostic(message.params.entry.text ?? 'console error'),
        });
      }
      if (message.method === 'Network.loadingFailed') {
        this.browserIssueCounts.network += 1;
        const requestId = message.params?.requestId;
        const tracked = requestId ? this.trackedRequests.get(requestId) : undefined;
        this.requestFailures.push({
          path: tracked?.path ?? 'unknown',
          resourceType: String(message.params?.type ?? tracked?.resourceType ?? 'unknown'),
          initiator: tracked?.initiator ?? 'unknown',
          errorText: String(message.params?.errorText ?? 'unknown'),
          canceled: message.params?.canceled === true,
          startedAt: tracked?.startedAt ?? 0,
          failedAt: Number(message.params?.timestamp ?? 0),
        });
      }
      if (message.method === 'Network.responseReceived') {
        const status = message.params?.response?.status ?? 0;
        if (status >= 500) this.browserIssueCounts.http5xx += 1;
        const requestId = message.params?.requestId;
        const tracked = requestId ? this.trackedRequests.get(requestId) : undefined;
        if (tracked && status > 0) this.requestCompletions.push({ path: tracked.path, status, at: Number(message.params?.timestamp ?? 0) });
      }
      if (typeof message.id !== 'number') return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply?.exceptionDetails) {
      const description = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'evaluation failed';
      throw new Error(String(description));
    }
    return reply?.result?.value as T;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function waitForPage(cdp: CdpSession, expression: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate<boolean>(`Boolean(${expression})`)) return;
      lastError = '';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError})` : ''}`);
}

function json(value: string): string {
  return JSON.stringify(value);
}

function sanitizeBrowserDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)"']+/gi, '[url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[account]')
    .replace(/(password|secret|token)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .slice(0, 140);
}

function safeBrowserRequestPath(value: string): string {
  try {
    return new URL(value).pathname
      .replace(/\/api\/emergencies\/[^/]+/g, '/api/emergencies/:id')
      .replace(/\/api\/ambulances\/[^/]+/g, '/api/ambulances/:id')
      .replace(/\/api\/protocol-sessions\/[^/]+/g, '/api/protocol-sessions/:id')
      .replace(/\/api\/events\/[^/]+/g, '/api/events/:id');
  } catch {
    return 'unknown';
  }
}

/**
 * Classifies every browser-side issue with per-request evidence instead of
 * treating all of them as equal failures:
 *
 * - A network failure only counts as an *expected cancellation* when it is a
 *   genuine abort (`net::ERR_ABORTED` + CDP `canceled=true`), it was initiated
 *   by page script (the dashboard's AbortController effect cleanup), a later
 *   request for the same path superseded it or completed after it, and that
 *   path did serve a successful response during the run. Anything else —
 *   connection errors, DNS failures, aborted requests with no recovery — stays
 *   unexpected and fails the check.
 * - A console error only counts as expected when it is the deliberate
 *   rejected-sign-in test hitting the auth endpoint with a 401. Every other
 *   console error fails the check.
 * - JavaScript exceptions and HTTP 5xx responses always fail the check.
 */
function classifyBrowserIssues(cdp: CdpSession): { ok: boolean; detail: Record<string, unknown> } {
  const pathsServed = new Set(
    cdp.requestCompletions
      .filter((completion) => completion.status >= 200 && completion.status < 400)
      .map((completion) => completion.path),
  );
  const expectedCancellations: string[] = [];
  const unexpectedNetwork: string[] = [];
  for (const failure of cdp.requestFailures) {
    const supersededByLaterRequest = cdp.requestStarts.some((start) => start.path === failure.path && start.at > failure.startedAt);
    const completedAfterFailure = cdp.requestCompletions.some(
      (completion) => completion.path === failure.path && completion.at > failure.failedAt && completion.status >= 200 && completion.status < 400,
    );
    const pathServedSuccessfully = pathsServed.has(failure.path);
    const evidence =
      `${failure.errorText} path=${failure.path} type=${failure.resourceType} initiator=${failure.initiator}` +
      ` canceled=${failure.canceled} supersededByLaterRequest=${supersededByLaterRequest}` +
      ` completedAfterFailure=${completedAfterFailure} pathServedSuccess=${pathServedSuccessfully}`;
    const isExpectedCancellation =
      failure.errorText === 'net::ERR_ABORTED' &&
      failure.canceled &&
      failure.initiator !== 'unknown' &&
      (supersededByLaterRequest || completedAfterFailure) &&
      pathServedSuccessfully;
    if (isExpectedCancellation) expectedCancellations.push(evidence);
    else unexpectedNetwork.push(evidence);
  }

  const rejectedSignInRecorded = results.some((result) => result.name === 'browser shows the rejected sign-in' && result.ok);
  const expectedConsoleErrors: string[] = [];
  const unexpectedConsoleErrors: string[] = [];
  for (const entry of cdp.consoleErrors) {
    const attributableToDeliberateLoginRejection =
      /401/.test(entry.text) &&
      (entry.path.endsWith('/api/auth/login') ||
        // Some DevTools builds omit the URL on resource-log entries; accept the
        // text-only attribution only when it is the sole console error and the
        // deliberate rejected-sign-in check actually ran and passed.
        (entry.path === '' && cdp.consoleErrors.length === 1 && rejectedSignInRecorded));
    const evidence = `${entry.text} path=${entry.path || '[url not reported]'} deliberateRejectedSignInRecorded=${rejectedSignInRecorded}`;
    if (attributableToDeliberateLoginRejection) expectedConsoleErrors.push(evidence);
    else unexpectedConsoleErrors.push(evidence);
  }

  const ok =
    cdp.browserIssueCounts.javascript === 0 &&
    cdp.browserIssueCounts.http5xx === 0 &&
    unexpectedNetwork.length === 0 &&
    unexpectedConsoleErrors.length === 0;
  return {
    ok,
    detail: {
      ok,
      rawCounts: { ...cdp.browserIssueCounts },
      expectedCancellations,
      unexpectedNetwork,
      expectedConsoleErrors,
      unexpectedConsoleErrors,
      completedRequestPaths: [...pathsServed].sort(),
    },
  };
}

async function connectCdp(port: number): Promise<{ cdp: CdpSession; target: Target }> {
  const deadline = Date.now() + 30_000;
  let targets: Target[] = [];
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      if (Array.isArray(list) && list.length > 0) {
        targets = list as Target[];
        const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? targets[0];
        if (target?.webSocketDebuggerUrl) {
          const ws = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve());
            ws.addEventListener('error', () => reject(new Error('DevTools websocket connection failed')));
          });
          const cdp = new CdpSession(ws);
          await cdp.send('Page.enable');
          await cdp.send('Runtime.enable');
          return { cdp, target };
        }
      }
      lastError = `browser ${version?.Browser ?? 'unknown'} exposed no debuggable page target`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Chrome DevTools endpoint on port ${port} never became ready: ${lastError}`);
}

async function runBrowserChecks(): Promise<void> {
  if (skipBrowser) {
    record('browser verification', true, 'skipped by DEMO_SKIP_BROWSER=true');
    return;
  }
  if (!edgePath) {
    record('browser verification', false, 'no Microsoft Edge executable found; set DEMO_EDGE_PATH or run with DEMO_SKIP_BROWSER=true');
    return;
  }
  if (!dispatcherPassword) {
    record('browser verification', false, 'dispatcher credentials were not provided');
    return;
  }

  const profileDir = resolve(tmpdir(), `resus-demo-edge-${randomBytes(4).toString('hex')}`);
  const debugPort = 9300 + Math.floor(Math.random() * 400);
  const browser = spawn(
    edgePath,
    [
      '--headless',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--window-size=1440,1200',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanupBrowser = (): void => {
    try {
      spawnSync('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    for (let attempt = 0; attempt < 10 && existsSync(profileDir); attempt += 1) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* retry */
      }
    }
  };

  let cdp: CdpSession | null = null;
  try {
    const connection = await connectCdp(debugPort);
    cdp = connection.cdp;
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    try {
      await cdp.send('Page.navigate', { url: `${dashboardUrl}/` });
      try {
        await waitForPage(cdp, 'document.querySelector(\'input[type="email"]\')', 'the dashboard sign-in form', 20_000);
      } catch {
        // Some headless builds ignore the first navigation; retry from the page itself.
        await cdp.evaluate<string>(`window.location.assign(${json(`${dashboardUrl}/`)}); 'navigating'`);
        await waitForPage(cdp, 'document.querySelector(\'input[type="email"]\')', 'the dashboard sign-in form', 30_000);
      }

      const heading = await cdp.evaluate<string>('document.querySelector("h1")?.textContent ?? ""');
      record('browser loads the dashboard shell', heading.includes('Emergency Operations Dashboard'), heading.trim());

      // Error handling: a rejected sign-in must surface a visible alert.
      await cdp.evaluate<string>(`
        (() => {
          const email = document.querySelector('input[type="email"]');
          const password = document.querySelector('input[type="password"]');
          const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setValue.call(email, ${json(dispatcherEmail)});
          email.dispatchEvent(new Event('input', { bubbles: true }));
          setValue.call(password, ${json(`${dispatcherPassword}-wrong`)});
          password.dispatchEvent(new Event('input', { bubbles: true }));
          const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim().startsWith('Sign in'));
          button.click();
          return 'submitted';
        })()
      `);
      await waitForPage(cdp, 'document.querySelector(\'[role="alert"]\')', 'a visible sign-in error message');
      const alertText = await cdp.evaluate<string>('document.querySelector(\'[role="alert"]\')?.textContent ?? ""');
      record('browser shows the rejected sign-in', alertText.toLowerCase().includes('invalid email or password'), alertText.trim());

      // Successful sign-in through the real proxied API.
      await cdp.evaluate<string>(`
        (() => {
          const password = document.querySelector('input[type="password"]');
          const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setValue.call(password, ${json(dispatcherPassword)});
          password.dispatchEvent(new Event('input', { bubbles: true }));
          const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim().startsWith('Sign in'));
          button.click();
          return 'submitted';
        })()
      `);
      await waitForPage(cdp, 'document.body.innerText.includes("Active emergencies")', 'the authenticated live view');
      record('browser authenticates against the listening backend', true, 'authenticated live view rendered');
      const proxiedHealth = await cdp.evaluate<{ status?: string; env?: string; routes?: number }>(
        'fetch("/api/health").then((response) => response.json())',
      );
      record('dashboard proxy reaches the requested isolated backend', proxiedHealth.status === 'ok' && proxiedHealth.env === 'test', `status=${proxiedHealth.status ?? '?'}, env=${proxiedHealth.env ?? '?'}, routes=${proxiedHealth.routes ?? '?'}`);

      const storage = await cdp.evaluate<number>('window.localStorage.length + window.sessionStorage.length');
      record('token is not persisted in web storage', storage === 0, `localStorage + sessionStorage entries = ${storage}`);

      if (authOnly) {
        const dispatcherView = await cdp.evaluate<string>('document.body.innerText');
        record('dispatcher dashboard shell is visible', dispatcherView.includes('Active emergencies') && !dispatcherView.includes("Role 'DISPATCHER' may not call this endpoint."), 'authenticated dispatcher view rendered');

        await cdp.evaluate<string>(`
          (() => {
            const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim() === 'Sign out');
            button.click();
            return 'signed out';
          })()
        `);
        await waitForPage(cdp, 'document.querySelector(\'input[type="email"]\')', 'the sign-in form after sign-out');
        await cdp.evaluate<string>(`
          (() => {
            const email = document.querySelector('input[type="email"]');
            const password = document.querySelector('input[type="password"]');
            const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setValue.call(email, ${json(driverEmail)});
            email.dispatchEvent(new Event('input', { bubbles: true }));
            setValue.call(password, ${json(driverPassword)});
            password.dispatchEvent(new Event('input', { bubbles: true }));
            const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim().startsWith('Sign in'));
            button.click();
            return 'submitted';
          })()
        `);
        await waitForPage(cdp, 'document.body.innerText.includes("Active emergencies") && document.querySelector(\'[role="alert"]\')?.textContent.includes("Role \'DRIVER\'")', 'the driver role-denial state');
        const driverView = await cdp.evaluate<string>('document.body.innerText');
        record('driver login succeeds but dashboard data is role-denied', driverView.includes('Sign out') && driverView.includes("Role 'DRIVER' may not call this endpoint."), 'driver session retained; operator dashboard endpoint shows 403');
        const driverStorage = await cdp.evaluate<number>('window.localStorage.length + window.sessionStorage.length');
        record('driver token is not persisted in web storage', driverStorage === 0, `localStorage + sessionStorage entries = ${driverStorage}`);
        return;
      }

      const emergenciesText = await cdp.evaluate<string>('document.querySelector(\'select\')?.innerText ?? ""');
      record('live emergencies reach the browser', emergenciesText.includes('CARDIAC_ARREST'), emergenciesText.split('\n')[0] ?? 'no options');

      await waitForPage(cdp, 'document.body.innerText.includes("Location freshness")', 'the fleet freshness column');
      const fleetText = await cdp.evaluate<string>('document.body.innerText');
      const freshnessMatch = /Location freshness/.test(fleetText) && /(Current|Stale|Missing|Freshness unknown)/.test(fleetText);
      record('fleet panel renders freshness state', freshnessMatch, freshnessMatch ? 'freshness column populated' : 'freshness labels missing');

      const emergencyId = process.env.DEMO_EMERGENCY_ID ?? (await cdp.evaluate<string>('document.querySelector("select")?.value ?? ""'));
      if (!emergencyId) throw new Error('no emergency option available in the dashboard select');
      await cdp.evaluate<string>(`
        (() => {
          const select = document.querySelector('select');
          const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setValue.call(select, ${json(emergencyId)});
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return 'selected';
        })()
      `);
      await waitForPage(cdp, 'document.body.innerText.includes("Observed lifecycle")', 'the lifecycle projection panel');
      const bodyText = await cdp.evaluate<string>('document.body.innerText');
      record('lifecycle projection renders in the browser', bodyText.includes('Ambulance arrival at scene (operator reported)') && bodyText.includes('Operational completion (operator reported)'), 'operator-reported milestones listed');
      record('evidence semantics are visible in the browser', bodyText.includes('OPERATOR_REPORTED') && bodyText.includes('this is not a patient outcome'), 'evidence source and no-outcome disclaimer rendered');
      record('dispatch workflow renders in the browser', bodyText.includes('Dispatch, route and simulated police notice') && bodyText.includes('isLiveTraffic: false'), 'workflow + non-live route provenance');

      const observed = (bodyText.match(/Observed/g) ?? []).length;
      record('observed lifecycle facts are present', observed >= 8, `${observed} observed markers`);

      if (pendingOfferEmergencyId) {
        await cdp.evaluate<string>(`
          (() => {
            const select = document.querySelector('select');
            const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setValue.call(select, ${json(pendingOfferEmergencyId)});
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return 'selected pending offer';
          })()
        `);
        await waitForPage(cdp, 'document.body.innerText.includes("assignment OFFERED") && document.body.innerText.includes("offer expires")', 'the simulated offer status and expiry');
        const offerText = await cdp.evaluate<string>('document.body.innerText');
        record('dashboard renders the pending offer and expiry', /assignment OFFERED/.test(offerText) && /offer expires/.test(offerText), 'OFFERED state and expiry timestamp visible');
      }
      const navigationTiming = await cdp.evaluate<{ domContentLoadedMs: number; loadEventEndMs: number; resourceEntries: number }>(`
        (() => {
          const nav = performance.getEntriesByType('navigation')[0];
          return {
            domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : -1,
            loadEventEndMs: nav ? Math.round(nav.loadEventEnd) : -1,
            resourceEntries: performance.getEntriesByType('resource').length,
          };
        })()
      `);
      const classification = classifyBrowserIssues(cdp);
      record(
        'browser has no console, JavaScript, or network errors',
        classification.ok,
        JSON.stringify({ ...classification.detail, navigationTiming }),
      );
    } finally {
      cdp.close();
      cdp = null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let diagnostics = '';
    if (cdp) {
      try {
        const state = await cdp.evaluate<string>(`
          JSON.stringify({
            href: location.href,
            ready: document.readyState,
            overlay: Boolean(document.querySelector('vite-error-overlay')),
            text: document.body ? document.body.innerText.slice(0, 300) : '',
          })
        `);
        diagnostics = ` | page=${state}`;
      } catch (cause) {
        diagnostics = ` | page state unavailable: ${cause instanceof Error ? cause.message : cause}`;
      }
      cdp.close();
      cdp = null;
    }
    record('browser verification', false, message + diagnostics);
  } finally {
    cleanupBrowser();
  }
}

async function main(): Promise<void> {
  console.log(`[demo-verify] backend  : ${baseUrl}`);
  console.log(`[demo-verify] dashboard: ${dashboardUrl}`);
  await runHttpChecks();
  if (!fatal) {
    await runBrowserChecks();
  } else {
    record('browser verification', false, fatal);
  }

  const failed = results.filter((result) => !result.ok);
  console.log('');
  console.log(`[demo-verify] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0 || fatal) {
    for (const failure of failed) console.log(`[demo-verify] FAILED: ${failure.name} — ${failure.detail}`);
    process.exit(1);
  }
  console.log('[demo-verify] live dashboard verification succeeded');
}

main().catch((error: unknown) => {
  console.error('[demo-verify] unexpected failure:', error);
  process.exit(1);
});
