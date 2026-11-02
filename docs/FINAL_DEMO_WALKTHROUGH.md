# Final demonstration walkthrough

Presentation script for the isolated software prototype "Real-Time Sequential Decision System for Pre-Hospital Emergency Survival". It uses only commands that exist in this repository. Commands marked **[verified 2026-10-18]** were executed and observed on this machine during Stages 4.19–4.21; everything else is referenced from `docs/STAGE_4_19_DEMO_GUIDE.md` and is labelled accordingly.

This walkthrough does not establish clinical validity, live emergency-service readiness, survival prediction, live traffic control, physical-device verification, or production readiness. Milestones shown in the demo are operator-reported attestations, not independently verified observations, and "operational completion" is not a patient outcome.

## 1. Problem statement

Pre-hospital emergencies are time-critical: an unstructured phone call must become an auditable sequence of decisions — classify, assign an ambulance, choose a hospital, route, track, hand over — while every decision remains attributable, replayable, and reviewable. The project is a modular prototype of that sequential decision pipeline with an append-only event history, role-based access, and explicit human confirmation at every operational step.

## 2. Architecture: twelve modules

| # | Module | Role in the demo | Status |
| --- | --- | --- | --- |
| 1 | Emergency call | Call intake, utterances, final transcript persistence | Implemented; telephony transport is `loopback` (no real PBX) |
| 2 | Speech processing | Transcription/synthesis ports | Implemented; loopback provider in the demo |
| 3 | NLP extraction | Optional candidate symptoms/priority | Disabled by default; a candidate is never a classification |
| 4 | Conversation support | Silence/localisation layer for calls | Inert without an explicit reviewed configuration |
| 5 | Bystander assistance | Protocol sessions and guidance | **Sole clinical/protocol authority**; catalogue includes `UNREVIEWED` content |
| 6 | Ambulance management | Fleet, assignment, driver accept/decline, explicit dispatch, GPS ingestion | Implemented; automatic dispatch disabled |
| 7 | Hospital intelligence | Hospital selection | Implemented; automatic selection disabled |
| 8 | Route optimization | Response-leg routes | Mock provider only (`isLiveTraffic: false`); auto-route disabled |
| 9 | Corridor coordination | Priority corridors, notifications | Simulated records only; disabled by default |
| 10 | Lifecycle orchestration | Read-only lifecycle projection over the event log | Projection implemented; legacy FSM deliberately disconnected |
| 11 | Database & events | SQLite/Prisma persistence, auth, append-only event log, outcome governance | Implemented |
| 12 | Dashboard & analytics | Operations dashboard, live views, learning eligibility | Implemented; learning disabled, samples empty |

## 3. Implemented vs mocked or simulated

**Implemented and exercised live:** authentication (JWT, role-scoped), emergency intake, final transcript persistence, operator-confirmed classification, Module 5 protocol sessions, ambulance assignment, driver accept/decline, explicit dispatch, driver GPS ingestion with freshness, all four lifecycle milestones (operator-reported, idempotent, order-enforced), Module 10 projection, dashboard over a real socket, outcome submission/review/correction with learning exclusion.

**Mocked or simulated by design:** routing (deterministic mock; `isLiveTraffic: false`), police notifications (`MOCK_POLICE_CONTROL_ROOM`, `realPoliceContacted: false`), corridors/signals, telephony transport, GPS fixtures. Nothing contacts Google Routes, OSRM, telephony infrastructure, police recipients, or traffic controllers.

**Unverified:** physical Android GPS, live telephony media, real external providers, any clinical outcome claim.

## 4. Live demo script (with expected results)

Start from the repository root in PowerShell. Full safety detail is in `docs/STAGE_4_19_DEMO_GUIDE.md`.

1. **Start the isolated backend** — ` $env:RESUS_DEMO_ISOLATED = 'true'; npm run demo:server `
   *Expected:* prints "isolated demo backend ready", the loopback URL, the owned temp database path, three test-only accounts (dispatcher/operator/driver `@demo.test` with per-run passwords), and the demo emergency/ambulance/hospital ids. Credentials are printed once and stored nowhere. **[verified 2026-10-18]** — if port 4000 is occupied, add `$env:DEMO_PORT = '4021'` and keep that port for later steps.
2. **Start the dashboard** — ` npm run dev --prefix apps/dashboard `
   *Expected:* Vite prints `Local: http://127.0.0.1:5173/` (the config binds IPv4 loopback explicitly). **[verified 2026-10-18]** (with an alternate `-- --port` argument).
3. **Sign in as the dispatcher** at `http://127.0.0.1:5173` with the printed dispatcher credentials.
   *Expected:* live view lists the demo emergency (`CARDIAC_ARREST · CRITICAL`); fleet panel shows the demo ambulance with a fresh location. Wrong password shows "Invalid email or password." **[verified 2026-10-18 via automated browser checks]**
4. **Select the emergency** and open the lifecycle panel.
   *Expected:* final transcript, an `OPERATOR`-sourced classification, and all four milestones labelled operator reported and Observed; completion reads `OPERATIONAL COMPLETION RECORDED` with "this is not a patient outcome"; no survival field exists. **[verified 2026-10-18]**
5. **Show idempotency and authorization** — record the same milestone again, or sign in as the driver and try to record one.
   *Expected:* duplicate returns the same event id (`duplicate: true`); the driver receives a visible 403. **[verified 2026-10-18]**
6. **Show routing provenance** in the dispatch/route panel.
   *Expected:* the route record shows the mock provider and `isLiveTraffic: false`; any police notice is labelled simulated. **[verified 2026-10-18]**
7. **Optional automated proof** — ` npm run demo:verify ` (add `$env:DEMO_SERVER_LOG = <demo-server log path>` or the `DEMO_DISPATCHER_*` variables when needed; `DEMO_SKIP_BROWSER = 'true'` skips the Edge step).
   *Expected:* 28/28 checks pass, including headless Edge browser checks driven over the already-installed browser's DevTools protocol — no tooling is downloaded. **[verified 2026-10-18: 28/28 twice]**
8. **Stop** the dashboard with Ctrl+C; stop the backend with Ctrl+C or by creating the printed sentinel file (`%TEMP%\resus-demo-server-<port>.stop`).
   *Expected:* the backend deletes only the database it created and owned. **[verified 2026-10-18]**

If a second demo instance must run beside an existing one, choose a free `DEMO_PORT` and pass matching `DEMO_BASE_URL`/`DEMO_DASHBOARD_URL` to `demo:verify`; never stop a process you did not start.

## 5. Module 5 clinical authority and Module 10 projection

**Module 5 is the only clinical/protocol authority.** No other module generates clinical guidance; the dashboard only displays protocol sessions Module 5 created. A passing session/API test is not clinical approval, and parts of the catalogue are marked `UNREVIEWED`.

**Module 10 is a read-only projection.** It replays the committed event log into a monotonic lifecycle state and observed facts (transcript, classification, the four milestones). It has no write ports, rejects milestone events lacking explicit `OPERATOR_REPORTED` provenance, and its older FSM is intentionally not connected to the live application. The canonical lifecycle is the event projection you see in step 4.

## 6. Modules 11 and 12

**Module 11** owns all persistence and the append-only system-event log. Every operational step (assignment, dispatch, route, milestone, outcome) is an event with actor and sequence; duplicates are idempotent; out-of-order milestones are refused with 409. Outcomes are append-only with supersession lineage, independent review before learning eligibility, and automatic exclusion of test/simulation data.

**Module 12** serves the dashboard and analytics read-only over Module 11's data. Learning is disabled by default; the learning-sample store stays empty in the demo, and outcome events trigger no dispatch, routing, corridor, notification, clinical, or completion side effects (asserted by tests).

## 7. Limitations and future work

- Operator-reported milestones are attestations; there is no independent arrival/handover/survival evidence.
- No live telephony, real police contact, traffic-signal control, live routing providers, or physical-device GPS verification.
- Emergency status has no enforced transition table outside the milestone path.
- No clinical validation, accuracy metrics, or deployment claims are made anywhere in this prototype.
- Future work: device-attested GPS, reviewed provider integrations with real credentials and consent, tenant-scoped outcome APIs, and clinical review of the protocol catalogue.

## 8. Troubleshooting

- **Login fails** — credentials are per-run and printed once by `demo:server`; restart it if lost. Wrong passwords show "Invalid email or password."; an expired/absent token shows the session message and returns you to the sign-in screen.
- **Port occupied** — `demo:server` exits with `EADDRINUSE`; set `$env:DEMO_PORT` (e.g. `4021`) and use matching `DEMO_BASE_URL`. Vite auto-selects the next free port and prints the actual `Local:` URL.
- **Dashboard loads but API calls fail** — you must open the Vite URL (`http://127.0.0.1:5173`), not the backend URL; the Vite dev server proxies `/api` and `/ws` to `127.0.0.1:4000` (test override: `RESUS_DASHBOARD_PROXY_TARGET`).
- **Verification fails** — `demo:verify` needs a running pair and the printed credentials; check `DEMO_BASE_URL`/`DEMO_DASHBOARD_URL` match your ports, and that Edge exists or set `DEMO_SKIP_BROWSER = 'true'`.
- **Anything ambiguous** (migration target, database ownership, unmocked provider) — stop rather than improvise.

## 9. Pre-presentation checklist

- [ ] `git status` reviewed; no unrelated processes stopped; demo ports free or offsets chosen.
- [ ] Backend starts, prints accounts and fixture ids; note the emergency id.
- [ ] Dashboard opens on `http://127.0.0.1:5173`; dispatcher login works; wrong-password message correct.
- [ ] Lifecycle panel shows four operator-reported milestones and the no-outcome disclaimer.
- [ ] Duplicate milestone idempotent; driver 403 demonstrated.
- [ ] Route shows mock provider and `isLiveTraffic: false`.
- [ ] `npm run demo:verify` passes (or was run the same day).
- [ ] Backend stopped via Ctrl+C/sentinel; owned database removed; no leftover listeners from your run.
- [ ] Talking points: Module 5 sole clinical authority; Module 10 read-only; learning disabled; nothing here is clinical validation or production readiness.

Optional automated regression evidence (run before presentation day; all verified 2026-10-18):

```powershell
$env:RESUS_RUN_ISOLATED_COMPOSITION_TEST = 'true'
node .\node_modules\vitest\vitest.mjs run tests/serverCompositionAmbulanceWorkflow.integration.test.ts
npm run typecheck
git diff --check
```

The full evidence tables (test counts, isolation guarantees, mocked providers) live in `docs/STAGE_4_19_DEMO_GUIDE.md`; consult it rather than improvising variants of the commands above.
