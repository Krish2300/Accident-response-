// Live call summaries and transcript timeline for the Police Control Room.
// This panel reuses the authenticated police API. Caller text is untrusted and
// is always rendered as text, never HTML.
(() => {
  const POLL_MS = 10000;
  const MAX_CALLS = 100;
  const CONCURRENCY = 6;
  const MAX_TIMELINE_LINES = 150;
  const $ = (id) => document.getElementById(id);
  const casesNode = $('liveCases');
  const timelineNode = $('liveTimeline');
  const statusNode = $('liveStatus');
  if (!casesNode || !timelineNode || !statusNode) return;

  let inFlight = false;
  let timer = null;

  const formatTime = (value) => {
    if (!value) return 'time unavailable';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'time unavailable' : date.toLocaleTimeString('en-IN', { hour12: false });
  };
  const timestamp = (value) => {
    const parsed = Date.parse(value ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const normalSeverity = (value) => String(value ?? '').toUpperCase();
  const locationText = (location) => location?.description || (
    Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude)
      ? `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`
      : 'Location not confirmed'
  );

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
          records[index] = {
            ...item,
            transcript: [],
            loadError: error.message,
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return records;
  }

  function openFullRecord(caseNumber) {
    // Use the existing police-console case row so navigation follows the same
    // audited record-view path as an officer selecting a case manually.
    const rows = Array.from(document.querySelectorAll('#list .row'));
    const row = rows.find((candidate) => candidate.querySelector('b')?.textContent === caseNumber);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      row.click();
      $('detail')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    statusNode.textContent = `Case ${caseNumber} is not in the current call list. Switch the call list to Live calls and refresh.`;
  }

  function renderTimeline(records) {
    const allLines = [];
    for (const record of records) {
      for (const line of (Array.isArray(record.transcript) ? record.transcript : [])) {
        allLines.push({ record, line, at: timestamp(line.at) });
      }
    }
    allLines.sort((a, b) => b.at - a.at || String(b.record.caseNumber).localeCompare(String(a.record.caseNumber)));

    const fragment = document.createDocumentFragment();
    fragment.append(element('div', 'live-section-title', 'Latest transcript activity · newest first'));
    if (allLines.length === 0) {
      fragment.append(element('p', 'muted', 'No transcript lines yet. New caller and system turns will appear here.'));
    } else {
      for (const entry of allLines.slice(0, MAX_TIMELINE_LINES)) {
        const speaker = entry.line.speaker === 'CALLER' ? 'CALLER' : 'SYSTEM';
        const item = element('article', `live-timeline-item ${speaker}`);
        const meta = element('div', 'timeline-meta');
        meta.append(element('time', '', formatTime(entry.line.at)));
        meta.append(element('b', '', entry.record.caseNumber || 'Case number unavailable'));
        meta.append(element('span', `pill ${normalSeverity(entry.record.severity)}`, normalSeverity(entry.record.severity) || 'PENDING'));
        meta.append(element('span', '', speaker === 'CALLER' ? 'Caller' : 'System response'));
        const button = element('button', 'ghost', 'Open case');
        button.type = 'button';
        button.addEventListener('click', () => openFullRecord(entry.record.caseNumber));
        meta.append(button);
        item.append(meta, element('div', 'timeline-text', String(entry.line.text ?? '')));
        fragment.append(item);
      }
    }
    timelineNode.replaceChildren(fragment);
  }

  function summaryItem(label, value) {
    const item = element('div', 'summary-item');
    item.append(element('b', '', label), document.createTextNode(value == null || value === '' ? 'Not available' : String(value)));
    return item;
  }

  function renderCases(records) {
    const fragment = document.createDocumentFragment();
    fragment.append(element('div', 'live-section-title', `Active case summaries · ${records.length}`));
    if (records.length === 0) {
      fragment.append(element('p', 'muted', 'No active calls right now. New calls appear automatically.'));
      casesNode.replaceChildren(fragment);
      return;
    }

    const ordered = [...records].sort((a, b) => {
      const severityOrder = (record) => ({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[normalSeverity(record.severity)] ?? 4);
      return severityOrder(a) - severityOrder(b) || timestamp(b.updatedAt || b.createdAt) - timestamp(a.updatedAt || a.createdAt);
    });

    for (const record of ordered) {
      const severity = normalSeverity(record.severity);
      const critical = severity === 'CRITICAL';
      const card = element('article', `live-case ${severity}`);
      if (critical) card.setAttribute('aria-label', `Critical emergency ${record.caseNumber}`);
      if (critical) card.append(element('p', 'critical-banner', '⚠ CRITICAL · PRIORITY CASE'));
      const title = element('div', 'live-case-title');
      title.append(element('b', '', record.caseNumber || 'Case number unavailable'));
      title.append(element('span', `pill ${severity}`, severity || 'SEVERITY PENDING'));
      title.append(element('span', 'pill live', record.status || 'ACTIVE'));
      card.append(title);

      const details = element('div', 'summary-grid');
      details.append(
        summaryItem('Incident', record.incidentType),
        summaryItem('Caller', record.caller?.number || record.caller?.channel),
        summaryItem('Location', locationText(record.location)),
        summaryItem('Ambulance', record.ambulance ? `${record.ambulance.vehicleNumber || 'Unit'} · ${record.ambulance.status || 'status unknown'}` : 'Not assigned'),
        summaryItem('Hospital', record.hospital?.name || 'Not selected'),
        summaryItem('Call opened', formatTime(record.createdAt)),
      );
      card.append(details);

      const transcript = Array.isArray(record.transcript) ? record.transcript : [];
      const latest = [...transcript].sort((a, b) => timestamp(b.at) - timestamp(a.at)).slice(0, 3);
      if (latest.length) {
        card.append(element('div', 'live-section-title', 'Latest turns'));
        for (const line of latest) {
          const speaker = line.speaker === 'CALLER' ? 'CALLER' : 'SYSTEM';
          const message = element('div', `latest-line ${speaker}`);
          message.append(element('time', '', `${formatTime(line.at)} · ${speaker === 'CALLER' ? 'Caller' : 'Response'}`));
          message.append(document.createTextNode(String(line.text ?? '')));
          card.append(message);
        }
      } else {
        card.append(element('p', 'muted', record.loadError || 'Waiting for first transcript…'));
      }

      const actions = element('div', 'case-actions');
      const button = element('button', '', 'Open full police record →');
      button.type = 'button';
      button.addEventListener('click', () => openFullRecord(record.caseNumber));
      actions.append(button);
      card.append(actions);
      fragment.append(card);
    }
    casesNode.replaceChildren(fragment);
  }

  async function refresh() {
    if (inFlight) return;
    const token = sessionStorage.getItem('pcr_token');
    const app = $('app');
    if (!token || !app || app.style.display === 'none') {
      statusNode.textContent = 'Sign in to view live call transcripts.';
      casesNode.replaceChildren();
      timelineNode.replaceChildren();
      return;
    }

    inFlight = true;
    statusNode.textContent = 'Refreshing live calls…';
    try {
      const result = await api(`/api/police/calls?scope=active&limit=${MAX_CALLS}`, token);
      const items = Array.isArray(result.items) ? result.items : [];
      const records = await collectRecords(items, token);
      renderTimeline(records);
      renderCases(records);
      statusNode.textContent = `${items.length} active call${items.length === 1 ? '' : 's'} · refreshed ${new Date().toLocaleTimeString('en-IN', { hour12: false })}${items.length === MAX_CALLS ? ' · display limit reached' : ''}`;
    } catch (error) {
      statusNode.textContent = error.message || 'Live transcript refresh failed. Retrying…';
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
    casesNode.replaceChildren();
    timelineNode.replaceChildren();
    statusNode.textContent = 'Sign in to view live call transcripts.';
  }

  // The main police page owns authentication. The side panel starts and stops
  // with the existing officer session; it does not create another login token.
  setInterval(() => {
    if (sessionStorage.getItem('pcr_token')) start();
    else stop();
  }, 1000);
  if (sessionStorage.getItem('pcr_token')) start();
})();
