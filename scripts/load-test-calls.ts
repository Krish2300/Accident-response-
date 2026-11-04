/**
 * Concurrent-call load test for the Sabarimala deployment.
 *
 *   npm run start:full          (window 1)
 *   npm run test:load           (window 2)   LOAD_CALLS=40 npm run test:load
 *
 * Places LOAD_CALLS simultaneous calls (default 30) from landmarks spread over
 * every pilgrim route, with no GPS (as a phone call would arrive), speaks two
 * turns per call, then follows every emergency until it is COMPLETED. With
 * more calls than ambulances this also exercises the priority queue.
 *
 * Reports per-turn latency (p50 / p95 / max), case numbers, how many calls had
 * to queue for a unit, and fails (exit 1) if any call is lost or stuck.
 */
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4000';
const total = Number(process.env.LOAD_CALLS ?? 30);
const timeoutS = Number(process.env.LOAD_TIMEOUT_S ?? 600);

const PLACES = ['Neelimala', 'Appachimedu', 'Marakoottam', 'Sannidhanam near the 18 steps', 'Pampa Triveni', 'Nilakkal parking', 'Erumely Vavar mosque',
  'Mundakayam bus stand', 'Kanamala bridge', 'Azhutha', 'Karimala', 'Pullumedu', 'Uppupara', 'Laha', 'Chalakayam', 'Sabari Peedam', 'Vandiperiyar', 'Attathode'];
const INCIDENTS = ['my friend collapsed and he is not breathing', 'an old man has severe chest pain', 'a pilgrim fell from the steps and his leg is bleeding a lot',
  'a lady is having a seizure', 'my father fainted and is unconscious', 'a child is choking', 'there was a bus accident, people are injured', 'he cannot breathe, asthma attack'];

type Json = Record<string, any>;
async function post(path: string, body: unknown, token?: string): Promise<Json> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-call-token': token } : {}) }, body: JSON.stringify(body) });
  const json = (await res.json()) as Json;
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}
async function get(path: string, token: string): Promise<Json> {
  const res = await fetch(`${base}${path}`, { headers: { 'x-call-token': token } });
  return (await res.json()) as Json;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

async function oneCall(i: number, latencies: number[]): Promise<{ callId: string; token: string; place: string }> {
  const place = PLACES[i % PLACES.length]!;
  const call = await post('/api/webcall/start', { language: 'en' });
  const say = async (text: string) => { const t0 = Date.now(); await post(`/api/webcall/${call.callId}/utterance`, { text }, call.token); latencies.push(Date.now() - t0); };
  await say(`Help, ${INCIDENTS[i % INCIDENTS.length]} at ${place}`);
  await say('Yes, he is not responding');
  return { callId: call.callId, token: call.token, place };
}

async function main(): Promise<void> {
  console.log(`placing ${total} simultaneous calls against ${base} …`);
  const latencies: number[] = [];
  const started = Date.now();
  const results = await Promise.allSettled(Array.from({ length: total }, (_, i) => oneCall(i, latencies)));
  const calls = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  console.log(`connected ${calls.length}/${total} calls in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const f of failed.slice(0, 5)) console.log(`  failed: ${f.reason}`);
  console.log(`caller-turn latency: p50 ${pct(latencies, 50)} ms · p95 ${pct(latencies, 95)} ms · max ${Math.max(...latencies)} ms`);

  const queued = new Set<string>();
  const done = new Map<string, Json>();
  const deadline = Date.now() + timeoutS * 1000;
  while (done.size < calls.length && Date.now() < deadline) {
    await Promise.all(calls.filter((c) => !done.has(c.callId)).map(async (c) => {
      const s = await get(`/api/webcall/${c.callId}/status`, c.token);
      if (s.stage === 'AWAITING_AMBULANCE') queued.add(c.callId);
      if (s.stage === 'COMPLETED' || s.stage === 'CANCELLED') done.set(c.callId, { ...s, place: c.place });
    }));
    process.stdout.write(`\r  completed ${done.size}/${calls.length} · queued at some point ${queued.size}   `);
    await sleep(3000);
  }
  console.log('');
  const sample = [...done.values()].slice(0, 8);
  for (const s of sample) console.log(`  ${s.caseNumber ?? s.emergencyId}  ${s.place.padEnd(30)} ${String(s.incidentType).padEnd(26)} ${s.ambulance?.vehicleNumber ?? '-'} → ${s.hospital?.name ?? '-'}`);
  const ok = failed.length === 0 && done.size === calls.length;
  console.log(ok ? `\nPASSED: ${calls.length} concurrent calls all completed (${queued.size} waited in the ambulance queue).` : `\nFAILED: ${calls.length - done.size} call(s) did not complete, ${failed.length} failed to connect.`);
  process.exit(ok ? 0 : 1);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
