import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { MockRoutingProvider } from '@resus/routing';
import { noopLogger } from '@resus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildServer, type BuiltServer } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { HeuristicProvider } from '../modules/module_05_bystander_assistance/src/llm/heuristicProvider.js';
import {
  assertDatabaseUrlMatches,
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from './helpers/isolatedTestDatabase.js';

/**
 * Synthetic end-to-end proof of Module 5 protocol progression.
 *
 * The live telephony run (Stage D) showed a recognised inbound answer failing
 * to advance the `confirm-location` step: the caller answered the protocol's
 * own question and the session looped, so dispatch was never given an address.
 * This test reproduces that exact conversation shape through the *composed*
 * server — real Fastify routes, real Module 5 session service, real engine, the
 * active rule-based extractor, real SQLite persistence — with nothing stubbed
 * except the routing provider and the absence of a telephone.
 *
 * It runs only under the isolated-composition gate (`RESUS_RUN_ISOLATED_COMPOSITION_TEST`)
 * against a database it owns under the approved temporary root. It never uses a
 * real phone number, a real emergency, or a real language model: the active
 * provider is named by reading `/api/health/llm` back from the running server.
 *
 * What it proves, and what it deliberately does not:
 *   - an answer in the shape the protocol asked for collects `caller_location`
 *     verbatim and advances `confirm-location -> confirm-safety`;
 *   - a vague or non-answer does NOT advance — the gate is not weakened;
 *   - the decision is persisted (session, step bookkeeping, append-only events)
 *     and the caller/system words are written to the call transcript;
 *   - the caller-stated location is recorded only as an auditable candidate
 *     with no coordinates, and the emergency's coordinates are untouched;
 *   - no audio, no speech recognition and no clinical review is exercised
 *     here — those stay BLOCKED/UNVERIFIED and are reported as such.
 */
const runCompositionIntegration = process.env.RESUS_RUN_ISOLATED_COMPOSITION_TEST === 'true';
const progressionDescribe = runCompositionIntegration ? describe : describe.skip;

type TurnResponse = {
  action: string;
  currentStepId: string;
  speech: string;
  instruction: string;
  degraded: boolean;
  escalationRequired: boolean;
  session: { emergencyId: string; currentStep: string; collectedFacts: Record<string, unknown> };
  steps?: Array<{ stepId: string; status: string }>;
};

progressionDescribe('synthetic protocol progression through the composed server', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const schemaPath = resolve(repoRoot, 'modules/module_11_database_event_system/prisma/schema.prisma');
  const restoredKeys = [
    'TRANSPORT_PROVIDER',
    'MODULE3_NLP_ENABLED',
    'MODULE7_AUTO_SELECT_SIMULATION',
    'MODULE8_AUTO_ROUTE_SIMULATION',
    'LLM_PROVIDER',
  ] as const;
  const previousExternalConfig: Record<string, string | undefined> = {};

  let testDatabase: IsolatedTestDatabase | undefined;
  let db: PrismaClient | undefined;
  let server: BuiltServer | undefined;
  let authHeaders: Record<string, string> = {};

  const scene = { latitude: 12.9716, longitude: 77.5946 };
  const locationAnswer = 'the exact location is building alpha, floor two, near the main gate';
  const locationFact = 'building alpha, floor two, near the main gate';

  beforeAll(async () => {
    for (const key of restoredKeys) previousExternalConfig[key] = process.env[key];

    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const approvedRoot = resolve(tmpdir(), 'resus-isolated-integration-tests');
    const absoluteDatabasePath = resolve(testDatabase.databasePath);
    expect(absoluteDatabasePath.startsWith(`${approvedRoot}${sep}`)).toBe(true);
    assertDatabaseUrlMatches(testDatabase.databaseUrl, absoluteDatabasePath);

    process.env.TRANSPORT_PROVIDER = 'loopback';
    process.env.MODULE3_NLP_ENABLED = 'false';
    // Automatic subscribers stay disabled by the helper's fail-closed flags;
    // these two only permit simulated rows on the explicit route endpoints.
    process.env.MODULE7_AUTO_SELECT_SIMULATION = 'true';
    process.env.MODULE8_AUTO_ROUTE_SIMULATION = 'true';
    // The active provider is named, never assumed: the real rule-based
    // fallback is supplied as the provider implementation and configured as
    // the primary, so no Ollama process or network request is involved — and
    // the assertion below reads the name back from `/api/health/llm` on the
    // running server rather than trusting this setting.
    process.env.LLM_PROVIDER = 'heuristic-fallback';

    db = new PrismaClient({ datasources: { db: { url: testDatabase.databaseUrl } } });
    server = await buildServer(
      loadServerConfig({
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '4000',
        LOG_LEVEL: 'error',
        JWT_SECRET: 'protocol-progression-isolated-test-secret-only',
        MODULE3_NLP_ENABLED: 'false',
      }),
      {
        db,
        ownsDatabaseClient: false,
        logger: noopLogger,
        routingProviders: { primary: new MockRoutingProvider(40), fallback: new MockRoutingProvider(41) },
        module5Providers: [new HeuristicProvider()],
      },
    );

    const password = 'progression-isolated-password';
    const dispatcher = await server.module11.users.create({
      email: 'progression-dispatcher@resus.test',
      displayName: 'Isolated Progression Dispatcher',
      passwordHash: await bcrypt.hash(password, 4),
      role: 'DISPATCHER',
    });
    const login = await server.fastify.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: dispatcher.email, password },
    });
    expect(login.statusCode).toBe(200);
    authHeaders = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
  });

  afterAll(async () => {
    try {
      await server?.shutdown();
    } finally {
      try {
        await db?.$disconnect();
      } finally {
        try {
          testDatabase?.cleanup();
        } finally {
          for (const [key, value] of Object.entries(previousExternalConfig)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      }
    }
  });

  const requireServer = (): BuiltServer => {
    expect(server).toBeDefined();
    return server as BuiltServer;
  };

  const createEmergency = async (): Promise<{ id: string; callSessionId: string }> => {
    const response = await requireServer().fastify.inject({
      method: 'POST',
      url: '/api/emergencies',
      headers: authHeaders,
      payload: {
        incidentType: 'OTHER',
        severity: 'MEDIUM',
        latitude: scene.latitude,
        longitude: scene.longitude,
        isSimulation: true,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { emergency: { id: string }; callSession: { id: string } };
    return { id: body.emergency.id, callSessionId: body.callSession.id };
  };

  const startGeneralTriage = async (emergencyId: string): Promise<string> => {
    const response = await requireServer().fastify.inject({
      method: 'POST',
      url: '/api/protocol-sessions',
      payload: { emergencyId, protocolId: 'general-triage' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { session: { id: string; currentStep: string } };
    expect(body.session.currentStep).toBe('confirm-location');
    return body.session.id;
  };

  const speak = async (sessionId: string, utterance: string): Promise<TurnResponse> => {
    const response = await requireServer().fastify.inject({
      method: 'POST',
      url: `/api/protocol-sessions/${sessionId}/utterance`,
      payload: { utterance },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as TurnResponse;
  };

  it('names the active extraction provider as the configured rule-based fallback', async () => {
    const response = await requireServer().fastify.inject({ method: 'GET', url: '/api/health/llm' });
    expect(response.statusCode).toBe(200);
    // Named, not assumed: this is the provider every extraction below runs on.
    expect(response.json()).toMatchObject({
      provider: 'heuristic-fallback',
      available: true,
      registered: expect.arrayContaining(['heuristic-fallback']),
    });
  });

  it('advances confirm-location to confirm-safety on the answer to the location question and persists it', async () => {
    const emergency = await createEmergency();
    const sessionId = await startGeneralTriage(emergency.id);

    const turn = await speak(sessionId, locationAnswer);

    // 1. The engine advanced, on the caller's own words.
    expect(turn).toMatchObject({
      action: 'ADVANCED',
      currentStepId: 'confirm-safety',
      escalationRequired: false,
      session: {
        emergencyId: emergency.id,
        currentStep: 'confirm-safety',
        collectedFacts: { caller_location: locationFact },
      },
    });
    expect(turn.degraded).toBe(true);
    expect(turn.speech.trim()).not.toBe('');

    // 2. The decision is durable: re-read from the database, not from the reply.
    const reread = await requireServer().fastify.inject({
      method: 'GET',
      url: `/api/protocol-sessions/${sessionId}`,
    });
    expect(reread.statusCode).toBe(200);
    const persisted = reread.json() as {
      session: { currentStep: string; collectedFacts: Record<string, unknown> };
      steps: Array<{ stepId: string; status: string; completedAt: string | null }>;
    };
    expect(persisted.session.currentStep).toBe('confirm-safety');
    expect(persisted.session.collectedFacts.caller_location).toBe(locationFact);
    const completedStep = persisted.steps.find((step) => step.stepId === 'confirm-location');
    expect(completedStep?.status).toBe('COMPLETED');
    expect(completedStep?.completedAt).toEqual(expect.any(String));

    // 3. The append-only event log carries the progression.
    const events = await requireServer().module11.eventQuery.list({ emergencyId: emergency.id });
    const stepCompleted = events.items.find(
      (event) =>
        event.type === 'PROTOCOL_STEP_COMPLETED' &&
        (event.payload as Record<string, unknown>).stepId === 'confirm-location',
    );
    expect(stepCompleted).toBeDefined();
    expect(stepCompleted?.payload).toMatchObject({
      stepId: 'confirm-location',
      nextStepId: 'confirm-safety',
    });

    // 4. The conversation record shows the words that caused it, in order.
    const transcript = await db!.transcript.findMany({
      where: { callSessionId: emergency.callSessionId },
      orderBy: { sequence: 'asc' },
    });
    const callerRow = transcript.find((row) => row.speaker === 'CALLER' && row.text === locationAnswer);
    expect(callerRow).toBeDefined();
    const systemRow = transcript.find(
      (row) => row.speaker === 'SYSTEM' && row.sequence > (callerRow?.sequence ?? 0),
    );
    expect(systemRow).toBeDefined();
    expect(systemRow!.text.trim()).not.toBe('');

    // 5. The caller's location is recorded as an auditable candidate only: no
    //    coordinates are invented and the emergency's coordinates do not move.
    const candidates = events.items.filter(
      (event) => event.type === 'EMERGENCY_LOCATION_CANDIDATE',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.payload).toMatchObject({
      source: 'CALLER_STATED',
      outcome: 'UNAVAILABLE',
      provider: 'unconfigured',
      callerLocationText: locationFact,
      candidateLatitude: null,
      candidateLongitude: null,
      attempt: 1,
    });
    const emergencyRow = await requireServer().module11.emergencies.requireById(emergency.id);
    expect(emergencyRow.latitude).toBe(scene.latitude);
    expect(emergencyRow.longitude).toBe(scene.longitude);
  });

  it('does not advance confirm-location on a vague or unknown location answer', async () => {
    // Safety direction: broadening the accepted answer shape must not let a
    // non-address move the protocol or reach dispatch as a location candidate.
    const emergency = await createEmergency();
    const sessionId = await startGeneralTriage(emergency.id);

    const turn = await speak(sessionId, 'the exact location is here');

    expect(turn.action).not.toBe('ADVANCED');
    expect(turn.currentStepId).toBe('confirm-location');
    expect(turn.session.currentStep).toBe('confirm-location');
    expect(turn.session.collectedFacts.caller_location ?? null).toBeNull();
    expect(turn.speech).toMatch(/exact location/i);

    const persisted = await requireServer().fastify.inject({
      method: 'GET',
      url: `/api/protocol-sessions/${sessionId}`,
    });
    expect((persisted.json() as { session: { currentStep: string } }).session.currentStep).toBe(
      'confirm-location',
    );

    const events = await requireServer().module11.eventQuery.list({ emergencyId: emergency.id });
    expect(
      events.items.filter((event) => event.type === 'EMERGENCY_LOCATION_CANDIDATE'),
    ).toHaveLength(0);
    expect(
      events.items.filter(
        (event) =>
          event.type === 'PROTOCOL_STEP_COMPLETED' &&
          (event.payload as Record<string, unknown>).stepId === 'confirm-location',
      ),
    ).toHaveLength(0);
  });
});
