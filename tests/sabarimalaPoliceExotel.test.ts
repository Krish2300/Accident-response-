import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { findSabarimalaPlace, SABARIMALA_PLACES } from '@resus/core';
import { buildServer, type BuiltServer } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { mediaFrame, parseInbound, UtteranceSegmenter } from '../apps/server/src/telephony/exotelStream.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './helpers/isolatedTestDatabase.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = resolve(repoRoot, 'modules/module_11_database_event_system/prisma/schema.prisma');

describe('Sabarimala gazetteer', () => {
  it.each([
    ['he collapsed near Appachimedu', 'Appachimedu'],
    ['we are at the 18 steps', 'Sannidhanam'],
    ['അഴുത കടവിൽ', 'Azhutha'],
    ['on the road near Kanamala bridge', 'Kanamala'],
    ['Erumely Vavar mosque', 'Erumely'],
    ['between Pullumedu and Uppupara', 'Pullumedu'],
    ['he collapsed near Appachimedu on the way to Sannidhanam', 'Appachimedu'],
    ['going to Pampa, we are at Nilakkal parking', 'Nilakkal'],
  ])('%s -> %s', (text, name) => {
    expect(findSabarimalaPlace(text)?.place.name).toBe(name);
  });

  it('covers every route and keeps coordinates inside the service area', () => {
    const routes = new Set(SABARIMALA_PLACES.map((p) => p.route));
    for (const route of ['SANNIDHANAM', 'MAIN_TREK', 'FOREST_PATH_ERUMELY', 'PULLUMEDU', 'ROAD_ERUMELY', 'ROAD_PATHANAMTHITTA', 'ROAD_NILAKKAL_PAMPA', 'BASE']) {
      expect(routes.has(route as never)).toBe(true);
    }
    for (const p of SABARIMALA_PLACES) {
      expect(p.latitude).toBeGreaterThan(9.2); expect(p.latitude).toBeLessThan(9.66);
      expect(p.longitude).toBeGreaterThan(76.5); expect(p.longitude).toBeLessThan(77.2);
    }
  });

  it('returns null when no landmark is named', () => {
    expect(findSabarimalaPlace('please help quickly')).toBeNull();
  });
});

describe('Exotel stream protocol', () => {
  it('parses start and media events and round-trips audio frames', () => {
    expect(parseInbound(JSON.stringify({ event: 'start', stream_sid: 'S1', start: { call_sid: 'C1', from: '+919800000000' } })))
      .toEqual({ kind: 'start', streamSid: 'S1', callSid: 'C1', from: '+919800000000' });
    const pcm = Int16Array.from([1, -2, 3000, -3000]);
    const frame = JSON.parse(mediaFrame('S1', pcm));
    const parsed = parseInbound(JSON.stringify({ event: 'media', media: frame.media }));
    expect(parsed.kind === 'media' && Array.from(parsed.pcm)).toEqual([1, -2, 3000, -3000]);
    expect(parseInbound('not json').kind).toBe('other');
  });

  it('segments one utterance after the caller stops talking', () => {
    const seg = new UtteranceSegmenter({ sampleRate: 8000, rmsThreshold: 500, hangoverMs: 400, minUtteranceMs: 200, maxUtteranceMs: 10_000 });
    const loud = new Int16Array(160).fill(4000); // 20 ms
    const quiet = new Int16Array(160);
    let out: Int16Array | null = null;
    for (let i = 0; i < 25; i += 1) expect(seg.push(loud)).toBeNull(); // 500 ms speech
    for (let i = 0; i < 25 && !out; i += 1) out = seg.push(quiet);
    expect(out).not.toBeNull();
    expect(seg.push(quiet)).toBeNull();
  });
});

describe('police control room, case numbers and security (integration)', () => {
  let testDatabase: IsolatedTestDatabase;
  let db: PrismaClient;
  let server: BuiltServer;
  const police = { email: 'si.pampa@police.test', password: 'Pampa-Control-Room-2026!' };
  const operator = { email: 'op@police.test', password: 'Operator-Account-2026!' };

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: testDatabase.databaseUrl } } });
    process.env.EXOTEL_ENABLED = 'true';
    process.env.EXOTEL_STREAM_TOKEN = 'test-token-0123456789abcdefghij';
    server = await buildServer(loadServerConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(48), CORS_ORIGIN: 'http://localhost:5173' }), { db, ownsDatabaseClient: false });
    await db.user.create({ data: { id: 'USR-POLICE', email: police.email, displayName: 'SI Pampa', role: 'POLICE_CONTROL_ROOM', passwordHash: bcrypt.hashSync(police.password, 4) } });
    await db.user.create({ data: { id: 'USR-OP', email: operator.email, displayName: 'Operator', role: 'OPERATOR', passwordHash: bcrypt.hashSync(operator.password, 4) } });
  }, 180_000);

  afterAll(async () => {
    delete process.env.EXOTEL_ENABLED; delete process.env.EXOTEL_STREAM_TOKEN;
    await server?.shutdown();
    await db?.$disconnect();
    testDatabase?.cleanup();
  });

  const login = async (who: { email: string; password: string }) => {
    const res = await server.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: who });
    return res.json().token as string;
  };

  async function phoneLikeCall(text: string) {
    const call = server.webCalls.startPhone({ callerNumber: '+919847000123' });
    const turn = await server.webCalls.utterance(call.callId, call.token, text);
    return { call, turn };
  }

  it('allots a case number and places a no-GPS caller at the landmark they name', async () => {
    const { turn } = await phoneLikeCall('my father collapsed near Neelimala and is not breathing');
    expect(turn.caseNumber).toMatch(/^SBM-\d{4}-\d{6}$/);
    const emergency = await db.emergency.findUniqueOrThrow({ where: { id: turn.emergencyId! } });
    const neelimala = SABARIMALA_PLACES.find((p) => p.name === 'Neelimala')!;
    expect(emergency.latitude).toBeCloseTo(neelimala.latitude, 4);
    expect(emergency.address).toContain('Neelimala');
    expect(emergency.callerId).toBe('+919847000123');
    const second = await phoneLikeCall('there is an accident at Kanamala');
    expect(Number(second.turn.caseNumber!.slice(-6))).toBe(Number(turn.caseNumber!.slice(-6)) + 1);
  });

  it('lets only police / admin read call records, and audits every read', async () => {
    const { turn } = await phoneLikeCall('a pilgrim fainted at Appachimedu');
    expect((await server.fastify.inject({ method: 'GET', url: '/api/police/calls' })).statusCode).toBe(401);
    const opToken = await login(operator);
    expect((await server.fastify.inject({ method: 'GET', url: '/api/police/calls', headers: { authorization: `Bearer ${opToken}` } })).statusCode).toBe(403);

    const token = await login(police);
    const list = await server.fastify.inject({ method: 'GET', url: '/api/police/calls?scope=all', headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((item: { caseNumber: string }) => item.caseNumber === turn.caseNumber)).toBe(true);

    const record = await server.fastify.inject({ method: 'GET', url: `/api/police/calls/${turn.caseNumber}`, headers: { authorization: `Bearer ${token}` } });
    expect(record.statusCode).toBe(200);
    const body = record.json();
    expect(body.caller.number).toBe('+919847000123');
    expect(body.transcript.map((t: { speaker: string }) => t.speaker)).toContain('CALLER');
    expect(body.events.map((e: { type: string }) => e.type)).toContain('EMERGENCY_CREATED');

    const audit = await db.accessAudit.findMany({ where: { emergencyId: turn.emergencyId } });
    expect(audit.some((row) => row.action === 'VIEW_CALL' && row.userEmail === police.email)).toBe(true);
    await expect(db.$executeRawUnsafe(`DELETE FROM access_audit`)).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it('masks the caller number for roles that do not need it', async () => {
    const { turn } = await phoneLikeCall('someone is bleeding at Pampa');
    const opToken = await login(operator);
    const res = await server.fastify.inject({ method: 'GET', url: `/api/emergencies/${turn.emergencyId}`, headers: { authorization: `Bearer ${opToken}` } });
    expect(res.json().callerId).toBe('••••0123');
  });

  it('locks an account after repeated failed sign-ins', async () => {
    const target = { email: police.email, password: 'wrong-password' };
    for (let i = 0; i < 5; i += 1) expect((await server.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: target })).statusCode).toBe(401);
    const locked = await server.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: police });
    expect(locked.statusCode).toBe(423);
  });

  it('sends security headers and has no password-less dev token route', async () => {
    const res = await server.fastify.inject({ method: 'GET', url: '/police' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect((await server.fastify.inject({ method: 'POST', url: '/api/auth/dev-token', payload: {} })).statusCode).toBe(404);
  });

  it('rejects an Exotel stream without the shared token', async () => {
    await server.fastify.listen({ port: 0, host: '127.0.0.1' });
    const address = server.fastify.server.address() as { port: number };
    const code = await new Promise<number>((resolveClose) => {
      // Node 22+ global WebSocket client.
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/telephony/exotel/stream?token=wrong`);
      ws.addEventListener('close', (event) => resolveClose(event.code));
    });
    expect(code).toBe(1008);
  });
});
