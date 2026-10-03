import type { FastifyInstance } from 'fastify';
import type { Module11 } from '@resus/data';

/**
 * Development-only harness for exercising Module 5 by hand.
 *
 * This exists so a human can sit down with the bystander flow and watch what the
 * LLM extracts, what the protocol engine decides next, and which safety rules
 * fire — without a caller-facing app existing yet. It is mounted only when
 * NODE_ENV is not production, and it mints its own throwaway emergency so it
 * cannot interfere with real dispatch data.
 *
 * Everything on this page goes through the same public API a real client would
 * use. There is no shortcut into the engine, because a harness that can bypass
 * the HTTP layer cannot prove the HTTP layer works.
 */

const INCIDENT_TYPES = [
  'CARDIAC_ARREST',
  'SEVERE_BLEEDING',
  'CHOKING',
  'ACTIVE_SEIZURE',
  'CHEST_PAIN',
  'OTHER',
] as const;

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Module 5 protocol harness (dev only)</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e9ef; --muted:#98a1b3;
          --accent:#5b8cff; --warn:#f0a13c; --bad:#e5484d; --good:#3fb950; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:12px 16px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:14px; margin:0; font-weight:600; }
  .badge { background:var(--warn); color:#1a1200; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; }
  .badge.bad { background:var(--bad); color:#fff; }
  main { display:grid; grid-template-columns:340px 1fr; gap:0; height:calc(100vh - 53px); }
  aside { border-right:1px solid var(--line); padding:16px; overflow:auto; }
  section { padding:16px; display:flex; flex-direction:column; min-height:0; }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-bottom:6px; }
  select, textarea, button { width:100%; background:var(--panel); color:var(--text); border:1px solid var(--line);
    border-radius:6px; padding:8px; font:inherit; }
  textarea { min-height:74px; resize:vertical; }
  button { background:var(--accent); color:#06122e; border:0; font-weight:700; cursor:pointer; margin-top:10px; }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); font-weight:400; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .field { margin-bottom:14px; }
  .row { display:flex; gap:8px; align-items:center; }
  #log { flex:1; overflow:auto; border:1px solid var(--line); border-radius:6px; background:var(--panel);
    padding:12px; margin-top:10px; min-height:0; }
  .turn { border-left:2px solid var(--line); padding:8px 0 8px 12px; margin-bottom:14px; }
  .turn.sys { border-left-color:var(--accent); }
  .turn.you { border-left-color:var(--muted); }
  .who { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-bottom:4px; }
  .say { white-space:pre-wrap; }
  .meta { margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; }
  .tag { font-size:11px; border:1px solid var(--line); border-radius:10px; padding:1px 8px; color:var(--muted); }
  .tag.warn { color:var(--warn); border-color:var(--warn); }
  .tag.bad { color:var(--bad); border-color:var(--bad); }
  .tag.good { color:var(--good); border-color:var(--good); }
  table { width:100%; border-collapse:collapse; font-size:12px; margin-top:6px; }
  td { padding:2px 0; vertical-align:top; }
  td:first-child { color:var(--muted); width:42%; padding-right:8px; }
  details { margin-top:8px; }
  summary { cursor:pointer; color:var(--muted); font-size:12px; }
  #llm { margin-top:12px; font-size:12px; }
  .hint { color:var(--muted); font-size:12px; margin-top:10px; }
</style>
</head>
<body>
<header>
  <h1>Module 5 protocol harness</h1>
  <span class="badge">DEVELOPMENT ONLY</span>
  <span class="badge bad" id="envbadge">not production</span>
  <span class="tag" id="llmbadge">llm: checking…</span>
  <span style="flex:1"></span>
  <button class="ghost" style="width:auto;margin:0;padding:6px 12px" onclick="copyTranscript()">copy transcript</button>
</header>
<main>
  <aside>
    <div class="field">
      <label for="incident">Incident type</label>
      <select id="incident">${INCIDENT_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
    </div>
    <div class="field">
      <label for="utterance">What the bystander says</label>
      <textarea id="utterance" placeholder="he is unresponsive and not breathing"></textarea>
    </div>
    <button id="send">Start / send</button>
    <button class="ghost" id="reset">New emergency</button>
    <div class="hint" id="hint">
      Start a session, then keep answering. Try: <em>“I don't know if he is responsive”</em>,
      <em>“there are wires sparking across the road”</em>, <em>“not sure”</em> three times.
    </div>
    <div id="llm"></div>
  </aside>
  <section>
    <div class="row">
      <span class="tag" id="sessiontag">no session</span>
      <span class="tag" id="steptag">—</span>
      <span class="tag" id="statustag">—</span>
    </div>
    <div id="log"></div>
  </section>
</main>
<script>
let sessionId = null, emergencyId = null, token = null;
const $ = (id) => document.getElementById(id);

async function post(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function tag(text, cls = '') { const el = document.createElement('span'); el.className = 'tag ' + cls; el.textContent = text; return el; }

function addTurn(who, text, metas = [], facts = null, reason = null) {
  const wrap = document.createElement('div');
  wrap.className = 'turn ' + (who === 'system' ? 'sys' : 'you');
  const label = document.createElement('div');
  label.className = 'who';
  label.textContent = who === 'system' ? 'assistant' : 'bystander';
  const say = document.createElement('div');
  say.className = 'say';
  say.textContent = text;
  wrap.append(label, say);

  if (metas.length) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    metas.forEach((m) => meta.appendChild(tag(m.text, m.cls)));
    wrap.appendChild(meta);
  }

  if (reason) {
    const d = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = 'escalation reason';
    const p = document.createElement('div');
    p.className = 'say';
    p.style.color = 'var(--bad)';
    p.textContent = reason;
    d.append(s, p);
    wrap.appendChild(d);
  }

  if (facts && Object.keys(facts).length) {
    const d = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = 'facts extracted';
    const table = document.createElement('table');
    Object.entries(facts).forEach(([k, v]) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = k;
      const b = document.createElement('td'); b.textContent = typeof v === 'string' ? v : JSON.stringify(v);
      tr.append(a, b); table.appendChild(tr);
    });
    d.append(s, table);
    wrap.appendChild(d);
  }

  $('log').appendChild(wrap);
  $('log').scrollTop = $('log').scrollHeight;
}

function renderTurn(turn) {
  const metas = [];
  metas.push({ text: 'step: ' + turn.currentStepId, cls: '' });
  metas.push({ text: turn.action, cls: turn.action === 'ESCALATED' ? 'bad' : turn.action === 'CLARIFY' ? 'warn' : 'good' });
  if (turn.requiresClarification) metas.push({ text: 'clarification', cls: 'warn' });
  if (turn.degraded) metas.push({ text: 'degraded extraction', cls: 'warn' });
  if (turn.missingFacts && turn.missingFacts.length) metas.push({ text: 'missing: ' + turn.missingFacts.join(', '), cls: 'warn' });
  if (turn.paraphrased === false) metas.push({ text: 'protocol text verbatim', cls: '' });
  if (turn.llmNotice) metas.push({ text: turn.llmNotice, cls: 'warn' });

  addTurn('system', turn.speech, metas, turn.session && turn.session.collectedFacts, turn.escalationReason || null);

  $('sessiontag').textContent = 'session ' + turn.session.id;
  $('steptag').textContent = turn.currentStepId;
  $('statustag').textContent = turn.status;
  $('statustag').className = 'tag ' + (turn.status === 'ESCALATED' ? 'bad' : turn.status === 'ACTIVE' || turn.status === 'WAITING_FOR_RESPONSE' ? '' : 'warn');
}

function fail(message) {
  const wrap = document.createElement('div');
  wrap.className = 'turn';
  const say = document.createElement('div');
  say.className = 'say';
  say.style.color = 'var(--bad)';
  say.textContent = message;
  wrap.appendChild(say);
  $('log').appendChild(wrap);
}

async function authenticate() {
  // Operator endpoints are authenticated, so the harness mints a local token
  // first. That route exists only when NODE_ENV is not production.
  const res = await fetch('/api/auth/dev-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'operator@resus.local' }),
  });
  if (!res.ok) {
    fail('this server has no development token route; the harness needs NODE_ENV=development');
    $('send').disabled = true;
    return false;
  }
  token = (await res.json()).token;
  return true;
}

async function send() {
  const utterance = $('utterance').value.trim();
  const button = $('send');
  button.disabled = true;
  try {
    if (!token && !(await authenticate())) return;
    if (!sessionId) {
      const emergency = await post('/api/dev/harness/emergency', { incidentType: $('incident').value });
      if (!emergency.ok) return fail('could not create a development emergency: ' + JSON.stringify(emergency.data));
      emergencyId = emergency.data.emergency.id;
      const start = await post('/api/protocol-sessions', { emergencyId, incidentType: $('incident').value });
      if (!start.ok) return fail('could not start the session: ' + JSON.stringify(start.data));
      sessionId = start.data.session.id;
      renderTurn(start.data);
      $('utterance').value = '';
      $('send').textContent = 'Send';
      return;
    }
    if (!utterance) return;
    addTurn('you', utterance);
    const res = await post('/api/protocol-sessions/' + sessionId + '/utterance', { utterance });
    if (!res.ok) { fail('request failed (' + res.status + '): ' + JSON.stringify(res.data)); return; }
    renderTurn(res.data);
    $('utterance').value = '';
  } finally {
    button.disabled = false;
  }
}

function reset() {
  sessionId = null;
  emergencyId = null;
  $('log').textContent = '';
  $('sessiontag').textContent = 'no session';
  $('steptag').textContent = '—';
  $('statustag').textContent = '—';
  $('send').textContent = 'Start / send';
}

function copyTranscript() {
  const text = [...$('log').children]
    .map((node) => {
      const who = node.querySelector('.who');
      const say = node.querySelector('.say');
      if (!who || !say) return '';
      const meta = node.querySelector('.meta');
      return who.textContent.toUpperCase() + ': ' + say.textContent + (meta ? '\\n  [' + [...meta.children].map((t) => t.textContent).join(' | ') + ']' : '');
    })
    .filter(Boolean)
    .join('\\n');
  navigator.clipboard?.writeText(text);
}

async function loadLlm() {
  const res = await fetch('/api/health/llm');
  const health = await res.json();
  const badge = $('llmbadge');
  badge.textContent = 'llm: ' + health.provider + '/' + health.model + (health.degraded ? ' (degraded)' : '');
  badge.className = 'tag ' + (health.degraded ? 'warn' : 'good');

  const box = $('llm');
  const rows = [
    ['provider', health.provider],
    ['model', health.model],
    ['available', String(health.available)],
    ['degraded', String(health.degraded)],
    ['fallback', health.fallbackEnabled ? 'allowed' : 'blocked'],
    ['reason', health.reason ?? '—'],
  ];
  const table = document.createElement('table');
  rows.forEach(([k, v]) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = k;
    const b = document.createElement('td'); b.textContent = v;
    tr.append(a, b); table.appendChild(tr);
  });
  box.appendChild(table);
  if (health.degraded) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.style.color = 'var(--warn)';
    p.textContent = 'Running on the keyword fallback: extraction is degraded and every turn requires confirmation.';
    box.appendChild(p);
  }
}

$('send').addEventListener('click', send);
$('reset').addEventListener('click', reset);
$('utterance').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
$('utterance').addEventListener('input', () => { $('send').textContent = sessionId ? 'Send' : 'Start session'; });
loadLlm();
</script>
</body>
</html>`;

export function registerDevHarness(
  fastify: FastifyInstance,
  module11: Module11,
  isProduction: boolean,
): void {
  if (isProduction) return;

  fastify.get('/dev/protocol-chat', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(PAGE),
  );

  /**
   * Creates a throwaway emergency so the harness needs no real dispatch data.
   * Never mounted when NODE_ENV=production.
   */
  fastify.post('/api/dev/harness/emergency', async (request, reply) => {
    const body = (request.body ?? {}) as { incidentType?: string };
    const incidentType = body.incidentType ?? 'CARDIAC_ARREST';

    const emergency = await module11.emergencies.create({
      incidentType,
      severity: 'CRITICAL',
      latitude: 12.9716,
      longitude: 77.5946,
      description: 'Development harness session.',
      callerId: 'dev-harness',
      isSimulation: true,
    });

    return reply.send({ emergency });
  });
}