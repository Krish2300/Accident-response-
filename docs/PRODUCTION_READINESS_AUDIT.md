# Production Readiness Audit — College Demonstration

**Repository:** `F:\minor` · **Branch:** `main` @ `121d793` · **Audit date:** 2026-10-23
**Scope:** Steps 1–4 of the integrated acceptance audit: verified baseline, 12-module status, integrated demonstration matrix, prioritized blockers, exact verification commands, acceptance criteria, dependencies and effort, and a phased remediation plan.

> **What this document is.** A development/audit artifact for a **controlled academic prototype**. It does **not** claim production readiness, clinical validation, medical-device status, live emergency-service capability, or physical-device verification. No test result appears here unless it was actually executed and its output captured on 2026-10-23 unless explicitly dated. Credentials, API keys, and patient data are never included; secrets are referenced by environment-variable name only.

---

## 1. Current verified baseline

### 1.1 Repository state (checked 2026-10-23, this audit)

| Check | Result |
| --- | --- |
| Branch / head | `main` @ `121d793` ("Implement ambulance tracking and dashboard modules") |
| Working tree | 148 porcelain entries (63 modified + 85 untracked); **0 staged**, **0 stashes**, no branch switch |
| Git operations this audit | none — documentation-only run; no commit, push, reset, clean, stash, or revert |
| Prior stages preserved | 4.17.x outcome governance, 4.18 cross-module audit, 4.19 integration/demo work — all present in the working tree and untouched |

### 1.2 Test baseline (re-run in this audit, not historical)

Command (repository root, PowerShell, five suite-enable flags):

```powershell
$env:RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_API_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_TEST = 'true'
$env:RESUS_RUN_ISOLATED_COMPOSITION_TEST = 'true'
$env:RESUS_RUN_DASHBOARD_LIVE_TEST = 'true'
node .\node_modules\vitest\vitest.mjs run
```

**Result (2026-10-23):** exit **0** — **86 files: 85 passed, 1 skipped · 830 tests: 829 passed, 1 skipped** (138.71 s). The single skip is `tests/module3Classifier.live.test.ts`, gated behind `MODULE3_LIVE_TEST=1` by design. Every database-backed test used the owned disposable-SQLite harness (`tests/helpers/isolatedTestDatabase.ts`); no shared database was opened.

Other gates captured 2026-10-23 on the same working tree:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0, clean |
| `npx prisma validate` with an explicit throwaway `DATABASE_URL` | exit 0, schema valid, no file created |
| `flutter test --no-pub --concurrency=1` (`apps/driver`) | **4/4 passed** |
| `flutter analyze --no-pub` (`apps/driver`) | **No issues found** |
| `git diff --check` | exit 0 (pre-existing repo-wide CRLF warnings only) |
| `demo:server` + Vite + `node scripts/demo-verify.ts` (Windows isolated pair) | **28/28 PASS**, incl. headless-Edge browser checks; pair then stopped via stop sentinel; owned temp database disposed; ports freed |

### 1.3 Deployment configuration (Windows / WSL)

Two runtime environments exist; they are not interchangeable.

| | **Windows (`F:\minor`)** | **WSL2 `Ubuntu` (`/home/resus/resus`)** |
| --- | --- | --- |
| Role | Development, full test suite, isolated demo backend, Vite dashboard, driver app | **Live telephony deployment** — full 12-module build synced 2026-10-22 (`docs/DEPLOYMENT_CONSISTENCY_REPORT.md` §3) |
| Backend | `demo:server` (owned temp SQLite) or in-process test composition | systemd `resus-server.service` (enabled, active), `tsx apps/server/src/main.ts`, port **4000**, `HOST=0.0.0.0` |
| Telephony | none — `TRANSPORT_PROVIDER` unset → code default `loopback` | Asterisk active: AMI `127.0.0.1:5038`, AudioSocket `0.0.0.0:9092` |
| Speech | loopback (no whisper/espeak binaries on Windows) | `SPEECH_PROVIDER=whisper` (`whisper-cli` + `ggml-base.en.bin`), `SPEECH_SYNTHESIS_PROVIDER=espeak` |
| Database | repo `dev.db` referenced by the older root `.env` (manual sessions only) | `modules/module_11_database_event_system/prisma/dev.db`, 10/10 migrations applied (2026-10-22, additive), preserved |
| Dashboard | Vite dev server `apps/dashboard` on `127.0.0.1:5173`, proxying `/api`+`/ws` to `127.0.0.1:4000` | server does not serve static assets; dashboard is expected from Windows or any Vite host |
| Other services | MicroSIP (running, local SIP extension 1001), Ollama (`127.0.0.1:11434`, running) | attached keeper session + `vmIdleTimeout=-1` (P1 remediated 2026-10-23 — see deployment report §4.1) |

**Cross-boundary connectivity (verified 2026-10-23):** `.wslconfig` uses `networkingMode=mirrored`; Windows → `http://127.0.0.1:4000/api/health` returns **HTTP 200** while the WSL keeper is alive, so the Windows-hosted dashboard can reach the WSL backend. The connection fails whenever the distro is not running (observed once during this audit between `wsl` command batches) — this is the P1 blocker below, not a networking defect. **P1 remediated later the same day** (see §4): with `vmIdleTimeout=-1` plus one attached keeper session, Windows→WSL probes stayed at HTTP 200 across a 90 s idle interval.

**WSL service lifecycle observation (2026-10-23, journal):** with no keeper process, each finished `wsl` command batch let the distro exit; systemd then stopped and re-started `resus-server.service`, producing SIGTERM ~15 s after each `server ready` (cycles at 05:18/05:19 UTC). A `nohup sleep infinity &` keeper (started by this audit for inspection) keeps the distro and services alive. The deployment guide (`docs/DEPLOYMENT_CONSISTENCY_REPORT.md` §4.1) documents this requirement. **Root-caused and remediated 2026-10-23 (Phase 1):** the SIGTERM was systemd's orderly poweroff of the WSL VM after its idle timeout (service exit 0, not a crash); a second layer — WslService dropping the Windows→WSL relay when the distro is marked "Stopped" — required one attached session. Fix: `vmIdleTimeout=-1` in `C:\Users\sanja\.wslconfig` + a hidden `wsl -d Ubuntu -- sleep infinity` keeper; verified with a 90 s idle test (kernel continuity + HTTP 200 from Windows). Exact commands: deployment report §4.1.

### 1.4 WSL database baseline (read-only inspection, 2026-10-23)

`prisma/dev.db` (987 136 bytes): `emergencies=132`, `call_sessions=125`, `transcripts=144`, `system_events=720`, `ambulances=6`, `outcome_assertions=0`, `users=1` — the single account is the seeded `operator@resus.local` (OPERATOR). No writes were made to this database during the audit. Row counts are historical test data, all created under `isSimulation` scenarios in earlier stages.

### 1.5 Live service checks performed during this audit (2026-10-23)

| Probe | Endpoint / action | Result |
| --- | --- | --- |
| Backend health | `GET /api/health` (WSL, and again from Windows) | 200 — `routes:71`, modules 01,02,03,05,06,07,08,09,10,11,12 registered (module 04 is the in-server conversation layer) |
| Telephony transport | `GET /calls/transport/status` | 200 — `{"provider":"asterisk","isLive":true,"reachable":true}` |
| Speech providers | `GET /speech/status` | 200 — whisper live (en, ml), espeak live (en, ml), `minConfidence 0.45` |
| LLM extraction | `GET /api/health/llm` | `available:false` — `qwen3:8b` not pulled; `degraded:true`, fallback enabled (Ollama itself reachable) |
| TTS engine (direct) | `espeak-ng -w /tmp/... 'This is a local synthesis check.'` | produced an 86 086-byte wav; temp file deleted afterwards |
| STT engine (direct) | `whisper-cli -ojf` on the JFK test wav | transcribed correctly ("And so my fellow America ask not …") — real recognition, run outside the database (no writes) |
| Safety flags in WSL `.env` | grep | `MODULE6/7/8/9` automation and `MODULE12_LEARNING` keys **not set** → fail-closed code defaults (disabled); `NODE_ENV=development`, `TRANSPORT_PROVIDER=asterisk` |

Not run during this audit (dated evidence cited instead): a full MicroSIP phone call (last live call evidence 2026-10-21/22, `docs/TELEPHONY_E2E_TEST_REPORT.md`, `docs/DEPLOYMENT_CONSISTENCY_REPORT.md` §3.4), and live LLM extraction (never live-verified; model absent).

---

## 2. Module-by-module status

Classification key: **IMP** implemented · **AT** automated-tested (today's suite) · **IT** integration-tested (isolated Fastify composition / live-proxy tests, today) · **LV** live-verified (real deployment, dated) · **SIM** simulated/mocked by design · **DIS** disabled by default · **UNV** unverified. "Live-device-verified" is claimed only for the MicroSIP softphone leg (dated 2026-10-21/22).

| # | Module (purpose) | Init / dependencies | Key APIs | Persistence | Tests (2026-10-23) | Runtime status | Demo role | Class |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Emergency call — call-session lifecycle, transport | composed in `apps/server/src/app.ts`; `startAsteriskRuntime` when `TRANSPORT_PROVIDER=asterisk`; needs M11 + M2 audio bridge | `POST /calls`, `POST /calls/:id/hangup`, `GET /calls/:id`, `GET /emergencies/:id/transcripts`, `GET /calls/transport/status`, AudioSocket :9092 | `call_sessions`, `transcripts` (via M11) | module 4 files/85; root `module01CallIntegration` 10, `asteriskConversationController` 11, `callDurationWatch` 5 → **111** | WSL: asterisk live (LV today); Windows: loopback | Intake → live call segment of the telephony demo | IMP, AT, IT, LV (dated); Windows side SIM |
| 2 | Speech — STT/TTS ports, confidence enforcement | `speechService` + provider adapters (loopback / whisper / espeak); events via M11 | `POST /speech/transcribe`, `POST /speech/speak`, `GET /speech/status`, `GET /speech/partial/:id` | final transcripts (transcribe path), `SPEECH_SYNTHESIZED` events | module 2 files/67; root `module02SpeechIntegration` 12 → **79** | WSL: whisper+espeak live (engines re-probed today); Windows: loopback | Transcription + spoken protocol replies | IMP, AT, IT, LV (dated; engines LV today); UNV: Windows whisper/espeak (absent by design) |
| 3 | NLP extraction — candidate symptoms/priority | operator-triggered classifier adapter in server; disabled by default | `POST …/classify` (operator route) | classification events (`source` never faked) | root `module3Classifier` 8, `nlpClassifyRoute` 10 (+1 live skip behind `MODULE3_LIVE_TEST=1`) → **18+1 skip** | `MODULE3_NLP_ENABLED=false` default; LLM `qwen3:8b` absent → heuristic fallback (LV today) | Optional: show a candidate ≠ classification | IMP, AT, DIS, degraded LV; UNV: live Python service, live LLM path |
| 4 | Conversation support — silence retry + localisation (in-server layer) | `ConversationSupportAdapter` in `apps/server/src/conversation`; inert without reviewed config | no own HTTP surface (wraps call path) | none (policy layer) | root `module4ConversationSupport` 20, `module4ControllerLocalisation` 5, `module4Localizer` 11, `module4Config` 5 → **41** | `MODULE4_SILENCE_TIMEOUT_MS=0` → inert (confirmed in WSL `.env`) | Mention only; no visible demo surface | IMP, AT, DIS |
| 5 | Bystander assistance — **sole clinical/protocol authority** | `module5` composed with `turnOrchestrator` wired after `module2`; protocols from `protocols/` (5 protocols, 33 steps) | `POST /api/protocol-sessions`, `POST /api/protocol-sessions/:id/utterance`, session reads | `protocol_sessions`, `protocol_steps` | module 4 files/124; root `protocolTurnOrchestrator` 12 → **136** | WSL live (LV dated 10-22: 12-row transcript, both gates crossed, gibberish safe-loop) | Protocol progression + safe uncertain-input handling | IMP, AT, IT, LV (dated); catalogue includes `UNREVIEWED` content; **no clinical validation** |
| 6 | Ambulance — fleet, assignment, driver accept/decline, explicit dispatch, GPS ingestion | `assignmentService`, `dispatch/`; `MODULE6_AUTO_DISPATCH_ENABLED` opt-in | `POST /api/ambulances/.../assignment`, driver decision routes, `POST /api/ambulances/:id/location`, dispatch route | `ambulances`, `ambulance_assignments`, locations (M11) | module 8 files/36; root `driverGpsIntegration` 20 → **56** | composed in both environments; auto-dispatch **DIS** (asserted in composition test) | Assignment → driver accept → explicit dispatch → GPS update | IMP, AT, IT, LV (GPS HTTP accepted live today via demo:verify); UNV: physical Android GPS |
| 7 | Hospital — resource updates, explicit selection, suitability scoring | `MODULE7_AUTO_SELECT_ENABLED` opt-in | `PUT`-style hospital-resource route, `POST …/select` | `hospitals`, `hospital_resources` (M11) | module 8 files/49 → **49** | composed; auto-select **DIS** | Hospital selection step | IMP, AT, IT; SIM: no real hospital systems (UNV) |
| 8 | Route optimization — leg planning with provider provenance | `MODULE8_PROVIDER=mock` default, `MODULE8_AUTO_ROUTE_ENABLED` opt-in | `POST /api/routes`, `POST /api/routes/recalculate` | `routes`, `route_updates` (M11) | module 11 files/108 → **108** | mock provider composed; provider-failure → mock fallback tested | Mock route with `isLiveTraffic:false` provenance | IMP, AT, IT, SIM; UNV: live Google Routes / OSRM |
| 9 | Corridor — simulated corridors, road-user geofence, police notices | `MODULE9_CORRIDOR_ENABLED` opt-in; needs M11 `notifications` port | corridor routes, simulated police-notification routes | `corridors`, `notifications` (M11) | module 8 files/46 → **46** | composed; corridors `SIMULATED`, notices `delivered:false`, `realPoliceContacted:false` | Show simulated notice labelling only | IMP, AT, SIM, DIS; UNV: real police/signals |
| 10 | Lifecycle — **read-only event projection** | observer consumes M11 event bus; waits for replay before serving; legacy FSM deliberately not wired | `GET /api/emergencies/:id/lifecycle` | none (projection over `system_events`) | module 4 files/41 → **41** (plus projection assertions inside composition tests) | WSL: replayed 720 events at boot (LV today) | Four operator-reported milestones + evidence semantics | IMP, AT, IT, LV (projection served today); UNV: independent arrival/handover evidence (attestations by design) |
| 11 | Database & events — persistence authority, JWT auth, append-only log, outcome governance | Prisma/SQLite; 10 migrations (WSL 10/10 applied); `guardDatabase`/`withTransaction` | emergency CRUD + `POST …/lifecycle-milestones/:milestone`, outcomes/reviews/supersessions, outcome grants, event queries | all tables | module 6 files/39; root outcome suites 41 + event-query 3 → **83** | both environments; role gates + strict bodies | Milestone recording, outcome flow, event timeline | IMP, AT, IT; UNV: multi-tenant/HA (out of scope) |
| 12 | Dashboard & analytics — operations UI, live views, outcome/grant UI | React frontend in `modules/module_12_dashboard_analytics/frontend` served by the `apps/dashboard` Vite shell (one codebase); reads M11; `MODULE12_LEARNING_ENABLED` default off | `/api/dashboard/live`, `/api/analytics/...` (admin-only reads) | `analytics_snapshots`, `learning_samples` (empty) | module 6 files/49; root `dashboardViteConfig` 1, `dashboardLiveProxy` 1 → **51** | Vite on `127.0.0.1:5173`; browser-verified today against the Windows isolated pair | Sign-in, live emergencies, fleet, lifecycle, dispatch provenance | IMP, AT, IT, browser-LV (today, isolated pair); DIS: learning; UNV: browser run against the WSL backend (P2) |

Driver app (cross-cutting): `apps/driver` Flutter — authenticated assignment view, accept/decline, GPS reporting contract; **4/4 tests + analyze clean (today)**; SIM fixture coordinates; **UNV: physical Android device**.

---

## 3. Integrated demonstration matrix

Supported end-to-end flow (the college demonstration), item by item. "Reproducible now" means the listed commands work today with captured evidence.

| # | Flow step | Status | Evidence | Reproducible now? |
| --- | --- | --- | --- | --- |
| 1 | Synthetic emergency intake + session creation | IMP, IT, LV | composition tests (today); `POST /calls` created emergency+session in live calls (dated 10-21/22) | **Yes** — API (`POST /api/emergencies` or `POST /calls` with `isSimulation:true`) |
| 2 | Caller speech capture + Whisper transcription | IMP, AT, LV (dated) | live calls transcribed real speech (10-21/22); whisper engine re-probed today; `realSpeechProviders` 42 tests | **Yes** (WSL); full phone-path transcription needs a live call — see P4 |
| 3 | Module 5 protocol progression + safe uncertain input | IMP, AT, LV (dated) | 12-row live transcript incl. gibberish safe-loop (10-22); 136 tests today | **Yes** — HTTP utterance route needs no phone (`docs/CONVERSATION_E2E_TEST_REPORT.md` §8.2) |
| 4 | TTS generation + audio delivery to MicroSIP | IMP, LV-DEVICE (dated); engine LV today | espeak greeting played over AudioSocket to MicroSIP (10-21/22); espeak-ng CLI synth today | **Yes** — engine today; handset delivery needs a live call (P4) |
| 5 | Transcript + lifecycle persistence | IMP, AT, IT | transcript rows (dated) + Module 10 projection replaying 720 events (today) | **Yes** |
| 6 | Ambulance assignment + explicit dispatch (test data) | IMP, AT, IT | `serverCompositionAmbulanceWorkflow` (today) | **Yes** |
| 7 | Hospital selection + mock route generation | IMP, AT, IT, SIM | composition + operational-events suites (today) | **Yes** |
| 8 | Driver app + authorized GPS workflow | IMP, AT, GPS-HTTP LV today | `driverGpsIntegration` 20 tests, Flutter 4/4, demo:verify GPS accepted + fleet freshness (today) | **Yes** (software path); **physical device UNV** |
| 9 | Operator-reported milestones + dashboard projection | IMP, AT, IT, browser-LV today | demo:verify 28/28 incl. browser lifecycle panel (today) | **Yes** (against the Windows isolated pair) |
| 10 | Hangup, repeated-call isolation, resource cleanup | IMP, LV (dated), AT | teardown `0 channels / 0 sockets`; isolation + no-double-effect checks (10-22) | **Yes** — re-run with the P4 call script |
| 11 | Failure handling, authn/authz, disabled automation | IMP, AT, LV today | rollback/failure tests in today's 829; 401/403/404/422 checks in today's demo:verify; WSL safety keys unset (fail-closed) | **Yes** |
| 12 | Demo startup / execution / shutdown instructions | Documented, LV today | this audit §5; `docs/STAGE_4_19_DEMO_GUIDE.md`; deployment report §4; telephony report §6 | **Yes**, with the P1 keeper requirement and the choose-one-backend rule (P5) |

**Not supported by the current implementation (documented gaps, not invented results):** independent verification of arrival/handover/completion (operator attestations only); physical Android GPS; live OSRM/Google routing; real police messaging or traffic-signal control; live telephone-network calling (local SIP extension only); live LLM extraction (model absent); clinical outcome claims; production emergency-service capability. The legacy Module 10 FSM stays disconnected by design; the canonical lifecycle is its read-only projection.

---

## 4. Prioritized blockers (top five)

| P | Blocker | Impact on the demonstration | Evidence | Remediation | Effort |
| --- | --- | --- | --- | --- | --- |
| **P1** | **WSL service lifecycle** — without a keeper, the distro exits after each idle command batch and systemd SIGTERMs `resus-server` ~15 s after startup — **REMEDIATED 2026-10-23 (Phase 1)** | **Highest**: backend dies mid-demo; Windows dashboard then fails every API call | journal cycles observed 2026-10-23; documented in telephony report §8 | **Done:** `vmIdleTimeout=-1` in `.wslconfig` (Layer A: VM lifetime) + one attached keeper session (Layer B: Windows→WSL relay); 90 s idle persistence + Windows health triad verified; procedure + troubleshooting in deployment report §4.1 | ~2 h (spent 2026-10-23) |
| **P2** | **Live-backend dashboard account/verification gap — CLOSED 2026-10-23** | Dedicated least-privilege demo identities and live WSL browser evidence now exist | Auth-only `demo:verify`: **23/23 PASS**, live proxy/backend `routes=71`; details in §10 | New DISPATCHER/DRIVER accounts created only through Module 11 `users.create` + bcrypt; existing users preserved | Closed |
| **P3** | **Module 3 live LLM extraction degraded** — `qwen3:8b` not pulled; heuristic fallback only | Cannot demo LLM-backed extraction; heuristic is narrower by design | `/api/health/llm` `available:false` (today); Ollama hosts `llama3:latest`, `gemma3:latest` only | Authorized `ollama pull qwen3:8b`, **or** repoint the configured model to an existing local model after prompt/schema compatibility check; re-probe `/api/health/llm` | ~1–2 h (+download) |
| **P4** | **Controlled retest failed acceptance 2026-10-23** — SIP/RTP/AudioSocket connected; Whisper did not recognize the requested phrase; Module 5 escalated after blank/incorrect utterances; protocol remained `ESCALATED` after hangup. Client audibility is still unconfirmed. | The live acoustic demonstration has not proven the intended caller phrase, audible TTS, or complete protocol lifecycle cleanup | telephony report §13: `CALL-D4B43310F30020`, `PSE-74EAB80EE70023`; 0 active Asterisk channels/sockets after hangup; caller transcript contains fragments and `[BLANK_AUDIO]` | A separate audio-path investigation is needed before another call; design a neutral call-ended lifecycle separately from genuine operator escalation. Keep dispatch fail-closed. | Open |
| **P5** | **Backend exclusivity / documentation drift** — Windows `demo:server` and the WSL service both target port 4000 (mirrored networking shares it); `docs/CONVERSATION_E2E_TEST_REPORT.md` §7.4 still describes the pre-10-22 reduced WSL build (superseded by the deployment report); `docs/MODULE_DEPENDENCY_MAP.md` is stale | Wrong backend or stale doc used during prep → confusion, port conflicts, false expectations | this audit §1.3; both reports' dates | One-backend-at-a-time rule written into the demo script; mark superseded sections in the older reports; refresh or annotate the dependency map | ~2 h |

Adjacent limitations (tracked, **not** demo blockers): physical Android GPS, live routing providers, real police/signal systems, live telephony network, clinical validation, `UNREVIEWED` protocol content, single-node SQLite, no multi-tenant isolation claims.

---

## 5. Exact verification commands

Run from `F:\minor` unless stated. Nothing here contacts an external provider.

**5.1 Automated baseline (Windows):**

```powershell
$env:RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_API_TEST = 'true'
$env:RESUS_RUN_ISOLATED_OUTCOME_TEST = 'true'
$env:RESUS_RUN_ISOLATED_COMPOSITION_TEST = 'true'
$env:RESUS_RUN_DASHBOARD_LIVE_TEST = 'true'
node .\node_modules\vitest\vitest.mjs run
npm run typecheck
npx prisma validate --schema modules/module_11_database_event_system/prisma/schema.prisma   # with a disposable DATABASE_URL set
git diff --check
```

Expected: 85 files passed / 1 skipped; 829 tests passed / 1 skipped; typecheck exit 0; validate exit 0; diff-check exit 0.

**5.2 Driver app (Windows):**

```powershell
cd apps\driver; flutter test --no-pub --concurrency=1; flutter analyze --no-pub
```

Expected: 4/4 passed; no issues found.

**5.3 WSL live-stack readiness (P1-remediated procedure, 2026-10-23):**

```powershell
# Keeper: one attached session (keeps distro Running + Windows->WSL relay)
Start-Process wsl.exe -ArgumentList "-d","Ubuntu","--","sleep","infinity" -WindowStyle Hidden
Start-Sleep -Seconds 14
# Health gate from Windows (all three must return HTTP 200):
curl.exe -s http://127.0.0.1:4000/api/health
curl.exe -s http://127.0.0.1:4000/calls/transport/status
curl.exe -s http://127.0.0.1:4000/speech/status
# Optional (P3 state probe):
curl.exe -s http://127.0.0.1:4000/api/health/llm
```

Expected: health `routes:71`; transport `asterisk, isLive:true, reachable:true`; speech whisper/espeak live; LLM currently `available:false` (P3) or `true` after remediation. Full start/stop/troubleshooting: `docs/DEPLOYMENT_CONSISTENCY_REPORT.md` §4.1.

**5.4 Isolated dashboard pair (Windows) — choose this OR the WSL backend, never both on port 4000:**

```powershell
$env:RESUS_DEMO_ISOLATED = 'true'; npm run demo:server     # prints per-run credentials once
npm run dev --prefix apps/dashboard                        # http://127.0.0.1:5173
node .\scripts\demo-verify.ts                              # expected: 28/28 PASS
# stop backend: create the printed sentinel %TEMP%\resus-demo-server-<port>.stop
```

**5.5 Live telephony call (WSL, after P4 prep):** exact start/stop and call commands are in `docs/TELEPHONY_E2E_TEST_REPORT.md` §6 and `docs/DEPLOYMENT_CONSISTENCY_REPORT.md` §4 (local extension 1001 only, `isSimulation:true`).

**5.6 HTTP conversation path without a phone (WSL):** `docs/CONVERSATION_E2E_TEST_REPORT.md` §8.2 (dev-token → emergency → protocol session → utterances → transcripts).

---

## 6. Acceptance criteria (gate for "college-demo ready")

All must hold on the day of the demonstration, with output captured:

1. Baseline green: 829 passed / 1 skipped (or better), typecheck 0, `prisma validate` 0, `git diff --check` 0, Flutter 4/4 + analyze clean.
2. Chosen backend healthy: `routes:71`; transport + speech status live (WSL) or `demo:server` ready (isolated pair); **`wsl -l -v` shows `Running` with the keeper session present** if WSL is used (P1 procedure, deployment report §4.1).
3. Every account used in the walkthrough can sign in to the chosen backend (P2 closed or worked around explicitly).
4. Browser verification passes against the **same** backend/dashboard pair that will be used on stage (demo:verify 28/28 or an agreed equivalent).
5. One fresh end-to-end call captured (transcripts persisted, hangup clean, `0` leftover channels/sockets) if the telephony segment is in scope (P4).
6. `/api/health/llm` is either `available:true` or the fallback is explicitly acknowledged in the talking points (P3).
7. Safety flags confirmed off: auto-dispatch, auto-select, auto-route, corridor, learning, silence timer; every scenario `isSimulation:true`; no real numbers; no secrets in any screen, log, or handout.
8. Startup and shutdown rehearsed start-to-finish, including the one-backend-at-a-time rule (P5).

---

## 7. Dependencies and estimated effort

**Runtime dependencies:** Windows 10/11 + WSL2 (Ubuntu, systemd); Node ≥ 20 with the existing `node_modules` (no installs needed); Python 3 (isolated-test SQLite helper); Asterisk (WSL) + whisper.cpp + model + espeak-ng (WSL, installed); MicroSIP (Windows, configured for `127.0.0.1`, `autoAnswer=all`); Ollama (optional, currently model-incomplete); Vite dashboard (workspace); Microsoft Edge (for `demo:verify` browser step, already installed); Flutter SDK (driver-app checks only).

**Remediation effort (rough, one person):**

| Phase | Items | Effort |
| --- | --- | --- |
| 1 — pre-demo hardening | P1 procedure + smoke check; P5 doc annotations + backend rule | ~4 h |
| 2 — verification closure | P2 accounts + browser run vs live backend; P4 fresh call; P3 model decision + probe | ~6–8 h (+ model download) |
| 3 — optional polish | ADMIN fixture for grant-UI walkthrough; consolidated pre-demo script; dependency-map refresh; automated WS-proxy check | ~4–6 h |

Total to a defensible demo-ready state: **≈ 1–2 working days**, dominated by verification runs rather than code changes.

---

## 8. Phased remediation plan

**Phase 0 — documentation (this run, complete).** `docs/PRODUCTION_READINESS_AUDIT.md` written; no code, config, or database changes.

**Phase 1 — pre-demo hardening (no behavior change).**
1. ~~Add the keeper + health-gate to a single "start demo stack" section shared by the demo guide and deployment report (P1).~~ **Done 2026-10-23:** P1 root-caused (VM idle-termination + WslService relay teardown) and fixed (`vmIdleTimeout=-1` + one attached keeper session); startup/health-gate/troubleshooting/shutdown commands written into `docs/DEPLOYMENT_CONSISTENCY_REPORT.md` §4.1 and mirrored in this audit §5.3; verified with a 90 s idle persistence test and Windows health triad.
2. Annotate `CONVERSATION_E2E_TEST_REPORT.md` §7.4 and `MODULE_DEPENDENCY_MAP.md` as superseded by the deployment report (P5); state the one-backend-at-a-time rule.
3. Pre-demo checklist: `pjsip show contacts`, transport status, health, keeper PID, ports 4000/5173 ownership.

**Phase 2 — verification closure (authorization required for the model download).**
1. P2: provision demo accounts for the chosen backend (env-generated passwords, never committed) and run `demo:verify` (or agreed equivalent) against it in a browser.
2. P4: scripted live call with captured evidence; refresh the dated telephony evidence.
3. P3: authorize `ollama pull qwen3:8b` or repoint the model; re-probe health; otherwise document the heuristic-fallback talking point.

**Phase 3 — optional polish.** ADMIN demo account for the grant-management panel; a single smoke-test script covering §5.3; WebSocket `/ws` reachability check through the mirrored network; automated pre-presentation checklist execution.

**Explicitly out of scope for this prototype:** production hardening, real provider credentials, phone-network calling, physical device certification, clinical review of protocol content, model training/activation, multi-tenant isolation.

---

## 9. Safety and preservation notes for this audit

- No git mutations (no commit/push/reset/clean/stash/revert/branch switch); 148 pre-existing working-tree entries preserved; this file is the only addition.
- No dependency installations; no external providers or emergency services contacted; all telephony remains local SIP extension 1001.
- Database writes: **none** — the WSL `dev.db` was opened read-only for counts; test databases were disposable harness-owned files; the temporary espeak wav was deleted.
- Secrets: never printed — AMI/SIP credentials and seed passwords referenced by name only; per-run demo credentials are generated at runtime and stored nowhere.
- Automation remains fail-closed: dispatch/select/route/corridor/learning/silence all default-off; this audit changed none of them.
- Services started by this audit: the WSL distro + `sleep infinity` keeper (needed to inspect the deployment). At audit end the keeper was stopped per "stop only what you started" — see the completion report for the final service state.

## 10. P2 live-dashboard verification (2026-10-23)

This addendum supersedes the earlier historical P2 snapshot above. Verification used the **live WSL backend** at `http://127.0.0.1:4000`, not the isolated `demo:server`.

### Current state and target confirmation

| Check | Actual result |
| --- | --- |
| `wsl -l -v` | `Ubuntu Running`, version 2 |
| `systemctl is-active resus-server.service` | `active` |
| keeper process | attached `sleep infinity` process present |
| `GET /api/health` from Windows and inside WSL | HTTP 200; `status=ok`, `routes=71`; modules 01,02,03,05,06,07,08,09,10,11,12 registered |
| `GET /calls/transport/status` | HTTP 200; Asterisk `isLive=true`, `reachable=true` |
| `GET /speech/status` | HTTP 200; Whisper and eSpeak `isLive=true` |
| Dashboard proxy target | `RESUS_DASHBOARD_PROXY_TARGET` unset; [vite.config.ts](../apps/dashboard/vite.config.ts) therefore uses its default `http://127.0.0.1:4000` |
| HTTP request through Vite `/api/health` | HTTP 200 with the same live health payload (`routes=71`), confirming the dashboard proxy reached WSL |

Relevant redacted output:

```text
Ubuntu  Running  2
service=active
health_http=200
{"status":"ok","env":"development","routes":71,...}
transport={"provider":"asterisk","isLive":true,"reachable":true,...}
speech={"speech":{"provider":"whisper","isLive":true,...},"synthesis":{"provider":"espeak","isLive":true,...}}
proxy_health_http=200
```

### Credential recovery and supported provisioning

- Inspected the documented demo setup, ignored `.env` key names, `scripts/provision-demo-accounts.ts`, `scripts/demo-server.ts`, and `scripts/demo-verify.ts`. The ignored WSL config contained no dispatcher/driver demo-password keys. Available temp logs contained only `@demo.test` credentials for isolated disposable demo servers; they do not authenticate the WSL database's `@resus.local` users. The existing dispatcher/driver passwords therefore had no authorized recovery path.
- Extended the existing provisioner with validated `DEMO_DISPATCHER_EMAIL` and `DEMO_DRIVER_EMAIL` overrides. Fixed roles remain `DISPATCHER` and `DRIVER`; password inputs remain environment-only (minimum 12 characters); `module11.users.create` and bcrypt are used; existing accounts are skipped, never reset.
- Created two new users in the live WSL DB: `p2-dispatcher-20261023@resus.local` (`DISPATCHER`) and `p2-driver-20261023@resus.local` (`DRIVER`). Random passwords are held in the Git-ignored Windows root `.env`; no credential value is recorded in this audit or emitted by the provisioning script.

### Authentication, authorization, and browser evidence

Inspected `apps/server/src/http/auth.ts`, `modules/module_11_database_event_system/src/repositories/userRepository.ts`, `modules/module_11_database_event_system/src/seed/seed.ts`, both provisioning/demo scripts, Module 6 and Module 12 role declarations, and dashboard `App.tsx` / `api.ts`.

The auth-only mode added to `scripts/demo-verify.ts` performs no operational writes. Command (run from `F:\minor`, where the ignored `.env` supplies only the credentials to the process):

```powershell
$env:DEMO_AUTH_ONLY = 'true'
npm run demo:verify
Remove-Item Env:DEMO_AUTH_ONLY
```

Actual result: **23/23 PASS**, exit 0, against `http://127.0.0.1:4000` (live WSL) and the Vite dashboard at `http://127.0.0.1:5173` through its default proxy target. Checks covered backend health (71 routes); anonymous and invalid-password rejection; successful dispatcher and driver login and role claims; valid and malformed JWT sessions and future expiry; dispatcher dashboard access; driver dashboard denial and driver assignment access; driver-to-dispatch and dispatcher-to-driver-action denials; dispatcher denial on an ADMIN-only route; and browser shell, invalid-login message, successful dispatcher dashboard, successful driver sign-in with expected operator-dashboard 403, and zero local/session storage token entries.

Redacted command output:

```text
PASS live backend health — HTTP 200, routes=71
PASS anonymous dashboard request rejected — HTTP 401
PASS invalid dispatcher password rejected — HTTP 401
PASS invalid driver password rejected — HTTP 401
PASS dispatcher authenticates with DISPATCHER role — HTTP 200
PASS driver authenticates with DRIVER role — HTTP 200
PASS dispatcher JWT session validated — HTTP 200
PASS driver JWT session validated — HTTP 200
PASS malformed JWT rejected — HTTP 401
PASS dispatcher dashboard read allowed — HTTP 200
PASS driver dashboard read denied — HTTP 403
PASS driver assignment read allowed — HTTP 200
PASS dispatcher admin-only grants read denied — HTTP 403
PASS driver dispatcher-only dispatch denied — HTTP 403
PASS dispatcher driver-only accept denied — HTTP 403
PASS both JWTs have a future expiry — token values suppressed
PASS browser loads the dashboard shell
PASS browser shows the rejected sign-in — Invalid email or password.
PASS browser authenticates against the listening backend
PASS token is not persisted in web storage — 0 entries
PASS dispatcher dashboard shell is visible
PASS driver login succeeds but dashboard data is role-denied — HTTP 403 shown
PASS driver token is not persisted in web storage — 0 entries
[demo-verify] 23/23 checks passed
```

### Database preservation and P2 status

Read-only counts before provisioning were `emergencies=133`, `transcripts=145`, `system_events=724`, `call_sessions=126`, `users=3`. After provisioning they were `133`, `145`, `724`, `126`, `5`. The only expected change was the two new user rows; the three existing OPERATOR/DISPATCHER/DRIVER users remain active and unchanged. No emergency, transcript, event, call-session, assignment, dispatch, or location rows were changed. No authentication event is written by these routes.

**P2 is closed.** Verification used the live WSL backend, not an isolated server. The in-app browser's prior invalid-login observation is supplemented by the actual headless Edge run in `demo:verify`, which authenticated both roles and confirmed the driver's expected 403 on operator-only dashboard data. No `/api/auth/dev-token`, seed, reset, or password update was used.

Files changed for P2: `scripts/provision-demo-accounts.ts`, `scripts/demo-verify.ts`, the WSL deployment copy of the provisioner, this audit, `docs/STAGE_4_19_DEMO_GUIDE.md`, and ignored local `.env` (credential values excluded from Git and documentation). Typecheck passed, exit 0. No branch change, commit, push, reset, clean, database reset/reseed, dependency installation, or live dispatch occurred. WSL keeper/backend were already running and remain running; stop the Vite process started for verification after review.

Next roadmap item after P2: **P4** — one fresh controlled MicroSIP call proving caller audio → Whisper transcript → Module 5 progression → audible TTS → clean hangup. No P3/P4/P5 work was started in this run.

## 11. P4 fresh MicroSIP acceptance (2026-10-23)

This addendum supersedes the earlier P4 statement that a live call simply needed a fresh rerun. The run used the **live WSL backend** at `127.0.0.1:4000`, the active WSL keeper, Asterisk, and the already-running MicroSIP client. It did not use `demo:server` or inject transcript text. No code, dependencies, configuration, or test suites were changed.

### Readiness and call evidence

| Check | Actual result |
|---|---|
| Initial repository state | Branch `main`; 150 porcelain entries; 0 staged. Existing changes preserved. |
| WSL and services | Ubuntu Running (WSL 2); existing keeper present; `resus-server.service` and `asterisk.service` active. |
| Health and providers | Backend HTTP 200, `status=ok`, `routes=71`; transport HTTP 200 and Asterisk reachable; speech HTTP 200 with Whisper/eSpeak `isLive=true`. |
| MicroSIP / AudioSocket | MicroSIP running; extension 1001 registered and answered. Asterisk AudioSocket modules loaded; server listener on `0.0.0.0:9092`; initially 0 channels / 0 call legs. Windows audio input/output selections were blank (default endpoints); Realtek mic array/speakers were available. |
| Safety | Module 6–9 enable flags were absent from the WSL `.env`; no automation settings were changed. |
| Call creation | `POST /calls` at `2026-10-23 08:33:36.833 UTC`, `isSimulation=true`, `CARDIAC_ARREST`, local SIP via Asterisk. `CALL-0DFE5A8D11000A`, emergency `EMG-ED99C6CA690008`; `isLiveTransport=true`. |
| Live media and Module 5 | Asterisk originated `PJSIP/1001-00000000`; AudioSocket connected and bound to the session; Module 5 started `PSE-386E4CA0ED000D` at `confirm-arrest`. |
| Caller audio / Whisper | Two synthetic speech clips were played through the workstation default output; no text was injected. Whisper stored `[BLANK_AUDIO]` (`confidence=0.78799225`, provider log `accepted=true`). No usable utterance was returned. **FAILED.** |
| Module 5 result | Session remained `WAITING_FOR_RESPONSE`, current step `confirm-arrest`, `clarificationCount=1`. No appropriate advancement from recognized synthetic speech. **FAILED.** |
| TTS | eSpeak produced and the live bridge sent instructions (`durationMs=8787` and `11277`). No client output capture or listener confirmation exists; **actual MicroSIP audibility UNVERIFIED**. |
| Transcript order | Three test-call rows persisted as `SYSTEM`, `CALLER [BLANK_AUDIO]`, `SYSTEM`, sequences 1–3, all linked to the same call. No cross-call transcript association observed. |
| Hangup / cleanup | Asterisk CLI `channel request hangup PJSIP/1001-00000000`; DB call row `ENDED` at `08:36:11.216 UTC` (153,485 ms). Asterisk channel count 0 and established AudioSocket sockets 0. AMI transport still reported one retained tracked-leg entry; this was not a live channel/socket. The Module 5 session remained waiting; a semantically appropriate closure was not verified. |

Read-only DB counts changed from `133/126/145/19/27/724` to `134/127/148/20/28/739` (`emergencies/call_sessions/transcripts/protocol_sessions/protocol_steps/system_events`), consistent with one synthetic emergency/call and its transcript/protocol/event records. No database reset, deletion, or reseed occurred. During the run, the separate pre-existing simulation `CALL-5F50FCE7270003` (started `08:03:21.596 UTC`) also transitioned to `ENDED` at `08:33:44.362 UTC`; P4 did not initiate or hang up that call, and its cause was not determined. This incidental state change is documented in the telephony report.

### Result and next action

**P4 is not closed.** SIP answer and live AudioSocket connection passed; the core acceptance criteria for usable caller audio, Module 5 advancement, audible TTS, and protocol-session closure did not. The exact redacted journal evidence, synthetic utterance procedure, transcript rows, hangup, cleanup checks, and incidental call closure are in [the telephony report](TELEPHONY_E2E_TEST_REPORT.md#10-fresh-p4-microsip-acceptance-run-2026-10-23).

Next: resolve/verify the local MicroSIP input/output routing and capture the real acoustic path, then repeat the single-call acceptance and verify all conversation/session cleanup criteria. P3 and P5 were not started. Do not describe this stack as production-ready or clinically validated.

## 12. Controlled P4 retest preflight (2026-10-23)

**P4 status: BLOCKED before call setup.** The required manual audio-device confirmation has not been received. No call was placed, no audio or transcript was injected, no service was restarted, and no configuration or application code was changed. The previous live-call evidence remains in the telephony report §10; the read-only preflight is recorded in §12 of that report.

Checks passed: Ubuntu remained `Running` with the existing keeper; `resus-server.service` and `asterisk.service` were active; `GET /api/health` returned HTTP 200 (`status=ok`, `routes=71`); Asterisk transport returned HTTP 200 (`isLive=true`, `reachable=true`); Whisper and eSpeak returned `isLive=true`; AudioSocket modules were loaded and its listener bound to `0.0.0.0:9092`; MicroSIP was running and extension 1001 was registered. Asterisk had 0 active channels and 0 active calls, with 0 established AudioSocket connections. The transport status still showed one tracked call-leg entry, which does not establish a live channel. The profile's input/output selections remain blank, and the microphone meter and physical speaker audibility were not observable by this check.

No dedicated live MicroSIP test script was found. The existing documented simulated local-call workflow was inspected but not run. Manual confirmation required before proceeding: select the physically used microphone and speaker/headset in MicroSIP Audio settings; confirm the microphone input meter moves while speaking in Windows Sound settings; play the Windows test sound and confirm it is audible. No claim is made that these checks passed.

No new evidence exists for retest transcription, Module 5 progression, TTS audibility, or post-call protocol cleanup. P4 acceptance is **BLOCKED** pending that confirmation and a controlled live call. Do not mark P4 complete based on preflight connectivity alone. No regression tests were run because no code changed; P3/P5 were not started.

## 13. Controlled live P4 E2E retest (2026-10-23)

Exactly one synthetic call ran through the live WSL backend and local MicroSIP extension 1001: `CALL-D4B43310F30020` / `EMG-5ABD7A5BDD001E`, with protocol `PSE-74EAB80EE70023`. Preflight passed: WSL keeper and backend/Asterisk were already active; health returned HTTP 200 with 71 routes; transport reported Asterisk reachable; Whisper/eSpeak were live; AudioSocket listener/modules and MicroSIP extension were present. No services were restarted. Automatic dispatch variables remained unset.

The user reported completing MicroSIP device setup and Windows microphone/speaker checks. However, the inspected AppData MicroSIP profile still contained blank per-app input/output device values, so the selected devices during the call could not be independently reconstructed.

Acceptance evidence and status:

| Criterion | Result | Evidence |
|---|---|---|
| SIP setup | **PASS** | Live `PJSIP/1001-00000001` channel; `isSimulation=true`, live SIP provider. |
| RTP / AudioSocket | **PASS** | Negotiated `ulaw`; sampled RTP receive/transmit counters increased with zero loss; AudioSocket connection existed during call. Per-frame AudioSocket RMS/peak and raw PCM were not instrumented. |
| Caller audio to Whisper | **PASS, limited** | Seventeen ordered transcript rows persisted, including nonblank speech-like outputs. Exact acoustic source cannot be isolated without raw audio/level data. |
| Requested phrase transcription | **FAIL** | No row contains “Hello, this is a test call. I am checking the RESUS audio system.”; results include incorrect fragments and `[BLANK_AUDIO]`. |
| Module 5 progression | **FAIL** | Stayed on `confirm-arrest`; after 3 clarifications and `[BLANK_AUDIO]`, status became `ESCALATED`. No actual dispatch or human handoff occurred. |
| eSpeak synthesis/send | **PASS** | Five eSpeak send records, durations 8787, 11277, 11277, 11277, 4582 ms. |
| TTS audibility | **BLOCKED** | No client-side output evidence; user confirmation is pending. |
| Hangup and media cleanup | **PASS** | Supported hangup returned `closed=true`, session `ENDED`, duration 71088 ms; Asterisk ended at 0 channels/calls and AudioSocket established sockets at 0. |
| Tracked call leg | **PASS, limited** | Aggregate tracked count returned to its pre-call value of 1; status does not expose identity of the retained pre-existing entry. |
| Protocol cleanup | **FAIL** | The Module 5 row remains `ESCALATED`, step `confirm-arrest` remains `ACTIVE`, `completedAt=null`. No semantically neutral call-ended transition exists. |

Database counts changed from `134/127/148/20/28/739` to `135/128/165/21/29/777` (`emergencies/call_sessions/transcripts/protocol_sessions/protocol_steps/system_events`), consistent with one synthetic call and its records. No reset or deletion occurred. Existing worktree changes were preserved. No code/configuration changes or tests were made. P4 is **FAIL / not accepted**; the audible-output criterion remains separately **BLOCKED** until the user confirms hearing the eSpeak prompt. The detailed utterance text, timing, cleanup evidence, and limitations are recorded in the telephony report §13.

## 14. P4 audio and protocol lifecycle diagnosis (2026-10-23)

No call was placed during this diagnosis. The active WSL copies of `audioBridge.ts` and `whisperProvider.ts` matched their workspace SHA-256 hashes. The WSL backend and Asterisk were not restarted, and the database was not changed.

**Transcription assessment: FAIL; cause unresolved pending measured ingress.** The verified source path is AudioSocket type `0x10` → 8 kHz mono signed 16-bit little-endian PCM → VAD buffer → Module 2 raw-PCM decoder (assumed 8 kHz) → resample to 16 kHz → temporary mono 16-bit WAV → whisper.cpp. The temporary work directory is removed after invocation, and the previous call retained no raw audio or PCM-level measurements. The live settings were RMS threshold `700`, 800 ms hangover, 400 ms minimum utterance, and 30 s maximum. No unexpected sample-rate warning appeared, and sampled Asterisk RTP showed zero loss, but neither observation proves that the captured PCM contained the caller's words. Prompt-like fragments make acoustic echo plausible; microphone level, echo, segmentation, and other acoustic issues remain hypotheses. `[BLANK_AUDIO]` was persisted with high confidence and therefore reached Module 5 as unusable text.

Metadata-only instrumentation was added for explicitly scoped synthetic calls: AudioBridge records sample rate(s), channel/format, samples, bytes, duration, VAD duration, frame count and payload-size bounds, RMS, peak, clipping ratio, and Module 2 round-trip duration. Whisper records preprocessing input/output sample counts and rates, WAV format/size, and invocation duration. No audio or transcript text is logged or retained. The diagnostic scope is forwarded only for a session marked `isSimulation=true`. A conditional rate-metadata loss exists in the call-resolution queue (queued buffers are replayed as 8 kHz); no warning indicated that it affected the prior call, so it was not changed.

**Protocol lifecycle assessment: PASS for existing semantics; no leak or fix indicated.** AudioSocket close removes the bridge connection, clears the timer, and invokes `forget`, which removes the conversation controller's per-call in-memory mapping. The database `ESCALATED` session with an active step and `completedAt=null` is deliberately retained by `SessionService.escalate` for operator review. It must not be marked completed or cancelled merely because the caller hung up; the cancellation operation represents professional help arriving. A neutral disconnect status is not part of the current design and would need a separate domain decision.

The user confirmed hearing the eSpeak prompt clearly and speaking the requested synthetic phrase during the §13 call. This supersedes the earlier audibility status: **TTS audibility is PASS by caller confirmation**, without independent client-side telemetry. The transcript still failed to contain the requested phrase and Module 5 still escalated after three clarifications, so overall **P4 remains FAIL / not accepted**.

Focused validation after instrumentation: `npm test -- modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts modules/module_02_speech_processing/tests/speechService.test.ts modules/module_02_speech_processing/tests/realSpeechProviders.test.ts` — 3 files, 76/76 passed; `npm run typecheck` — passed. No call, service restart, database write, or unrelated code change occurred in this diagnosis.

Next step: one controlled synthetic MicroSIP call after approval, collect the new metadata logs while the caller speaks, verify actual 8 kHz PCM levels/frame sizes and the 8→16 kHz Whisper preprocessing/invocation, then compare the transcript and Module 5 state with the expected phrase. Confirm TTS audibility and verify media cleanup; an escalated Module 5 record is expected to remain stored by design. Do not claim P4 acceptance unless the phrase is recognized, Module 5 advances appropriately, audible TTS is confirmed, and call cleanup matches the documented lifecycle. P3 and P5 remain unstarted.

## 15. Instrumented synthetic call validation (2026-10-23)

One controlled `isSimulation=true` call was run after the new diagnostics were verified active. The running `tsx` service initially used older WSL source. Read-only diffs showed only the four diagnostic additions were missing; those exact workspace files were copied to `/home/resus/resus`, then `resus-server.service` was restarted once to load them. Asterisk was not restarted. Post-restart health was `ok`, 71 routes; Asterisk transport was reachable; Whisper and eSpeak were live; AudioSocket listener was bound; there were no pre-call channels or established AudioSocket sessions. Safety flags remained unset/default and fail-closed.

Call `CALL-63E5E987D00003`, emergency `EMG-1C29759BF50001`, protocol `PSE-58201E211B0006`; local live SIP to extension 1001, synthetic coordinates `(0,0)`. Channel `PJSIP/1001-00000002`; AudioSocket UUID `64c53b3f-7f5d-4109-98a8-fc710c6929b0`. Asterisk negotiated `ulaw`; sampled counters at 23 seconds were RX 1112 / 0 lost and TX 1065 / 0 lost. Exactly 12 synthetic ingress, Whisper preprocessing, invocation, and Module 2 round-trip records correlated to this call.

Measured ingress was 8 kHz mono signed-int16-LE, all frames 320 bytes, 6,720–41,440 samples (840–5,180 ms), 42–259 frames per utterance. Aggregate RMS was 241–812, peak 1,980–7,676, clipping ratio 0. VAD settings were threshold 700, 800 ms hangover, 400 ms minimum and 30 s maximum. Aggregate RMS includes trailing silence and is not directly comparable to the per-frame threshold; VAD did detect each segment. No incorrect rate or channel format was measured. All 12 buffers decoded at 8 kHz mono 16-bit, resampled exactly 2× to 16 kHz, and produced WAV sizes consistent with the adapter's 44-byte header plus 16-bit samples. All 12 whisper.cpp invocations completed in 1,647–5,758 ms; none failed preprocessing or invocation.

The transcript had 17 ordered rows (5 SYSTEM, 12 CALLER), including two `[BLANK_AUDIO]` results. The requested phrase was absent. Module 5 stayed at `confirm-arrest`, reached three clarifications, and remained `ESCALATED` with `completedAt=null`; this record is intentionally retained for operator review. No dispatch or external contact occurred. **Phrase recognition: FAIL; Module 5 progression: FAIL.** TTS send records exist, but audibility for this call is **BLOCKED** pending current-call human confirmation; earlier-call confirmation is not substituted. P4 overall remains **FAIL / not accepted**.

The supported hangup returned `closed=true`, `ENDED`, duration 109387 ms. Post-call checks found 0 Asterisk channels/calls, 0 established AudioSocket connections, 0 tracked call legs, and healthy backend/Asterisk services. Cleanup and intentional protocol retention **PASS**. No second call, database reset/deletion, speculative fix, or raw-audio/transcript-text logging occurred.

Focused findings: active PCM was present, and format conversion and Whisper invocation were correct. The current measurements do not distinguish weak acoustic capture, eSpeak echo, utterance segmentation, or recognizer quality because they are utterance aggregates without raw media or per-frame level distribution. Do not change Whisper or Module 5 based on this run. The next justified action, only after approval, is a narrowly scoped per-frame RMS distribution experiment under the same no-recording rule. P4 remains **FAIL**; P3/P5 were not started.

## 16. P4 utterance metadata and offline Whisper check (2026-10-23)

No call was made, services were not restarted, and no source/configuration or database changes were made during this diagnosis. For `CALL-63E5E987D00003` (`EMG-1C29759BF50001`, protocol `PSE-58201E211B0006`), the user confirms hearing eSpeak and speaking the complete requested synthetic phrase; this supersedes the prior “audibility blocked” statement for that call.

The correlated journal contains 12 ingress/preprocess/invocation/round-trip records. Ingress was 8 kHz mono S16LE with 320-byte/20 ms frames, 42–259 frames per buffer, 840–5,180 ms per buffer, aggregate RMS 241–812, peak 1,980–7,676, and zero clipping. Every preprocessor input byte count matched ingress; all 8 kHz inputs were decoded as mono 16-bit, resampled exactly 2× to 16 kHz, and emitted correctly sized WAVs. Invocation times were 1,647–5,758 ms; all completed. Per-utterance values are tabulated in telephony report §16. Segment 4 is the shortest/lowest aggregate level; segment 7 is longest/highest RMS; segment 6 has the highest peak. The current logs omit segment ordinals and invocation input sizes, so exact invocation-to-ingress pairing (especially the repeated 43,520-byte segments) is unavailable. Aggregates include trailing silence and do not establish speech intelligibility. No framing, rate, sample-count or preprocessing anomaly is supported.

Code confirms type/length AudioSocket framing, 8 kHz signed-linear type `0x10`, mono S16LE decoding, VAD onset on threshold-crossing frames, discarded pre-onset quiet frames, and finalization after 800 ms below threshold (or 30 s maximum). Outbound `sendAudio` does not directly feed the receive callback, but acoustic or software loopback can return playback as inbound audio; current data cannot distinguish it from speech and does not establish echo as cause. No raw audio is retained. The existing local eSpeak/Whisper setup supported an offline known-speech probe through the actual adapter: completed in 2,217 ms, confidence 0.7388, 6/8 expected words matched but not the full phrase. Output was compared in memory, text was not logged, and temporary audio was removed. This verifies operation on a known sample only partially and does not isolate the live telephony failure.

**Root-cause assessment:** unresolved among acoustic capture quality, VAD onset/tail/segmentation, possible echo, and recognizer performance. No speculative change was made. Add synthetic-only segment ordinals propagated across stages, boundary reason and active/trailing counts, and compact per-frame RMS quantiles/bins; this can expose weak activity and segmentation but cannot alone identify echo. The smallest next live experiment, after approval, is one call with deliberate silence during eSpeak playback and the requested phrase after playback, collecting those metadata only. If proof of echo is needed, compare inbound frames to the outbound reference in memory and log only bounded correlation score/lag.

The escalated Module 5 record remains intentionally retained; no protocol lifecycle code changed. Requested phrase recognition and appropriate Module 5 progression remain failed; TTS audibility is user-confirmed; media cleanup passed as recorded in §15. **P4 remains FAIL / not accepted.** No regression tests were run because no source code changed. P3 and P5 remain unstarted.

## 17. P4 segment-correlated diagnostics (2026-10-23)

P4 remains **FAIL / not accepted**. Implemented a narrow diagnostic-only change; no call, service restart, or database access occurred. VAD thresholds, AudioSocket framing, sample conversion, Whisper parameters, Module 5 state transitions, and dispatch behavior were not changed.

Each VAD onset now receives a per-call segment ID. Synthetic-only diagnostics record start/end timestamps, audio duration/sample count, boundary reason, dropped/submitted/unfinished outcome, and bounded per-frame RMS/peak summaries. The ID and metadata are propagated from AudioBridge through SpeechService into Whisper preprocessing/invocation and back to the bridge round-trip log. Preprocessing reports prepared/empty/failed outcome and duration; inference reports completed/failed and duration. Empty and short segments are explicitly covered. Logger exceptions are caught, and detailed diagnostics stop after 64 segments per call. No audio waveform or transcript text is emitted; records are gated on simulation state and explicit diagnostic scope.

Validation: focused tests passed, 4 files / 86 tests. Covered segment correlation, multiple segments, empty/quiet and short segments, hangover/max-duration/call-ended boundary reasons, simulation-only propagation, log cap, and throwing diagnostic sinks. `npm run typecheck` passed. No dependencies were added. Changed files and the detailed evidence are listed in telephony report §17.

The next controlled experiment, after approval, is one synthetic call with caller silence during eSpeak playback and for two seconds after, then one steady utterance of the requested phrase. Correlate segment IDs through preprocessing and inference and review per-frame level/boundary summaries, transcript outcome, Module 5 state and cleanup without retaining audio/text. Inbound activity during silent playback supports but does not prove echo; if observed, compare inbound frames to the outbound eSpeak reference in memory and log only a bounded correlation score/lag. Weak activity during speech points toward capture; split segment boundaries point toward VAD segmentation; one adequately active segment with correct preprocessing but wrong recognition leaves recognizer/acoustic mismatch as the leading unresolved category. Keep the retained `ESCALATED` protocol unchanged.

No claim of P4 acceptance is made: the requested phrase still has not been recognized and correct Module 5 progression has not been demonstrated. P3 and P5 remain unstarted.

## 18. Controlled VAD/Whisper experiment (2026-10-23)

**P4 remains FAIL / not accepted.** Exactly one synthetic live call was run: `CALL-A8B24D05A20003`, emergency `EMG-70BC2E8F430001`, protocol `PSE-A0475854610006`. Full measurements and per-segment results are in [the telephony E2E report](TELEPHONY_E2E_TEST_REPORT.md) §18.

The initial live source lacked segment correlation. The four reviewed diagnostic-path files were backed up to `/tmp/resus-p4-pre-segment-diag`, synchronized from the workspace, and `resus-server.service` was restarted once so the running `tsx` process loaded them. Asterisk was not restarted. An immediate health probe raced startup; post-start checks passed: backend `/api/health` `ok`, 71 routes; Asterisk transport reachable; AudioSocket listening; Whisper and eSpeak live; MicroSIP running and extension 1001 registered. All four deployed source hashes matched the workspace before the call. Automatic dispatch remained fail-closed.

The call generated 15 matching ingress/preprocessing/inference/round-trip segment records. Input was 8 kHz mono S16LE in 320-byte frames; all 15 inputs were prepared as 16 kHz mono and all 15 Whisper invocations completed (1,620–2,206 ms). All boundaries were `silence-hangover`, each with 40 trailing-silence frames. The expected phrase was absent from the 15 persisted CALLER rows (20 total transcript rows, including 5 SYSTEM). The user confirmed speaking the phrase after the live prompt; playback audibility for this call was not confirmed. Early VAD activity occurred before the user prompt and no explicit silent-window confirmation/time marker exists, so the run cannot distinguish speech, background activity, or echo. The final two segments were 860/880 ms with 2/4 frames over the VAD threshold; without a speech timestamp they cannot be attributed confidently to the phrase.

Module 5 remains intentionally `ESCALATED` at `confirm-arrest`, with three clarification attempts and no completion timestamp. Hangup set the call to `ENDED` (201,898 ms); afterward Asterisk channels/calls, established AudioSocket connections, and tracked call legs were all zero. The escalated record was preserved.

| Criterion | Result |
|---|---|
| Audio capture | **PASS, limited:** inbound PCM segments received; phrase-specific intelligibility not established. |
| Exact phrase recognition | **FAIL:** requested phrase absent from persisted caller transcript. |
| Module 5 progression | **FAIL:** `confirm-arrest` escalated after three clarifications. |
| eSpeak audibility | **BLOCKED:** send records exist; current-call human audibility confirmation is absent. |
| Call/media cleanup | **PASS:** ended call, zero channels/sockets/tracked call legs; intentional escalated protocol retained. |

No raw audio or transcript text was written to logs or this report. No VAD, Whisper, protocol, or dispatch behavior changed. The §17 focused validation (86 tests and typecheck) remains the latest code test evidence. The only live change was deployment of the already-tested segment-diagnostic source and one justified backend restart. Next, after approval, run one controlled synthetic call with an externally noted silent interval and spoken start/end time; have the user explicitly confirm silence through eSpeak plus two seconds, then speak once. Compare those phases with the segment diagnostics, and use bounded in-memory outbound/inbound correlation only if inbound activity persists during confirmed silence. Keep P4 FAIL until the phrase is recognized and Module 5 progresses correctly; P3/P5 remain unstarted.

## 19. Timestamped speech-capture preflight (2026-10-23)

**Result: BLOCKED before call; no call was placed.** Read-only preflight showed Ubuntu WSL and both services active, backend health `ok` with 71 routes, Asterisk reachable, Whisper/eSpeak live, AudioSocket listening with zero established peers, and no active Asterisk channels. The four live diagnostic source hashes matched the workspace. No healthy service was restarted and no database or call endpoint was used.

Current diagnostics correlate VAD segments with preprocessing and Whisper using segment IDs, and timestamp VAD onset/end with wall-clock `Date.now()`. The persisted call start can serve as an approximate wall-clock offset. Those values do not mark intentional speech start/end: VAD onset waits for a threshold-crossing frame, segment end includes the silence hangover, and inference logs include duration only. The eSpeak send log is written after `sendAudio` returns, not at prompt-send start/end. No supported marker endpoint, command, script, or dashboard control exists for recording operator speech-start/speech-end. The required prompt, silence, and speech intervals therefore cannot be reliably established without new instrumentation.

No experiment call was made and no source changes or tests were made. **P4 remains FAIL.** The smallest next change is synthetic-only, capped marker telemetry: prompt-start/end at the AudioSocket send boundary plus operator-authenticated speech-start/end markers for an active simulated call, all timed against one per-call monotonic origin and correlated by call/emergency ID. Emit only marker kind and timing metadata. Add focused tests for ordering/clock origin, synthetic/active-call gating, cap, and safe logger failure; then run focused tests and typecheck before another call. VAD thresholds, Whisper settings, Module 5, and dispatch must remain unchanged. P3 and P5 remain unstarted.

## 20. Coordinated audio timing markers (2026-10-23)

**Implementation complete in the workspace; P4 remains FAIL. No call was placed and no service was restarted.** This change is not deployed to the live WSL backend.

The AudioBridge now establishes one monotonic origin per bound simulated call. Synthetic eSpeak output records `prompt-start` at enqueue and `prompt-end` after the final paced frame reaches the local socket writer. An authenticated `POST /calls/:id/timing-markers` route accepts only `speech-start` and `speech-end` for an ACTIVE simulated call with a bound AudioSocket. It requires a completed prompt before speech-start and a speech-start before speech-end; duplicates, invalid order, unavailable call state, and marker-limit conditions are rejected. Events are capped at 64 per call, metadata-only, and safe if diagnostic logging throws. Segment diagnostics carry call-relative start/end values from the same clock into preprocessing and Whisper correlations. No VAD, audio conversion, Whisper, Module 5 lifecycle, or dispatch behavior changed.

Validation: focused command listed in the telephony report §20 passed **46/46 tests in 4 files**; `npm run typecheck` passed; `git diff --check` passed (only Git line-ending advisory output). No dependencies or database changes. Historical escalated protocol rows and all other worktree changes were preserved.

Limit: `prompt-end` means final frame handed to the local socket, not independently confirmed playback/audibility; an interrupted prompt intentionally has no prompt-end marker. Speech markers record backend monotonic handler time after active-session validation and include request/handler latency; they do not measure physical speech onset. The live deployment and end-to-end marker workflow remain unverified.

Next step: deploy the reviewed source by the approved controlled procedure, verify live source/route hashes and health, then place exactly one synthetic call. Wait through automatic prompt markers and two seconds after prompt-end. Using the existing authorized local credential mechanism, post to `POST /calls/{CALL_ID}/timing-markers` with `{"marker":"speech-start"}` immediately before speaking once: “Hello, this is a test call. I am checking the RESUS audio system.” Post the same route with `{"marker":"speech-end"}` immediately after. Correlate marker offsets with segment/per-frame diagnostics and Whisper records; verify exact persisted phrase, Module 5 progression, user-confirmed playback audibility, and hangup cleanup. Keep secrets out of logs and notes, dispatch disabled, and the intentional escalated record unchanged.

**Ready:** source and focused validation. **Blocked:** live deployment and the coordinated call. P4 remains **FAIL** until phrase recognition, Module 5 progression, audible playback, and cleanup are verified together.

## 21. P4 live deployment and coordinated call (2026-10-23)

**P4 remains FAIL / not accepted.** Exactly one synthetic live MicroSIP call used the deployed marker implementation: call `CALL-328E6F84530003`, emergency `EMG-4FF96C885F0001`, protocol `PSE-5117B518380006`. Deployment preflight found WSL service active, backend health `ok` (71 routes before; 72 after marker route loaded), Asterisk reachable, AudioSocket port 9092 listening, and Whisper/eSpeak live. Six intended runtime files were compared, backed up at `/home/resus/resus/.backup-20261023T1143Z-p4-timing-markers`, then synchronized; hashes matched the workspace. WSL typecheck passed. Only `resus-server.service` was restarted; Asterisk was not. Marker route roles were CALL_CENTRE/OPERATOR/ADMIN and an unauthenticated valid-schema request returned 401. Automatic dispatch remained disabled.

Call-relative events: prompt-start/end #1 at 441.571/9,396.961 ms; prompt-start/end #2 at 9,943.286/20,878.116 ms; speech-start/end at 77,474.169/131,513.830 ms. The user confirmed speaking the exact requested phrase. The 54.040-second backend marker interval is too broad to represent physical speech duration. Seventeen unique ingress segments were received (8 kHz mono PCM, 6,560–40,160 samples, 820–5,020 ms, 41–251 frames, RMS 167–743, peak 1,564–5,884, all `silence-hangover`); preprocessing prepared all 17 and all Whisper calls completed. Segments occurred during both prompt windows and before speech-start as well as during the broad speech interval. This does not prove echo or intelligible speech. Persisted transcript had 17 CALLER and 5 SYSTEM rows; exact phrase absent. Module 5 remains intentionally `ESCALATED`, unchanged. The two eSpeak prompts were sent, but this call's playback audibility is not yet confirmed.

Hangup returned `ENDED` at 183,829 ms. Follow-up showed zero Asterisk active channels/calls, zero established AudioSocket peers, and zero tracked call legs. No raw audio or transcript text was retained in this report. No VAD, Whisper, protocol lifecycle, or dispatch behavior changed. Detailed per-criterion evidence is in [the telephony report](TELEPHONY_E2E_TEST_REPORT.md) §21.

| P4 criterion | Result |
|---|---|
| Audio capture | **PASS, limited** — non-empty segments reached preprocessing; intelligibility unproven. |
| Exact phrase recognition | **FAIL** — phrase absent from persisted CALLER rows. |
| Module 5 progression | **FAIL** — protocol remains `ESCALATED`. |
| eSpeak audibility | **BLOCKED** — awaiting user confirmation for this call. |
| Hangup/resource cleanup | **PASS** — ended; no active channels, AudioSocket peers, or tracked call legs; escalation retained. |

The evidence supports inbound activity during eSpeak prompt windows and prior to speech-start, but not its cause. Background sound, echo, device activity, marker timing, and overlapping turns remain possibilities. Next step: ask the user to confirm audibility for this call. Before another live call, narrow the marker interval with a locally visible operator control and agreed silent window, or first use an existing known synthetic speech fixture through the Whisper adapter in isolation. If needed, only then design bounded in-memory inbound/outbound correlation; store no waveform. Keep P4 FAIL until the exact phrase is recognized, Module 5 progresses correctly, audibility is confirmed, and cleanup passes. P3/P5 remain unstarted.

## 22. Offline Whisper fixture inspection (2026-10-23)

**BLOCKED: no suitable deterministic speech fixture exists in the inspected repository inventory, so no Whisper inference was run. P4 remains FAIL.** No call was placed, no database accessed, no dependencies installed, and no audio was generated.

The six WAVs under `MicroSIP/` are named as ringtone/ringing/hangup/message notification sounds and have no expected speech phrase. The only other WAV is the untracked `modules/Module_2_Zipped/Module_2/temp_audio.wav` (224,044 bytes). Its associated `microphone.py`, `main.py`, and `live_transcription.py` scripts show microphone recording but provide no verified speaker, phrase, or expected transcript. Because it could contain private audio, it was not played, sampled, copied, or submitted for recognition. Speech-provider tests use generated PCM/WAV arrays for format behavior only; they do not contain known speech. The existing real-provider test notes that whisper.cpp itself is not exercised by the test suite.

Code inspection confirms the adapter accepts 8 kHz mono AudioSocket S16LE and converts it to 16 kHz mono WAV for Whisper; 16-bit WAV input also goes through adapter conversion. A real local binary and model are required. No offline phrase-match result is available. The live call's 17 segments being non-empty, prepared, and inferred proves the pipeline executed, but phrase absence does not distinguish poor live acoustic input/segmentation from a recognition-model limitation. Current evidence does not establish an adapter/model defect.

Smallest safe next step: authorize generation of one disposable synthetic speech WAV for the exact harmless phrase using the project's already-installed eSpeak binary, then pass it through the existing `WhisperSpeechProvider` and preprocessing path. Check format/duration and compare expected phrase in memory; retain only a phrase-match boolean and metadata, then remove the generated file. No such fixture was generated in this task because none with known synthetic provenance and expected phrase was already present. Do not use `temp_audio.wav`. P4 remains FAIL until full end-to-end acceptance passes.

## 23. Disposable synthetic eSpeak-to-Whisper validation (2026-10-23)

**Offline phrase recognition: FAIL. Overall P4 remains FAIL / not accepted.** Read §22 first. No live call, database operation, source change, dependency installation, model download, or service restart occurred; dispatch remained disabled.

Preflight verified the configured eSpeak executable, Whisper command on PATH (`--help` exited successfully), and readable configured model. An initial harness check stopped before audio generation because the configured executable was a PATH command rather than a direct file path; the temporary harness was corrected to resolve the command through PATH, with no production source/config changes. The already-installed configured eSpeak binary generated one disposable WAV for the known expected phrase “This is a synthetic speech test.” Metadata was RIFF/WAVE PCM, 22,050 Hz, mono, 16-bit, duration 2,151 ms, size 94,884 bytes.

The existing `WhisperSpeechProvider` received the WAV and exercised its normal WAV decode, 22.05-to-16 kHz mono resampling, WAV encoding, and whisper.cpp invocation. Inference completed in 2,121 ms with adapter confidence 0.5267. In-memory exact phrase comparison failed; normalized comparison also failed (lowercase, NFKC, punctuation removal, whitespace collapse). Recognized text was not printed or durably retained; the adapter's temporary JSON output was inside its automatically cleaned inference directory. The WAV's outer temporary directory and the temporary harness were removed and checked absent; the adapter also cleans its own inference work directory in `finally`. No tests were added or run because no source changed; this runtime validation was the narrowly relevant check. Detailed evidence is in [the telephony report](TELEPHONY_E2E_TEST_REPORT.md) §23.

This offline failure excludes live microphone capture, SIP/RTP, AudioSocket, VAD, and Module 5 from the test path. Thus the unresolved failure cannot be attributed only to live capture or segmentation. Investigate local model/runtime behavior, generated speech pronunciation, WAV preprocessing, and the adapter invocation before another call. One phrase/voice/inference is not enough to identify an adapter defect or its root cause. Keep P4 FAIL until the offline issue is understood and the full live acceptance criteria pass.

## 24. Offline Whisper failure diagnosis (2026-10-23)

**Recognition result: FAIL for the tested synthetic phrase. No confirmed production-code defect identified. Overall P4 remains FAIL / not accepted.** No live call, database operation, production source/configuration change, model download, dependency installation, or dispatch action occurred.

The configured recognizer is `/home/resus/whisper.cpp/build/bin/whisper-cli`, version `1.9.5-dev`; configured model `/home/resus/whisper.cpp/models/ggml-base.en.bin` is 147,964,211 bytes with SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`. The runtime loaded the file and completed inference. The configured model basename identifies base.en (English-only base). Configuration selects Whisper and eSpeak, with Whisper language `auto`; for request language `en`, the provider uses effective language `en`, four threads, and no translation. Actual invocation form is `-m MODEL -f WAV -t 4 -l en -ojf -nt`; runtime help lists each option and `-ojf` direct invocation exited 0. The provider retries `-oj` if `-ojf` fails, but the historical provider logs do not expose that branch; direct invocation confirms the primary flag works on the installed runtime.

The configured eSpeak binary/voice generated the known synthetic phrase “This is a synthetic speech test.” WAV: RIFF/WAVE PCM, 22,050 Hz mono S16LE, 47,420 samples, 2,151 ms, 94,884 bytes. The adapter decodes little-endian int16, resamples to mono 16 kHz (34,409 samples), and encodes a 68,862-byte WAV. No gain normalization is performed by the inspected conversion code. The independent direct CLI invocation consumed that exact prepared WAV with the same arguments; its JSON was parsed in memory through the provider parser. Direct and adapter results/confidence matched (0.5267458), and both exact and normalized expected-phrase comparisons failed. Inference took 2,026 ms direct and 1,729 ms through the adapter.

A second synthetic representation followed live input format: the same eSpeak source was downsampled to raw mono S16LE at 8 kHz (17,205 samples, 34,410 bytes, 2,151 ms; peak 23,079, RMS 2,671). The adapter converted that to 16 kHz mono WAV (34,410 samples, 68,864 bytes). Direct CLI and adapter outputs/confidences again matched (0.5195059), while both failed normalized phrase comparison; direct/adapter inference took 1,830/1,671 ms. Temporary audio, prepared inputs, JSON and harness artifacts were cleaned. Recognized text was never emitted or persisted beyond ephemeral adapter/CLI output files inside the disposable directories, which were removed.

**Confirmed:** both WAV and AudioSocket-like raw PCM paths execute; formats, duration, and language align with the implementation; `-ojf` works; the runtime loads the configured model; direct CLI and adapter agree on result and confidence for both representations. **No confirmed defect** in resampling, PCM interpretation, amplitude handling, task/language options, subprocess execution, JSON extraction, or adapter/direct result consistency. The live and offline recognition failures are therefore not explained by the previously suspected live path alone.

**Unresolved:** a single short phrase from one eSpeak voice does not measure general model quality or acoustic intelligibility. Agreement on two inputs does not prove every model output or parser edge case. No raw audio was listened to or retained. Whether the base.en model struggles with this voice/phrase, and whether a different known-speech control succeeds, remain hypotheses.

Next smallest experiment: before another live call, generate one disposable phonetically simple English eSpeak control phrase with the same voice and repeat paired direct-versus-adapter comparison on WAV and raw 8 kHz PCM. Keep comparisons in memory and report only metadata/match booleans. If both paths agree and recognize the control, investigate the original phrase/voice robustness; if both miss the control, investigate the local model/runtime; if direct and adapter diverge, isolate the specific adapter branch with a focused test. Do not change production settings/code without a specific demonstrated defect. P4 remains FAIL until full live acceptance passes.

## 25. Controlled Whisper model capability check (2026-10-23)

**Result: mixed/limited recognition; not reliable across this small synthetic phrase set. P4 remains FAIL / not accepted.** No live call, database operation, production code/configuration change, model download, dependency installation, or dispatch action occurred.

The configured runtime/model were revalidated: whisper.cpp `1.9.5-dev`; `/home/resus/whisper.cpp/models/ggml-base.en.bin`, 147,964,211 bytes, SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`. Effective language was `en` (from configured `auto` and request language), threads 4, translation off; direct CLI used `-m/-f/-t/-l/-ojf/-nt`. The configured eSpeak voice/speed synthesized seven distinct short harmless English phrases. Source files were mono 22,050 Hz RIFF/WAVE S16LE with durations 1,987–2,608 ms (mean 2,252 ms). Existing repository decode/resample/encode helpers prepared each as 16 kHz mono WAV. Direct whisper.cpp completed all seven inferences (1,658–1,992 ms; mean 1,764 ms). Exact expected-phrase matches: **3/7**. Normalized matches: **4/7**. The expected phrases existed only in the disposable harness; recognized text was not emitted or retained outside temporary engine output files, and all temporary WAVs, JSON, phrase files and harness artifacts were removed and checked absent.

The model/runtime recognizes some of these eSpeak samples, but the small set does not show reliable recognition. This helps separate model capability from the live microphone/VAD path, yet does not prove a model defect or make the test a representative accuracy benchmark. The seven-sample check used direct CLI only; §24's direct-versus-adapter tests on the original phrase agreed, but the adapter was not rerun across this varied set. No source changed, so no separate automated tests/typecheck were needed. Full method and limitations are in [the telephony report](TELEPHONY_E2E_TEST_REPORT.md) §25.

Next targeted step before another live call: run the same disposable phrase set through `WhisperSpeechProvider` with synthetic diagnostics enabled, comparing only per-sample match booleans and adapter/direct agreement in memory. This will establish whether varied-phrase behavior diverges at the adapter boundary without retaining transcript content. Do not change model, adapter, VAD, or production settings without a specific reproduced defect. P4 remains FAIL until the coordinated live acceptance criteria pass.

### §25 paired adapter follow-up

The same seven synthetic eSpeak samples were subsequently run through direct whisper.cpp and `WhisperSpeechProvider`, on the same prepared 16 kHz mono WAV inputs with matching model, language, and inference options. All 14 inferences completed. Direct and adapter exact-match counts were **3/7** each; normalized-match counts were **4/7** each. Normalized direct/adapter results agreed **7/7**, as did confidence values (**7/7**). Mean inference times were 1,770 ms direct and 1,716 ms through the adapter. Expected and recognized strings remained in memory for comparison only; no transcript text or per-phrase outcome was printed or retained.

All generated WAVs, intermediate audio, CLI JSON, harness files, and temporary directories were removed and verified absent (`TEMP_ARTIFACT_CLEANUP=PASS`). This paired result shows no adapter divergence in this small sample set. Recognition was mixed, so the set does not establish reliable model capability, a model defect, or the cause of live-call failures. No production code/configuration changed; source tests and typecheck were not applicable. **P4 remains FAIL / not accepted.** Next step: obtain/verify an independent intelligible synthetic reference or gather stronger live-call acoustic evidence before considering any production adjustment. No live call was performed in this check.

## 26. Whisper suitability review and P4 acceptance plan (2026-10-23)

**Assessment: the configured model/runtime are compatible for English inference, but reliability for the controlled synthetic demonstration has not been demonstrated. P4 remains FAIL / not accepted.** This was a documentation and local metadata review of §§21–25; no live call, audio generation, model/configuration change, dependency installation, dispatch action, or database operation occurred.

The configured model is `/home/resus/whisper.cpp/models/ggml-base.en.bin`, 147,964,211 bytes, SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`; the configured runtime is whisper.cpp `1.9.5-dev`. The `.en` basename identifies the English-only base model, and the installed runtime has loaded it and completed inference. Repository deployment documentation uses this model family. Module 2 resolves an `en` request to English when configured language is `auto`, uses 4 threads, disables translation, prepares 16 kHz mono WAV, and invokes `-m/-f/-t/-l/-ojf/-nt` (with legacy `-oj` fallback). Runtime help supports those options. This establishes compatibility for the English path, not recognition accuracy. The codebase advertises `en` and `ml`, which is broader than this `.en` model; P4 acceptance here is English-only and does not establish Malayalam support.

Evidence from §§21–25: seven synthetic eSpeak samples completed on direct CLI and adapter; each path produced 3/7 exact and 4/7 normalized matches. Direct/adapter normalized outcomes and confidence agreed 7/7. A separate known phrase failed on both paths. Live calls did not produce the target caller phrase and Module 5 remained `ESCALATED`; the latest call's channel, AudioSocket, and call-leg cleanup passed, while prompt audibility was not confirmed. These facts establish mixed performance on this limited synthetic sample set and no observed adapter divergence on it. They do not identify whether model capability, generated-voice intelligibility, live capture, echo, VAD segmentation, or another acoustic condition caused the live failures; no general accuracy claim follows from seven samples.

### Acceptance matrix

| Gate | Required evidence for controlled English demo | Current |
|---|---|---|
| Offline recognition | Fixed seven-phrase synthetic English set: 7/7 normalized matches through adapter and 7/7 direct/adapter agreement; compare expected text only in memory. | **FAIL — 4/7 normalized** |
| Live caller phrase | In one coordinated call, target phrase is a normalized match in the correct persisted CALLER result, with correlated segment, preprocessing, and inference metadata. | **FAIL — absent in prior calls** |
| Module 5 | Predeclare approved synthetic scenario and expected next state; matched caller response produces that progression, without recognition-driven escalation. | **FAIL — prior state was ESCALATED** |
| Prompt audibility | Operator confirms audibility during the same call. | **BLOCKED — latest-call confirmation missing** |
| Cleanup and dispatch | Zero active Asterisk channels, established AudioSocket peers, and tracked call legs after hangup; protocol retention/completion follows documented semantics; dispatch is verified disabled before and after. | **PASS, limited — latest media/call-leg cleanup passed; escalation retained intentionally** |

The gates are for a controlled college demonstration only. They do not represent clinical validation or a comprehensive speech-recognition benchmark.

### Next experiment

Run one offline intelligibility-confirmed control before another live call. Synthesize the same fixed seven harmless English phrases with the installed eSpeak binary, have the operator confirm each is intelligible from local playback, and run the disposable WAVs through the existing preprocessing, direct CLI, and `WhisperSpeechProvider`. Keep phrase comparisons in memory and retain only aggregate match counts, parity, and audio/runtime metadata; delete generated WAVs and temporary outputs. This isolates recognition behavior from MicroSIP/VAD/live capture and verifies adapter parity on the full fixed set without private audio or model downloads. Proceed to one live acceptance call only after the offline 7/7 gate passes and the Module 5 scenario's expected state is predeclared. If offline recognition fails, remain offline and diagnose that limitation. **P4 remains FAIL / not accepted.**

## 27. Offline intelligibility-confirmed repeat blocked (2026-10-23)

**Status: BLOCKED; the exact seven-phrase set is not recoverable from retained artifacts. P4 remains FAIL / not accepted.** This read-only review inspected §§25–26, repository artifacts, the previously recorded temporary harness location, and local PowerShell history using only the harness's unique identifiers. No audio was generated or played, no Whisper inference or live call was run, and no code/configuration, dependency, database, or dispatch state changed.

The prior report states that expected phrases existed only in the deleted disposable harness. Both recorded temporary harness paths are absent; the local PowerShell history contains no entries matching the harness identifiers. Reports preserve aggregate results but intentionally omit the phrase strings and a set hash. Reconstructing the exact set from those records is therefore impossible; substituting phrases would silently change the experiment. This run has no listening/intelligibility or inference outcome and no generated-media cleanup to report.

**Next action:** obtain the exact seven approved phrase strings or original harness artifact, or explicitly approve a new canonical set and label the next run as a new experiment. Once the set is fixed, generate disposable eSpeak samples, have the operator confirm intelligibility, run direct CLI and adapter comparisons in memory, and verify removal. Do not place a live call until §26's offline gate passes. Retain neither recognized transcript text nor raw audio. **P4 remains FAIL / not accepted.**

## 28. Recheck of offline seven-phrase reproduction (2026-10-23)

**BLOCKED; the exact prior phrase set and harness remain unavailable. P4 remains FAIL / not accepted.** The new workspace search found only the existing Whisper provider and diagnostic tests, not the seven phrases or temporary harness. Local PowerShell history has no matching harness invocation, and both recorded WSL temporary harness paths remain absent. Sections 25–27 preserve aggregate results but not the expected phrase strings or set hash.

No audio was generated or played, so operator intelligibility confirmation was unavailable. No direct/adapter inference was run; there are no new match counts or generated artifacts to clean. No source/configuration changes, live call, dispatch action, or database operation occurred. The repeat requires the original phrase set/harness, or explicit authorization to establish a new set and label it as a new experiment. P4 remains FAIL until offline and end-to-end criteria pass.

## 29. Pending Malayalam Whisper feasibility fixtures (2026-10-23)

**Status: BLOCKED pending review by a Malayalam speaker; no audio has been generated and no inference has been run. P4 remains FAIL / not accepted.** This is a synthetic offline feasibility proposal, not clinical validation. The outstanding English fixture experiment remains separate and unchanged.

### Verified local prerequisites and isolation

The dedicated multilingual model at `/home/resus/p4-ml-experiment/ggml-base.bin` is 147,951,465 bytes with SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`. The production model remains `/home/resus/whisper.cpp/models/ggml-base.en.bin`. Project language/provider code supports `ml`. Installed eSpeak NG is version 1.52.0; its voice list reports Malayalam as `ml` (`dra/ml`). Proposed temporary output path `/home/resus/p4-ml-experiment/audio-fixtures` does not exist; its parent is restricted mode 700 and writable. This preflight created no audio directory or audio. The backend was active and healthy, and no service or configuration was changed; dispatch remains disabled.

### Candidate test phrases

The candidates below are harmless synthetic statements, separate from Module 5's clinical protocol. They are not approved emergency instructions. A fluent Malayalam speaker must review the Malayalam text, glosses, and naturalness before any synthesis.

| # | Proposed Malayalam text | Provisional English meaning |
|---|---|---|
| 1 | ഇത് ഒരു പരിശീലന സന്ദേശമാണ്. | This is a training message. |
| 2 | പരിശീലന വാഹനം റോഡരികിൽ നിൽക്കുന്നു. | The training vehicle is stopped by the roadside. |
| 3 | സഹായസംഘം സ്ഥലത്തെത്തി. | The assistance team has arrived at the location. |
| 4 | സിമുലേഷൻ ഇപ്പോൾ ആരംഭിക്കുന്നു. | The simulation is starting now. |
| 5 | ഈ ഉദാഹരണം യഥാർത്ഥ അടിയന്തരാവസ്ഥയല്ല. | This example is not a real emergency. |
| 6 | പരിശീലന സംഘത്തിൽ മൂന്ന് പേർ ഉണ്ട്. | There are three people in the training team. |
| 7 | പരീക്ഷണ സന്ദേശം ഇപ്പോൾ അവസാനിക്കുന്നു. | The test message is ending now. |

### Test procedure after review

Store the reviewed expected phrases only in a disposable harness. Synthesize with installed eSpeak NG voice `ml` into a mode-700 temporary directory. Have the reviewer confirm each output is intelligible before inference. Use repository audio preparation helpers, then run direct whisper.cpp and `WhisperSpeechProvider` on identical prepared samples with explicit language `ml`, 4 threads, translation off, and the isolated model path `/home/resus/p4-ml-experiment/ggml-base.bin`. Pass the path only to the test harness; do not alter `WHISPER_CPP_MODEL` or production configuration. Compare exact/normalized phrase matches and direct/adapter agreement in memory; report aggregate counts/metadata only. Do not retain or print recognized text. Remove and verify removal of source/prepared WAVs, temporary JSON, and harness artifacts. No live call or Module 5/dispatch change is included.

**Required next approval:** a fluent Malayalam speaker must review or correct all seven candidate phrases and meanings, including naturalness and any unintended instructional interpretation. Do not generate audio before that review. P4 remains FAIL / not accepted regardless of this proposal; offline feasibility would not establish clinical validation.

## 30. Malayalam offline synthetic recognition attempt (2026-10-24)

**Execution status: BLOCKED before test startup; P4 remains FAIL / NOT ACCEPTED.** The requested WSL paths could not be accessed: invoking `wsl.exe --exec sh -lc ...` failed with `Wsl/Service/E_UNEXPECTED` (the WSL service reported a catastrophic failure) before the shell ran. As a result, accessibility of `/home/resus/p4-ml-experiment/ggml-base.bin`, `/home/resus/whisper.cpp/build/bin/whisper-cli`, and `espeak-ng` could not be verified. No alternate model or environment was used.

No temporary audio or harness was created; no recognition inference occurred. Exact matches: **0/7 measured (not run)**. Normalized matches: **0/7 measured (not run)**. Raw transcripts and audio were neither printed nor persisted. Temporary artifact cleanup: **not applicable; none created**. This failure provides no recognition or intelligibility evidence and does not satisfy any P4 acceptance criterion. No production configuration, services, calls, dispatch, clinical logic, or database state was touched.

**Next action:** make the existing WSL environment available, then rerun this exact seven-phrase test with explicit language `ml` and the specified isolated model and binaries.

### WSL diagnosis follow-up (2026-10-24)

The attached archive was inspected read-only. The extracted `logs.etl` was converted with `tracerpt.exe`; the ETL contained system/provider metadata (including virtual-disk component symbols) but no decoded event tying this startup failure to a specific cause. The available `wslservice.txt` confirms `WslService` was running. `wsl --list --verbose` confirms Ubuntu is registered as WSL2 and stopped. The retry `wsl -d Ubuntu --exec /bin/true` still fails with `Wsl/Service/CreateInstance/E_FAIL`, error code 6, failure step 2. The checked Hyper-V Compute Admin log had no events in the 10:15–10:45 window; System events in that interval included informational Hyper-V virtual-switch activity but no identified disk/VM initialization failure. The Lxss Operational event channel was unavailable on this host. **Root cause remains unknown; evidence is insufficient to justify a service restart, configuration change, security change, or disk operation.** No such operation was performed. WSL remains unavailable, so Malayalam synthesis/inference was not resumed; counts remain not run and no test artifacts were created. P4 remains FAIL / NOT ACCEPTED.

### Isolated Malayalam synthetic feasibility run (2026-10-24)

**Limitation:** all seven phrases remain provisional and have not been reviewed by a fluent Malayalam speaker. This offline synthetic feasibility result is not linguistic, clinical, or P4 acceptance evidence.

WSL became available after the preceding blocked attempt. The isolated model SHA-256 was verified before and after the run as `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`. eSpeak NG 1.52.0 synthesized all seven exact §29 phrases with voice `ml`; whisper.cpp was run once per WAV with the isolated model and explicit `-l ml`, four threads, timestamps disabled, and translation off. All seven synthesis and inference commands completed with exit code 0; no errors were reported. The production English-only model/configuration was not used or changed.

| Phrase | WAV duration (s) | Whisper runtime (s) | Exact | Normalized |
|---:|---:|---:|:---:|:---:|
| 1 | 2.579 | 2.487 | No | No |
| 2 | 3.260 | 2.459 | No | No |
| 3 | 2.357 | 2.134 | No | No |
| 4 | 2.676 | 2.124 | No | No |
| 5 | 3.535 | 4.067 | No | No |
| 6 | 2.948 | 2.179 | No | No |
| 7 | 3.404 | 2.428 | No | No |
| **Total** | **20.759** | **17.878** | **0/7** | **0/7** |

All WAVs were valid mono PCM WAVE, 16-bit, 22,050 Hz. Exact comparison used Unicode NFC plus trimming outer whitespace. Malayalam-aware normalization used NFC and casefolding, removed Unicode punctuation, collapsed whitespace, and preserved all other code points, including letters, combining marks, and word boundaries. The recognized outputs did not match the expected Malayalam phrases; the full per-phrase expected and recognized strings, timings, audio metadata, commands, and stdout/stderr are retained in `/home/resus/p4-ml-experiment/runs/malayalam-seven-phrases-20261024T054218Z/` (`results.json` and numbered artifacts). Audio and result artifacts are intentionally retained only in this isolated experiment directory. No live calls, external services, dispatch, clinical logic, production configuration, or database operations were used.

**P4 remains FAIL / NOT ACCEPTED.** This synthetic offline test does not satisfy the separate end-to-end acceptance criteria.

### Audio review and P4 acceptance audit (2026-10-24)

**Human intelligibility and phrase matching remain NOT VERIFIED.** The saved seven-item checklist was inspected and all intelligibility/match boxes remain blank; no human judgments were supplied or inferred. No one listened to these files during this audit. A fluent Malayalam speaker must review them before any further Whisper parameter experiments.

The seven saved WAVs were opened locally with Python's `wave` reader and each was confirmed to be nonempty mono PCM WAVE, 16-bit, 22,050 Hz. Durations matched the recorded experiment metadata. Windows can read the files directly through `\\wsl.localhost\Ubuntu`; `ffplay.exe` is installed, so copying is unnecessary. A blank checklist with the exact expected phrases, Windows paths, durations, and two human judgment boxes is saved at `/home/resus/p4-ml-experiment/runs/malayalam-seven-phrases-20261024T054218Z/AUDIO_REVIEW_CHECKLIST.md`.

| ID | Expected phrase | Audio path (Windows UNC) | Duration | Human review |
|---:|---|---|---:|---|
| 1 | ഇത് ഒരു പരിശീലന സന്ദേശമാണ്. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\01.wav` | 2.579 s | Pending |
| 2 | പരിശീലന വാഹനം റോഡരികിൽ നിൽക്കുന്നു. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\02.wav` | 3.260 s | Pending |
| 3 | സഹായസംഘം സ്ഥലത്തെത്തി. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\03.wav` | 2.357 s | Pending |
| 4 | സിമുലേഷൻ ഇപ്പോൾ ആരംഭിക്കുന്നു. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\04.wav` | 2.676 s | Pending |
| 5 | ഈ ഉദാഹരണം യഥാർത്ഥ അടിയന്തരാവസ്ഥയല്ല. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\05.wav` | 3.535 s | Pending |
| 6 | പരിശീലന സംഘത്തിൽ മൂന്ന് പേർ ഉണ്ട്. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\06.wav` | 2.948 s | Pending |
| 7 | പരീക്ഷണ സന്ദേശം ഇപ്പോൾ അവസാനിക്കുന്നു. | `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\07.wav` | 3.404 s | Pending |

To play them sequentially in Windows PowerShell:

```powershell
$base = '\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z'
$player = 'F:\aimovie\ffmpeg_extracted\ffmpeg-8.0.1-essentials_build\bin\ffplay.exe'
1..7 | ForEach-Object {
  $wav = Join-Path $base ('{0:D2}.wav' -f $_)
  Write-Host "Phrase $_ — $wav"
  & $player -nodisp -autoexit -loglevel error $wav
  Read-Host 'Record intelligibility and phrase match on the checklist, then press Enter'
}
```

#### P4 criteria status

| Criterion | Status | Evidence / smallest next step |
|---|---|---|
| Seven Malayalam synthetic files generated and valid | **PASS** | Seven valid WAVs; format/durations verified above. Phrases are provisional and unreviewed. |
| Offline Malayalam phrase recognition | **FAIL** | Saved run used explicit `-l ml`; 0/7 exact and 0/7 normalized. Do not tune further until human audio review. |
| Human intelligibility and match to intended text | **NOT VERIFIED** | Fluent Malayalam speaker review pending; use the checklist above. |
| Local SIP/RTP/AudioSocket setup and resource cleanup | **PASS (historical)** | Previous controlled call §13; not repeated because live calls are prohibited in this audit. |
| Expected caller phrase recognized in the live call | **FAIL** | §13 persisted fragments/blanks; requested phrase absent. A new live call is not authorized in this task. |
| Module 5 progression from intended caller phrase | **FAIL** | §13 stayed at `confirm-arrest`, then escalated after blank/incorrect utterances. |
| eSpeak generation/send over AudioSocket | **PASS (historical)** | §13 records five send attempts. |
| Human-confirmed MicroSIP prompt audibility | **NOT VERIFIED** | No independent client playback confirmation in §13. A future controlled call requires separate authorization. |
| Module 5 post-hangup state and resource cleanup | **PASS (limited to escalated-record retention); NOT VERIFIED for ordinary waiting session** | Historical call/media cleanup passed; §14 and `SessionService.escalate` specify that an `ESCALATED` protocol record remains open with its active step and `completedAt=null` for operator review. AudioBridge closes its connection and releases per-call controller state. The repository does not specify whether an ordinary `WAITING_FOR_RESPONSE` protocol should remain active after hangup or receive a neutral disconnect state. |
| Automatic dispatch disabled | **PASS (configuration gate)** | Current server process and `/home/resus/resus/.env` have no `MODULE6_AUTO_DISPATCH_ENABLED` value; code enables only explicit `true`. The bounded config/auto-dispatch suites below passed. No dispatch was triggered. |
| Overall P4 acceptance | **FAIL / NOT ACCEPTED** | Live phrase recognition and Module 5 lifecycle failed; human audio validation and client audibility remain unverified. |

Safe bounded synthetic tests run from `F:\minor`:

```text
npm test -- --reporter=dot modules/module_01_emergency_call/tests/callService.test.ts modules/module_02_speech_processing/tests/speechService.test.ts modules/module_02_speech_processing/tests/realSpeechProviders.test.ts modules/module_05_bystander_assistance/tests/sessionService.test.ts modules/module_06_ambulance_management/tests/config.test.ts modules/module_06_ambulance_management/tests/autoDispatch.test.ts
Test Files  6 passed (6)
     Tests  132 passed (132)
Exit code: 0
```

These suites use fake call adapters, in-memory protocol storage, synthetic audio/provider fixtures, and dispatch-gate stubs; they do not place calls, contact external services, or test the real engines. The Module 5 tests emitted expected heuristic-fallback warnings. No live call, database operation, clinical/protocol edit, or production telephony/model change was made. `git diff --check` was run after this audit update; it reported no whitespace errors (only the repository's existing CRLF conversion warnings on unrelated modified files).

#### Additional bounded controller evidence (2026-10-24)

The separate fake-backed Asterisk conversation controller suite was run because it covers protocol start, forwarding caller text, turn prompting, terminal-status prompt suppression, and duplicate-connect handling without repeating the prior six suites:

```text
npm test -- --reporter=dot tests/asteriskConversationController.test.ts
Test Files  1 passed (1)
Tests  11 passed (11)
Exit code: 0
```

This synthetic controller result does not establish that the real phone path recognized a caller phrase, that the intended Module 5 state followed that phrase in a real call, that MicroSIP rendered audible prompts, or that the session closed after hangup. Those remain failed or unverified as marked above. The remaining acceptance evidence requires one coordinated, harmless controlled call with a predeclared expected caller phrase and Module 5 state, human confirmation of prompt audibility, and post-hangup verification of session semantics and dispatch-disabled state; no such call was made in this audit.

After this report update, `git diff --check` exited 0 with no whitespace errors; Git emitted LF-to-CRLF conversion warnings for existing modified worktree files.

#### Additional bounded audio-bridge evidence (2026-10-24)

Because the unresolved gates include caller phrase handling and teardown, the separate fake-backed AudioBridge conversation suite was also run; it was not part of the prior 132-test batch or the controller suite above:

```text
npm test -- --reporter=dot modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts
Test Files  1 passed (1)
Tests  14 passed (14)
Exit code: 0
```

The suite exercises synthetic utterance forwarding/protocol advancement, closed-stream transcription and playback guards, and conversation release on close. Its transcriber, media stream, and call context are test doubles. It does not reverse the failed historical live-phrase or Module 5 evidence and does not establish human MicroSIP audibility or persistent Module 5 hangup closure. Those require the coordinated controlled call described above; no call was made. The audio checklist remains blank, and no further Whisper inference was run.

The final `git diff --check` after this report update exited 0; only existing LF-to-CRLF conversion warnings were emitted, with no whitespace errors.

#### Controlled-call plan prepared, not executed (2026-10-24)

The saved Malayalam checklist was re-read for this plan: **0 of 14 human-review fields are completed** (seven intelligibility fields and seven intended-phrase-match fields). Human review remains pending; no intelligibility or match judgment is inferred. No call or additional Whisper inference was run.

The following is a proposed single harmless local test using `isSimulation=true`, incident type `OTHER` (which resolves to the `general-triage` catalogue), and local MicroSIP extension 1001 only. Use no real person, address, emergency number, dispatch endpoint, or patient data. It is not authorization to run the call.

| Plan item | Proposed check | Evidence boundary |
|---|---|---|
| Exact caller phrase | First say: “Hello, this is a test call. I am checking the RESUS audio system.” Then say: “I am at Synthetic Test Site Seven.” Both are synthetic test utterances; the first is the phrase used in prior controlled-call evidence (§13). | The correlated `CALLER` transcript must contain each phrase, compared after Unicode NFC and trimming outer whitespace. Prior calls failed the first phrase check. |
| Module 5 behavior | `OTHER` resolves to `general-triage`, whose entry step is `confirm-location` and requires `caller_location`. The first test phrase contains no location, so expect `WAITING_FOR_RESPONSE`, remain at `confirm-location`, and ask for the exact location. The second phrase provides a synthetic location; expect `ADVANCED` to `confirm-safety` with no emergency action. Stop there and hang up. | Grounded in the catalogue transition (`caller_location exists` → `confirm-safety`), `callerLocation`'s explicit “I am at …” pattern, and the engine's missing-fact clarification behavior. If runtime fact extraction does not preserve these expected outcomes, stop and record failure; do not continue the protocol. |
| MicroSIP audibility | A human listener at the active MicroSIP audio output confirms hearing the expected eSpeak prompt during this same call; record only call ID, prompt, and yes/no confirmation, not a private recording. | Must be direct human confirmation; server-side send records alone are insufficient. |
| Hangup and Module 5 lifecycle | Hang up the same test call; verify the call row is `ENDED`, Asterisk channels/calls and established AudioSocket peers are zero, and per-call controller state is released. Inspect the protocol record without editing it. | The current code will leave the non-escalated protocol at `WAITING_FOR_RESPONSE` on `confirm-safety`, active step, `completedAt=null`: `CallService.close` ends the call row but does not transition Module 5; `AudioBridge.onClose` deletes connection state, clears its timer, and calls `conversation.forget`. **BLOCKED — confirmation required:** decide whether retaining this ordinary in-progress protocol for operator review is acceptable or whether a neutral disconnect lifecycle is required. Do not implement completion/cancellation as a substitute. |
| Dispatch safety | Before and after the call, read the running server environment and `.env`; verify `MODULE6_AUTO_DISPATCH_ENABLED` is unset/false and code remains fail-closed unless explicitly `true`. Do not call dispatch endpoints; verify no assignment/dispatch event was created by the test. | Existing audit evidence shows the key unset and explicit-true gating. This is a read-only pre/post check, not a dispatch exercise. |

Stop immediately if either phrase is not recognized, the Module 5 state differs from the expected state, a prompt is not human-confirmed audible, any call/media/controller resource remains after hangup, or dispatch is not demonstrably disabled. **BLOCKED — confirmation required before executing the planned call:** confirm whether a non-escalated `WAITING_FOR_RESPONSE` Module 5 record may remain open after the telephony call ends, or specify the intended neutral disconnect lifecycle. Escalated-record retention is explicitly documented; ordinary waiting-session retention is not. Overall P4 stays **FAIL / NOT ACCEPTED**.

#### Code-level pipeline and lifecycle audit (2026-10-24)

The seven WAVs were re-read through Python's standard `wave` reader, including all sample frames. All are readable mono PCM WAVE, 16-bit, 22,050 Hz, with durations 2.357–3.535 seconds. This is file-integrity evidence only; it does not establish speech intelligibility. The saved checklist remains blank (0/14 human fields complete).

The retained experiment metadata (read without printing transcript text) confirms all seven synthesis/inference records completed with zero harness errors; eSpeak voice `ml`; explicit whisper.cpp language `-l ml`; isolated multilingual model `/home/resus/p4-ml-experiment/ggml-base.bin`, SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`; exact matches 0/7 and Malayalam-normalized matches 0/7. Exact normalization is NFC plus trim. Malayalam normalization is NFC plus casefold, punctuation removal and whitespace collapse while preserving other code points and word boundaries. No model/language mismatch, invalid WAV, harness exception or compare-normalization defect is evidenced in this run. The cause of the recognition failure remains undetermined: eSpeak pronunciation/intelligibility and recognizer acoustic performance cannot be separated without the pending fluent-speaker review. No inference was run in this audit.

The repository Whisper provider decodes telephony input as mono signed 16-bit PCM (AudioSocket's 8 kHz contract), resamples it to 16 kHz mono WAV, and passes `-l` using either the configured explicit language or the request language when configured as `auto`. The saved Malayalam harness did not use the production model/configuration. Historical live-call diagnostics measured 8 kHz mono 16-bit ingress and successful 16 kHz preprocessing/inference; they did not identify a malformed-rate cause, though weak/ambiguous acoustic activity and VAD segmentation remain hypotheses. The requested English caller phrase was still absent in historical live calls. No concrete speech-pipeline root cause is proven.

Hangup code review found distinct lifecycles: Asterisk hangup invokes `CallService.close`, which hangs up transport, ends the `CallSession`, and records `CALL_DISCONNECTED`; AudioBridge `onClose` removes its connection, marks it closed, clears the silence timer, discards unfinished speech and calls `conversation.forget`; the conversation controller deletes its per-call map entry. Separately, `SessionService.escalate` explicitly says an escalated protocol is deliberately nonterminal so an operator can review the transcript/facts and writes `completedAt=null`. `cancel` is documented for emergency services reaching the scene, so hangup must not call it. Historical `ESCALATED` plus active step and null `completedAt` is expected retention, not a cleanup defect. For a non-escalated `WAITING_FOR_RESPONSE` session, `CallService.close` does not update Module 5 and the repository has no explicit ordinary-disconnect rule; whether that active protocol should remain open is a product/domain decision. The acceptance table above supersedes the older unconditional Module 5 closure FAIL wording: escalated-record retention and call/media cleanup are distinct from the unresolved ordinary-waiting-session rule.

Existing fake-provider tests safely cover these boundaries: the prior `audioBridgeConversation.test.ts` run passed 14 tests including release on stream close; the earlier six-suite run passed the fake Module 6 dispatch config tests; this audit ran the two targeted AMI hangup tests:

```text
npm test -- --reporter=dot modules/module_01_emergency_call/tests/asteriskProtocols.test.ts -t "closes the session when AMI reports the channel hung up|waits for an in-flight open to commit before closing"
Test Files  1 passed (1)
Tests  2 passed | 48 skipped (50)
Exit code: 0
```

No source regression test was added because inspection found no established expected behavior for ordinary Module 5 disconnect to encode. A neutral protocol-disconnect status would be a new domain rule, not a test-only cleanup fix. The proposed two-utterance call is **blocked pending that rule decision**, even though the initial progression expectation is grounded in `general-triage`.

#### Module 5 disconnect owner decision — PENDING OWNER APPROVAL (2026-10-24)

Code review confirms the existing status set has no disconnected protocol state. `CallService.close` ends the telephony call and emits `CALL_DISCONNECTED`, but does not change an ordinary Module 5 session. `SessionService.escalate` intentionally retains an `ESCALATED` session for operator review with `completedAt=null`; `cancel()` is documented for emergency services arriving at the scene and is not an appropriate hangup substitute. AudioBridge/controller teardown removes per-call in-memory resources, which is separate from protocol persistence.

The owner must decide, without treating any option below as an approved policy:

1. When an ordinary `WAITING_FOR_RESPONSE` session loses its telephone connection, should it remain open for operator review? Keeping the current behavior leaves its status/step intact and `completedAt` null, but may leave an active-looking session after its call ended. Transitioning it would require an approved neutral lifecycle rule; no such state currently exists.
2. If it must transition, what exact existing neutral state and transition event are approved? The repository currently defines no disconnected protocol state/event. Reusing `COMPLETED` or `CANCELLED` would assert semantics the code assigns to different outcomes; adding a state/event requires an explicit domain decision and implementation review.
3. Should `completedAt` remain null for a disconnected but unresolved session? Current escalation retention uses null; completion/cancellation set a timestamp. The ordinary disconnect path currently does not alter it. The owner must define its meaning for this case.
4. How should reconnection or operator resumption work, if supported? Current call teardown deletes per-call controller state; no protocol reconnection/resumption contract is established by this code review. Define whether a new call resumes the same persisted protocol and step or starts separately, including duplicate/replay handling.
5. What audit event and user-visible status are required? `CALL_DISCONNECTED` audits the call lifecycle, but there is no distinct protocol-disconnect event/UI status identified for an ordinary waiting session. Define actor/system provenance and the operator-facing status needed to avoid implying that the protocol completed.

**Decision: PENDING OWNER APPROVAL.** Until resolved, the ordinary-session post-hangup acceptance check and the proposed controlled call remain blocked. No Module 5 code or policy was changed.

#### Human audio review and controlled-call preflight (2026-10-24)

The saved review checklist is `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\AUDIO_REVIEW_CHECKLIST.md`; all 14 judgments remain blank. WAV paths are `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\01.wav` through `07.wav`. The checklist already has separate blank Yes/No fields for intelligibility and intended-text match. Windows `ffplay.exe` and the previously recorded command are:

```powershell
$base = '\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z'
$player = 'F:\aimovie\ffmpeg_extracted\ffmpeg-8.0.1-essentials_build\bin\ffplay.exe'
1..7 | ForEach-Object {
  $wav = Join-Path $base ('{0:D2}.wav' -f $_)
  Write-Host "Phrase $_ — $wav"
  & $player -nodisp -autoexit -loglevel error $wav
  Read-Host 'Record both judgments on AUDIO_REVIEW_CHECKLIST.md, then press Enter'
}
```

A fluent Malayalam speaker should play each clip, compare it with that row's expected text, mark both independent Yes/No fields, save the checklist in place, and return it. No audio was played or judged in this audit.

The following is a readiness checklist only; no call was authorized or executed:

- [ ] Confirm a local simulated call to MicroSIP extension 1001, `isSimulation=true`, incident type `OTHER`; verify automatic dispatch is disabled before starting.
- [ ] Use only these harmless caller phrases: “Hello, this is a test call. I am checking the RESUS audio system.” then “I am at Synthetic Test Site Seven.” Expected progression from the repository catalogue: `general-triage` starts at `confirm-location`; first phrase leaves `WAITING_FOR_RESPONSE` at that step and prompts for location; second phrase supplies `caller_location` and should advance to `confirm-safety`. Confirm the actual transcript and state; stop after that step.
- [ ] Have a human listening at MicroSIP confirm the eSpeak prompt is audible and record the yes/no result. A server send record is not proof of audibility.
- [ ] After hangup, verify the call is `ENDED`, Asterisk channels/calls are zero, AudioSocket peers are zero, and per-call controller state is released; inspect the protocol record read-only.
- [ ] Verify dispatch remains disabled after the call and no assignment/dispatch event was created; do not invoke dispatch endpoints.
- [ ] Capture correlated call/session IDs, exact observed transcripts and state transitions, prompt audibility result, post-hangup resource counts, dispatch gate evidence, and timestamps without credentials or patient data.
- [ ] Stop on phrase/state mismatch, inaudible prompt, residual call/media/controller resource, or any indication dispatch is enabled. Do not progress beyond `confirm-safety`.

**BLOCKED:** the expected ordinary `WAITING_FOR_RESPONSE` protocol result after hangup cannot be accepted until the owner resolves the decision above. This preflight is not call authorization. Overall P4 remains **FAIL / NOT ACCEPTED**.

## P4 Release Blockers (2026-10-24)

Overall status: **FAIL / NOT ACCEPTED**. This handoff summarizes the remaining gates; no new tests or calls were run.

- **Human audio review: BLOCKED** — 0/14 judgments completed. A fluent Malayalam speaker must listen to all seven WAVs, record intelligibility and intended-phrase match separately for each, and save the checklist at `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\AUDIO_REVIEW_CHECKLIST.md`.
- **Module 5 disconnect policy: BLOCKED** — the protocol owner must decide whether an ordinary `WAITING_FOR_RESPONSE` session remains open after hangup. If not, the owner must identify an approved existing state/event and define `completedAt`, resumption, audit, and operator-visible behavior. Do not invent a new state or use `cancel()` as a substitute.
- **Controlled end-to-end call: NOT EXECUTED** — wait for the saved human audio review and lifecycle decision; then obtain explicit authorization before the proposed local simulated call. The plan is not authorization.
- **Dispatch: MUST REMAIN DISABLED** — verify disabled before and after any later authorized test; do not invoke dispatch endpoints.

Exit checklist (none of these outcomes is presumed):

- [ ] Fluent speaker completes and saves all 14 audio judgments; record the supplied results without inference.
- [ ] Protocol owner records the ordinary-disconnect decision and answers the lifecycle questions above.
- [ ] Explicit authorization is obtained; only then execute the bounded local simulated call and capture transcript/state progression, human prompt audibility, post-hangup channel/AudioSocket/controller cleanup, and dispatch-disabled evidence.
- [ ] Reconcile each acceptance criterion against captured evidence; mark only demonstrated outcomes, and retain **FAIL / NOT ACCEPTED** while any required criterion is failed or unverified.

## Module 5 ordinary-call-disconnect policy proposal — PROPOSED — PENDING PROTOCOL-OWNER APPROVAL

This is an owner-review proposal, **not an existing repository rule**. Source review shows that Asterisk `CallService.close` ends the telephony `CallSession` and records `CALL_DISCONNECTED` against the call entity. AudioBridge/controller teardown releases per-call media/controller resources. That event currently carries the call ID, emergency ID, duration, and reason; it does not identify the Module 5 protocol session or last protocol step. The protocol status vocabulary has no disconnected state/event. `SessionService.cancel()` represents emergency services reaching the scene and sets `CANCELLED` plus `completedAt`; `escalate()` deliberately retains an unresolved session for operator review with `completedAt=null`.

### Proposed safeguards for owner decision

- Close telephony call resources on hangup.
- Do not treat an unresolved clinical session as resolved or silently cancelled because the call ended.
- Make the disconnect and last known protocol step auditable; current `CALL_DISCONNECTED` evidence alone does not link that event to the protocol session/step.
- Do not set `completedAt` solely because telephony ended, unless the approved lifecycle contract explicitly defines that meaning.
- Permit resumption only through an approved, repository-supported workflow; do not imply reconnection/resumption is currently supported.

### Required owner decision

Choose whether the ordinary unresolved `WAITING_FOR_RESPONSE` session is retained for operator review, or identify an already-supported neutral transition that the owner approves. The current status/event definitions contain no protocol-disconnected state/event; do not invent one in this proposal. If a transition is selected, the owner must also approve the exact `completedAt` semantics, resumption behavior, audit linkage, and operator-visible status. Do not use `cancel()` as a hangup substitute.

### Focused regression-test plan after approval

Do not add or run tests asserting this unapproved policy. Once the owner records the decision, add focused tests around Module 1 call-close/`CALL_DISCONNECTED` and the Module 5 session lifecycle: verify one disconnect audit record, call/media/controller cleanup, preservation of the last known protocol step and collected facts, and the approved status/`completedAt` outcome. If the approved path retains the session, assert it remains unresolved and reviewable; if the owner identifies an already-supported neutral transition, assert that exact transition and event without completion/cancellation semantics. Add a resume/idempotency test only if the approved workflow supports resumption. Confirm the operator-visible status from the actual projection/API before asserting it.

No Module 5 code, tests, or clinical protocol were changed. P4 remains **FAIL / NOT ACCEPTED** pending owner decision and end-to-end evidence.

## Actionable Module 5 owner decision request and test matrix

**Decision request — PENDING APPROVAL:** Choose one policy for an ordinary unresolved `WAITING_FOR_RESPONSE` session when its telephony call disconnects:

- **A. Retain for operator review:** keep the unresolved clinical session and its last protocol step, while clearly auditing that the associated call disconnected.
- **B. Approved neutral transition:** use only a transition that already exists and whose semantics the protocol owner explicitly approves. The repository currently has no dedicated protocol-disconnect state/event; do not add or imply one here.

The owner must explicitly decide the resulting session state, whether `completedAt` remains null, reconnection/resumption behavior, and the audit event plus operator-visible status. `cancel()` has different semantics: the existing service documents it as “Emergency services reached the scene,” writes `PROTOCOL_CANCELLED`, and sets `completedAt`; it is not a hangup substitute. This request proposes no policy and changes no Module 5 behavior.

| Decision / criterion | Focused regression coverage after owner approval | Existing test file(s) and candidate command |
|---|---|---|
| Telephony cleanup on hangup | Call closes once, emits `CALL_DISCONNECTED` once, and media/controller resources release. | `modules/module_01_emergency_call/tests/callService.test.ts` (`records the duration and emits CALL_DISCONNECTED once`, `is idempotent...`); `modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts` (`leaves silent frames alone and releases the conversation on close`). |
| Clinical session persistence and last protocol step | Add the approved disconnect-path test: preserve facts/step and assert either owner-approved retention or exact already-supported transition. | `modules/module_05_bystander_assistance/tests/sessionService.test.ts` (`persists facts and bookkeeping together in one transition`) plus an approved-policy regression; combined command below. |
| `completedAt` | Assert the owner-approved value for a disconnected unresolved session; separately preserve existing completion/cancellation semantics. | `modules/module_05_bystander_assistance/tests/sessionService.test.ts`; do not assert a value before approval. |
| Audit event and operator-visible status | Assert approved audit linkage to the call and protocol/last step, and verify the actual session GET/list response or operator projection. No dedicated Module 5 route test for this disconnect behavior was identified. | `modules/module_05_bystander_assistance/tests/sessionService.test.ts`; add a focused route/projection test only if the approved UI/status contract requires it. `modules/module_01_emergency_call/tests/callService.test.ts` covers the existing call-disconnect event. |
| Resumption, if supported | Test only the approved resume path, preserving session/step and avoiding duplicate transitions; otherwise document no resume workflow. No existing Module 5 resume test was identified. | Candidate: `modules/module_05_bystander_assistance/tests/sessionService.test.ts` and, if call reconnection is part of the approved flow, `tests/asteriskConversationController.test.ts`. |
| Automatic dispatch remains disabled | Keep fail-closed default and disabled subscriber behavior covered. | `modules/module_06_ambulance_management/tests/config.test.ts` and `modules/module_06_ambulance_management/tests/autoDispatch.test.ts`. |

Candidate focused command after the owner decision and implementation (not run for this handoff):

```text
npm test -- --reporter=dot modules/module_01_emergency_call/tests/callService.test.ts modules/module_01_emergency_call/tests/audioBridgeConversation.test.ts modules/module_05_bystander_assistance/tests/sessionService.test.ts modules/module_06_ambulance_management/tests/config.test.ts modules/module_06_ambulance_management/tests/autoDispatch.test.ts
```

### Human audio review handoff

Verified checklist: `\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z\AUDIO_REVIEW_CHECKLIST.md`. The checklist and `01.wav`–`07.wav` exist; 0/14 human judgments are complete. A fluent Malayalam speaker must play all seven clips, mark intelligibility and intended-phrase match separately for each, and save the checklist. Use this existing PowerShell command from Windows:

```powershell
$base = '\\wsl.localhost\Ubuntu\home\resus\p4-ml-experiment\runs\malayalam-seven-phrases-20261024T054218Z'
$player = 'F:\aimovie\ffmpeg_extracted\ffmpeg-8.0.1-essentials_build\bin\ffplay.exe'
1..7 | ForEach-Object {
  $wav = Join-Path $base ('{0:D2}.wav' -f $_)
  Write-Host "Phrase $_ — $wav"
  & $player -nodisp -autoexit -loglevel error $wav
  Read-Host 'Record both judgments on AUDIO_REVIEW_CHECKLIST.md, then press Enter'
}
```

No call or tests were run for this handoff. Automatic dispatch remains required to stay disabled; overall P4 remains **FAIL / NOT ACCEPTED**.
