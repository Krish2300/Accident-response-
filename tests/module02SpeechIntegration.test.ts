import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { buildServer, type BuiltServer } from '../apps/server/src/app.js';
import { Module2, LoopbackSpeechProvider, audioCarrier } from '@resus/speech';

/**
 * Module 2 integration test against the real database and the real route adapter.
 *
 * Lives at the repository root because it deliberately spans four boundaries:
 * Module 1's call lifecycle, Module 2's speech service, the server's route
 * adapter, and Module 11's transcript persistence.
 *
 * The point of the happy path here is the join: audio posted over HTTP for a
 * session that Module 1 actually created must land as a sequenced transcript row
 * with its event, and an interim result for the same session must leave no row
 * behind. Neither fact is visible from the unit tests, which fake persistence.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');
const prismaCli = resolve(repoRoot, 'node_modules/prisma/build/index.js');
const devDbPath = resolve(prismaDir, 'dev.db');
const dbPath = resolve(prismaDir, 'test-module-02.db');
const dbUrl = `file:${dbPath.replace(/\\/g, '/')}`;

function removeDatabaseFiles(): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

let db: PrismaClient;
let server: BuiltServer;
let app: BuiltServer['fastify'];
let module11: BuiltServer['module11'];
let module2: BuiltServer['module2'];
let adminAuth: { authorization: string };

/** Signs a real operator token with the server's own secret. */
function authHeaders(): { authorization: string } {
  return adminAuth;
}

/** Auth plus the content type a real audio client sends. */
function audioHeaders(): { authorization: string; 'content-type': string } {
  return { ...adminAuth, 'content-type': 'application/octet-stream' };
}

beforeAll(async () => {
  removeDatabaseFiles();
  process.env.DATABASE_URL = dbUrl;

  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
  });

  db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  const probe = await db.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
  const target = probe.find((row) => row.name === 'main')?.file ?? '';
  if (target && resolve(target) === resolve(devDbPath)) {
    throw new Error(`Refusing to run: resolved to the development database (${devDbPath}).`);
  }

  // The real server, wired exactly as production wires it.
  server = await buildServer();
  app = server.fastify;
  module11 = server.module11;
  module2 = server.module2;
  // Signed with the running server's own secret, so these tests exercise the real
  // authentication path rather than a stubbed one.
  adminAuth = { authorization: `Bearer ${app.jwt.sign({ sub: 'test-operator', role: 'ADMIN', email: 'test@local' })}` };
  await app.ready();
}, 180000);

afterAll(async () => {
  await server?.shutdown();
  await db?.$disconnect();
  removeDatabaseFiles();
});

const location = { latitude: 12.9716, longitude: 77.5946, incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL' };

/** Opens a real call through Module 1 and returns both ids. */
async function openCall(): Promise<{ emergencyId: string; callSessionId: string }> {
  const response = await app.inject({ method: 'POST', url: '/calls', payload: location });
  const body = response.json();
  return { emergencyId: body.emergency.id, callSessionId: body.session.id };
}

describe('POST /speech/transcribe', () => {
  it('stores a final utterance as a sequenced transcript row with its event', async () => {
    const { emergencyId, callSessionId } = await openCall();

    const response = await app.inject({
      method: 'POST',
      url: `/speech/transcribe?callSessionId=${callSessionId}&emergencyId=${emergencyId}&language=en`,
      headers: audioHeaders(),
      payload: Buffer.from(audioCarrier('He is not breathing.')),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(true);
    expect(body.text).toBe('He is not breathing.');
    expect(body.isLive).toBe(false);
    expect(body.persisted.sequence).toBe(1);

    const rows = await db.transcript.findMany({ where: { emergencyId }, orderBy: { sequence: 'asc' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ speaker: 'CALLER', text: 'He is not breathing.', isFinal: true });

    const events = await module11.eventQuery.list({ emergencyId });
    const types = events.items.map((event) => event.type);
    // Emitted by the repository inside its transaction; exactly one, no duplicate.
    expect(types.filter((type) => type === 'TRANSCRIPT_UPDATED')).toHaveLength(1);
  });

  it('numbers a second utterance after the first', async () => {
    const { emergencyId, callSessionId } = await openCall();

    for (const text of ['He is not breathing.', 'I am doing chest compressions.']) {
      await app.inject({
        method: 'POST',
        url: `/speech/transcribe?callSessionId=${callSessionId}&emergencyId=${emergencyId}`,
        headers: audioHeaders(),
        payload: Buffer.from(audioCarrier(text)),
      });
    }

    const rows = await db.transcript.findMany({ where: { emergencyId }, orderBy: { sequence: 'asc' } });
    expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
  });

  it('publishes an interim result without writing a row', async () => {
    const { emergencyId, callSessionId } = await openCall();

    const response = await app.inject({
      method: 'POST',
      url: `/speech/transcribe?callSessionId=${callSessionId}&emergencyId=${emergencyId}&isFinal=false`,
      headers: audioHeaders(),
      payload: Buffer.from(audioCarrier('He is not')),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().persisted).toBeNull();

    // Interim guesses must never become part of the incident record.
    expect(await db.transcript.count({ where: { emergencyId } })).toBe(0);

    const partial = await app.inject({
      method: 'GET',
      url: `/speech/partial/${callSessionId}`,
      headers: authHeaders(),
    });
    expect(partial.json().text).toBe('He is not');

    const events = await module11.eventQuery.list({ emergencyId });
    expect(events.items.filter((event) => event.type === 'TRANSCRIPT_PARTIAL')).toHaveLength(1);
  });

  it('keeps a low-confidence utterance out of the record', async () => {
    // Driven through the service with a strict floor rather than over HTTP: the
    // production server is built from configuration, so the threshold behaviour
    // belongs to the unit tests, and asserting it here would only be testing an
    // injected object that production never has.
    const { emergencyId, callSessionId } = await openCall();
    const strict = new Module2({
      calls: module11.calls,
      events: module11.eventPublisher,
      config: { ...module2.config, speech: { ...module2.config.speech, minConfidence: 0.99 } },
      speech: new LoopbackSpeechProvider({ confidence: 0.5 }),
    });

    const result = await strict.speech.transcribe({
      callSessionId,
      emergencyId,
      audio: audioCarrier('unclear mumbling'),
      language: 'en',
    });

    expect(result.accepted).toBe(false);
    expect(result.text).toBe('');
    expect(await db.transcript.count({ where: { emergencyId } })).toBe(0);
  });

  it('refuses a session that belongs to a different emergency', async () => {
    const first = await openCall();
    const second = await openCall();

    const response = await app.inject({
      method: 'POST',
      url: `/speech/transcribe?callSessionId=${first.callSessionId}&emergencyId=${second.emergencyId}`,
      headers: audioHeaders(),
      payload: Buffer.from(audioCarrier('misattributed')),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(await db.transcript.count({ where: { emergencyId: second.emergencyId } })).toBe(0);
  });

  it('refuses speech on a call that has been hung up', async () => {
    const { emergencyId, callSessionId } = await openCall();
    await app.inject({
      method: 'POST',
      url: `/calls/${callSessionId}/hangup`,
      headers: authHeaders(),
      payload: {},
    });

    const response = await app.inject({
      method: 'POST',
      url: `/speech/transcribe?callSessionId=${callSessionId}&emergencyId=${emergencyId}`,
      headers: audioHeaders(),
      payload: Buffer.from(audioCarrier('still there?')),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONVERSATION_CLOSED');
  });

  it('rejects a request missing the session id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/speech/transcribe?emergencyId=EMG-1',
      headers: audioHeaders(),
      payload: Buffer.from(audioCarrier('x')),
    });

    expect(response.statusCode).toBe(422);
  });
});

describe('POST /speech/speak', () => {
  it('records the attempt and reports that nothing is audible', async () => {
    const { emergencyId, callSessionId } = await openCall();

    const response = await app.inject({
      method: 'POST',
      url: '/speech/speak',
      headers: authHeaders(),
      payload: {
        emergencyId,
        callSessionId,
        text: 'Are they breathing normally?',
        language: 'en',
        tone: 'CALM',
        verbatimProtocolText: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.isAudible).toBe(false);
    expect(body.isLive).toBe(false);
    expect(body.verbatimProtocolText).toBe(true);

    const events = await module11.eventQuery.list({ emergencyId });
    const synthesized = events.items.find((event) => event.type === 'SPEECH_SYNTHESIZED');
    expect(synthesized).toBeDefined();
    expect((synthesized?.payload as { verbatimProtocolText: boolean }).verbatimProtocolText).toBe(true);
  });

  it('requires the caller to state whether the text is verbatim', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/speech/speak',
      headers: authHeaders(),
      payload: { text: 'Check their breathing.', language: 'en', tone: 'CALM' },
    });

    // A defaulted value here would write a record claiming the caller heard
    // reviewed wording when they did not.
    expect(response.statusCode).toBe(422);
  });

  it('refuses a language the build cannot speak', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/speech/speak',
      headers: authHeaders(),
      payload: { text: 'Hello', language: 'de', tone: 'CALM', verbatimProtocolText: true },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('SPEECH_LANGUAGE_UNSUPPORTED');
  });
});

describe('GET /speech/status', () => {
  it('reports both providers as development adapters', async () => {
    const response = await app.inject({ method: 'GET', url: '/speech/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      speech: { provider: 'loopback', isLive: false },
      synthesis: { provider: 'loopback', isLive: false },
    });
  });
});

describe('route table', () => {
  it('mounts every Module 2 route and keeps them authenticated', () => {
    const urls = module2.routes().map((route) => `${route.method} ${route.url}`);

    expect(urls).toContain('POST /speech/transcribe');
    expect(urls).toContain('POST /speech/speak');
    expect(urls).toContain('GET /speech/status');

    const transcribe = module2.routes().find((route) => route.url === '/speech/transcribe');
    expect(transcribe?.auth?.public).toBeUndefined();
    expect(transcribe?.auth?.roles).toContain('OPERATOR');
    // No body schema: the body is raw audio, and the adapter would try to
    // validate it against one.
    expect(transcribe?.body).toBeUndefined();
    expect(transcribe?.query).toBeDefined();
  });
});
