# RESUS pilot integration guide for a Kerala Police demonstration

This guide describes a safe way to demonstrate the repository's existing emergency-response stack and the enhanced police live-call screen. It is an integration plan, **not an assertion that RESUS is connected to Kerala Police or approved for operational use**.

> **Prototype warning:** the repository describes protocol text as unreviewed and unsuitable for real emergencies. Use synthetic scenarios and test accounts for demonstrations. Do not send real emergency calls, dispatch a real ambulance, or provide unreviewed first-aid instructions from a demo deployment.

## What the repository provides

The current stack is a Node.js/TypeScript Fastify server, React/Vite dispatcher dashboard, Prisma persistence (SQLite by default; PostgreSQL is an option), emergency-response modules, browser caller page, driver app, and a role-protected police console.

The existing workflows include:

- Browser-based caller experience at `/call`; it can collect browser speech recognition, push-to-talk server audio, or typed input. Speech recognition and voice synthesis depend on the selected browser/provider configuration.
- Optional inbound telephony through Exotel WebSocket streaming or the documented Asterisk/SIP path. Provider provisioning and account-level protocol verification are required.
- Separate case IDs, call sessions, transcripts, protocol progression, classification, location candidates, ambulance/hospital selection, routes, corridor events, and lifecycle records.
- Authenticated driver app flows for assignment and GPS reporting when a driver account is configured.
- Police console at `/police` for active and historical call search, full record viewing, JSON export, ambulance trail, transcript/event timelines, and audited record access.
- Live-call transcript wall: active case summaries, critical/high severity emphasis, a newest-first transcript timeline, and a button to open the existing full case record.

Seeded facilities, ambulance coordinates, routes, simulated movement, and generated ETAs must be labeled as demo/planning data unless independently connected to a verified live source. A map marker is not proof of a real dispatched unit.

## Run a local, simulated demonstration

Requirements: Node.js 22+, npm, and a supported browser. From a clean checkout:

```bash
npm install
npm run dev:full
```

Open:

- Caller page: `http://localhost:4000/call`
- Dispatcher dashboard: `http://localhost:5173`
- Police console: `http://localhost:4000/police`
- Health endpoint: `http://localhost:4000/api/health`

Use the configured local demo/operator credentials only in a local demo environment. Create a separately named `POLICE_CONTROL_ROOM` account for the police-console demonstration using the repository's `npm run user:add` command; do not share or retain demo passwords in a real deployment.

Suggested presentation:

1. Open the caller page on a phone or laptop and accept microphone/location permissions, or choose typed mode for a deterministic fallback.
2. Start a test call. Use a clearly synthetic scenario and state that it is simulated.
3. Sign into `/police` in another browser window using the test police account.
4. Observe the active-case summary, critical/high highlighting, newest-first conversation timeline, and transcript refresh status. Select **Open full police record** to see the audited detailed case, event timeline, map and available response data.
5. Run `npm run test:e2e` to verify the local web-call path. Run `npm run test:load` against the local demo to exercise multiple concurrent calls. These are software checks, not clinical or operational validation.

The live-transcript panel currently polls active call records; latency depends on the configured refresh interval and backend load. It is not a guaranteed sub-second dispatch channel. For a large deployment, implement a dedicated, bounded transcript subscription/event stream rather than repeatedly fetching every full case record, and load-test that design with representative database and network conditions.

## Low-integration pilot architecture

Start with a **standalone, isolated demonstration** before requesting any production connection:

```text
Caller browser / QR link ── HTTPS ──> RESUS API + persistent database
                                            │
                                            ├──> dispatcher dashboard
                                            └──> role-protected police console

Optional later, only after approval:
Telephone provider ── authenticated media stream ──> RESUS telephony adapter
Approved ambulance/hospital feed ── documented integration ──> service adapters
```

Minimum demonstration dependencies are the existing web caller, local database, demo dispatcher and police account. Do not integrate directly into police production systems just to present the workflow. For a proposed pilot, first agree with the Police control-room owner on one controlled environment, a named technical contact, roles, test-data rules, escalation boundaries, data retention and an incident-response contact.

Potential integration stages:

1. **Stage 0 — offline showcase:** Synthetic incidents, no real phone number, no external police network, and unmistakable simulation labels.
2. **Stage 1 — controlled user evaluation:** Police-authorized test environment and test accounts; evaluate the console with scripted scenarios and no dispatch authority.
3. **Stage 2 — data connection:** Only after written approval, connect one documented data source at a time through a least-privilege adapter. Define freshness, provenance, authentication, rate limits, failure behavior, and ownership for every field.
4. **Stage 3 — operational pilot:** Separate security/privacy and clinical safety reviews, reliability engineering, disaster recovery, support and on-call arrangements, training, and explicit human decision/dispatch gates before any live use.

No police API, police application affiliation, live ambulance feed, or health-centre integration is implied by this repository. Identify the relevant system owners and obtain their current interface documentation and written authorization before designing an adapter. If no approved interface exists, keep the deployment independent and show only a simulated integration.

## Voice and language integration

The browser flow and phone flow are different transports. For a minimal voice demo, start with browser microphone access on HTTPS/localhost. Select and test a speech-to-text and text-to-speech provider that supports the target Malayalam, English and Hindi varieties. Preserve the original recognized text, record whether language identification was automatic or caller-selected, label uncertainty, and let a human correct it. Show spoken replies as text too, with a repeat control and a clear way to reach a human.

Before enabling phone calls, provision a provider number and validate its current media protocol, callback authentication, caller ID behavior, concurrency limits, codec/sample-rate handling, timeout behavior, and disconnect/retry semantics against provider documentation. Keep provider credentials in deployment secrets—not source code, browser bundles, logs or this document. The existing Exotel adapter currently requires account-level protocol verification; the Asterisk instructions require a separately provisioned PBX.

Do not treat language detection, transcription, or an AI classification as ground truth. Keep the original utterance and any translated/normalized form distinct, show confidence/uncertainty, and route ambiguous or high-risk cases to a trained human according to the agreed operating procedure.

## Persistent police records and access

The database stores case and operational records used by the police console. The console restricts case access to `POLICE_CONTROL_ROOM` and `ADMIN` roles, masks caller numbers for other permitted roles, and audits police record views/exports. Before any real data is accepted, the responsible authority must decide and document:

- lawful purpose and authority, notice/consent where required, retention and deletion schedule;
- permitted operator roles, account provisioning/disablement, password and MFA policy, review of access logs;
- encryption in transit and at rest, key management, backups, restore tests and breach response;
- whether recordings are stored (transcript persistence is not the same as audio recording);
- hosting jurisdiction, network boundaries, data-sharing agreements, and vendor/subprocessor review.

Use TLS, restrict the service to an approved private network/VPN or hardened gateway, set production secrets, apply least privilege, protect backups, and have an independent security assessment before a real pilot. The prototype's controls are not a substitute for police authorization, legal review, a privacy impact assessment, or penetration testing.

## Live ambulance, hospital and first-aid data

The app cannot create real-time data by itself. Each source needs an owner and an approved integration contract. For every ambulance/hospital record, identify its authoritative source, identifier, coordinate reference, update interval, timestamp, stale-data threshold, availability definition, and failure mode. Display provenance and last-updated time. If a feed becomes stale or unreachable, say **unknown/unavailable** rather than presenting seeded or cached values as live. Never automatically dispatch based only on approximate seed data.

All medical instructions must be approved and versioned by qualified clinical authorities for the target jurisdiction, language and intended user. Record the protocol/version shown, and provide safe escalation to trained dispatchers. Unreviewed repository content is demo-only.

## Deployment handoff checklist

- [ ] Police system owner has approved the environment, purpose, data flow, roles and test plan in writing.
- [ ] Synthetic demo data is visibly distinguished from verified live data.
- [ ] Caller speech/language behavior is tested with native speakers and noisy conditions; uncertainty and human fallback are demonstrated.
- [ ] Telephony and provider callback/message formats are verified against the actual provider account before accepting real calls.
- [ ] Every real ambulance/hospital feed is authorized, source-labelled, freshness-checked and load/failure-tested.
- [ ] Clinical content is reviewed, signed off, version-controlled and translated/reviewed by qualified people.
- [ ] Authentication, MFA/SSO expectations, least privilege, TLS, backups, retention, audit review, incident response and security testing are approved.
- [ ] Concurrency, outages, overload, duplicate callbacks, disconnects, database recovery and on-call operations have been tested.
- [ ] A human operator remains responsible for real dispatch and emergency decisions until the competent authorities explicitly approve another process.

## Support and current repository guidance

Use the repository README for setup, scripts and module details; `docs/asterisk-setup.md` for the optional PBX transport; and `.env.example` for configuration names. Never commit `.env` or provider secrets. The current supported start command for the integrated Node stack is `npm run dev:full`; the Python `emergency-dispatcher/` subtree is a separate prototype, not a replacement for the integrated police console.
