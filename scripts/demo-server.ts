/**
 * Stage 4.19 isolated demo backend.
 *
 * One command that starts the real Fastify composition against a disposable,
 * uniquely owned SQLite database, provisions deterministic demo fixtures, and
 * listens on loopback only. Stopping the process deletes the database it owned.
 *
 * It exists because the acceptance test's fixtures live inside the test
 * lifecycle: nothing could be demonstrated in a browser afterwards. This keeps
 * the same isolation contract as `tests/helpers/isolatedTestDatabase.ts`:
 *
 *   - the database path is issued by the helper under the OS temporary root and
 *     must match `DATABASE_URL` exactly;
 *   - migrations run only against that file;
 *   - Module 6-9 automation stays fail-closed disabled;
 *   - no external provider, telephony transport or shared database is touched;
 *   - the owned database is removed on graceful shutdown.
 *
 * Run (from the repository root):
 *   RESUS_DEMO_ISOLATED=true npm run demo:server
 *
 * Credentials are generated per run and printed once to this process's stdout.
 * They are never written to a file, never committed, and never documented.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { audioCarrier } from '@resus/speech';
import { buildServer, type BuiltServer } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { HeuristicProvider } from '../modules/module_05_bystander_assistance/src/llm/heuristicProvider.js';
import { createIsolatedTestDatabase } from '../tests/helpers/isolatedTestDatabase.js';

type DemoMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface DemoRequest {
  method: DemoMethod;
  url: string;
  headers?: Record<string, string>;
  payload?: string | Buffer | Record<string, unknown>;
}

interface DemoFixtures {
  emergencyId: string;
  callSessionId: string;
  ambulanceId: string;
  vehicleNumber: string;
  hospitalId: string;
  accounts: Array<{ label: string; email: string; password: string; role: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const schemaPath = resolve(repoRoot, 'modules/module_11_database_event_system/prisma/schema.prisma');

if (process.env.RESUS_DEMO_ISOLATED !== 'true') {
  console.error(
    '[demo-server] refused to start: set RESUS_DEMO_ISOLATED=true to confirm this run may create a disposable local database.\n' +
      '[demo-server] never point this launcher at a shared database; it owns only the temp file it creates.',
  );
  process.exit(1);
}

const port = process.env.DEMO_PORT ?? '4000';
const host = '127.0.0.1';
const stopFile = resolve(tmpdir(), `resus-demo-server-${port}.stop`);
const demoBaseUrl = process.env.DEMO_BASE_URL ?? `http://127.0.0.1:${port}`;
const dashboardUrl = process.env.DEMO_DASHBOARD_URL ?? 'http://127.0.0.1:5173';

function demoPassword(): string {
  return `Demo419-${randomBytes(12).toString('base64url')}!`;
}

async function main(): Promise<void> {
  // Fail-closed defaults for everything the composition reads from process.env.
  // The isolated helper additionally pins Module 6-9 automation to disabled and
  // issues this run's DATABASE_URL.
  process.env.TRANSPORT_PROVIDER = 'loopback';
  process.env.SPEECH_PROVIDER = 'loopback';
  process.env.SPEECH_SYNTHESIS_PROVIDER = 'loopback';
  process.env.MODULE3_NLP_ENABLED = 'false';
  process.env.MODULE12_LEARNING_ENABLED = 'false';
  // Do not require or contact Ollama in this offline demo. Module 5 remains
  // visibly degraded and uses its deterministic non-LLM extraction fallback.
  process.env.LLM_PROVIDER = 'heuristic-fallback';
  // This isolated demo contains only simulation fixtures, so let the dashboard
  // display them while learning remains disabled.
  process.env.MODULE12_INCLUDE_SIM = 'true';

  const testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
  // The demo provisions an explicit mock route for its simulated emergency.
  // Keep automatic route generation disabled; this only permits that explicit
  // operator-triggered route in the owned, disposable demo database.
  process.env.MODULE8_AUTO_ROUTE_SIMULATION = 'true';
  // Hospital selection is also an explicit operator action in this demo. Keep
  // automatic hospital selection disabled while allowing the simulated record.
  process.env.MODULE7_AUTO_SELECT_SIMULATION = 'true';
  const db = new PrismaClient({ datasources: { db: { url: testDatabase.databaseUrl } } });

  let server: BuiltServer;
  let stopping = false;
  const watchHandle: { timer?: NodeJS.Timeout } = {};

  const stop = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (watchHandle.timer) clearInterval(watchHandle.timer);
    try {
      await server.shutdown();
    } catch (error) {
      console.error('[demo-server] shutdown error:', error);
    }
    try {
      await db.$disconnect();
    } finally {
      try {
        testDatabase.cleanup();
        console.log(`[demo-server] disposed owned database ${testDatabase.databasePath}`);
      } catch (error) {
        console.error('[demo-server] owned database cleanup failed:', error);
      }
      if (existsSync(stopFile)) rmSync(stopFile, { force: true });
    }
    console.log(`[demo-server] stopped (${reason})`);
    process.exit(0);
  };

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  try {
    server = await buildServer(
      // The demo backend always runs as `test`: fixture records are then stored
      // with dataClassification TEST instead of being presented as operational
      // data, and the database is always disposable.
      loadServerConfig({
        NODE_ENV: 'test',
        HOST: host,
        PORT: port,
        LOG_LEVEL: process.env.DEMO_LOG_LEVEL ?? 'warn',
        CORS_ORIGIN: `${dashboardUrl},http://localhost:5173,http://127.0.0.1:5173`,
        JWT_SECRET: randomBytes(48).toString('hex'),
        JWT_EXPIRES_IN: '1h',
        MODULE3_NLP_ENABLED: 'false',
      }),
      { db, ownsDatabaseClient: false, module5Providers: [new HeuristicProvider()] },
    );
  } catch (error) {
    testDatabase.cleanup();
    throw error;
  }

  const call = async (request: DemoRequest): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await server.fastify.inject(request);
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };

  const expect = async (request: DemoRequest, allowed: number | number[], label: string): Promise<Record<string, unknown>> => {
    const { status, body } = await call(request);
    const accepted = Array.isArray(allowed) ? allowed : [allowed];
    if (!accepted.includes(status)) {
      throw new Error(
        `[demo-server] ${label}: expected HTTP ${accepted.join('/')}, received ${status} — ${JSON.stringify(body).slice(0, 400)}`,
      );
    }
    return body;
  };

  const fixtures = await seed(server, db, expect);

  await server.fastify.listen({ port: Number(port), host });
  if (existsSync(stopFile)) rmSync(stopFile, { force: true });
  watchHandle.timer = setInterval(() => {
    if (existsSync(stopFile)) void stop('stop-file');
  }, 500);

  const lines = [
    '',
    '[demo-server] isolated demo backend ready',
    `[demo-server] listening        : ${demoBaseUrl} (loopback only)`,
    `[demo-server] owned database   : ${testDatabase.databasePath}`,
    `[demo-server] data classification of fixtures: TEST (NODE_ENV=test)`,
    `[demo-server] dashboard        : ${dashboardUrl} (start separately: npm run dev, run from apps/dashboard)`,
    '[demo-server] test-only accounts (printed once, never stored):',
    ...fixtures.accounts.map((account) => `[demo-server]   ${account.role.padEnd(10)} ${account.email} / ${account.password}`),
    `[demo-server] demo emergency   : ${fixtures.emergencyId}`,
    `[demo-server] demo ambulance   : ${fixtures.vehicleNumber} (${fixtures.ambulanceId})`,
    `[demo-server] demo hospital    : ${fixtures.hospitalId}`,
    `[demo-server] stop with Ctrl+C, or create the sentinel file: ${stopFile}`,
    '',
  ];
  console.log(lines.join('\n'));
}

/** Provisions deterministic demo fixtures through the real authenticated routes. */
async function seed(
  server: BuiltServer,
  db: PrismaClient,
  expect: (request: DemoRequest, allowed: number | number[], label: string) => Promise<Record<string, unknown>>,
): Promise<DemoFixtures> {
  const dispatcherPassword = process.env.DEMO_DISPATCHER_PASSWORD ?? demoPassword();
  const driverPassword = process.env.DEMO_DRIVER_PASSWORD ?? demoPassword();
  const operatorPassword = process.env.DEMO_OPERATOR_PASSWORD ?? demoPassword();
  const accounts = [
    { label: 'dispatcher', email: process.env.DEMO_DISPATCHER_EMAIL ?? 'dispatcher@demo.test', password: dispatcherPassword, role: 'DISPATCHER' },
    { label: 'driver', email: process.env.DEMO_DRIVER_EMAIL ?? 'driver@demo.test', password: driverPassword, role: 'DRIVER' },
    { label: 'operator', email: process.env.DEMO_OPERATOR_EMAIL ?? 'operator@demo.test', password: operatorPassword, role: 'OPERATOR' },
  ];

  const users = [] as Array<{ id: string; email: string; role: string }>;
  for (const account of accounts) {
    const user = await server.module11.users.create({
      email: account.email,
      displayName: `Demo ${account.role}`,
      passwordHash: await bcrypt.hash(account.password, 4),
      role: account.role,
    });
    users.push({ id: user.id, email: user.email, role: user.role });
  }
  const dispatcher = users[0]!;
  const driver = users[1]!;
  const operator = users[2]!;

  const login = async (email: string, password: string): Promise<string> => {
    const body = await expect({ method: 'POST', url: '/api/auth/login', payload: { email, password } }, 200, `login ${email}`);
    return String((body.token as string) ?? '');
  };
  const dispatcherToken = await login(dispatcher.email, dispatcherPassword);
  const driverToken = await login(driver.email, driverPassword);
  const operatorToken = await login(operator.email, operatorPassword);
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  const scene = { latitude: 12.9716, longitude: 77.5946 };
  const vehicleNumber = `DEMO419-${randomBytes(3).toString('hex').toUpperCase()}`;
  const ambulance = await server.module11.ambulances.create({
    vehicleNumber,
    latitude: scene.latitude,
    longitude: scene.longitude,
    status: 'AVAILABLE',
    isSimulation: true,
  });
  await db.ambulance.update({ where: { id: ambulance.id }, data: { assignedDriverId: driver.id } });

  const hospitalId = `HSP-DEMO419-${randomBytes(3).toString('hex').toUpperCase()}`;
  await db.hospital.create({
    data: {
      id: hospitalId,
      name: 'Demo 419 Isolated Hospital',
      latitude: scene.latitude + 0.02,
      longitude: scene.longitude + 0.02,
      status: 'OPEN',
      capabilitiesJson: JSON.stringify(['ED_CARDIAC']),
      traumaLevel: 2,
      acceptingEmergencies: true,
      isSimulation: true,
      resources: { create: { id: `HRS-DEMO419-${randomBytes(3).toString('hex').toUpperCase()}`, resourceType: 'ICU_BED', code: '', total: 10, available: 10 } },
    },
  });

  // Emergency intake through the authenticated API, not direct table writes.
  const created = await expect(
    {
      method: 'POST',
      url: '/api/emergencies',
      headers: auth(dispatcherToken),
      payload: { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL', latitude: scene.latitude, longitude: scene.longitude, isSimulation: true },
    },
    201,
    'create emergency',
  );
  const emergency = created.emergency as { id: string };
  const callSession = created.callSession as { id: string };

  await expect(
    {
      method: 'POST',
      url: `/speech/transcribe?callSessionId=${encodeURIComponent(callSession.id)}&emergencyId=${encodeURIComponent(emergency.id)}`,
      headers: { ...auth(operatorToken), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(audioCarrier('Caller reports a collapse; the patient is not breathing normally.')),
    },
    200,
    'persist final transcript',
  );

  await expect(
    {
      method: 'PATCH',
      url: `/api/emergencies/${encodeURIComponent(emergency.id)}`,
      headers: auth(dispatcherToken),
      payload: { normalizedClassification: { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL' } },
    },
    200,
    'operator-confirmed classification',
  );

  await expect(
    {
      method: 'POST',
      url: '/api/ambulances/assign',
      headers: auth(dispatcherToken),
      payload: { emergencyId: emergency.id, ...scene },
    },
    200,
    'ambulance assignment',
  );
  const assignments = await server.module11.ambulances.assignmentsForEmergency(emergency.id);
  const assignmentId = assignments[assignments.length - 1]?.id;
  if (!assignmentId) throw new Error('[demo-server] assignment was not persisted.');
  await expect(
    { method: 'POST', url: `/api/drivers/me/assignment/${assignmentId}/accept`, headers: auth(driverToken), payload: {} },
    200,
    'driver accept',
  );

  await expect(
    {
      method: 'POST',
      url: `/api/ambulances/${encodeURIComponent(ambulance.id)}/location`,
      headers: auth(driverToken),
      payload: { latitude: scene.latitude + 0.0005, longitude: scene.longitude + 0.0005, speedKmh: 24, headingDeg: 91, accuracyM: 8, source: 'SPOOFED', isSimulation: true },
    },
    200,
    'driver GPS update',
  );

  await expect(
    { method: 'POST', url: `/api/ambulances/${encodeURIComponent(ambulance.id)}/dispatch`, headers: auth(dispatcherToken), payload: { emergencyId: emergency.id } },
    200,
    'explicit dispatch',
  );

  await expect(
    {
      method: 'POST',
      url: `/api/emergencies/${encodeURIComponent(emergency.id)}/routes`,
      headers: auth(dispatcherToken),
      payload: { leg: 'RESPONSE' },
    },
    200,
    'deterministic mock route',
  );

  await expect(
    {
      method: 'POST',
      url: `/api/emergencies/${encodeURIComponent(emergency.id)}/hospital-selection`,
      headers: auth(dispatcherToken),
      payload: {},
    },
    200,
    'hospital selection',
  );

  // Operator-reported lifecycle milestones, in dependency order. Each is an
  // authenticated report, never an independently verified observation.
  for (const milestone of ['scene-arrival', 'patient-onboard', 'hospital-arrival', 'operational-completion']) {
    await expect(
      {
        method: 'POST',
        url: `/api/emergencies/${encodeURIComponent(emergency.id)}/lifecycle-milestones/${milestone}`,
        headers: auth(dispatcherToken),
        payload: {},
      },
      [200, 201],
      `lifecycle milestone ${milestone}`,
    );
  }

  return {
    emergencyId: emergency.id,
    callSessionId: callSession.id,
    ambulanceId: ambulance.id,
    vehicleNumber,
    hospitalId,
    accounts: accounts.map((account) => ({ label: account.label, email: account.email, password: account.password, role: account.role })),
  };
}

main().catch((error: unknown) => {
  console.error('[demo-server] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
