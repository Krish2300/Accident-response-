# RESUS master completion report — 2026-10-27 17:53 UTC

Report directory: `artifacts/master-completion-20261027T175321Z-d267/`
Predecessor report (not overwritten): `artifacts/master-completion-20261027T151227Z-9c5a/QUALITY_GATE_REPORT.md`

---

## 1. Executive summary

All five highest-risk gaps identified at the start of this task were closed, and the full
verification chain is green on this workspace:

| Gate | Result |
|---|---|
| `npm test` (baseline, ungated) | **PASS** — 83 files / 813 tests passed, 9 files / 66 skipped |
| Gated full suite (all isolated flags + dashboard live proxy) | **PASS — EXIT 0**, 91 files passed / 1 skipped (92), **879 tests passed / 1 skipped (880)** |
| `npm run typecheck` | **PASS**, exit 0 |
| `npm run lint` | **PASS**, exit 0 — 0 errors, 50 pre-existing `no-explicit-any` warnings |
| `npm run build` | **PASS**, exit 0 — `dist/server/server.js` + `dist/web` (252.17 kB, gzip 73.18 kB) |
| `npx prisma validate` | **PASS** — schema valid |
| `npm run protocols:validate` | **PASS** — 5 protocols / 33 steps / 0 errors / 3 warnings (all 5 catalogues still `UNREVIEWED`) |
| `flutter test --no-pub` (apps/driver) | **PASS** — 4/4 |
| `flutter analyze --no-pub` (apps/driver) | **PASS** — no issues |
| `npm run demo:verify` (headless browser) | **PASS — 32/32 checks**, exit 0 |
| `git diff --check` | **PASS**, exit 0 (existing LF/CRLF warnings only) |
| Live telephony Stage A (readiness) | **PASS** |
| Live telephony Stage B (MicroSIP signaling, outbound) | **PASS** |
| Live telephony Stage C (digital media both directions) | **PASS (digital path)**; acoustic leg **BLOCKED** |
| Live telephony Stage D (audio → protocol step behaviour) | **PARTIAL** — ingest/intent/extraction PASS, step advancement not observed over live audio |

Additional integration work completed this run: the WSL deployment was brought back in sync with
this workspace (source rsync, pending Prisma migration applied, Prisma client regenerated), one
**live defect was found and fixed** (Asterisk call-leg bookkeeping leak, fix proven in unit tests and
against the live PBX), and the deployed server now runs the current source (75 routes, 0 errors).

**This is not production, clinical, regulatory, or operational acceptance.** No real emergency
number was dialled, no real patient/case was handled, no external notification was sent, and all
five clinical protocol catalogues remain unreviewed. See §12 and §15.

---

## 2. Workspace, preservation, and git state

- Checkout `F:\minor`; branch **`main`**; HEAD **`121d7933ae3edcd478089343fdc493f2757d2ad8`** (unchanged).
- No `git reset`, `git clean`, stash, branch switch, commit, or push was performed. No existing
  report or artifact was overwritten; this report is additive.
- Baseline at task start (from the predecessor report): **71 modified, 99 untracked**.
- Final at report time: **71 modified, 102 untracked, 0 other states**.
  The three additional untracked entries appeared in the task window (creation timestamps
  15:13–16:02 UTC) and are feature/tooling files this report did not write or edit:
  `apps/server/src/ambulance/offerExpiryWatch.ts`, `tests/ambulanceOfferExpiryWatch.test.ts`
  (paired with the pre-existing `20261027120000_ambulance_offer_expiry` migration), and
  `apps/dashboard/public/favicon.svg`. They were preserved untouched and are exercised by the final
  gated suite (`tests/ambulanceOfferExpiryWatch.test.ts` — 3 tests passed).
- `git diff --stat` (tracked modifications): **71 files changed, 6888 insertions(+), 532 deletions(-)**
  — all pre-existing except this task's edits listed in §5.
- `git diff --check`: **exit 0**; Git emitted its existing `LF will be replaced by CRLF` warnings for
  ~45 tracked files. No whitespace errors.
- Final `git status --porcelain` saved to `%TEMP%\resus-final-git-status.txt`.

---

## 3. Module-by-module status

“Automated” means local tests/synthetic fixtures unless a live path is named. **No row represents a
successful real emergency call or a clinical outcome.**

| Module | Evidence this run | Status |
|---|---|---|
| 1 — Emergency call | Unit/integration suites in gated run; **live** outbound originate → MicroSIP auto-answer → AudioSocket → protocol session → hangup (Stage B); **live** inbound `baresip` → dialplan `1000` → AudioSocket → close (Stages C/D); 4 controlled calls, 0 journal errors; call-leg leak **fixed** (+ regression test, `asteriskProtocols.test.ts` 51/51). | **PASS (local PBX, controlled test calls)** — human-audible TTS and human speech not verified (§8) |
| 2 — Speech processing | `/speech/status` live `whisper` + `espeak`, `isLive:true`, en/ml; Whisper transcribed live call audio in all 4 calls (confidence 0.525–0.881, accepted vs `minConfidence 0.45`); eSpeak prompts synthesized 8.8–12.2 s and captured at the caller leg (downlink RMS 0.077–0.083). | **PARTIAL** — digital path PASS; canonical recognition quality and acoustic (human) leg **BLOCKED/NOT TESTED** |
| 3 — NLP extraction | Adapter/classifier tests in gated run. | **PARTIAL** — live Python classifier **NOT TESTED** (the single suite skip, opt-in, interpreters lack runtime deps) |
| 4 — Conversation support | Conversation/localization tests in gated run. | **PARTIAL** — no caller-facing UI/legacy Python service established |
| 5 — Bystander assistance | Engine/session/API tests; **live** sessions on calls (3 protocol sessions created); audio answer → intent/fact extraction observed (`responsive=NO`, `consciousness=UNRESPONSIVE`, `intent=PATIENT_UNRESPONSIVE`); `protocols:validate` 0 errors. | **PARTIAL** — all 5 catalogues `UNREVIEWED`; live audio did **not** advance a step (re-asked, correct for a non-answering utterance); LLM path unavailable → heuristic fallback |
| 6 — Ambulance management | Assignment/offer-expiry/dispatch tests incl. new `ambulanceOfferExpiryWatch.test.ts` (3 passed); dashboard renders offer + expiry in browser. | **PARTIAL** — no real vehicle/dispatch; synthetic only |
| 7 — Hospital intelligence | Resource/selection/config tests; dashboard evidence. | **PARTIAL** — auto-selection disabled by default; no live hospital system |
| 8 — Route optimization | Provider/route tests; browser shows non-live route provenance. | **PARTIAL** — no external routing provider contacted (`isLiveTraffic:false`) |
| 9 — Corridor coordination | Corridor/notification tests with non-delivery assertions. | **PARTIAL** — no real police/traffic integration |
| 10 — Lifecycle orchestration | Projection tests; browser shows 4 operator-reported milestones + no-survival-claim copy. | **PARTIAL** — milestones are operator reports, not independent outcomes |
| 11 — Database & events | `prisma validate` PASS; deployed migration `20261027120000_ambulance_offer_expiry` **applied to the live dev DB** (exit 0, “All migrations have been successfully applied”); Prisma client regenerated (v6.19.3) after a real stale-client failure; transaction-safety/event tests PASS. | **PASS (owned dev + isolated test DBs)** — no production database touched |
| 12 — Dashboard & analytics | API/client/component tests + live local Vite proxy test PASS; `demo:verify` **32/32** including authenticated browser rendering of emergencies, fleet, lifecycle, offers, evidence semantics. | **PASS (local demo/browser)** — physical device UI **NOT TESTED** |
| location-resolution | Composed workflow + tests; provider explicitly unconfigured by default. | **PARTIAL** — no geocoder contacted; operator confirmation path only |

---

## 4. Integration gaps closed this run

1. **Browser verification (was 31/32).** `scripts/demo-verify.ts` was strengthened rather than
   suppressed: each CDP failure is now classified with URL, resource type, initiator, cancellation
   flag, recovery/completion evidence and navigation timing (`classifyBrowserIssues()`).
   Re-run against the live demo backend → **32/32 PASS**: `javascript=0`, `http5xx=0`,
   15 `net::ERR_ABORTED` fetches all `canceled=true`, initiated by `script@…/frontend/src/api.ts`,
   superseded by later requests and the same paths completed successfully; the single console error is
   the deliberate rejected sign-in (`401` on `POST /api/auth/login`, `deliberateRejectedSignInRecorded=true`).
2. **Gated composed E2E suite.** Full run with all isolated flags → **EXIT 0** (see §6).
3. **Telephony Stage B/C.** Signaling and digital media verified against the live WSL backend,
   Asterisk 22.5.2, and MicroSIP/baresip (§8). Acoustic leg remains blocked and is labelled as such.
4. **Clinical protocol blockers.** Re-validated, not hidden: 5 protocols / 33 steps / 0 errors /
   **3 warnings**, every catalogue flagged `UNREVIEWED` and served with that status attached
   (visible in the live session payload: `protocolSource … [UNREVIEWED]`).
5. **Full verification chain + new timestamped report.** This document; predecessor untouched.

Plus two defects found by this run's work:

- **Stale Prisma client in the deployed WSL server** — after syncing source and applying the pending
  migration, the live server logged `Unknown argument 'expiresAt' … Failed to find expired ambulance
  offers` every 5 s. Fixed with `npx prisma generate` (client now contains `expiresAt`, 49 matches)
  and a service restart; **0 errors** in the journal afterwards.
- **Call-leg bookkeeping leak** — `AsteriskTelephonyProvider.hangup()` returned early when AMI
  reported the hangup first, leaving the dead leg in `calls`/`byChannel`/`byUuid`, so
  `/calls/transport/status` reported `1 call leg(s) tracked` after every caller-side hangup
  (reproduced live on Stage C). Fixed to `release()` the entry; regression test added; re-verified
  live on a fresh inbound call → **`0 call leg(s) tracked`** after close.

---

## 5. Files changed by this task

Repository (all additive to existing work; nothing reverted or deleted):

| File | Change |
|---|---|
| `scripts/demo-verify.ts` | Evidence-based browser cleanliness classification + navigation timing (Gap 1; edited pre-checkpoint in this task) |
| `modules/module_01_emergency_call/src/telephony/asteriskProvider.ts` | `hangup()` releases AMI-marked-hung-up legs instead of leaking them |
| `modules/module_01_emergency_call/tests/asteriskProtocols.test.ts` | New regression test: *"releases a leg AMI already reported hung up instead of leaving it tracked"* (file now 51 tests) |
| `artifacts/master-completion-20261027T175321Z-d267/QUALITY_GATE_REPORT.md` | This report |

Outside the repository (temporary/operator-visible output):

- `%TEMP%\opencode\resus-*.sh` — WSL helper scripts (sync, migrate, Stage B/C/D, probes).
- `%TEMP%\resus-final-lint.log`, `resus-final-gated-suite.log`, `resus-final-demo-verify.log`,
  `resus-final-git-status.txt` — captured command output.
- WSL: `/tmp/resus-*.log` (stage logs), `/home/resus/siptest/{stageC-20261027, stageC-retest-20261027, stageD-20261027}`
  (isolated baresip configs, uplink/downlink WAVs), `/home/resus/resus-deploy-src-backup-20261027T171316Z.tar.gz`
  (1.15 GB pre-sync backup of the deployed source), `/home/resus/resus/` (deployed source synced from `F:\minor`).
- One erroneous 4.38 GB `lead.wav` created by a bad `sox -n … pad` invocation was **deleted immediately**
  (disk back to 8.7 GB used of 1007 GB); no other cleanup or destructive action was taken.

---

## 6. Exact commands and results

All commands ran from `F:\minor` unless noted. **No timeout was inflated and no test was weakened or
skipped to force a pass**; skips listed are the repository's pre-existing opt-in gates.

1. Baseline suite (pre-checkpoint): `npm test -- --reporter=dot`
   → **PASS**, 83 files / 813 tests passed, 9 files / 66 skipped.
2. Gated suite (pre-checkpoint): the four `RESUS_RUN_ISOLATED_*` flags then `node .\node_modules\vitest\vitest.mjs run`
   → **EXIT 0**, 90 files / 877 tests passed, 2 skipped (`dashboardLiveProxy` opt-in, `module3Classifier` live Python).
   (The first attempt exited 1 with identical counts and was not reproduced; log `%TEMP%\resus-gated-suite-run.log`.)
3. `RESUS_RUN_DASHBOARD_LIVE_TEST=true node .\node_modules\vitest\vitest.mjs run tests/dashboardLiveProxy.integration.test.ts`
   → **PASS 1/1**.
4. `npm run typecheck` → **PASS, exit 0**.
5. `npm run lint` → **PASS, exit 0** — `✖ 50 problems (0 errors, 50 warnings)`, all `@typescript-eslint/no-explicit-any`.
6. `npx prisma validate --schema modules/module_11_database_event_system/prisma/schema.prisma`
   → `The schema … is valid 🚀`, **exit 0**.
7. `npm run protocols:validate` → **exit 0**, `5 protocol(s), 33 step(s), 0 error(s), 3 warning(s)`;
   `[protocols] ok`; warnings name critical escalation rules with no `escalation_step`.
8. `npm run build` → `[build] ok`, **exit 0** (`dist/server/server.js`, `dist/web` 252.17 kB / gzip 73.18 kB, built in 2.79 s).
9. In `apps/driver`: `flutter test --no-pub` → `All tests passed!` (**4**, exit 0);
   `flutter analyze --no-pub` → `No issues found! (ran in 9.7s)`, **exit 0**.
10. Final gated suite (after this task's source edits), background run:
    ```powershell
    $env:RESUS_RUN_ISOLATED_COMPOSITION_TEST='true'; $env:RESUS_RUN_ISOLATED_OUTCOME_TEST='true'
    $env:RESUS_RUN_ISOLATED_OUTCOME_API_TEST='true'; $env:RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST='true'
    $env:RESUS_RUN_DASHBOARD_LIVE_TEST='true'
    node .\node_modules\vitest\vitest.mjs run
    ```
    → **EXIT 0**: `Test Files 91 passed | 1 skipped (92)`, `Tests 879 passed | 1 skipped (880)`,
    duration 180.64 s. The single skip is `tests/module3Classifier.live.test.ts`. Log `%TEMP%\resus-final-gated-suite.log`.
11. Targeted run of the edited test file: `node .\node_modules\vitest\vitest.mjs run modules/module_01_emergency_call/tests/asteriskProtocols.test.ts`
    → **51 passed**, exit 0.
12. Final browser verification:
    ```powershell
    $env:DEMO_SERVER_LOG = Join-Path $env:TEMP 'resus-demo-server-4021-3e44a84facc04a1ab2429de08d640cee.log'
    $env:DEMO_BASE_URL='http://127.0.0.1:4021'; $env:DEMO_DASHBOARD_URL='http://127.0.0.1:5175'
    npm run demo:verify
    ```
    → `[demo-verify] 32/32 checks passed`, `live dashboard verification succeeded`, **exit 0**.
    (The credential-bearing log is private and was never printed.)
13. `git diff --check` → **exit 0**. `git rev-parse HEAD` → `121d7933…`. `git status --porcelain` → 71 M / 102 `??`.
14. WSL deployment sync and migration (scripts in `%TEMP%\opencode\`, invoked as `wsl bash /mnt/c/…`):
    - pre-sync backup: `/home/resus/resus-deploy-src-backup-20261027T171316Z.tar.gz` (1.15 GB);
    - `rsync -a --delete --exclude …` workspace → `/home/resus/resus` (`.env`, `node_modules`, `dist`, DBs preserved; deps identical);
    - `npx prisma migrate deploy --schema modules/module_11_database_event_system/prisma/schema.prisma`
      → `All migrations have been successfully applied`, `migrate_exit=0`;
    - `npx prisma generate --schema …` → `Generated Prisma Client (v6.19.3)`, `generate_exit=0`;
    - `sudo -n systemctl restart resus-server.service` → `active`.
15. Live probes (final, 2026-10-27T17:52:42Z):
    ```
    GET /api/health          → status ok, env development, routes 75, 12 modules listed
    GET /calls/transport/status → {"provider":"asterisk","isLive":true,"reachable":true,"detail":"Asterisk AMI reachable; 0 call leg(s) tracked."}
    GET /speech/status       → speech whisper isLive true (en,ml), synthesis espeak isLive true (en,ml), minConfidence 0.45
    asterisk -rx 'pjsip show contacts' → 1001 registered (MicroSIP)
    asterisk -rx 'core show channels' → 0 active channels / 0 active calls / 4 calls processed
    journal since final restart → 0 errors; warnings: 6× "primary LLM provider unavailable", 2× "extraction produced by heuristic fallback"
    systemctl is-active resus-server.service asterisk.service → active / active
    ```

---

## 7. Browser verification (detail)

- Backend: demo server on `127.0.0.1:4021` (PID 23444), dashboard Vite on `127.0.0.1:5175` (PID 33700) —
  both were already running and were **not** killed.
- Checks: shell load, rejected sign-in, authenticated live view, proxy status (`routes=75`),
  zero token storage in `localStorage`/`sessionStorage`, live emergencies, fleet freshness,
  lifecycle projection + evidence semantics + no-outcome disclaimer, dispatch workflow with non-live
  route provenance, pending offer + expiry, 12 observed lifecycle facts, role 403s, structured 404/422.
- Cleanliness gate (evidence-classified, not a blanket abort counter):
  `javascript=0`, `http5xx=0`, `network raw=15`, `unexpectedNetwork=[]`, `unexpectedConsoleErrors=[]`.
  All 15 aborts: `net::ERR_ABORTED`, `canceled=true`, `initiator=script@…/frontend/src/api.ts`,
  `supersededByLaterRequest=true`, `completedAfterFailure=true`, `pathServedSuccess=true`.
  The 1 console error is `401` on `/api/auth/login` from the deliberate rejected sign-in check.
  Navigation timing: `domContentLoadedMs=245`, `loadEventEndMs=245`, 67 resource entries.
- Verdict: **PASS 32/32 (headless Edge/CDP against the local demo backend — a demo/loopback runtime, not the live PBX stack).**

---

## 8. Telephony — MicroSIP / Asterisk signaling and audio

Live stack: WSL Ubuntu — Asterisk 22.5.2 (`asterisk.service`), AMI `127.0.0.1:5038`,
AudioSocket `127.0.0.1:9092`, dialplan contexts `resus` (ext 1001) and `resus-inbound` (ext 1000),
RESUS server `resus-server.service` on `:4000` (current source, 75 routes).
Clients: **MicroSIP** on Windows (PID 4764, `autoAnswer=all`, registered `1001`), **baresip 1.1.0**
in WSL (`aufile` uplink/downlink, registered as `emergency`, `-4` for IPv4).

All calls used **local extensions only (1001 / 1000)**. No real emergency number was dialled.

### Stage A — readiness: PASS
`transport/status` `isLive:true`; `pjsip show contacts` shows `1001 … Avail`; `/speech/status`
whisper + espeak `isLive:true`.

### Stage B — outbound signaling to MicroSIP: PASS
| Item | Evidence |
|---|---|
| Open | `POST /calls` (public, `callerId=1001`, `incidentType=CARDIAC_ARREST`, `isSimulation=true`, synthetic `(0,0)`) → 201: `CALL-5D2C0CB4AF0003`, `EMG-DE0EA2B9E00001`, `provider=asterisk`, `transport=SIP`, `isLiveTransport=true`, status `ACTIVE` |
| Channel | `PJSIP/1001-00000000` state `Up`, application `AudioSocket(846deb04-7b8f-4ff4-80c6-e1ba27c4ce28)`; `AudioSocket channel connected … remote 127.0.0.1:44640` |
| Protocol | `PSE-100757D5400006` started (`CARDIAC_ARREST`, ACTIVE), eSpeak prompts 8 787 ms and 11 277 ms sent |
| Media | 6 audio segments ingressed from the MicroSIP leg (8 kHz s16 mono, VAD segments 840–4 720 ms), Whisper completed each (conf. 0.881 / 0.857 / 0.606 / 0.616 / 0.525), transcripts stored |
| Hangup | `POST /calls/CALL-5D2C0CB4AF0003/hangup` (dev-token) → `status ENDED`, `durationMs 62925`, `closed:true`; media stream ended; `0 active channels`; transport `0 call leg(s) tracked` |
| Errors | 0 |

*(An initial hangup attempt used the emergency id by mistake and returned `CALL_NOT_FOUND`; corrected
immediately with the call-session id. No extra call was opened.)*

### Stage C — inbound digital media (baresip `aufile`): PASS (digital path)
Known-content uplink generated with **espeak-ng** (provenance: synthetic, not human):
`"yes, the person is unresponsive and not breathing normally"` (1 s lead-in, 8 kHz mono s16, 10 s).

| Item | Evidence |
|---|---|
| Signaling | baresip registered as `emergency`, `/dial sip:1000@127.0.0.1` → `PJSIP/emergency-00000001` answered at `1000@resus-inbound`, `AudioSocket(f7c0b694-…)` connected |
| Session | `CALL-5399E6D3A70030`, `EMG-B8B7EA61B30031`, protocol `PSE-2ECED8C4C50035` (`general-triage`, source …`[UNREVIEWED]`) |
| Uplink → Whisper | Transcript `CALLER` = **"a person in unresponsive and hot breathing normally."** (conf. 0.756, band HIGH, 52 chars, accepted) vs expected phrase — recognisable but imperfect (Whisper mis-rendered “yes, the”→“a person in”, “not”→“hot”) |
| → Module 5 | `collectedFacts` = `responsive:NO`, `consciousness:UNRESPONSIVE`, `breathing_status:BREATHING`, `intent:PATIENT_UNRESPONSIVE`, `notes:<transcript>`; clarification re-asked (`clarificationCount:1`, `WAITING_FOR_RESPONSE`) |
| Downlink (server → caller) | baresip `aufile: writing speaker audio to …/downlink.wav`; 10 s, max ±0.668, **RMS 0.0796** (non-silent TTS) |
| Close | Caller-side EOF hangup at 10 s → `media stream ended`, `emergency call closed`, `durationMs 9986`, 0 errors |

### Retest after the leg-leak fix: PASS
Fresh inbound call `CALL-643B51AB580001` / `EMG-19173D98410002` (9 995 ms, closed by caller hangup)
→ transport reported **`0 call leg(s) tracked`** afterwards (pre-fix it stayed at `1`); downlink
re-captured (max 0.668, RMS 0.0767); 0 errors.

### Stage D — audio → protocol step behaviour: PARTIAL
Known phrase `"the exact location is building alpha, floor two, near the main gate"` → `CALL-7A398432940016`
/ `EMG-19DC93E7620017` / `PSE-F95B8751A9001B`. Whisper returned **"and a Mac location in building out a
floor to their main gate."** (conf. 0.704). Module 5 recorded it (`intent:OTHER`, `notes:…`), kept
`currentStep=confirm-location` `ACTIVE`, and re-asked the question (correct behaviour for an answer it
could not parse as a location). **Step advancement over the live audio path was therefore not
demonstrated**; step advancement is covered by the composed synthetic E2E test instead. Downlink RMS
0.0826; 11 068 ms; 0 errors. Total for the run: 4 controlled calls, `core show channels` → 4 calls processed.

### Acoustic leg (human speech in / human-heard audio out): BLOCKED — NOT TESTED
- The MicroSIP microphone path did deliver real acoustic audio (ambient/room + TTS echo) and Whisper
  produced stored transcripts — including hallucinations on silence (`[BLANK_AUDIO]`) and on ambient
  audio (`"and on the concrete regularly, we have or else…"` conf. 0.91). This confirms plumbing, **not**
  recognition quality.
- No human confirmed hearing the greeting/TTS in this run (headless environment). The historical
  acceptance record for that leg is `docs/TELEPHONY_E2E_TEST_REPORT.md` (P4 acoustic phrase
  recognition previously **FAIL**). The digital-path substitute above does not override it.

---

## 9. Driver app (Flutter)

- `flutter test --no-pub` → **All tests passed! (4)**, exit 0.
- `flutter analyze --no-pub` → **No issues found!**, exit 0.
- Role/authorization behaviour of driver-facing API paths was exercised through `demo:verify`
  (e.g. `driver role cannot record operational milestones — HTTP 403`).
- **NOT TESTED:** physical Android device, real GPS, background location, APK build/signing,
  app-against-live-backend end-to-end.

---

## 10. Providers verified (live vs mock)

| Provider | Mode in this run | Evidence |
|---|---|---|
| Asterisk (AMI/PJSIP/AudioSocket) | **LIVE (local PBX)** | `isLive:true`, 4 calls originated/answered/hung up, media both ways, 0 errors |
| whisper.cpp (speech recognition) | **LIVE** | `/speech/status isLive:true`; transcribed 10+ segments across 4 calls |
| eSpeak-ng (TTS) | **LIVE** | 8.8–12.2 s prompts synthesized; captured at caller leg (downlink RMS 0.077–0.083) |
| MicroSIP / baresip (SIP clients) | **LIVE (local)** | `1001` registered; baresip `emergency` registered and dialled ext 1000 |
| Ollama LLM (Module 5) | **UNREACHABLE** | `fetch failed`; server logs `primary LLM provider unavailable` + `heuristic fallback` — extraction used the deterministic keyword matcher; **LLM quality NOT TESTED** |
| Demo backend (port 4021) | **MOCK / loopback** | `provider=loopback`, `isLive:false`, `env=test`, disposable SQLite |
| Routing (OSRM/Google code paths) | **MOCK (default)** | no external contact; composed workflow labels `isLiveTraffic:false` |
| Hospital auto-selection | **DISABLED by default** | tests only |
| Corridor / police notification | **SIMULATED** | tests assert non-delivery; nothing sent |
| Location resolution | **UNCONFIGURED by default** | no geocoder contacted; operator confirmation only |
| Module 3 Python NLP | **NOT TESTED (live)** | opt-in test skipped |
| Dashboard browser (CDP/Edge) | **LIVE local demo** | `demo:verify` 32/32 |
| Module 11 database | **LIVE dev SQLite (WSL)** + isolated test DBs | migration applied; no production DB |

---

## 11. Failures and limitations encountered (with resolution)

| # | What happened | Resolution / status |
|---|---|---|
| 1 | First gated suite run exited 1 with identical passing counts | Not reproduced; second run and final run both EXIT 0 (logs kept) |
| 2 | Deployed WSL server lagged workspace source (`app.ts`, `espeakProvider.ts`, …) | Backup tarball → rsync → verify (deps identical, `.env` preserved) |
| 3 | Pending migration `20261027120000_ambulance_offer_expiry` missing in deployed DB | `prisma migrate deploy` — applied, exit 0 |
| 4 | **Live error:** `Unknown argument 'expiresAt' … Failed to find expired ambulance offers` (stale generated client) | `prisma generate` + restart → 0 errors afterwards |
| 5 | **Live defect:** transport reported `1 call leg(s) tracked` after caller-side hangup | Root-caused to early return in `asteriskProvider.hangup()`; fixed + regression test; re-verified live → 0 legs |
| 6 | `sox -n … pad 1.0` produced an infinite 4.38 GB file (null input is unbounded) | Script stopped, file deleted immediately, corrected to `trim`/`pad` on real input; disk healthy |
| 7 | `espeak-ng --wavrate=8000` unsupported in this build | Generate at default rate + `sox -r 8000` resample |
| 8 | baresip failed: `tcp: sock_bind … Invalid argument (af=10, IPv6)` | `-4` (IPv4 only) |
| 9 | My first hangup call used the emergency id → `CALL_NOT_FOUND` | Re-issued with the call-session id; call closed correctly (no duplicate calls opened) |
| 10 | Whisper quality: imperfect phrase renders, silence/ambient hallucinations (`[BLANK_AUDIO]`, ambient text accepted at conf. up to 0.91) | **Open limitation** — recognition gate not met; documented, not suppressed |
| 11 | LLM (ollama) unreachable | Deterministic heuristic fallback used and labelled by the server itself; **not** an LLM-quality result |
| 12 | Protocol validation warnings (3) | Critical escalation rules without `escalation_step` — open clinical item |

Nothing was bypassed, and no policy-blocked command was replaced with an alternative mechanism in
this run; where an operator-preferred command differs, the exact command is given in §6/§13.

---

## 12. Clinical, security, regulatory, and operational blockers

**Clinical**
- All five protocol catalogues are `UNREVIEWED` (validated structurally only: 0 errors / 3 warnings);
  sessions are served with `[UNREVIEWED]` attached. **Clinical review is a hard blocker** for any
  patient-facing use — nothing in this run reviews or approves clinical content.
- Whisper recognition quality is below any acceptability bar for clinical use (imperfect renders on
  known synthetic phrases; hallucinations on silence/ambient audio; canonical set historically 3/7).
- No human-confirmed audibility of instructions; no clinician in the loop for any observed session.
- Module 5 ran on a keyword heuristic because the LLM provider was unavailable — **not a language model**.

**Security**
- Dev-only credentials exist and are documented as such: SIP `1001`/dev password, AMI secret bound to
  `127.0.0.1:5038`, `POST /api/auth/dev-token` gated by `NODE_ENV !== production` (404 otherwise).
  None were printed in this run; `.env` values were redacted in all output.
- MicroSIP `autoAnswer=all` and open local endpoints are prototype-only; production must use header-based
  auto-answer and network isolation.
- Dashboard token handling verified: **0** entries in `localStorage`/`sessionStorage`.
- `pjsip set logger` may still be enabled from earlier debugging — run
  `asterisk -rx "pjsip set logger off"` after testing.

**Regulatory / safety**
- No clinical validation, no regulatory clearance, no survival-outcome claim exists or is implied.
  The dashboard's own copy asserts operator-reported milestones and an explicit no-outcome disclaimer
  (verified in-browser). Nothing here may be described as production-ready.

**Operational**
- Single-host WSL prototype: no HA, no observability stack, no load/failover testing, no backup/restore drill.
- Automatic dispatch, hospital auto-selection, external routing, corridor/police notification are all
  disabled/simulated; no real vehicle, hospital, or dispatcher integration exists.
- Driver app has no physical-device/GPS evidence.
- Module 3 live Python classifier and Module 4 legacy service are unverified.
- WSL lifecycle depends on `vmIdleTimeout=-1` plus a keeper process (`sleep 7200`, PID 625) — it will
  expire; asterisk and the RESUS service are systemd-managed and restart on distro boot.
- Four controlled test calls created rows in the live dev database
  (`CALL-5D2C0CB4AF0003`, `CALL-5399E6D3A70030`, `CALL-643B51AB580001`, `CALL-7A398432940016` with their
  `EMG-…` emergencies; Stage B is `isSimulation=true`, the inbound Stages C/D are not). **No destructive
  database action was taken**; IDs are listed for operator review only.

---

## 13. Startup / demo / shutdown runbook

### Start the live stack
```powershell
# 1. Ensure WSL is up
wsl -d Ubuntu -e bash -c "echo ok"
# 2. Asterisk + RESUS server (inside WSL; both are systemd units)
wsl -d Ubuntu -e bash -c "sudo -n systemctl start asterisk.service"
wsl -d Ubuntu -e bash -c "sudo -n systemctl start resus-server.service"
# 3. MicroSIP (Windows)
Start-Process -FilePath "F:\minor\MicroSIP\MicroSIP.exe"
```
### Verify ready
```bash
# inside WSL
curl -s http://127.0.0.1:4000/api/health                 # routes 75, 12 modules
curl -s http://127.0.0.1:4000/calls/transport/status      # asterisk, isLive true, 0 legs
curl -s http://127.0.0.1:4000/speech/status               # whisper+espeak isLive true
sudo -n asterisk -rx "pjsip show contacts"                # 1001 … Avail
```
### Controlled test call (local extension only)
```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:4000/api/auth/dev-token \
  -H 'Content-Type: application/json' \
  -d '{"email":"operator@resus.dev","role":"OPERATOR"}' | grep -oE '"token":"[^"]*"' | cut -d'"' -f4)
curl -s -X POST http://127.0.0.1:4000/calls -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"callerId":"1001","latitude":0,"longitude":0,"incidentType":"CARDIAC_ARREST","isSimulation":true}'
# take the returned session.id (CALL-…), then:
curl -s -X POST http://127.0.0.1:4000/calls/<CALL-ID>/hangup \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```
Inbound digital-media test: `wsl -d Ubuntu -e bash /mnt/c/Users/sanja/AppData/Local/Temp/opencode/resus-stageC.sh`
(baresip → ext 1000 with a known uplink WAV; artifacts under `/home/resus/siptest/stageC-20261027/`).
Keep the bearer token out of notes and logs.

### Demo (browser) stack — already running in this session
```powershell
# Terminal 1 — private credential log + demo backend on 4021 (see predecessor report §"Browser verification blocker")
$env:RESUS_DEMO_ISOLATED='true'; $env:DEMO_PORT='4021'
npm.cmd run demo:server *> $env:TEMP\resus-demo-server-4021-<guid>.log
# Terminal 2 — dashboard
$env:RESUS_DASHBOARD_PROXY_TARGET='http://127.0.0.1:4021'
npm.cmd run dev:web -- --port 5175 --strictPort
# Terminal 3 — verification
$env:DEMO_BASE_URL='http://127.0.0.1:4021'; $env:DEMO_DASHBOARD_URL='http://127.0.0.1:5175'
$env:DEMO_SERVER_LOG='<private log path>'; npm.cmd run demo:verify
```
Open `http://127.0.0.1:5175/`. Never open, paste, or publish the credential log.

### Stop (only what you started)
```powershell
Get-Process -Name MicroSIP -ErrorAction SilentlyContinue | Stop-Process -Force   # MicroSIP
Stop-Process -Id 23444,33700 -Force -ErrorAction SilentlyContinue               # demo backend + Vite from this session
wsl -d Ubuntu -e bash -c "sudo -n systemctl stop resus-server.service"
wsl -d Ubuntu -e bash -c "sudo -n asterisk -rx 'core stop now'"
```
The demo backend's documented graceful shutdown removes only its own disposable database. The live
WSL dev database is **not** reset by any documented stop step.

---

## 14. Final git status

```
HEAD     121d7933ae3edcd478089343fdc493f2757d2ad8
branch   main
status   71 modified, 102 untracked, 0 other
diff --stat (tracked)  71 files changed, 6888 insertions(+), 532 deletions(-)
git diff --check       exit 0 (existing LF/CRLF warnings only)
```
Full porcelain output: `%TEMP%\resus-final-git-status.txt`. Nothing was committed, stashed, reset, or
removed; all pre-existing work is intact.

---

## 15. Explicit non-claims

- This system is **not production-ready**, not clinically validated, not regulatory-cleared, and must
  not be used for real emergencies.
- No real emergency number was dialled; no real patient, ambulance, hospital, police, or dispatcher
  was contacted; no external notification or message was sent.
- Mock/simulated/loopback providers are labelled as such in §10; only Asterisk, whisper.cpp,
  eSpeak-ng, MicroSIP/baresip, the local dashboard browser, and the local dev database were live —
  and all within this machine.
- Acoustic (human) speech recognition and human-audible TTS were **not** verified this run.
- LLM output quality, Module 3 live classification, Module 4 legacy service, physical driver device/GPS,
  and external routing/hospital/location providers were **not** verified.
- All five protocol catalogues remain **UNREVIEWED**; the 3 validation warnings are open clinical items.
