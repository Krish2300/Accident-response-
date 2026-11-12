// Live transcript wall for the Police Control Room.
// This page only requests records after the authenticated police console has
// stored its short-lived bearer token in sessionStorage. All text is rendered
// with textContent; caller speech is untrusted input.
(() => {
  const POLL_MS = 8000;
  const MAX_CALLS = 500;
  const CONCURRENCY = 6;
  const $ = (id) => document.getElementById(id);
  const list = $('liveList');
  const status = $('liveStatus');
  if (!list || !status) return;

  let inFlight = false;
  let timer = null;

  const formatTime = (value) => {
    if (!value) return 'time unavailable';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'time unavailable' : date.toLocaleTimeString('en-IN', { hour12: false });
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function api(path, token) {
    const response = await fetch(path, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Officer session expired. Sign in again.' : `Control-room request failed (${response.status}).`);
    return response.json();
  }

  async function collectRecords(items, token) {
    const records = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const index = next++;
        const item = items[index];
        try {
          records[index] = await api(`/api/police/calls/${encodeURIComponent(item.caseNumber)}`, token);
        } catch (error) {
          records[index] = { caseNumber: item.caseNumber, status: item.status, incidentType: item.incidentType, severity: item.severity, location: item.location, transcript: [], loadError: error.message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return records;
  }

  function render(records) {
    const fragment = document.createDocumentFragment();
    if (records.length === 0) {
      fragment.append(element('p', 'muted', 'No active calls right now. New calls will appear here automatically.'));
      list.replaceChildren(fragment);
      return;
    }

    for (const record of records) {
      const section = element('article', 'live-case');
      const title = element('div', 'live-case-title');
      title.append(element('b', '', record.caseNumber || 'Case number unavailable'));
      title.append(element('span', `pill ${record.severity || ''}`, record.severity || 'severity pending'));
      title.append(element('span', 'pill', `${record.incidentType || 'Incident pending'} · ${record.status || 'active'}`));
      section.append(title);
      const place = record.location?.description || (Number.isFinite(record.location?.latitude) && Number.isFinite(record.location?.longitude)
        ? `${record.location.latitude.toFixed(4)}, ${record.location.longitude.toFixed(4)}`
        : 'Location not confirmed');
      section.append(element('div', 'meta', place));

      const lines = Array.isArray(record.transcript) ? record.transcript : [];
      if (lines.length === 0) {
        section.append(element('p', 'muted', record.loadError || 'Waiting for the first transcript…'));
      } else {
        for (const line of lines) {
          const message = element('div', `live-line ${line.speaker === 'CALLER' ? 'CALLER' : 'SYSTEM'}`);
          message.append(element('time', '', `${formatTime(line.at)} · ${line.speaker === 'CALLER' ? 'Caller' : line.speaker === 'SYSTEM' ? 'Response' : line.speaker || 'Update'}`));
          message.append(document.createTextNode(String(line.text ?? '')));
          section.append(message);
        }
      }
      fragment.append(section);
    }
    list.replaceChildren(fragment);
  }

  async function refresh() {
    if (inFlight) return;
    const token = sessionStorage.getItem('pcr_token');
    const app = $('app');
    if (!token || !app || app.style.display === 'none') {
      status.textContent = 'Sign in to view live call transcripts.';
      list.replaceChildren();
      return;
    }

    inFlight = true;
    status.textContent = 'Refreshing live calls…';
    try {
      const result = await api(`/api/police/calls?scope=active&limit=${MAX_CALLS}`, token);
      const items = Array.isArray(result.items) ? result.items : [];
      const records = await collectRecords(items, token);
      render(records);
      status.textContent = `${items.length} active call${items.length === 1 ? '' : 's'} · refreshed ${new Date().toLocaleTimeString('en-IN', { hour12: false })}${items.length === MAX_CALLS ? ' · display limit reached' : ''}`;
    } catch (error) {
      status.textContent = error.message || 'Live transcript refresh failed. Retrying…';
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer) return;
    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    list.replaceChildren();
    status.textContent = 'Sign in to view live call transcripts.';
  }

  // The main police page owns authentication. Observe its existing session token
  // so this panel starts and stops with sign-in/sign-out without another login.
  setInterval(() => {
    if (sessionStorage.getItem('pcr_token')) start();
    else stop();
  }, 1000);
  if (sessionStorage.getItem('pcr_token')) start();
})();
