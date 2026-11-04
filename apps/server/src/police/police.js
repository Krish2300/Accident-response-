// Police Control Room console. All data is rendered with textContent (never
// innerHTML) so caller-supplied text cannot inject markup.
(() => {
  const $ = (id) => document.getElementById(id);
  const IDLE_LOGOUT_MS = 15 * 60 * 1000;
  let token = sessionStorage.getItem('pcr_token');
  let selected = null; let listTimer = null; let detailTimer = null; let idleTimer = null; let map = null; let layers = [];

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v; else if (k === 'onclick') node.addEventListener('click', v); else node.setAttribute(k, v);
    }
    for (const child of children.flat()) node.append(child instanceof Node ? child : document.createTextNode(child == null ? '' : String(child)));
    return node;
  }
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { hour12: false }) : '—');

  async function api(path, options = {}) {
    const res = await fetch(path, { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) } });
    if (res.status === 401) { signOut('Session expired. Please sign in again.'); throw new Error('unauthorised'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || res.statusText);
    return body;
  }

  function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => signOut('Signed out after 15 minutes of inactivity.'), IDLE_LOGOUT_MS); }
  ['click', 'keydown', 'mousemove'].forEach((e) => document.addEventListener(e, resetIdle, { passive: true }));

  function signOut(message) {
    token = null; sessionStorage.removeItem('pcr_token'); clearInterval(listTimer); clearInterval(detailTimer);
    $('app').style.display = 'none'; $('login').style.display = 'flex'; $('who').textContent = ''; $('loginErr').textContent = message || '';
  }

  $('login').addEventListener('submit', async (e) => {
    e.preventDefault(); $('loginErr').textContent = '';
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { $('loginErr').textContent = body.error?.message || 'Sign-in failed.'; return; }
    if (!['POLICE_CONTROL_ROOM', 'ADMIN'].includes(body.user?.role)) { $('loginErr').textContent = 'This account is not authorised for the control room.'; return; }
    token = body.token; sessionStorage.setItem('pcr_token', token); $('password').value = ''; start(body.user);
  });
  $('logout').addEventListener('click', () => signOut());
  $('scope').addEventListener('change', loadList);
  let qTimer; $('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadList, 300); });

  async function start(user) {
    if (user) $('who').textContent = `${user.email} · ${user.role}`;
    $('login').style.display = 'none'; $('app').style.display = 'grid'; resetIdle();
    await loadList(); listTimer = setInterval(loadList, 4000);
  }

  async function loadList() {
    if (!token) return;
    try {
      const params = new URLSearchParams({ scope: $('scope').value }); if ($('q').value.trim()) params.set('q', $('q').value.trim());
      const { items } = await api(`/api/police/calls?${params}`);
      const list = $('list'); list.replaceChildren();
      if (!items.length) list.append(el('p', { class: 'muted', style: 'padding:12px' }, 'No calls.'));
      for (const c of items) {
        list.append(el('div', { class: `row${selected === c.caseNumber ? ' sel' : ''}`, onclick: () => openCase(c.caseNumber) },
          el('b', {}, c.caseNumber), el('span', { class: `pill ${c.severity}` }, c.severity), c.callActive ? el('span', { class: 'pill live' }, 'ON CALL') : '',
          el('div', {}, `${c.incidentType} · ${c.status}`),
          el('div', { class: 'meta' }, `${fmt(c.createdAt)} · ${c.location.description || `${c.location.latitude.toFixed(4)}, ${c.location.longitude.toFixed(4)}`}`),
          el('div', { class: 'meta' }, `Caller: ${c.caller.number || c.caller.channel || 'unknown'} · Ambulance: ${c.ambulance ? `${c.ambulance.vehicleNumber} (${c.ambulance.status})` : 'pending'}`)));
      }
    } catch (e) { if (e.message !== 'unauthorised') console.warn(e); }
  }

  async function openCase(caseNumber) { selected = caseNumber; clearInterval(detailTimer); await renderCase(); detailTimer = setInterval(renderCase, 5000); loadList(); }

  async function renderCase() {
    if (!selected || !token) return;
    let r; try { r = await api(`/api/police/calls/${encodeURIComponent(selected)}`); } catch (e) { $('detail').replaceChildren(el('p', { class: 'err' }, e.message)); return; }
    const kv = (k, v) => el('div', { class: 'kv' }, el('span', {}, k), v == null || v === '' ? '—' : String(v));
    const candidates = r.events.filter((e) => e.type === 'EMERGENCY_LOCATION_CANDIDATE' && e.payload?.outcome === 'CANDIDATE');
    const detail = el('div', {},
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap' },
        el('h2', { style: 'margin:0;font-family:ui-monospace,Consolas,monospace' }, r.caseNumber),
        el('div', { style: 'display:flex;gap:6px' },
          el('button', { class: 'ghost', type: 'button', onclick: () => exportCase(r.caseNumber) }, 'Export record'),
          el('button', { class: 'ghost', type: 'button', onclick: () => showAccess(r.caseNumber) }, 'Access log'))),
      el('div', { class: 'grid', style: 'margin-top:10px' },
        kv('Status', r.status), kv('Incident', `${r.incidentType} / ${r.severity}`), kv('Opened', fmt(r.createdAt)),
        kv('Caller number', r.caller.number), kv('Channel', r.caller.channel), kv('Call', r.callActive ? 'IN PROGRESS' : 'ended'),
        kv('Location', r.location.description || `${r.location.latitude.toFixed(5)}, ${r.location.longitude.toFixed(5)}`),
        kv('Ambulance', r.ambulance ? `${r.ambulance.vehicleNumber} · ${r.ambulance.status} · ${r.ambulance.station || ''}` : 'not yet assigned'),
        kv('Hospital', r.hospital?.name)),
      el('div', { id: 'map' }),
      candidates.length ? el('div', {}, el('h3', {}, 'Caller-stated location candidates'), candidates.map((c) => el('div', { class: 'tline' },
        `“${c.payload.callerLocationText}” → ${c.payload.latitude?.toFixed(4)}, ${c.payload.longitude?.toFixed(4)} (${c.payload.provider}, ${Math.round((c.payload.confidence || 0) * 100)}%) `,
        el('button', { type: 'button', onclick: () => confirmLocation(r.emergencyId, c.id) }, 'Confirm location')))) : '',
      el('h3', {}, 'Transcript'), r.transcript.length ? r.transcript.map((t) => el('div', { class: `tline ${t.speaker}` }, el('span', { class: 'muted' }, `${fmt(t.at)} ${t.speaker}: `), t.text)) : el('p', { class: 'muted' }, 'No transcript yet.'),
      el('h3', {}, `Event timeline (${r.events.length})`),
      el('table', {}, r.events.filter((e) => e.type !== 'AMBULANCE_LOCATION_UPDATED').map((e) => el('tr', {}, el('td', { class: 'muted' }, fmt(e.timestamp)), el('td', {}, e.type), el('td', { class: 'muted' }, `${e.actorType || ''} ${e.actorId || ''}`)))),
      el('h3', {}, 'Call sessions'), el('table', {}, r.callSessions.map((s) => el('tr', {}, el('td', {}, s.id), el('td', {}, s.channel), el('td', {}, s.callerId || ''), el('td', {}, `${fmt(s.startedAt)} → ${fmt(s.endedAt)}`), el('td', {}, s.status)))),
      el('p', { class: 'muted' }, `Record generated ${fmt(r.generatedAt)}. This view was logged to the access audit.`));
    const scroll = $('detail').scrollTop; $('detail').replaceChildren(detail); $('detail').scrollTop = scroll;
    drawMap(r);
  }

  function drawMap(r) {
    if (!window.L) return;
    map = L.map('map').setView([r.location.latitude, r.location.longitude], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    L.circleMarker([r.location.latitude, r.location.longitude], { radius: 9, color: '#ef4444', fillOpacity: .8 }).addTo(map).bindTooltip('Caller');
    if (r.hospital) L.marker([r.hospital.latitude, r.hospital.longitude]).addTo(map).bindTooltip(r.hospital.name);
    if (r.ambulance?.latitude != null) L.circleMarker([r.ambulance.latitude, r.ambulance.longitude], { radius: 8, color: '#3b82f6', fillOpacity: 1 }).addTo(map).bindTooltip(r.ambulance.vehicleNumber);
    for (const route of r.routes) if (route.polyline?.length) L.polyline(route.polyline, { color: route.destinationName === 'SCENE' ? '#3b82f6' : '#ef4444', weight: 4 }).addTo(map);
    if (r.ambulanceTrail?.length) L.polyline(r.ambulanceTrail.map((p) => [p.latitude, p.longitude]), { color: '#22c55e', weight: 2, dashArray: '4 4' }).addTo(map);
  }

  async function confirmLocation(emergencyId, resolutionId) {
    if (!confirm('Confirm this caller-stated location as the emergency location?')) return;
    try { await api(`/api/emergencies/${encodeURIComponent(emergencyId)}/location-resolutions/${encodeURIComponent(resolutionId)}/confirm`, { method: 'POST', body: '{}' }); renderCase(); }
    catch (e) { alert(e.message); }
  }

  async function exportCase(caseNumber) {
    const res = await fetch(`/api/police/calls/${encodeURIComponent(caseNumber)}/export`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) { alert('Export failed'); return; }
    const url = URL.createObjectURL(await res.blob()); const a = el('a', { href: url, download: `${caseNumber}.json` }); a.click(); URL.revokeObjectURL(url);
  }

  async function showAccess(caseNumber) {
    const { items } = await api(`/api/police/calls/${encodeURIComponent(caseNumber)}/access-log`);
    alert(items.slice(0, 40).map((a) => `${fmt(a.at)}  ${a.action}  ${a.userEmail} (${a.role})  ${a.ipAddress || ''}`).join('\n') || 'No access recorded.');
  }

  if (token) start(null); else signOut();
})();
