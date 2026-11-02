import bcrypt from 'bcryptjs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './helpers/isolatedTestDatabase.js';
import {
  ApiError,
  generateResponseRoute,
  getEmergencyRoutes,
  getLifecycle,
  getLiveAmbulances,
  getLiveEmergencies,
  getDriverAssignment,
  login,
  recordLifecycleMilestone,
} from '../modules/module_12_dashboard_analytics/frontend/src/api.js';
import { getLocationFreshness } from '../modules/module_12_dashboard_analytics/frontend/src/App.js';

/**
 * Live dashboard integration: the real Vite dev server in front of a real
 * Fastify server process, both started here and stopped here, on an owned
 * disposable SQLite database.
 *
 * What this proves: the dashboard's own API client, served by Vite, reaches the
 * backend through Vite's `/api` proxy, with authenticated requests, lifecycle
 * projection, fleet freshness and error handling working over a real socket.
 *
 * What this does not prove: that a browser executed the React bundle (no
 * browser tooling is installed here), that a physical device reported GPS, or
 * that any external provider was contacted. The client's relative `/api/...`
 * URLs are resolved against the Vite origin by a shim, exactly as a browser
 * resolves them against the page origin.
 */
const enabled = process.env.RESUS_RUN_DASHBOARD_LIVE_TEST === 'true';
const suite = enabled ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const schemaPath = resolve(repoRoot, 'modules/module_11_database_event_system/prisma/schema.prisma');
/** Picked at run time: the first free loopback port, so this check can run beside a manual session. */
let backendPort = 4000;
/** Captured before any stub so polling and the shim never recurse. */
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const dispatcherPassword = 'Stage419-live-only-dispatcher-9!';
const driverPassword = 'Stage419-live-only-driver-9!';
const scene = { latitude: 12.9716, longitude: 77.5946 };
const hospitalId = 'HSP-STAGE419-LIVE';

function isPortFree(port: number): Promise<boolean> {
  return new Promise((answer) => {
    const probe = createServer();
    probe.once('error', () => answer(false));
    probe.once('listening', () => probe.close(() => answer(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickVitePort(): Promise<number> {
  for (let port = 5173; port <= 5192; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('No free local port between 5173 and 5192 was available for the dashboard dev server.');
}

/** Prefers 4000 (the proxy default) and falls through when that port is taken. */
async function pickBackendPort(): Promise<number> {
  for (let port = 4000; port <= 4019; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('No free local port between 4000 and 4019 was available for the isolated backend.');
}

function attachLogs(child: ChildProcess, sink: string[]): void {
  child.stdout?.on('data', (chunk: Buffer) => sink.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => sink.push(chunk.toString()));
}

async function waitForHttp(url: string, timeoutMs: number, label: string, logs: string[]): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'no attempt completed';
  while (Date.now() < deadline) {
    try {
      const response = await nativeFetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((wait) => setTimeout(wait, 300));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (${lastFailure}).\n${logs.slice(-40).join('\n')}`);
}

/** Stops only a process this suite started, and its whole tree. */
function stopChild(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

suite('live dashboard against an isolated Fastify backend through the Vite proxy', () => {
  let owned: IsolatedTestDatabase | undefined;
  let db: PrismaClient | undefined;
  let backend: ChildProcess | undefined;
  let vite: ChildProcess | undefined;
  let viteOrigin = '';
  let backendLogs: string[] = [];
  let viteLogs: string[] = [];

  beforeAll(async () => {
    backendPort = await pickBackendPort();
    const vitePort = await pickVitePort();
    viteOrigin = `http://127.0.0.1:${vitePort}`;

    owned = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: owned.databaseUrl } } });

    const dispatcherHash = await bcrypt.hash(dispatcherPassword, 4);
    const driverHash = await bcrypt.hash(driverPassword, 4);
    await db.user.create({
      data: {
        id: 'USR-STAGE419-LIVE-DISPATCH', email: 'dispatcher@stage419.test',
        displayName: 'Live Isolated Dispatcher', passwordHash: dispatcherHash, role: 'DISPATCHER',
      },
    });
    await db.user.create({
      data: {
        id: 'USR-STAGE419-LIVE-DRIVER', email: 'driver@stage419.test',
        displayName: 'Live Isolated Driver', passwordHash: driverHash, role: 'DRIVER',
      },
    });
    await db.hospital.create({
      data: {
        id: hospitalId, name: 'Stage 4.19 Live Check Hospital',
        latitude: scene.latitude + 0.02, longitude: scene.longitude + 0.02,
        status: 'OPEN', capabilitiesJson: JSON.stringify(['ED_CARDIAC']),
        traumaLevel: 2, acceptingEmergencies: true, isSimulation: false,
        resources: { create: { id: 'HRS-STAGE419-LIVE', resourceType: 'ICU_BED', code: '', total: 6, available: 6 } },
      },
    });

    backend = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(backendPort),
        LOG_LEVEL: 'error',
        CORS_ORIGIN: viteOrigin,
        JWT_SECRET: `stage-4.19-live-${randomBytes(16).toString('hex')}`,
        DATABASE_URL: owned.databaseUrl,
        TRANSPORT_PROVIDER: 'loopback',
        MODULE3_NLP_ENABLED: 'false',
        MODULE6_AUTO_DISPATCH_ENABLED: 'false',
        MODULE6_AUTO_DISPATCH_SIMULATION: 'false',
        MODULE7_AUTO_SELECT_ENABLED: 'false',
        MODULE7_AUTO_SELECT_SIMULATION: 'false',
        MODULE8_PROVIDER: 'mock',
        MODULE8_AUTO_ROUTE_ENABLED: 'false',
        MODULE8_AUTO_ROUTE_SIMULATION: 'false',
        MODULE9_CORRIDOR_ENABLED: 'false',
        MODULE9_CORRIDOR_SIMULATION: 'false',
        MODULE12_LEARNING_ENABLED: 'false',
        MODULE12_INCLUDE_SIM: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    attachLogs(backend, (backendLogs = []));
    await waitForHttp(`http://127.0.0.1:${backendPort}/api/health`, 90_000, 'the isolated Fastify backend', backendLogs);

    vite = spawn(
      process.execPath,
      [
        resolve(repoRoot, 'node_modules/vite/bin/vite.js'),
        '--config', resolve(repoRoot, 'apps/dashboard/vite.config.ts'),
        '--host', '127.0.0.1',
        '--port', viteOrigin.slice(viteOrigin.lastIndexOf(':') + 1),
        '--strictPort',
      ],
      { cwd: repoRoot, env: { ...process.env, FORCE_COLOR: '0', RESUS_DASHBOARD_PROXY_TARGET: `http://127.0.0.1:${backendPort}` }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    attachLogs(vite, (viteLogs = []));
    await waitForHttp(`${viteOrigin}/`, 60_000, 'the dashboard Vite dev server', viteLogs);
  }, 240_000);

  afterAll(async () => {
    try {
      vi.unstubAllGlobals();
    } finally {
      try {
        stopChild(vite);
      } finally {
        try {
          stopChild(backend);
        } finally {
          try {
            await db?.$disconnect();
          } finally {
            owned?.cleanup();
          }
        }
      }
    }
  });

  it('verifies authenticated API requests, lifecycle projection, fleet freshness and error handling', async () => {
    const origin = viteOrigin;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === 'string' ? input
          : input instanceof URL ? input.href
            : (input as Request).url;
      return nativeFetch(raw.startsWith('/') ? `${origin}${raw}` : raw, init);
    });

    const jsonHeaders = (token?: string): Record<string, string> => ({
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    });
    const post = async (url: string, body: unknown, token?: string) =>
      fetch(url, { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify(body) });

    // --- the dashboard entry is served by Vite --------------------------------
    const page = await fetch('/');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain('Emergency Operations Dashboard');
    const entry = await fetch('/src/main.tsx');
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain('module_12_dashboard_analytics');

    // --- the Vite proxy reaches the isolated backend --------------------------
    const health = await fetch('/api/health');
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { status: string; env: string; modules: string[] };
    expect(healthBody).toMatchObject({ status: 'ok', env: 'test' });
    expect(healthBody.modules).toEqual(expect.arrayContaining(['module_11', 'module_12']));

    // --- authentication and error handling ------------------------------------
    await expect(login('dispatcher@stage419.test', 'not-the-password')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    } satisfies Partial<ApiError>);
    const session = await login('dispatcher@stage419.test', dispatcherPassword);
    expect(session.user.role).toBe('DISPATCHER');
    const driverSession = await login('driver@stage419.test', driverPassword);
    expect(driverSession.user.role).toBe('DRIVER');

    const anonymous = await fetch('/api/dashboard/live');
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    await expect(getLifecycle(session.token, 'EMG-STAGE419-ABSENT')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    } satisfies Partial<ApiError>);
    const invalidEmergency = await post('/api/emergencies', { incidentType: 'NOT_A_REAL_TYPE', severity: 'CRITICAL', latitude: 1, longitude: 1 }, session.token);
    expect(invalidEmergency.status).toBe(422);
    expect(((await invalidEmergency.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    // --- emergency intake over the live path ----------------------------------
    const created = await post('/api/emergencies', {
      incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL',
      latitude: scene.latitude, longitude: scene.longitude, isSimulation: false,
    }, session.token);
    expect(created.status).toBe(201);
    const emergency = (await created.json()) as { emergency: { id: string } };
    const emergencyId = emergency.emergency.id;
    const liveEmergencies = await getLiveEmergencies(session.token);
    expect(liveEmergencies.some((item) => item.id === emergencyId)).toBe(true);

    const classified = await fetch(`/api/emergencies/${encodeURIComponent(emergencyId)}`, {
      method: 'PATCH',
      headers: jsonHeaders(session.token),
      body: JSON.stringify({ normalizedClassification: { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL' } }),
    });
    expect(classified.status).toBe(200);

    // --- ambulance registration, assignment, acceptance and dispatch ----------
    const registered = await post('/api/ambulances', {
      vehicleNumber: 'STAGE419-LIVE-1', latitude: scene.latitude, longitude: scene.longitude,
      isSimulation: false, status: 'AVAILABLE',
    }, session.token);
    expect(registered.status).toBe(201);
    const ambulance = (await registered.json()) as { ambulance: { id: string } };
    const assignedDriver = await db!.user.findUnique({ where: { email: 'driver@stage419.test' } });
    await db!.ambulance.update({ where: { id: ambulance.ambulance.id }, data: { assignedDriverId: assignedDriver!.id } });

    const assigned = await post('/api/ambulances/assign', {
      emergencyId: emergencyId, latitude: scene.latitude, longitude: scene.longitude,
    }, session.token);
    expect(assigned.status).toBe(200);
    const assignment = (await assigned.json()) as { ambulanceId: string; assignmentId: string };
    expect(assignment.ambulanceId).toBe(ambulance.ambulance.id);

    const ownAssignment = await fetch('/api/drivers/me/assignment', { headers: jsonHeaders(driverSession.token) });
    expect(ownAssignment.status).toBe(200);
    expect(((await ownAssignment.json()) as { assignment: { id: string; status: string } }).assignment).toMatchObject({
      id: assignment.assignmentId, status: 'OFFERED',
    });
    await expect(getDriverAssignment(driverSession.token)).resolves.toMatchObject({
      assigned: true,
      assignment: { id: assignment.assignmentId, status: 'OFFERED' },
    });
    const accepted = await post(`/api/drivers/me/assignment/${assignment.assignmentId}/accept`, {}, driverSession.token);
    expect(accepted.status).toBe(200);

    const prematureRoute = await post(`/api/emergencies/${encodeURIComponent(emergencyId)}/routes`, { leg: 'RESPONSE' }, session.token);
    expect(prematureRoute.status).toBe(409);
    const dispatched = await post(`/api/ambulances/${ambulance.ambulance.id}/dispatch`, { emergencyId: emergencyId }, session.token);
    expect(dispatched.status).toBe(200);

    const hospitalSelection = await post(`/api/emergencies/${encodeURIComponent(emergencyId)}/hospital-selection`, {}, session.token);
    expect(hospitalSelection.status).toBe(200);
    expect(((await hospitalSelection.json()) as { result: { hospitalId: string } }).result.hospitalId).toBe(hospitalId);

    // --- routing stays on the deterministic mock provider ---------------------
    const route = await generateResponseRoute(session.token, emergencyId);
    expect(route).toMatchObject({ ambulanceId: ambulance.ambulance.id, provider: 'mock', isLiveTraffic: false });
    const routes = await getEmergencyRoutes(session.token, emergencyId);
    expect(routes.some((item) => item.id === route.id)).toBe(true);

    // --- authorized GPS update and fleet freshness ----------------------------
    const position = { latitude: 12.9721, longitude: 77.5951, speedKmh: 24, headingDeg: 91, accuracyM: 8, source: 'SPOOFED' };
    const foreignGps = await post('/api/ambulances/AMB-STAGE419-ABSENT/location', position, driverSession.token);
    expect(foreignGps.status).toBe(403);
    const gps = await post(`/api/ambulances/${ambulance.ambulance.id}/location`, position, driverSession.token);
    expect(gps.status).toBe(200);
    const fleet = await getLiveAmbulances(session.token);
    const live = fleet.find((item) => item.id === ambulance.ambulance.id);
    expect(live).toBeDefined();
    expect(live).toMatchObject({ latitude: position.latitude, longitude: position.longitude, isSimulation: false });
    const recordedAt = Date.parse(live!.lastLocationUpdate ?? '');
    expect(Number.isFinite(recordedAt)).toBe(true);
    expect(recordedAt).toBeLessThanOrEqual(Date.now());
    expect(recordedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(getLocationFreshness(live!)).toBe('CURRENT');

    // --- operator-reported lifecycle milestones and their projection ----------
    await expect(recordLifecycleMilestone(driverSession.token, emergencyId, 'scene-arrival')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    } satisfies Partial<ApiError>);
    const sceneArrival = await recordLifecycleMilestone(session.token, emergencyId, 'scene-arrival');
    expect(sceneArrival).toMatchObject({ duplicate: false, evidenceSource: 'OPERATOR_REPORTED', operationalOnly: true });
    const duplicateArrival = await recordLifecycleMilestone(session.token, emergencyId, 'scene-arrival');
    expect(duplicateArrival.duplicate).toBe(true);
    expect(duplicateArrival.event.id).toBe(sceneArrival.event.id);
    await recordLifecycleMilestone(session.token, emergencyId, 'patient-onboard');
    await recordLifecycleMilestone(session.token, emergencyId, 'hospital-arrival');
    const completion = await recordLifecycleMilestone(session.token, emergencyId, 'operational-completion');
    expect(completion.event.type).toBe('EMERGENCY_COMPLETED');

    const projection = await getLifecycle(session.token, emergencyId);
    expect(projection.facts.sceneArrival).toMatchObject({ ambulanceId: ambulance.ambulance.id, evidenceSource: 'OPERATOR_REPORTED' });
    expect(projection.facts.patientOnboard).toMatchObject({ evidenceSource: 'OPERATOR_REPORTED' });
    expect(projection.facts.hospitalArrival).toMatchObject({ hospitalId, evidenceSource: 'OPERATOR_REPORTED' });
    expect(projection.facts.operationalCompletion).toMatchObject({ status: 'COMPLETED', evidenceSource: 'OPERATOR_REPORTED' });

    // --- conflict handling for a milestone recorded out of order -------------
    const secondEmergency = await post('/api/emergencies', {
      incidentType: 'TRAUMA', severity: 'MEDIUM',
      latitude: scene.latitude + 0.01, longitude: scene.longitude + 0.01, isSimulation: false,
    }, session.token);
    expect(secondEmergency.status).toBe(201);
    const secondId = (await secondEmergency.json()) as { emergency: { id: string } };
    await expect(recordLifecycleMilestone(session.token, secondId.emergency.id, 'scene-arrival')).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    } satisfies Partial<ApiError>);

    // --- learning stays off and outcome-free of side effects ------------------
    const learningSamples = await fetch('/api/analytics/learning/samples', { headers: jsonHeaders(session.token) });
    expect(learningSamples.status).toBe(403);
    expect(await db!.learningSample.count()).toBe(0);
    expect(await db!.systemEvent.count({ where: { emergencyId: emergencyId, type: 'AMBULANCE_DISPATCHED' } })).toBe(1);
    expect(await db!.systemEvent.count({ where: { emergencyId: emergencyId, type: 'ROUTE_GENERATED' } })).toBe(1);
    expect(await db!.systemEvent.count({ where: { emergencyId: secondId.emergency.id, type: 'AMBULANCE_DISPATCHED' } })).toBe(0);
    expect(await db!.corridor.count()).toBe(0);
  }, 180_000);
});
