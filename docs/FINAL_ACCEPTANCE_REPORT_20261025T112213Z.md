# RESUS college-demo readiness report — 2026-10-25 11:22 UTC

**Status: PARTIALLY ACCEPTED FOR A LOCAL, SYNTHETIC SOFTWARE DEMONSTRATION.**
This report is not production, clinical, live-telephony, or real-dispatch
acceptance.

## Checkout and preservation

- Working directory: `F:\minor` (`Accident-assistance-system`).
- Branch: `main`; HEAD: `121d7933ae3edcd478089343fdc493f2757d2ad8`.
- Upstream display: `origin/master` (branch was not switched).
- Starting worktree: 164 modified/untracked entries, none staged. Existing work
  was preserved; no reset, clean, checkout, commit, push, or deployment occurred.
- `docs/FINAL_ACCEPTANCE_REPORT.md` and all other pre-existing reports were not
  overwritten. The only existing tracked document changed is
  `docs/MODULE_DEPENDENCY_MAP.md`, which now labels its old inventory as
  historical and adds a source-verified current inventory in §15.
- Current pre-report status: 71 modified and 94 untracked entries. New audit
  logs/builds and this report are additive under existing untracked locations.

## Module status

| Module | Verified current status | Limits / blockers |
| --- | --- | --- |
| 1 — Emergency call | Server composition, loopback/Asterisk adapters, routes, call lifecycle, synthetic AudioSocket framing and bridge tests exist; tests pass. | No PBX call or live two-way media was run. |
| 2 — Speech processing | Loopback and Whisper/eSpeak provider paths and routes exist; provider/speech tests pass. | Canonical English Whisper gate remains 3/7 normalized matches for direct and provider Whisper; no live caller-audio acceptance. |
| 3 — NLP extraction | Python FastAPI source and composed Node adapter/routes exist; adapter tests pass. | Live Python test skipped. Python 3.10 is below the module's 3.11 minimum; Python 3.14 lacks FastAPI/uvicorn/pytest. No packages were installed. |
| 4 — Conversation support | Server conversation/localization adapters and tests exist. Separate Python `modules/module_4` source was not established as wired into server composition. | No caller-facing conversation UI or independent legacy-service integration was tested. |
| 5 — Bystander assistance | Protocol engine, session service, API, LLM/heuristic boundary, and dev harness are composed; tests pass. | Five catalogues remain `UNREVIEWED`; three critical escalation rules produce validator warnings. Six disconnect decisions remain pending protocol-owner approval. |
| 6 — Ambulance management | Fleet, assignment, driver accept/decline, GPS ingestion, explicit dispatch, and opt-in automatic dispatch are composed; tests pass. | No real ambulance/dispatch integration or physical driver GPS was exercised. The interactive demo launcher currently seeds `isSimulation:false` records despite using a disposable `NODE_ENV=test` database; do not present those records as simulated until corrected. |
| 7 — Hospital intelligence | Resource updates and operator selection are composed; tests pass; auto-select defaults off. | No hospital system is connected. |
| 8 — Route optimization | Mock, OSRM, and Google providers exist; default is mock and auto-route defaults off; tests pass. | No external routing provider was contacted. |
| 9 — Corridor coordination | Corridor and notification records are simulated; tests pass with non-delivery assertions. | No signals, road-user feeds, police recipients, or traffic controls were contacted. |
| 10 — Lifecycle orchestration | Read-only event-log projection/observer and routes are composed; tests pass. A separate legacy FSM remains in the module tree. | Milestones are operator reports, not independently verified events or patient outcomes. |
| 11 — Database and events | Prisma schema, repositories, event bus, append-only event log, and migrations exist; schema validation and isolated migration tests pass. | This audit did not inspect or mutate any shared/runtime database. |
| 12 — Dashboard and analytics | Module 12 API/analytics and React/Vite dashboard exist; frontend, API, and live local proxy tests pass. | Physical driver-device UI and GPS behavior remain unverified. |

## Findings and priorities

- **P0:** None demonstrated by the local baseline.
- **P1 acceptance blockers:** English Whisper recognition is below its 7/7
  normalized gate (3/7); live PBX/two-way audio is unverified; Module 5 content
  is unreviewed and disconnect policy lacks owner decisions. These are not
  evidence of a provider-code defect; restricted model/VAD/policy changes were
  not made.
- **P1 demo-safety correction still needed:** `scripts/demo-server.ts` is an
  existing untracked file and seeds ambulance, hospital, emergency, and GPS
  payloads with `isSimulation:false`. It uses an owned disposable database,
  loopback speech/transport, and fail-closed automation, but the persisted
  simulation flags conflict with the simulated-only demo rule. The file was
  left unchanged under the no-overwrite-without-approval rule. Safest next code
  step: change those fixture flags to `true`, add a focused regression
  assertion, then rerun the demo integration.
- **P2:** `npm run lint` exits 1 on two `no-empty` errors in existing untracked
  Whisper experiment scripts under `artifacts/`; 49 additional warnings were
  reported. Those files were left unchanged. The historical dependency map's
  false current-state claims are corrected by its dated §15 addendum.
- No P0/P1 application-source defect was established that could be corrected
  without changing restricted speech/protocol behavior or the untracked demo
  launcher.

## Baseline and verification

Full outputs are preserved in
`F:\minor\artifacts\readiness-audit-20261025T111148Z-9f1dc276\`.

| Command / operation | Result |
| --- | --- |
| `npm run typecheck` | PASS, exit 0. |
| `npm run lint` | FAIL, exit 1: 2 errors, 49 warnings. Both errors are in existing artifact scripts, not application source. |
| `npm test -- --reporter=dot` | PASS: 80 files, 785 tests passed; 9 files / 66 tests skipped behind opt-in integration/live gates. |
| Same Vitest command with `RESUS_RUN_ISOLATED_COMPOSITION_TEST`, `RESUS_RUN_ISOLATED_OUTCOME_TEST`, `RESUS_RUN_ISOLATED_OUTCOME_API_TEST`, `RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST`, `RESUS_RUN_DASHBOARD_LIVE_TEST` set to `true` | PASS: 88 files, 850 passed, 1 skipped (live Python Module 3). DB integration tests used owned temporary SQLite files. |
| `npm run protocols:validate` | PASS with 0 errors and 3 warnings across 5 catalogues / 33 steps; all 5 catalogues are `UNREVIEWED`. |
| `DATABASE_URL=file:./nonexistent-validation-only.sqlite npx prisma validate --schema modules/module_11_database_event_system/prisma/schema.prisma` | PASS. Schema validation only; no database opened. |
| Server `esbuild` and Vite dashboard build to fresh audit `build-server` and `build-web` paths | PASS, both exit 0. Normal `npm run build` was not run because existing `dist/server` and `dist/web` would be overwritten. |
| `flutter test --no-pub --concurrency=1`; `flutter analyze --no-pub` | PASS: 4 tests; no analyzer issues. Run against a source mirror so existing ignored `.dart_tool`/`build` outputs were not changed. |
| Python pytest / live Module 3 | NOT RUN: pytest/uvicorn/FastAPI absent from available Python 3.14; Python 3.10 is below the module's declared minimum. No dependencies installed. |
| PBX/PJSIP calls, live speech, manual interactive demo | NOT RUN. No calls were placed and no service was changed. |

No automated result is claimed for live telephony, caller intelligibility,
clinical validity, or real dispatch.

## Repeatable synthetic demonstration

The verified end-to-end path is the isolated composition workflow: owned
disposable SQLite, loopback call/speech adapters, simulated records, mock
routing, explicit operator actions, and disabled automatic dispatch. Rerun
these composition scenarios in PowerShell:

```powershell
$env:RESUS_RUN_ISOLATED_COMPOSITION_TEST = 'true'
npx vitest run --reporter=dot tests/serverCompositionAmbulanceWorkflow.integration.test.ts tests/serverCompositionOperationalEvents.integration.test.ts
Remove-Item Env:\RESUS_RUN_ISOLATED_COMPOSITION_TEST
```

Rerun the dashboard's live local proxy workflow separately:

```powershell
$env:RESUS_RUN_DASHBOARD_LIVE_TEST = 'true'
npx vitest run --reporter=dot tests/dashboardLiveProxy.integration.test.ts
Remove-Item Env:\RESUS_RUN_DASHBOARD_LIVE_TEST
```

Expected: emergency intake, transcript storage, operator classification,
assignment/driver acceptance, simulated GPS, explicit dispatch, mock
route/hospital/corridor actions, operator-reported lifecycle projection, and
dashboard API calls through a real local Vite proxy. These are synthetic/local
workflows, not telephony tests.

The documented interactive launcher sequence (`RESUS_DEMO_ISOLATED=true`,
`npm run demo:server`, dashboard Vite, then `npm run demo:verify`) is **not
accepted as simulation-safe yet** because of the `isSimulation:false` fixture
flags above. Correct and verify those flags before using its dispatch display.

## Final acceptance boundary

Suitable today for a **local synthetic software demonstration** only, using the
isolated composition workflow and clearly labelled mock/simulation data. Not
production-ready. English recognition, Module 5 clinical review and
disconnect-owner decisions, interactive demo fixture flags, actual PBX audio,
physical GPS, live external integrations, and the live Python Module 3 service
remain unaccepted or untested.
