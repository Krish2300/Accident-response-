/**
 * End-to-end check of the integrated system through the public Web Call API —
 * the same calls the browser page at /call makes.
 *
 *   1. start the system:   npm run start:full     (or npm run dev:full)
 *   2. in another window:  npm run test:e2e
 *
 * It places one call, speaks two caller turns, then follows the emergency
 * through every stage of the figure (classified -> ambulance assigned ->
 * hospital selected -> routes -> corridor -> en route -> on scene -> onboard ->
 * transporting -> at hospital -> completed) and prints the event timeline.
 * Exit code 0 only if the emergency reaches COMPLETED.
 *
 * Options (env): E2E_BASE_URL (default http://127.0.0.1:4000),
 * E2E_TEXT (first caller sentence), E2E_TIMEOUT_S (default 300).
 */
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4000';
const firstText = process.env.E2E_TEXT ?? 'My father collapsed near Appachimedu on the way to Sannidhanam and he is not breathing';
const timeoutS = Number(process.env.E2E_TIMEOUT_S ?? 300);

type Json = Record<string, any>;

async function request(path: string, init: { method?: string; body?: unknown; token?: string; bearer?: string } = {}): Promise<Json> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers['x-call-token'] = init.token;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  const response = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as Json) : {};
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return json;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (who: string, text: string) => console.log(`${who.padEnd(7)}| ${text}`);

async function main(): Promise<void> {
  const health = await request('/api/health');
  console.log(`server ok: ${health.modules.length} modules mounted (${health.modules.join(', ')})\n`);

  const call = await request('/api/webcall/start', { method: 'POST', body: { language: 'en' } });
  say('SYSTEM', call.greeting);

  say('CALLER', firstText);
  let turn = await request(`/api/webcall/${call.callId}/utterance`, { method: 'POST', token: call.token, body: { text: firstText } });
  console.log(`        [Module 3] ${turn.classification.incidentType} / ${turn.classification.severity} via ${turn.classification.provider} (confidence ${turn.classification.confidence})`);
  say('SYSTEM', turn.speech);

  const second = 'Yes, he is unresponsive. We are just above the Appachimedu emergency medical centre.';
  say('CALLER', second);
  turn = await request(`/api/webcall/${call.callId}/utterance`, { method: 'POST', token: call.token, body: { text: second } });
  say('SYSTEM', turn.speech);
  console.log('');

  const seen = new Set<string>();
  const deadline = Date.now() + timeoutS * 1000;
  let status: Json = {};
  while (Date.now() < deadline) {
    status = await request(`/api/webcall/${call.callId}/status`, { token: call.token });
    const line = [
      `stage=${status.stage}`,
      status.ambulance ? `ambulance=${status.ambulance.vehicleNumber}:${status.ambulance.status}@${status.ambulance.latitude?.toFixed(4)},${status.ambulance.longitude?.toFixed(4)}` : 'ambulance=-',
      status.hospital ? `hospital=${status.hospital.name}` : 'hospital=-',
      status.responseRoute ? `responseETA=${status.responseRoute.etaMin.toFixed(1)}min` : '',
      status.transportRoute ? `transportETA=${status.transportRoute.etaMin.toFixed(1)}min` : '',
    ].filter(Boolean).join('  ');
    const key = `${status.stage}|${status.ambulance?.status}|${Boolean(status.hospital)}|${Boolean(status.responseRoute)}|${Boolean(status.transportRoute)}`;
    if (!seen.has(key)) { seen.add(key); console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`); }
    if (status.stage === 'COMPLETED' || status.stage === 'CANCELLED') break;
    await sleep(1500);
  }

  // Event timeline, read as the seeded operator (Module 11 + Module 10 lifecycle).
  try {
    const login = await request('/api/auth/login', { method: 'POST', body: {
      email: process.env.SEED_OPERATOR_EMAIL ?? 'operator@resus.local',
      password: process.env.SEED_OPERATOR_PASSWORD ?? 'ChangeMe!2024',
    } });
    const bearer = login.token ?? login.accessToken;
    const events = await request(`/api/emergencies/${status.emergencyId}/events?limit=500`, { bearer });
    const list: Json[] = Array.isArray(events) ? events : events.items ?? events.events ?? [];
    const types = list.map((event) => event.type).filter((type) => type !== 'AMBULANCE_LOCATION_UPDATED' && type !== 'TRANSCRIPT_UPDATED');
    console.log(`\nevent timeline (${list.length} events, GPS/transcript updates omitted):\n  ${types.join(' -> ')}`);
    const lifecycle = await request(`/api/emergencies/${status.emergencyId}/lifecycle`, { bearer });
    console.log(`\nModule 10 lifecycle state: ${lifecycle.state ?? lifecycle.lifecycle?.state ?? JSON.stringify(lifecycle).slice(0, 200)}`);
  } catch (error) {
    console.log(`\n(timeline not shown: ${(error as Error).message})`);
  }

  if (status.stage !== 'COMPLETED') {
    console.error(`\nFAILED: emergency stopped at ${status.stage}`);
    process.exit(1);
  }
  console.log('\nPASSED: call -> classification -> ambulance -> hospital -> route -> corridor -> arrival -> completed');
}

main().catch((error: unknown) => {
  console.error(`e2e failed: ${(error as Error).message}`);
  process.exit(1);
});
