# Final Acceptance Report

**Project:** Real-Time Sequential Decision System for Pre-Hospital Emergency Survival
**Repository:** `F:\minor` · **Branch:** `main` @ `121d793` · **Acceptance date:** 2026-10-21
**Stage:** 4.29 — Final Integrated Acceptance and Gap Closure
**Historical Stage 4.29 conclusion: ACCEPTED FOR CONTROLLED PROTOTYPE DEMO**
**Latest completion result (2026-10-25): PARTIALLY COMPLETE** — see §12.

This report covers the isolated software prototype only. It does not claim
clinical validation, medical-device status, live emergency-service readiness,
survival prediction, live traffic control, or production readiness. Every
command below was executed on this machine during Stage 4.29 unless explicitly
marked as historical. Results reported by earlier stages are labelled as such.

---

## 1. Repository state preserved

| Check | Result |
| --- | --- |
| Branch / head | `main` @ `121d793` (5 commits; nothing staged, nothing committed) |
| Working tree | 132 modified/untracked entries preserved throughout; 133 after this report file |
| Forbidden operations | No reset, clean, stash, revert, commit, push, or branch switch performed |
| Dependencies | None installed; all runs used the existing `node_modules` |
| Databases | Only owned disposable SQLite files under the OS temp directory were used; the shared `dev.db` was never opened by acceptance runs |
| External providers | None contacted; routing/police/corridor/telephony paths are mocked or loopback by configuration |
| Other sessions | No unrelated processes were terminated; the demo backend and Vite server started by this stage were stopped by this stage (sentinel file and targeted process stop) |

## 2. Acceptance method and evidence levels

Per module: **Implemented** (code exists and is composed into the server),
**Automated-tested** (unit/integration suites passed in this stage's full run),
**Integrated-test verified** (covered by the isolated Fastify composition or
live-proxy tests), **Browser/live-process verified** (observed today against a
real listening backend + headless Edge over its DevTools protocol),
**Device/external-provider verified** (physical device or live external
service — none exist in this prototype), **Disabled-by-default safeguards**
(env-gated automation confirmed off).

Verification ran in this order today: full automated regression → live demo
backend + dashboard + `demo:verify` (HTTP + browser) → clean shutdown →
driver-app Flutter tests → typecheck/lint/diff checks.

## 3. Acceptance checklist — 12 modules

| # | Module | Implemented | Automated-tested (today) | Integrated / browser verified | Not verified / by design | Safeguards |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Emergency call intake | ✔ composition `app.ts` | ✔ `module01CallIntegration`, `callService`, `asteriskProtocols`, `audioBridgeConversation`, `audioBridgeSilence`, `callDurationWatch`, `asteriskConversationController` | ✔ composition workflow (intake + final transcript); ✔ demo:verify (transcript rendered in browser) | ✗ live PBX/telephony media (transport=`loopback`) | `TRANSPORT_PROVIDER=loopback` default; loopback reports `isLive=false` |
| 2 | Speech processing | ✔ | ✔ `module02SpeechIntegration`, `speechService`, `realSpeechProviders` (audio-format + confidence honesty) | ✔ loopback STT/TTS exercised in composition and demo | ✗ whisper.cpp / espeak-ng engines (not installed; test documents this rather than skipping) | Loopback provider default; no confidence invented |
| 3 | NLP extraction | ✔ classifier adapter + operator-triggered classify route | ✔ `module3Classifier`, `nlpClassifyRoute` | — | ✗ live Python service (`MODULE3_LIVE_TEST=1` — the single suite skip) | `MODULE3_NLP_ENABLED=false` default; a candidate is never a classification |
| 4 | Conversation support | ✔ `ConversationSupportAdapter` + localizer, inert without reviewed config | ✔ `module4Config`, `module4Localizer`, `module4ConversationSupport`, `module4ControllerLocalisation` | ✔ wired in composition (silence/localisation off by default) | ✗ no browser UI (bystander-facing by design) | Localisation requires reviewed translations file; silence timer off unless positive timeout |
| 5 | Bystander assistance | ✔ sole clinical/protocol authority | ✔ `protocolEngine`, `sessionService`, `factTrust`, `llm` | ✔ composition: Module 5 session access; protocol-chat dev harness (never in production) | ✗ no clinical approval implied by green tests; catalogue includes `UNREVIEWED` content; no bystander frontend | No other module generates clinical guidance (verified by code search) |
| 6 | Ambulance management | ✔ fleet, assignment, driver accept/decline, explicit dispatch, GPS ingestion | ✔ `assignment`, `assignmentDispatch`, `autoDispatch`(+integration), `config`, `driverAssignmentRoutes`, `fleet`, `integration` | ✔ composition workflow (assign → driver view → explicit dispatch); ✔ demo:verify (driver GPS accepted; fleet freshness updated in HTTP and browser) | ✗ physical Android GPS (driver app has contract tests only) | `MODULE6_AUTO_DISPATCH_ENABLED=false` default; composition asserts `autoDispatch.enabled === false` |
| 7 | Hospital intelligence | ✔ resource updates, explicit selection, suitability scoring | ✔ `autoSelect`, `config`, `hospitalResourceUpdate`(+integration), `hospitalSelection`(+integration), `operatorRoutes`, `suitability` | ✔ composition workflow (hospital selection); ✔ operational-events composition (resource update end-to-end with durable event) | ✗ real hospital systems | `MODULE7_AUTO_SELECT_ENABLED=false` default; suitability table documented as routing aid, not clinical advice |
| 8 | Route optimization | ✔ deterministic mock default, provider provenance, recalculation | ✔ `autoRouteService`, `config`, `googleRoutesProvider`, `osrmRoutingProvider`, `operatorRoutes`, `routeGeneration.integration`, `routeRecalculation`(+integration, +actor.integration), `routingProviders` | ✔ operational-events composition (initial generation + recalculation + injected provider-failure handling); ✔ demo:verify (browser shows `provider: mock`, `isLiveTraffic: false`) | ✗ live OSRM/Google calls | `MODULE8_PROVIDER=mock` default; `MODULE8_AUTO_ROUTE_ENABLED=false`; fails closed to mock |
| 9 | Corridor coordination | ✔ simulated corridors + road users + notifications | ✔ `autoCorridorService`, `config`, `corridorCoordination.integration`, `corridorService`, `geometry`, `operatorRoutes`, `policeNotificationRoutes`, `policeNotificationService` | ✔ composition workflow (mock police-notification records; `realPoliceContacted: false`) | ✗ traffic signals, road-user feeds, real police messaging | `MODULE9_CORRIDOR_ENABLED=false`; every corridor `priorityMode: SIMULATED`, every notification `delivered: false` |
| 10 | Lifecycle orchestration | ✔ read-only projection; legacy FSM deliberately not wired | ✔ `lifecycleProjection`, `lifecycleObserver`, `lifecycleRoutes`, `stateMachine` | ✔ composition waits for replay before serving; ✔ demo:verify + browser (all four milestones operator-reported, idempotent duplicate, driver 403, no survival field) | ✗ independent arrival/handover verification (attestations only, by design) | No write ports; projection rejects milestone events lacking `OPERATOR_REPORTED` provenance; grant/audit events excluded from lifecycle allowlist |
| 11 | Database & events | ✔ SQLite/Prisma persistence, JWT auth, append-only event log, outcome governance (submissions, reviews, corrections, emergency scope, per-emergency grants, grant audit) | ✔ `transactionSafety`, `ambulanceAssignmentDecision`, `analyticsLearningWrite`, `learningSampleSeedPolicy`, `outcomeHistory.integration`, `simulatedPoliceNotificationRepository`, `module11EventQueryRoute`, `module11OperationalEventQuery` | ✔ `outcomeApi` (8), `outcomeEmergencyScope` (9), `outcomeAccessGrants` (12), `outcomeGrantAudit` (12) — 41 scenarios, all passing today | ✗ multi-tenant/production hardening claims | 5 schema migrations applied only to disposable DBs by tests; role gates + strict zod bodies; transactional grant+event writes |
| 12 | Dashboard & analytics | ✔ operations dashboard, live views, outcome submission/review UI, ADMIN grant-management UI, operational event history | ✔ `dashboard`, `dashboardFrontend` (32), `integration`, `learning` (9), `analytics`, `config` | ✔ `dashboardLiveProxy` through the real Vite `/api` proxy; ✔ demo:verify 28/28 incl. headless Edge (login failure message, token not persisted, live emergencies, fleet freshness, lifecycle evidence, dispatch provenance) | ✗ grant-management UI not scripted inside the Edge browser checks (covered by 32 automated frontend tests + 24 grant/audit server tests) | `MODULE12_LEARNING_ENABLED=false` default; learning write-gate tested; outcome events emit no operational side effects (tested) |

## 4. Integrated workflow evidence (Stage 4.29)

### 4.1 Emergency and dispatch workflow
`tests/serverCompositionAmbulanceWorkflow.integration.test.ts` (isolated Fastify
composition, owned disposable SQLite, mock adapters): asserts automatic
dispatch/route/corridor subscribers are disabled, login (incl. invalid password
401), emergency intake with final transcript, explicit assignment, driver
assignment view, explicit dispatch, hospital selection, deterministic mock
route with `isLiveTraffic: false`, simulated police-notification records, and
operator-reported lifecycle milestones with Module 10 projection — **passed in
today's full run**. Browser-side: demo:verify confirmed the dispatch workflow
render, non-live route provenance, and lifecycle evidence.

### 4.2 Hospital and routing workflow
`tests/serverCompositionOperationalEvents.integration.test.ts`: hospital
resource update via API → repository read-back → durable event; initial route
generation; route recalculation; injected provider failure handling
(`FAIL` mode → mock fallback); operator visibility of the event history —
**passed today**. Module 7/8 unit + integration suites (resource updates,
selection, recalculation actor, provider contracts) — **passed today**. Live
OSRM/Google were never contacted (mock provider only).

### 4.3 Lifecycle and telemetry workflow
Demo pair running today: driver GPS update accepted (HTTP 200, `source=MOBILE`),
fleet freshness reflected within the same second, lifecycle projection
`OPERATIONAL_COMPLETION_RECORDED` with all four milestones
`OPERATOR_REPORTED`, completion carrying no survival claim, duplicate milestone
`duplicate=true`, driver role 403, unknown emergency 404, unknown milestone
422. `dashboardLiveProxy` and Module 10 suites passed in the full run.
Module 10 observed facts only: no write ports; legacy FSM not connected in
`apps/server/src/app.ts`.

### 4.4 Outcome security workflow
41 integration scenarios across four suites all passed today:
per-emergency scope denials (9), SUBMIT/REVIEW capability separation and grant
management (12), durable `OUTCOME_GRANTED`/`OUTCOME_GRANT_REVOKED` audit events
+ ADMIN audit/list endpoints with transactional rollback (12), and core
submission/review/correction governance incl. independent review, append-only
lineage, forged-field rejection, and learning-eligibility rules (8).
Dashboard grant-management UI: 32 frontend tests (role gate, exact API
contracts, reactivation notice, revoke confirmation flow, audit table,
error surfacing) — passed today. Learning samples stayed empty throughout the
demo pair; learning reads remained admin-only (403 observed in demo:verify).

### 4.5 Dashboard and demo workflow
`npm run demo:server` (isolated flag required) started the real composition on
`127.0.0.1:4000` against an owned temp database, printed per-run credentials
once, and refused nothing it should. `npm run dev --prefix apps/dashboard`
served Vite on `127.0.0.1:5173`. `node scripts/demo-verify.ts` reported
**28/28 PASS** — HTTP checks on real sockets plus headless Edge browser checks
(no browser tooling downloaded). Shutdown: sentinel file →
`[demo-server] disposed owned database … stopped (stop-file)`; owned DB
deleted; ports freed; no leftover listeners.

## 5. Architecture boundaries verified

| Boundary | Evidence |
| --- | --- |
| Module 5 is the sole clinical/protocol authority | Code search: no clinical-guidance generation outside `module_05_bystander_assistance`; Module 7 suitability documented as "routing aid, not clinical advice"; conversation controller and Module 3 classifier explicitly keep interpretation out of their layers |
| Module 6 automatic dispatch disabled by default | `MODULE6_AUTO_DISPATCH_ENABLED` opt-in only; composition asserts `autoDispatch.enabled === false` |
| Modules 7–9 fail-closed + simulation safeguards | Auto-select / auto-route / corridor all env-gated opt-in; mock routing default; corridors `SIMULATED`; notifications `delivered: false`, `realPoliceContacted: false`; provider-failure tests assert fallback |
| Module 10 read-only projection | Observer consumes bus + event query only; no write ports in composition; legacy FSM not imported into the live app; grant/audit events excluded from the lifecycle allowlist (tested) |
| Module 11 durable persistence/event authority | Append-only event log with actor+sequence; transactional writes (grant row + event roll back together); all operational steps are events |
| Module 12 learning disabled | `MODULE12_LEARNING_ENABLED=false` default; learning service short-circuits when disabled (tested); demo pair showed empty samples + admin-only reads |
| No dangerous side effects during acceptance | No learning-model activation, no live police contact, no traffic-signal control, no external provider calls; transports loopback; demo server pins safety flags internally |

## 6. Exact commands and results (Stage 4.29, this machine)

| # | Command | Result |
| --- | --- | --- |
| 1 | `git status --porcelain` / `git log --oneline -10` | 132 entries preserved; `main` @ `121d793`; nothing staged |
| 2 | Full vitest with `RESUS_RUN_ISOLATED_{OUTCOME_GRANT,OUTCOME_API,OUTCOME,COMPOSITION}_TEST=true` + `RESUS_RUN_DASHBOARD_LIVE_TEST=true` | **85 files: 84 passed, 1 skipped · 802 tests: 801 passed, 1 skipped** (skip = `module3Classifier.live` behind `MODULE3_LIVE_TEST=1`, by design) |
| 3 | `RESUS_DEMO_ISOLATED=true npm run demo:server` | Ready on `127.0.0.1:4000`; owned DB under `%TEMP%`; credentials/fixtures printed once |
| 4 | `npm run dev --prefix apps/dashboard` | Vite ready on `http://127.0.0.1:5173` |
| 5 | `node scripts/demo-verify.ts` (with `DEMO_SERVER_LOG`) | **28/28 PASS** (HTTP + Edge browser, DevTools protocol, nothing downloaded) |
| 6 | Sentinel stop file | `disposed owned database … stopped (stop-file)`; DB deleted; port freed |
| 7 | `flutter test --no-pub --concurrency=1` (`apps/driver`) | **4/4 passed** |
| 8 | `flutter analyze --no-pub` (`apps/driver`) | **No issues found** |
| 9 | `npm run typecheck` | Clean (exit 0) |
| 10 | `npm run lint` (whole repo) | 17 errors / 49 warnings — **all pre-existing** `no-unused-vars` debt in files untouched by this stage (legacy Module 10 FSM files, a few route/service files, test helper). Not release-blocking: typecheck and all tests pass; instructions forbid unrelated style fixes. Documented lint debt below. |
| 11 | `git diff --check` | Exit 0 (repo-wide CRLF warnings only, pre-existing) |
| 12 | Leftover-process check | Ports 4000/5173 free; no stray node processes from acceptance runs |

No test failed during Stage 4.29; no fix was required.

## 7. Confirmed defects fixed during this stage

**None.** Every suite, the live demo pair, `demo:verify` (28/28), Flutter
tests/analyze, typecheck, and diff-check were green on first execution. No
code, configuration, or schema was modified during Stage 4.29.

## 8. Known limitations and unverified integrations

- **Unverified external/device integrations:** live telephony (Asterisk PBX),
  real STT/TTS engines (whisper.cpp, espeak-ng), live routing (OSRM/Google
  Routes), police/traffic-signal systems, physical Android GPS, the live
  Module 3 Python classifier service. All are mocked, loopback, or absent by
  design; nothing was contacted during acceptance.
- **Operator-reported milestones are attestations**, not independently
  verified observations; "operational completion" is not a patient outcome.
- **Clinical content:** parts of the Module 5 catalogue are `UNREVIEWED`; no
  clinical validation or accuracy claim is made anywhere.
- **Grant-management UI** is covered by automated frontend + server tests but
  was not scripted inside the Edge browser checks; `demo:server` provisions
  dispatcher/operator/driver accounts only (no ADMIN fixture), so a live
  browser walkthrough of the ADMIN grant panel would need an ADMIN account
  added to the demo fixtures — optional, not release-blocking.
- **Documentation drift:** `docs/MODULE_DEPENDENCY_MAP.md` still describes an
  early inventory (Modules 1–4, 7–10 absent). The authoritative current
  module status table is `docs/FINAL_DEMO_WALKTHROUGH.md`. The outdated map is
  recorded here rather than rewritten during acceptance.
- **Lint debt:** 17 pre-existing `no-unused-vars` errors and 49 warnings in
  files outside this stage's scope; functional gates (typecheck, tests) pass.
- **SQLite/Prisma** single-node persistence only; no multi-tenant or HA claims.

## 9. Remaining blockers

**None for the controlled prototype demonstration.** The gaps in §8 are
documented limitations of an isolated prototype, not defects blocking the
college demo.

## 10. Reproducible demonstration instructions (verified today)

Run from the repository root in PowerShell. These exact commands were executed
and observed on 2026-10-21.

1. **Backend (isolated, disposable database):**
   ```powershell
   $env:RESUS_DEMO_ISOLATED = 'true'; npm run demo:server
   ```
   Prints the loopback URL, owned temp-database path, three per-run test
   accounts (dispatcher / operator / driver `@demo.test`), and demo emergency /
   ambulance / hospital ids. Credentials are printed once and stored nowhere.
   If port 4000 is busy: `$env:DEMO_PORT = '4021'` and keep that port below.
2. **Dashboard:**
   ```powershell
   npm run dev --prefix apps/dashboard
   ```
   Open the printed `Local:` URL (default `http://127.0.0.1:5173`).
3. **Login** with the printed dispatcher credentials → live view shows the demo
   emergency (`CARDIAC_ARREST · CRITICAL`); fleet panel shows the demo
   ambulance with a fresh location; wrong passwords show
   "Invalid email or password."
4. **Walk the workflow:** select the emergency → final transcript, OPERATOR
   classification, four operator-reported milestones, completion disclaimer;
   re-record a milestone (idempotent `duplicate: true`); sign in as driver and
   attempt a milestone (403); dispatch/route panel shows `provider: mock`,
   `isLiveTraffic: false` and simulated police notice.
5. **Optional automated proof:**
   ```powershell
   node .\scripts\demo-verify.ts
   ```
   (Add `$env:DEMO_SERVER_LOG = <log path>` if the server output was
   redirected; set `$env:DEMO_SKIP_BROWSER = 'true'` to skip Edge.)
   Expected: 28/28 PASS.
6. **Automated regression evidence (pre-presentation):**
   ```powershell
   $env:RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST = 'true'
   $env:RESUS_RUN_ISOLATED_OUTCOME_API_TEST = 'true'
   $env:RESUS_RUN_ISOLATED_OUTCOME_TEST = 'true'
   $env:RESUS_RUN_ISOLATED_COMPOSITION_TEST = 'true'
   $env:RESUS_RUN_DASHBOARD_LIVE_TEST = 'true'
   node .\node_modules\vitest\vitest.mjs run
   npm run typecheck
   git diff --check
   ```
   Expected: 84 files passed / 1 skipped; 801 tests passed / 1 skipped;
   typecheck clean; diff-check exit 0.
7. **Shutdown:** stop the dashboard with Ctrl+C; stop the backend with Ctrl+C
   or by creating the printed sentinel file
   (`%TEMP%\resus-demo-server-<port>.stop`). Expected:
   `[demo-server] disposed owned database …` — only the owned database is
   removed.

Full narrative script and talking points: `docs/FINAL_DEMO_WALKTHROUGH.md`;
safety detail and environment matrix: `docs/STAGE_4_19_DEMO_GUIDE.md`.

## 11. Historical Stage 4.29 conclusion (superseded by §12)

**ACCEPTED FOR CONTROLLED PROTOTYPE DEMO.**

All twelve modules are implemented, automated-tested, and exercised through
isolated integrated workflows; the emergency/dispatch, hospital/routing,
lifecycle/telemetry, outcome-security, and dashboard workflows passed today
against real in-process and real-socket backends, including headless-browser
checks. Architecture safeguards (Module 5 sole clinical authority; Module 6–9
automation off by default; Module 10 read-only; Module 11 durable authority;
Module 12 learning disabled) were verified, not assumed. No release-blocking
defect was found; nothing external was contacted; the working tree was
preserved uncommitted.

This acceptance establishes software-prototype behaviour only. It is not
clinical validation, not device certification, and not production readiness.

## 12. Reverification addendum — 2026-10-25

**Overall result for this completion pass: PARTIALLY COMPLETE.** The isolated
prototype demo and software verification pass; P4 acceptance and the Module 5
disconnect policy remain blocked on human evidence and protocol-owner input.

The following results were captured against the current working tree. They
supersede the dated command counts above where the same check was rerun; the
historical acceptance scope and its limitations remain unchanged.

| Check | Current result |
| --- | --- |
| Full Vitest run with isolated outcome, composition, and dashboard-live gates enabled | **87 files passed, 1 skipped; 847 tests passed, 1 skipped**. The single skip is the opt-in live Module 3 classifier test. Two new timeout-body regression cases are included. |
| Opt-in Module 3 live-service test | **1/1 passed** under Python 3.14 in a temporary venv installed from the declared requirements. It exercised the real local FastAPI service and TypeScript adapter; Anthropic credentials were removed, Module 4/10 URLs were pinned to an unused loopback port, and the service returned its degraded fallback. No model-backed classification or downstream integration was tested. |
| Module 3 Python service unit tests | **21 passed** under that venv with `-W error::DeprecationWarning`; includes the new health-configuration regression. Anthropic calls are mocked in the unit suite. |
| Focused Module 5, audio/speech, and Module 10 projection tests | **10 files passed; 223 tests passed**. The real speech-provider suite is fake/executable-backed; no live STT/TTS engine was used. |
| Module 3 adapter focused tests | **10 tests passed**, including timeout enforcement while reading both success JSON and error response bodies. |
| Focused regression run after removing unused imports/helper code | **16 files passed; 94 tests passed** across Modules 1, 6, 12, and the owned isolated database harness. |
| `npm run typecheck` | Passed (exit 0), including after the final source cleanup. |
| `npm run build` | Passed (server and dashboard production bundles). |
| `npm run build --prefix apps/dashboard` | Passed (Vite production bundle). |
| Isolated `demo:server` + dashboard + `node scripts/demo-verify.ts` | Earlier this acceptance pass: **28/28 passed** over HTTP and headless browser checks. Not rerun after the Module 3 health/timeout-only changes. Driver GPS freshness, role denials, idempotent operator-reported milestones, non-live route provenance, dashboard evidence wording, and lack of persisted browser tokens were observed. |
| Flutter `flutter test --no-pub --concurrency=1` / `flutter analyze --no-pub` | **4/4 tests passed; no analyzer issues.** |
| `npm run protocols:validate` | Passed: 5 protocols / 33 steps, 0 errors, 3 escalation-metadata warnings. All 5 catalogues remain `UNREVIEWED`. |
| `npm run lint` | Passed (exit 0): **0 errors, 49 `any` warnings** remain across the repository. |
| `git diff --check` | Passed (exit 0); Git printed line-ending normalization warnings. |

The isolated demo backend was started with `RESUS_DEMO_ISOLATED=true`; its
owned SQLite file was removed by its own stop-file shutdown. The dashboard
server was stopped after verification. No shared database, real provider, PBX,
emergency service, or physical ambulance was used. This was a synthetic
software workflow, not a controlled telephony call. Automatic dispatch was
not enabled; Module 6 retains its fail-closed default.

The current WSL Malayalam bundle contains seven WAV files and the documented
`harness.py` experiment. Re-reading and decoding all seven files succeeded;
their WAVE metadata matched the recorded run metadata. The isolated model hash
matches the documented SHA-256, but the run recorded **0/7 exact and 0/7
normalized recognition matches**. The human-review checklist still has all
14 judgments blank. P4 therefore remains **NOT ACCEPTED** pending fluent
speaker review and the other stated live acceptance gates.

### Slow English voice interaction — 2026-10-25

The current speech path is Module 1 AudioSocket input -> Module 2 Whisper
transcription -> the existing Module 5 conversation controller -> Module 2
TTS -> paced AudioSocket output. Whisper converts captured mono signed 16-bit
8 kHz PCM to mono 16 kHz WAV and passes the call's language to whisper.cpp;
with `WHISPER_CPP_LANGUAGE=auto` and the existing call default `en`, English
calls are explicitly recognized with whisper.cpp `-l en`. Empty, unsupported,
low-confidence, and failed results retain the existing refusal/error paths.

The configured local eSpeak NG `-s` unit is approximate words per minute
(documented default 175). Its opt-in config default is now 145 WPM (82.9% of
default), voice `en-gb`; urgent prompts remain at that pace, and reassuring
prompts use 135 WPM. This host's WSL eSpeak NG 1.52.0 lists `en-gb` and `en-us`
but no `en-IN`/Indian-English voice, so the generated voice is British English,
not Indian English. The existing production-safe provider defaults remain
loopback; selecting local engines is an explicit configuration choice.

Generated three sample WAVs under `artifacts/slow-clear-english-samples/`
using the installed WSL eSpeak NG and `en-gb -s 145`: configured greeting,
location question, and a synthetic number/landmark phrase. All three were
decoded by the installed English-only whisper.cpp base model using explicit
`-l en`; its transcripts matched the wording (normalizing “fourteen” to “14”).
All three WAVs are mono 16-bit PCM at 22,050 Hz with no full-scale samples.
The existing Module 2 converter was also run against each actual WAV: it
produced mono signed 16-bit 8,000 Hz audio with durations preserved at 3,251,
6,809, and 4,299 ms respectively.
This is local real-engine sample evidence, not caller-audio, telephony, human
intelligibility, or clinical acceptance. The existing sample-safe TTS path
converts eSpeak's 22.05 kHz WAV to 8 kHz mono signed-linear PCM for AudioSocket.

No protocol catalogue is marked reviewed (all five remain `UNREVIEWED`), so no
clinical safety instruction was selected or rewritten for a sample. Prompt
wording and Module 5 transitions were left unchanged. The next voice checks
require a human to listen to the three WAVs, then a protocol owner to provide
approved safety wording if a safety-prompt sample is required. No real call was
placed. Automatic dispatch and Module 5 disconnect semantics were not changed.

After this voice change, the targeted speech suites passed: **2 files, 72
tests** (`realSpeechProviders.test.ts` and `speechService.test.ts`). The current
default full run was **79 files passed, 9 skipped; 784 tests passed, 66
skipped** (`npm test`, exit 0). It is not the earlier all-gates-enabled run:
this default invocation also skips opt-in integration suites; the one live
Module 3 classifier test remains skipped because it needs the configured
service/test setup. The local Whisper sample exercise above is separate from
Vitest and uses the actual local binary/model; it is not a live integration
test of caller audio or the Asterisk path.

Current tree checks after the change: `npm run typecheck` passed (exit 0),
`npm run lint` passed with 0 errors and 49 existing `any` warnings, and
`npm run build` passed (server and dashboard production bundles). These do not
replace the previously reported all-gates-enabled acceptance run or its
separate Flutter, demo, and protocol-validation results.

No Module 5 disconnect policy was approved or changed. `CALL_DISCONNECTED`
still describes telephony lifecycle only; the protocol owner must specify
the post-hangup status, `completedAt`, review retention, resumption, audit
linkage, and operator-visible status before any clinical-session transition
is implemented.

The protocol-owner request is also available as
[`MODULE5_DISCONNECT_POLICY_DECISION.md`](MODULE5_DISCONNECT_POLICY_DECISION.md).
It explains the current architectural implications, gives a clearly pending
proposal, and includes a response form. A separate blank fluent-speaker form
and safe sequential playback command are in
[`MALAYALAM_AUDIO_REVIEW_HANDOFF.md`](MALAYALAM_AUDIO_REVIEW_HANDOFF.md); the
experiment's original WAVs and checklist were not changed.

This run removed unused imports and an unused synthetic-test helper from
Module 1, Module 6, Module 12, the isolated database test harness, and the
legacy Module 10/server adapter/P4 harness. These edits do not change runtime
behavior. The complete source diff was left uncommitted and all pre-existing
modified and untracked files were preserved.

### Remaining external actions

1. The Module 5 protocol owner must approve the post-hangup session status,
   `completedAt`, review retention, resumption, audit linkage, and operator
   display before a clinical-session transition can be implemented.
2. A fluent Malayalam speaker must listen to the seven existing clips and
   complete the 14 checklist judgments. P4 remains **NOT ACCEPTED** even after
   that review until the remaining speech and live acceptance gates pass.
3. The local Module 3 fallback path is now verified 1/1 on a supported
   Python 3.14 runtime. This pass found that the standalone Python service's
   configured downstream paths (`/api/v1/dialog/initialize` and
   `/api/v1/state/transition`) do not match the current Module 4/10 surfaces:
   Module 4 is a CLI without an HTTP route, and Module 10 exposes other routes
   protected by `X-Internal-Token`, which Module 3 does not send. The payloads
   also lack the identity/contract needed to safely map an extraction into the
   current Module 10 API. No live or fake downstream integration is claimed;
   an owner-approved service contract and Module 4 API are required before a
   correct adapter can be implemented. The live test intentionally removes the
   Anthropic key and directs both configured URLs to an unused loopback port.
   The default full suite continues to skip this opt-in test.
4. This pass did not perform a controlled MicroSIP/Asterisk call or physical
   Android GPS check. Latest recorded speech acceptance remains failed for
   recognition and unverified for audibility; see the telephony report.

The Module 3 `/health` response now distinguishes process liveness from model
configuration: it identifies Anthropic as the provider and reports whether
credentials are configured, whether the path is fallback-only, and that
fallback is enabled. It never exposes a key or claims remote provider
reachability. A Python regression test covers configured and fallback-only
responses. The TypeScript adapter timeout now remains active through body reads;
two regression cases cover delayed successful and error bodies, which
previously could exceed the configured timeout after headers arrived. The
opt-in supported-runtime local fallback test passed again after these changes.
No real Anthropic call or downstream Module 4/10 service was exercised.

### Module 5 protocol-owner decision request — pending approval

For a telephony disconnect while the protocol session is unresolved in
`WAITING_FOR_RESPONSE`, please decide:

| Decision | Protocol-owner response |
| --- | --- |
| Resulting protocol status | Retain the unresolved status for review, or name an already-supported transition: ______ |
| `completedAt` | Leave null, set a timestamp, or specify another existing rule: ______ |
| Operator review | Should the session remain reviewable? Which operator role/view should expose it? ______ |
| Resumption | Is reconnection/resumption supported? If so, define identity, expiry, and restart point: ______ |
| Audit linkage | Which existing event must link the disconnected call to the protocol session and last step? ______ |
| Operator display | What status/message should operators see, and which existing projection/API should carry it? ______ |

The current `cancel()` method means emergency services reached the scene and
sets `CANCELLED` plus `completedAt`; it is not a hangup handler. No transition
or event should be added until the owner approves the complete contract.

### Module 3 live-test setup and current evidence

The opt-in test starts `uvicorn` itself from
`modules/module3_emergency_nlp`; it does not require an already-running service
or an Anthropic key. Its port is now configurable with
`MODULE3_LIVE_TEST_PORT` (default `8044`). A supported Windows setup is:

```powershell
$module3Venv = Join-Path $env:TEMP ("resus-module3-" + [guid]::NewGuid().ToString('N'))
py -3.11 -m venv $module3Venv
& (Join-Path $module3Venv 'Scripts\python.exe') -m pip install -r modules/module3_emergency_nlp/emergency_nlp/requirements.txt
$env:MODULE3_PYTHON = Join-Path $module3Venv 'Scripts\python.exe'
$env:MODULE3_LIVE_TEST = '1'
$env:MODULE3_LIVE_TEST_PORT = '18044'
$env:MODULE4_URL = 'http://127.0.0.1:9'
$env:MODULE10_URL = 'http://127.0.0.1:9'
$env:DISPATCH_RETRIES = '1'
npx vitest run tests/module3Classifier.live.test.ts
```

The final supported-runtime run used the temporary Python 3.14 venv,
`MODULE3_LIVE_TEST_PORT=18044`, and the two loopback-only downstream URLs;
Vitest reported **1 test passed**. A prior exploratory run under Python
3.10.2 also reached the service, but the new version guard correctly rejects
that interpreter. No model-backed classification or external provider result
was tested.

### Automatically generated English audio — 2026-10-25

Created a fresh, unique output directory for this run and left the earlier
`artifacts/slow-clear-english-samples/` directory untouched:

`F:\minor\artifacts\generated-english-audio-20261025T094721Z-ea4f1267\`

The requested text source files and complete run details are in `manifest.json`
and the corresponding `.txt` files in that directory. The three newly created
WAVs are:

| File | Bytes | WAV encoding | Duration | Local Whisper `-l en` transcript |
| --- | ---: | --- | ---: | --- |
| `greeting.wav` | 292,488 | mono PCM signed 16-bit, 22,050 Hz | 6.631383 s | “Hello. You are speaking with the reused training system. Please speak clearly after the tone.” (`RESUS` was heard as “reused”.) |
| `location.wav` | 300,332 | mono PCM signed 16-bit, 22,050 Hz | 6.809252 s | Exact match. |
| `number-and-landmark.wav` | 265,498 | mono PCM signed 16-bit, 22,050 Hz | 6.019365 s | “please save a house number, road name, and a nearby landmark slowly and clearly.” (“say” was heard as “save”; “the” was omitted.) |

`ffprobe` identified all streams as `pcm_s16le`; ffmpeg 8.0.1 decoded all
three without errors. Sample inspection found nonzero audio in every file
(peak/RMS: greeting 27608/3028.4, location 28894/3200.5, number/landmark
29033/3311.3), with no full-scale samples. The actual project converter
`decodeAudio` + `toMonoSlin` ran on these files and produced 8 kHz mono signed
16-bit samples at 6,631 ms, 6,809 ms, and 6,019 ms respectively.

The host's WSL installation is `/usr/bin/espeak-ng`, eSpeak NG 1.52.0. Its
English voice list includes `en-gb` (Great Britain) and `en-us` (America); no
Indian-English/`en-IN` voice was listed. It documents `-s` as approximate words
per minute with a default of 175. These files use the RESUS provider's
configurable default rate of 145 WPM with its calm delivery values (`-p 50`,
`-a 110`) and voice `en-gb` (British English). The application’s configurable
`ESPEAK_NG_VOICE` and `ESPEAK_NG_SPEED_WPM` settings flow into the provider;
urgent prompts retain the configured rate, while reassuring prompts use 10 WPM
less (not below 80). The provider rejects empty/unsupported requests, applies a
15-second default process timeout, rejects empty generated audio, and removes
its temporary work directory in `finally`.

The RESUS provider could not be invoked directly for file generation from this
Windows process: it launches a native child binary, while the verified eSpeak
executable is a WSL Linux binary. The samples were therefore generated by that
verified executable with the same provider voice, speed, calm pitch/amplitude,
and converted with the project's actual audio converter. This is not a live
provider-to-AudioSocket call. Local whisper.cpp and its English-only base model
were available; the actual transcripts and differences above are recorded in
the manifest. Those results are automated recognition only and do not establish
human intelligibility.

`play-samples.ps1` checks `ffplay.exe` and all three exact expected sample paths
before playing them sequentially; it does not search for or substitute audio.
The script parses successfully. Exact command to launch it:

```powershell
& 'F:\minor\artifacts\generated-english-audio-20261025T094721Z-ea4f1267\play-samples.ps1'
```

No human listening or live telephony was performed. The voice remains British
English because no local Indian-English voice was available; user listening is
still required to judge intelligibility and acceptability.

### Real TTS and Asterisk audio integration — 2026-10-25 follow-up

**Acceptance by layer**

| Layer | Status | Evidence and limit |
| --- | --- | --- |
| Conversation → Module 2 TTS → AudioBridge → AudioSocket output | **PASS (synthetic)** | Added `tests/asteriskSpeechPipeline.test.ts`. Actual `Module2` speech service, `AudioBridge`, `AudioSocket` framing, and conversation controller are connected in a loopback TCP test using in-process fake recognizer and synthesizer ports. It verifies call/session association, outgoing audio frames, incoming audio reaching STT, transcript order, next turn, and cleanup. This does not prove the eSpeak/Whisper engines or PBX media. |
| Audio format and existing speech provider behavior | **PASS (software/fake-backed)** | Existing provider tests and generated English WAV conversion evidence above cover the local conversion/provider behavior; no real-time provider-to-PBX call was run. |
| Local Asterisk service and dialplan | **PASS (read-only inspection)** | `wsl -d Ubuntu --exec sudo -n /usr/sbin/asterisk -rx "core show version"` reported Asterisk 22.5.2. `core show channels count` reported 0 active channels, 0 active calls, 0 processed. `dialplan show resus` showed Answer → `AudioSocket(${RESUS_CALL_UUID},127.0.0.1:9092)` → Hangup. A separate TCP connect check to `127.0.0.1:9092` returned `connect_ex=11` (connection refused); the application AudioSocket listener was not running/reachable in this check. |
| Actual PBX audio playback and two-way call | **BLOCKED / unverified** | No call was originated. Current workspace configuration does not establish that the separately running WSL service uses this checkout/configuration. A controlled local test endpoint and the matching server process/configuration are needed; no emergency/PSTN call is appropriate. |
| Malayalam human review | **BLOCKED on fluent-speaker review** | Verified that all seven WAV files remain in `.resus-p4-offline-new-20261023/samples/` and read `docs/MALAYALAM_AUDIO_REVIEW_HANDOFF.md`; its 14 independent judgment boxes and reviewer/date fields remain blank. Automated phrase recognition was 0/7 per the handoff and is not human acceptance. |
| Module 5 disconnect policy | **BLOCKED on protocol-owner decision** | Existing decision request remains in this report. No clinical transition, event, or hangup policy was inferred or changed. |

**Verification in this follow-up**

- Focused synthetic suite: `npm test -- --run tests/asteriskSpeechPipeline.test.ts modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts modules/module_01_emergency_call/tests/asteriskProtocols.test.ts` — 3 files passed, 65 tests passed.
- Full default suite: `npm test` — 80 files passed, 9 skipped; 785 tests passed, 66 skipped; exit 0. The opt-in `tests/module3Classifier.live.test.ts` was skipped. Other environment-gated integration tests were also skipped; this default run is not evidence for those external/database gates.
- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0; 0 errors, 49 `no-explicit-any` warnings.
- `npm run build` — exit 0; server and dashboard production builds completed.
- `git diff --check` — exit 0 (only Git line-ending conversion warnings were printed).
- Asterisk version/channels/dialplan and TCP listener commands listed above were read-only. No call, dispatch, user-data database operation, credentials, or external speech service was used.

**Files changed for this follow-up**

- `tests/asteriskSpeechPipeline.test.ts` adds the missing synthetic end-to-end application audio-path regression test; speech and transport adapters are deliberately fake-backed.
- `docs/FINAL_ACCEPTANCE_REPORT.md` records this evidence and the remaining controlled-test gates.

**Exact next action**

Authorize and arrange one controlled local test call from a synthetic/loopback PJSIP endpoint to the `resus` test extension, and identify the server process/configuration that should own the AudioSocket listener. Before that call, start/verify the matching application listener and use a non-emergency test identity. Do not test through PSTN or an emergency number. Full acceptance remains **PARTIAL** until actual two-way playback/recognition, the fluent Malayalam review, and the protocol-owner disconnect decision are complete.
