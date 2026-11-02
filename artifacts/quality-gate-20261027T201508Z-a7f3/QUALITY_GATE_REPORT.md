# RESUS Quality Gate Report — Protocol Progression Fix, Separated Telephony Acceptance, Whisper Fidelity, and Live-Database Incident Recovery

| Field | Value |
|---|---|
| Generated (UTC) | 2026-10-27T20:15:08Z |
| Workspace | `F:\minor` |
| Branch / HEAD | `main` / `121d7933ae3edcd478089343fdc493f2757d2ad8` (unchanged) |
| Git state | **Nothing committed, pushed, reset or cleaned.** 71 modified / 103 untracked (103 = 102 pre-existing + 1 new test file) |
| Predecessor report | `artifacts/master-completion-20261027T175321Z-d267/QUALITY_GATE_REPORT.md` — **preserved unchanged**, 33 776 bytes, SHA-256 `32CABFBDE9C2FBAE76D154F1920C84DAABD24BE66D759840C73B435BC7ACE7D2` |
| Live stack | WSL `resus-server.service` (:4000), `asterisk.service` (Asterisk 22.5.2); demo backend :4021 and Vite :5175 untouched |
| Clinical content | **All 5 protocols remain `UNREVIEWED`.** No clinical instruction was created, edited or deployed; `git status -- modules/module_05_bystander_assistance/protocols` is empty |
| Production claim | **Not production-ready.** Audio, clinical, device and provider capabilities that were not proven are explicitly BLOCKED/UNVERIFIED in §6 |

---

## 1. Verification gate summary (this run)

| # | Gate | Command | Result | Exit |
|---|---|---|---|---|
| 1 | Targeted regression (fix) | `node .\node_modules\vitest\vitest.mjs run modules/module_05_bystander_assistance/tests/llm.test.ts modules/module_05_bystander_assistance/tests/sessionService.test.ts` | **2 files / 68 tests passed** (47 + 21) | 0 |
| 2 | New synthetic integration | `RESUS_RUN_ISOLATED_COMPOSITION_TEST=true … vitest.mjs run tests/protocolProgression.integration.test.ts` | **1 file / 3 tests passed** | 0 |
| 3 | Baseline suite (final, ungated) | `node .\node_modules\vitest\vitest.mjs run` | **93 files: 83 passed / 10 skipped · 887 tests: 818 passed / 69 skipped**, 120.98 s | 0 |
| 4 | Gated full suite (final) | `RESUS_RUN_ISOLATED_COMPOSITION_TEST/OUTCOME_TEST/OUTCOME_API_TEST/OUTCOME_GRANT_TEST/DASHBOARD_LIVE_TEST=true` + `node .\node_modules\vitest\vitest.mjs run` | **93 files: 92 passed / 1 skipped · 887 tests: 886 passed / 1 skipped**, 153.11 s | 0 |
| 5 | Typecheck | `npm run typecheck` | PASS (after fixing `TS2532` in the new test, see §5) | 0 |
| 6 | Lint | `npm run lint` | PASS — `✖ 50 problems (0 errors, 50 warnings)`, all pre-existing `@typescript-eslint/no-explicit-any` | 0 |
| 7 | Build | `npm run build` | PASS — `[build] ok` | 0 |
| 8 | Prisma schema | `npx prisma validate --schema modules/module_11_database_event_system/prisma/schema.prisma` | PASS — `The schema … is valid` | 0 |
| 9 | Protocol catalogue | `npm run protocols:validate` | PASS — **5 protocols, 33 steps, 0 errors, 3 warnings**, all `UNREVIEWED` | 0 |
| 10 | Caller-location suite | `node … vitest.mjs run tests/callerLocationResolution.test.ts` | **6/6 tests passed** | 0 |
| 11 | Flutter analyze | `flutter analyze` (in `apps/driver`) | PASS — `No issues found! (ran in 7.8s)` | 0 |
| 12 | Flutter test | `flutter test` (in `apps/driver`) | PASS — `All tests passed!` (4 tests) | 0 |
| 13 | Simulated E2E lifecycle | `npm run demo:verify` with `DEMO_BASE_URL=http://127.0.0.1:4021`, `DEMO_DASHBOARD_URL=http://127.0.0.1:5175` | **PASS — 32/32 checks**, `live dashboard verification succeeded` | 0 |
| 14 | Whitespace | `git diff --check` | PASS (only pre-existing `LF will be replaced by CRLF` warnings) | 0 |
| 15 | Live deployment health | `GET /api/health`, `/api/health/llm`, `/calls/transport/status`, `/speech/status` (WSL) | `status:ok` (75 routes, 12 modules); LLM degraded→fallback; Asterisk live; whisper+espeak live | 0 |

The only failure in the whole chain was gate 5 on its first attempt (`error TS2532` inside the new test file) — fixed, re-verified, and both suites re-run to completion afterwards (§5).

---

## 2. Files changed in this run (exactly four)

| File | Change |
|---|---|
| `modules/module_05_bystander_assistance/src/llm/heuristicProvider.ts` | Third `callerLocation()` pattern for the protocol's own question form; `VAGUE_LOCATION_WORDS` extended with non-answers (`unknown`, `not known`, `not sure`, `i don't know`, …); doc comments state ASR corruption is never repaired by guessing |
| `modules/module_05_bystander_assistance/tests/llm.test.ts` | +2 tests (answer-form extraction ×6 cases; vague/non-answer rejection ×7 cases) → 47 tests |
| `modules/module_05_bystander_assistance/tests/sessionService.test.ts` | +2 tests (`general-triage` `confirm-location → confirm-safety` advance; vague/unknown must NOT advance) → 21 tests |
| `tests/protocolProgression.integration.test.ts` | **New**, gated by `RESUS_RUN_ISOLATED_COMPOSITION_TEST`; 3 tests through the composed server |

Everything else in the working tree predates this run. Non-repository helper scripts were written only to `C:\Users\sanja\AppData\Local\Temp\opencode\*.sh`. **No protocol JSON, no Prisma schema, no application route or dashboard file was modified.**

---

## 3. Task results

### Task 1 — prior state preserved
Prior report re-read and hash-verified unchanged (§ header). No `git reset/clean/commit/push`, no unrelated files overwritten, no unrelated services terminated. The demo backend (PID 23444) and Vite dev server (PID 33700) were left running throughout.

### Task 2 — root cause of the non-advancing step, fix, and proof

**Two independent defects** (both must hold for a live call to stall):

1. **Extraction defect (fixed).** `confirm-location` (entry step of `general-triage`) gates on `caller_location exists`. The extractor only read `"I am at X"` / `"address is X"`, so the answer to the protocol's own question — *"What is the exact location…?"* → *"the exact location is building alpha, floor two, near the main gate"* — was dropped. Fix: a third pattern `/\b(?:(?:the|my|our|their)\s+)?(?:exact\s+)?location\s*(?:is\s*:|is|:)\s*(.{3,}?)(?:[.!?]|$)/i` that captures to the end of the sentence (comma-inclusive, 200-char cap) and rejects vague words *and* non-answers. Caller words stay verbatim; garbled ASR text is never pattern-matched into an address.
2. **ASR defect (measured, NOT fixed).** Live telephony evidence shows the same phrase transcribed as `"and a Mac location in building out a floor to their main gate."` (confidence 0.7000) — above the 0.45 floor, therefore accepted, therefore no pattern can legitimately match. The conservative behaviour is to ask again, which is what the system does.

**Proof of progression (automated):**
- Regression unit/session tests: **68/68 pass**, including `"the exact location is building alpha, floor two, near the main gate"` → `caller_location = "building alpha, floor two, near the main gate"` → `ADVANCED` → `confirm-safety`, and 7 non-answer utterances that must stay put.
- Synthetic integration test (composed server: real Fastify routes, real engine, real `HeuristicProvider`, real isolated SQLite): **3/3 pass** — reads the active provider back from `/api/health/llm` as `heuristic-fallback` (never assumed), proves `confirm-location → confirm-safety` `ADVANCED`, persisted session/step `COMPLETED`, `PROTOCOL_STEP_COMPLETED` event, CALLER→SYSTEM transcript order, `EMERGENCY_LOCATION_CANDIDATE` with `outcome:UNAVAILABLE` + `candidateLatitude/Longitude:null`, emergency coordinates unchanged; and proves a vague answer does **not** advance.

**Proof of progression (live, ASR-independent — HTTP probes against the deployed server):**

| Probe | Utterance | Result |
|---|---|---|
| address (post-restore 19:46Z) | `the exact location is building alpha, floor two, near the main gate` | `ADVANCED`, `confirm-location → confirm-safety`, verbatim fact, `degraded:true`, `escalationRequired:false`, `PROTOCOL_STEP_COMPLETED{stepId:confirm-location,nextStepId:confirm-safety}`, candidate `LOC-73ce2e0c…` `outcome:UNAVAILABLE provider:unconfigured candidateLatitude:null candidateLongitude:null`, emergency coords `12.9716/77.5946` unchanged — `EMG-887FEB35920001` / `PSE-9EAD41641F0005` |
| vague (post-restore 19:46Z) | `the exact location is here` | `CLARIFY`, stays `confirm-location`, no fact, **zero** candidate events, **zero** step events — `EMG-67F33E09230015` / `PSE-32DE93AEC80019` |

Both probe sessions were cancelled after capture. Live SIP calls (Stage E, below) still do **not** advance — correct, because ASR mangles the phrase before extraction sees it.

### Task 3 — telephony layers, separated acceptance results (Stage E)

Each layer measured on its own so one layer's result cannot hide behind another's. Synthetic only: espeak-ng ground truth, loopback SIP to extension `1000`, simulation-flagged emergencies. Workdir `/home/resus/siptest/stageE-20261027T191721Z`, log `%TEMP%\resus-stageE-run.log`.

| Layer | Evidence | Verdict |
|---|---|---|
| **L0 providers in use** | `speech:{provider:whisper,isLive:true}`, `synthesis:{provider:espeak,isLive:true}`, `minConfidence:0.45`, `transport:{provider:asterisk,isLive:true}`, `llm:{provider:ollama,model:qwen3:8b,available:false,…degraded:true,registered:[ollama,heuristic-fallback]}` | **Named, not assumed** |
| **L1 SIP signalling** | Before: `0 active channels`. During call: `PJSIP/emergency-0000000X 1000@resus-inbound:4 Up AudioSocket(uuid)` (1 active leg). After: `0 active channels`, `0 call leg(s) tracked` → no leg leak. Lifecycle `AudioSocket channel connected → inbound Asterisk call opened → emergency call closed` (durationMs 19 053 / 16 762). Dialplan `resus-inbound` 1000 → `NoOp/Set/Answer/AudioSocket(uuid,127.0.0.1:9092)/Hangup`. Asterisk 22.5.2. Endpoint `1001` shows contact `1001/sip:1001@127.0.0.1:50880;ob`, state *Not in use*; `pjsip show registrations` prints `No objects found` | **PASS** (call set-up/teardown, leg release) |
| **L2 audio transport** | callD uplink RMS 0.049129 / max 0.851318, downlink RMS 0.069556 / max 0.886597, 19.08 s. callE uplink RMS 0.038029, downlink RMS 0.075159 / max 0.886597, 16.78 s. 8 kHz mono 16-bit | **PASS** (measurable energy both directions) |
| **L3 speech recognition** | callD: truth `the exact location is building alpha, floor two, near the main gate` → ASR `"and a Mac location in building out a floor to their main gate."` conf **0.7000**, word accuracy **0.167**. callE: truth `the exact location is 12 main street` → `"and a Mac location in Well Main Street."` conf **0.6493**, word accuracy **0.143**. Systematic prefix mangling `and a Mac location in`, both above `minConfidence 0.45` → accepted as final | **FAIL (fidelity)** — capability works, quality does not |
| **L4 TTS playback** | `POST /speech/speak` → `{provider:"espeak", isLive:true, voice:"en-us", durationMs:5063, characterCount:78, isAudible:true, verbatimProtocolText:true, audio:81008 base64 chars ≈ 3.8 s @8 kHz}` | **PASS (synthesis capability, automated)** — human-audible listening **BLOCKED** (§6) |
| **L5 protocol over live call (ASR in path)** | callD `EMG-B39E0E8B800002`/`CALL-6EE9CA57CC0001`/`PSE-24606A2B6E0006`; callE `EMG-ACB755FAAD0017`/`CALL-A8513382FD0016`/`PSE-7C674D903A001B`. Both stay `confirm-location`, `clarificationCount:1`, `collectedFacts {notes,intent:OTHER}`, SYSTEM repeats the question verbatim | **No advancement — correct conservative behaviour** given the L3 failure |
| **L5b probes without ASR** | See Task 2 table (Stage E run at 19:19Z and post-restore run at 19:46Z both green) | **PASS** |

**Conclusion:** SIP, audio transport, TTS and protocol engine are accepted; the live end-to-end path fails only at speech-recognition fidelity, and the system's response to that failure is to re-ask, never to guess an address.

### Task 4 — controlled, repeatable Whisper investigation

Isolates ASR from transport: espeak-ng → 8 kHz mono s16 WAV (1.0 s lead / 3.0 s tail) → `POST /speech/transcribe` (the same HTTP entry the live path uses), 6 non-emergency phrases × 2 transcriptions each. Provider **read from the server, never assumed**: `whisper.cpp whisper-cli`, model `ggml-base.en.bin`, `WHISPER_CPP_LANGUAGE=auto`, `SPEECH_MIN_CONFIDENCE=0.45`, synthesis `espeak-ng`. Run `/home/resus/siptest/whisper-20261027T195445Z`, log `%TEMP%\resus-whisper-measure-2.log`.

| Id | Ground truth | ASR output | Conf | Band | Word accuracy (run 1 / run 2) | Latency s |
|---|---|---|---|---|---|---|
| P1 | the exact location is building alpha, floor two, near the main gate | `They have Mac location in building out a floor to their main gate.` | 0.738 | LOW | **0.167 / 0.167** | 2.29 / 1.92 |
| P2 | the weather is sunny and the train is running late today | `A winner in Tony and a traded running late to May.` | 0.580 | LOW | **0.182 / 0.182** | 1.89 / 1.92 |
| P3 | please bring a small blue umbrella to the garden gate | `Clean bring a small blue umbrella to garden gate` | 0.778 | HIGH | 0.800 / 0.800 | 1.83 / 1.82 |
| P4 | twelve main street | `Well, Main 3.` | 0.593 | LOW | **0.333 / 0.333** | 1.64 / 1.72 |
| P5 | the quick brown fox jumps over the lazy dog | `A quick brown hot jump over a rainy dog.` | 0.628 | LOW | 0.333 / 0.333 | 1.85 / 1.86 |
| P6 | my name is sam and I work at the central library | `My name is M and I work at the Central Library.` | 0.835 | HIGH | 0.818 / 0.818 | 1.85 / 1.93 |

**Aggregate:** 12 transcriptions, **0 exact matches, mean word accuracy 0.439**, all HTTP 200 `accepted:true`.

**Findings & limitations (documented, not papered over):**
1. **Repeatable:** identical transcript text for every phrase across independent transcriptions and across two separate measurement sessions; confidence varies only in the 4th decimal. The failure is *deterministic model behaviour*, not channel noise — the same systematic mangling of `the exact location is…` appears through the full SIP path (Stage E L3) and through the direct HTTP path.
2. **Confidence is miscalibrated:** 0.58–0.84 confidence on texts that are only 0.17–0.82 accurate; every result clears the 0.45 floor, so *garbage is accepted and recorded as final* (e.g. P2 at 0.58). The confidence floor therefore does not protect against wrong transcriptions.
3. **Short address phrases are worst** (P4 `twelve main street` → `Well, Main 3.`, accuracy 0.333) — precisely the input dispatch depends on.
4. **Bounded scope:** espeak-ng synthetic speech ≠ human speech; clean 8 kHz files with no packet loss, jitter or codec distortion (real calls can only be worse); one model (`ggml-base.en`), English only; no human speaker involved. These results are an *upper bound* on live accuracy, not a live-accuracy claim.
5. Active provider is Whisper (`ggml-base.en`); no LLM or heuristic substituted for any transcription step. On the extraction side the active provider is `ollama/qwen3:8b` **unavailable** (`Model 'qwen3:8b' is not pulled`) → the server reports `degraded:true` and runs `heuristic-fallback` (a deterministic keyword matcher, explicitly *not* a language model).

### Task 5 — caller-location resolution coverage (no fabricated coordinates)

- **Automated:** `tests/callerLocationResolution.test.ts` **6/6 pass** (ambiguous locations, missing data, provider uncertainty/timeout — each asserts the candidate path never invents a coordinate). Plus the new unit tests (vague/non-answer rejection ×7) and the integration test's `candidateLatitude:null, candidateLongitude:null` assertions.
- **Live evidence:** both probes (Stage E 19:19Z and post-restore 19:46Z) recorded `EMERGENCY_LOCATION_CANDIDATE` with `source:CALLER_STATED`, `provider:"unconfigured"`, `outcome:"UNAVAILABLE"`, `confidence:null`, `candidateLatitude:null`, `candidateLongitude:null`, while the emergency's own coordinates stayed exactly `12.9716 / 77.5946`. The vague probe produced **no candidate at all**.
- **Never fabricated:** the resolver in the deployment is `UnconfiguredCallerLocationResolver`; only a confirmed operator action through the authenticated routes (`POST /api/emergencies/:id/location-resolutions/:id/confirm`, roles `LOCATION_OPERATORS`) can attach a coordinate, and no test or probe performed one.

### Task 6 — simulated E2E lifecycle re-run
`npm run demo:verify` (demo backend :4021, Vite :5175, Edge/CDP) → **32/32 checks passed**, `live dashboard verification succeeded`, exit 0 — covering authenticated browser rendering of emergencies, fleet freshness, operator-reported lifecycle milestones, ambulance offers with expiry, evidence semantics, token-not-persisted, and browser console/network cleanliness (0 unexpected JS/console/network errors).

### Task 7 — clinical protocols
`npm run protocols:validate` → **5 protocols, 33 steps, 0 errors, 3 warnings**, exit 0; every protocol `review_status=UNREVIEWED`:

| Protocol | Steps | Status | Warnings |
|---|---|---|---|
| cardiac-arrest-adult@1.0.0 | 9 | UNREVIEWED | — |
| choking-adult@1.0.0 | 7 | UNREVIEWED | `unresponsive-choking-patient` CRITICAL but names no `escalation_step` |
| general-triage@1.0.0 | 6 | UNREVIEWED | — |
| severe-bleeding@1.0.0 | 6 | UNREVIEWED | — |
| active-seizure@1.0.0 | 5 | UNREVIEWED | `status-epilepticus-risk` and `repeated-seizures` CRITICAL but name no `escalation_step` |

The live API serves the same state (`GET /api/protocols` → `reviewStatus: UNREVIEWED` ×5). **Human override is required:** the public utterance route deliberately accepts no `forceEscalationReason`; escalation is an operator action behind the authenticated `POST /api/protocol-sessions/:id/escalate` role check, and the 3 warnings above mean those CRITICAL rules may not voice an escalation instruction to the bystander — all three must be resolved by a clinician before any clinical use. No clinical text was created, edited or deployed in this run (`git status` over `protocols/` is empty).

### Task 8 — Flutter driver app
`flutter` 3.41.2 stable available. `flutter analyze` → **No issues found** (exit 0). `flutter test` → **All tests passed** (4 tests, `apps/driver/test/widget_test.dart` + `driver_contracts_test.dart`), exit 0. Devices: `Windows (desktop)` and `Edge (web)`; one Android emulator available (`Medium_Phone_API_36.1`) but not launched; **no physical Android device connected**. On-device UI interaction was therefore **NOT TESTED** — manual instructions in §10.

### Task 9 — complete verification chain (final order)
1. Baseline suite → **83/818 passed, 10/69 skipped, exit 0** (120.98 s) — log `%TEMP%\resus-baseline-final-20261028.log`
2. Gated suite (5 flags) → **92/886 passed, 1/1 skipped, exit 0** (153.11 s) — log `%TEMP%\resus-gated-final-20261028.log` (single skip = `tests/module3Classifier.live.test.ts`, unchanged from predecessor)
3. `npm run typecheck` → exit 0
4. `npm run lint` → exit 0 (0 errors / 50 pre-existing warnings)
5. `npm run build` → exit 0
6. `npx prisma validate --schema …` → exit 0
7. `npm run protocols:validate` → exit 0 (5/33/0/3)
8. Flutter `analyze` + `test` → exit 0 / exit 0
9. `npm run demo:verify` → 32/32, exit 0
10. `git diff --check` → exit 0
11. Live health snapshot (WSL) → §15 of the table above

Steps 3–10 were re-run **after** the final source edit (§5), so the chain reflects the final tree.

### Task 10 — new report
This file: `artifacts/quality-gate-20261027T201508Z-a7f3/QUALITY_GATE_REPORT.md`. The predecessor report was not overwritten.

---

## 4. Live-database incident: cause, evidence, recovery, prevention

**This incident was caused by this run's deployment step and is disclosed here in full.**

### 4.1 What happened
The WSL deployment sync (`tar` backup + `rsync -a`, no `--delete`) copied **source** from `F:\minor` to `/home/resus/resus`. The workspace contains a stale `modules/module_11_database_event_system/prisma/dev.db` (602 112 bytes, mtime **2026-10-04**, 4 applied migrations) and the rsync exclusion list covered `*.sqlite*` but **not `*.db`** — so at ≈19:07Z the live runtime database (729 088 bytes, **11 applied migrations**) was overwritten by the stale file.

### 4.2 Evidence
| Check | Pre-sync backup (tar taken **19:06:45Z**, before rsync) | Live DB after the sync |
|---|---|---|
| `_prisma_migrations` rows | **11** (last: `20261027120000_ambulance_offer_expiry`) | **4** (last: `20261004121453_add_driver_assignment`) |
| `ambulance_assignments.expiresAt` | present | **missing** |
| Stage D emergency `EMG-19DC93E7620017` | present (+3 transcripts) | **absent** |
| `PRAGMA integrity_check` | `ok` | — |

Prisma's own error names the mechanism: `` Invalid this.db.ambulanceAssignment.findMany() invocation … The column `main.ambulance_assignments.expiresAt` does not exist in the current database. `` → surfaced as `DATABASE_FAILURE "Failed to find expired ambulance offers"` from `ambulanceRepository.ts:583`, logged once per sweep cycle.

**Timeline (journal):** migrations 5–11 were applied at **17:20:21Z** (the earlier deploy step); sweep errors 17:20:29–17:21:04 then went silent while the schema was correct; the sync overwrote the DB at ≈19:07Z; errors resumed at **19:09:42Z** and repeated continuously until recovery. The errors are therefore *not* caused by this run's code changes, but the schema regression that re-exposed them *was* caused by this run's sync.

### 4.3 Recovery (19:44–19:47Z, service stopped for the swap)
1. Extracted `prisma/dev.db` from the pre-sync backup tar → `PRAGMA integrity_check` = `ok`, 11 migrations, `expiresAt` present, Stage D row + 3 transcripts present, 64 emergencies / 260 events — verified **before** trusting it.
2. Stopped `resus-server.service`, moved the clobbered file aside as **`dev.db.postincident-20261027T194440Z`** (kept, not deleted), installed the restored file.
3. Restarted and verified: `resus-server` active, `/api/health` 200, 11 migrations incl. `20261027120000_ambulance_offer_expiry`, `expiresAt` present, Stage D row back, sweep query returns 0 rows.
4. **Zero `error`-level journal lines since 19:45:00Z** (verified twice: at 19:45 and at the 20:12 snapshot — `offer_sweep_errors=0`, `other_error_lines=0`).
5. Re-ran both progression probes post-restore (Task 2 table) and re-ran the Whisper measurement — all green; DB writable (emergencies 64 → 68 after 4 new synthetic rows).

**No data was permanently lost:** everything destroyed by the overwrite came back from the backup taken before the sync, and every row created *during* the incident window (Stage E calls `EMG-B39E0E8B800002`, `EMG-ACB755FAAD0017`, probes `EMG-E6AAD8F22E002B`, `EMG-2EDD698EAD003F` + 6 transcripts) is preserved in the kept `dev.db.postincident-20261027T194440Z` copy (verified by query).

### 4.4 Prevention
`resus-sync-fix.sh` now excludes **every database artifact** (`*.db`, `*.db-journal`, `*.db-wal`, `*.db-shm`, `dev.db.*`, `*.sqlite*`) — databases are runtime state, never source — and prints a source/destination size guard for the two known DB files after each sync. The backup tar step (which contains the live DB) is retained as the recovery path.

---

## 5. Regressions, failures and count reconciliation

| Item | Detail | Status |
|---|---|---|
| `npm run typecheck` first attempt | `error TS2532: Object is possibly 'undefined'` at `tests/protocolProgression.integration.test.ts(280,12)` — index access on `candidates[0]` in my new test | **Fixed** (`candidates[0]!.payload`), typecheck exit 0, the gated test re-run 3/3, both full suites re-run to completion afterwards |
| Baseline counts vs predecessor | Predecessor: 83 files/813 passed + 9/66 skipped; **this run: 83 files/818 passed + 10/69 skipped**. Deltas: **+4** = my new regression tests (`llm.test.ts` ×2, `sessionService.test.ts` ×2); **+1 skipped file / +3 skipped tests** = the new gated `tests/protocolProgression.integration.test.ts`; the residual **+1 passed test** reconciles against the predecessor's own totals — its baseline summed to 879 tests while its gated run summed to 880; this run's baseline and gated totals both sum to **887 = 880 + 7 new tests** | Reconciled, no unexplained test loss |
| Gated counts vs predecessor | Predecessor: 91+1 files / 879+1 tests → **this run 92+1 files / 886+1 tests** = +4 unit +3 integration tests | Expected |
| Assertions weakened / failures excluded | **None.** No test was skipped, deleted or loosened; the only source-of-truth change is the extraction fix, which is covered by new assertions in both directions (must-advance and must-not-advance) | Clean |
| First `demo:verify` attempt | `ECONNREFUSED 127.0.0.1:4000` — the script defaults to :4000/:5173 while the predecessor's run used the isolated demo backend | Re-run with the predecessor's exact env (`DEMO_BASE_URL=:4021`, `DEMO_DASHBOARD_URL=:5175`) → 32/32, exit 0 |
| First `whisper` measurement run | Latency column garbage (`date +%s%3N` arithmetic) | Timing moved to curl `time_total` and the whole measurement re-run; accuracy results identical across both runs |
| Database incident | §4 — caused by this run's sync, fully recovered, disclosed | Recovered + prevented |

---

## 6. Explicitly BLOCKED / UNVERIFIED (never described as production-ready)

| Capability | Status | Exact blocker |
|---|---|---|
| **Human-audible two-way audio** | **BLOCKED** | Headless environment: no human has listened to the TTS output or spoken into the call path. `isAudible:true` is the *provider's own* flag, not human evidence. Manual test script in §10. |
| **Live protocol progression over the telephony path** | **BLOCKED by ASR fidelity** | Whisper mangles the location phrase deterministically (0.167/0.143 word accuracy through the SIP path, 0.439 mean over 6 phrases on the direct path); the system correctly re-asks instead of guessing. Engine/extraction progression is proven by the integration test and live HTTP probes. |
| **Live LLM** | **DEGRADED / UNVERIFIED** | `ollama` provider configured, `qwen3:8b` not pulled (`available:false`, `degraded:true`); `heuristic-fallback` (deterministic keyword matcher, **not a language model**) is active and reported as such by `/api/health/llm`. |
| **Clinical safety of protocols** | **UNREVIEWED** | All 5 protocols `reviewStatus:UNREVIEWED`; 3 CRITICAL escalation warnings (§7); human clinician review + operator override required. |
| **Physical driver-app UI** | **NOT TESTED** | No Android device connected; emulator available but launching + interactive verification not performed (§10 manual steps). Only `analyze`/`test` were run. |
| **Live emergency dispatch / notifications** | **NOT EXERCISED (by design)** | No real phone numbers, no driver/police/corridor notifications, no real dispatch; every emergency this run used `isSimulation:true` and every probe session was cancelled after evidence capture. |
| **Caller-location → coordinates** | **UNAVAILABLE by design** | Resolver is unconfigured: candidates are recorded `outcome:UNAVAILABLE` with null coordinates; only an authenticated operator confirm can attach one. No coordinate was ever invented. |
| **Live Python NLP classifier (Module 3)** | **NOT TESTED** | Single pre-existing opt-in suite skip (`tests/module3Classifier.live.test.ts`), unchanged from the predecessor report. |

---

## 7. Automated vs human verification

**Automated evidence (all reproducible, exact commands in §1 and §8):** fix regression tests 68/68; synthetic integration 3/3; baseline 818 passed / 69 skipped; gated suite 886 passed / 1 skipped; typecheck; lint 0 errors; build; `prisma validate`; `protocols:validate` 5/33/0/3; `callerLocationResolution` 6/6; Flutter analyze+test; `demo:verify` 32/32; `git diff --check`; live health/LLM/transport/speech endpoints; Stage E separated layer measurements (SIP/audio/ASR/TTS); controlled Whisper measurement (12 transcriptions); live progression probes with persisted events; DB restore verification + zero-error journal checks.

**Human verification performed: none.** Specifically *not* human-verified: audibility/intelligibility of TTS output, speaking and understanding a live call, clinical correctness of any protocol, physical-device UI, real telephony interconnection, and any production claim. Where a human is required, §10 gives the exact manual steps and the result of each step is to be recorded by that human — no automated output in this report stands in for them.

---

## 8. Exact commands (this run, Windows PowerShell unless noted)

```powershell
# 1 targeted regression (after the fix)
node .\node_modules\vitest\vitest.mjs run modules/module_05_bystander_assistance/tests/llm.test.ts modules/module_05_bystander_assistance/tests/sessionService.test.ts
# 2 synthetic integration (gated)
$env:RESUS_RUN_ISOLATED_COMPOSITION_TEST='true'
node .\node_modules\vitest\vitest.mjs run tests/protocolProgression.integration.test.ts
# 3 baseline
node .\node_modules\vitest\vitest.mjs run
# 4 gated full suite
$env:RESUS_RUN_ISOLATED_COMPOSITION_TEST='true'; $env:RESUS_RUN_ISOLATED_OUTCOME_TEST='true'
$env:RESUS_RUN_ISOLATED_OUTCOME_API_TEST='true'; $env:RESUS_RUN_ISOLATED_OUTCOME_GRANT_TEST='true'
$env:RESUS_RUN_DASHBOARD_LIVE_TEST='true'
node .\node_modules\vitest\vitest.mjs run
# 5-10 chain
npm run typecheck
npm run lint
npm run build
npx prisma validate --schema modules/module_11_database_event_system/prisma/schema.prisma
npm run protocols:validate
# 11 caller-location suite
node .\node_modules\vitest\vitest.mjs run tests/callerLocationResolution.test.ts
# 12-13 flutter (in apps\driver)
flutter analyze
flutter test
# 14 demo lifecycle (predecessor's exact env)
$env:DEMO_BASE_URL='http://127.0.0.1:4021'; $env:DEMO_DASHBOARD_URL='http://127.0.0.1:5175'
$env:DEMO_SERVER_LOG=(Join-Path $env:TEMP 'resus-demo-server-4021-3e44a84facc04a1ab2429de08d640cee.log')
npm run demo:verify
# 15 whitespace + git
git diff --check
git rev-parse HEAD
```

```bash
# WSL: live evidence + recovery (each run inside one session — see §11)
wsl bash /mnt/c/Users/sanja/AppData/Local/Temp/opencode/resus-stageE.sh          # separated layers + probes
wsl bash /mnt/c/Users/sanja/AppData/Local/Temp/opencode/resus-db-incident.sh     # overwrite confirmation
wsl bash /mnt/c/Users/sanja/AppData/Local/Temp/opencode/resus-db-restore.sh      # restore + verification
wsl bash /mnt/c/Users/sanja/AppData/Local/Temp/opencode/resus-probe-postrestore.sh
wsl bash /mnt/c/Users/sanja/AppData/Local/Temp/opencode/resus-whisper-measure.sh # controlled ASR measurement
wsl bash /mnt/c/Users/sanja/AppData/Local/Temp/opencode/resus-final-snapshot.sh  # final live state
```

---

## 9. Logs and evidence artifacts

- Windows (`%TEMP%`): `resus-baseline-final-20261028.log`, `resus-gated-final-20261028.log`, `resus-baseline-20261028.log`, `resus-gated-suite-20261028.log`, `resus-t1.log`, `resus-prog-3.log`, `resus-typecheck-20261028{,b}.log`, `resus-lint-20261028.log`, `resus-build-20261028.log`, `resus-callerloc.log`, `resus-demo-verify-20261028.log`, `resus-stageE-run.log`, `resus-stageE-diag.log`, `resus-stageE-errors.log`, `resus-db-incident-run.log`, `resus-db-timeline-run.log`, `resus-db-restore-run.log`, `resus-probe-postrestore.log`, `resus-whisper-measure{,-2}.log`, `resus-final-snapshot.log`, `resus-sync-fix.log`
- WSL: `/tmp/resus-stageE*.log`, `/tmp/resus-db-*.log`, `/tmp/resus-probe-postrestore.log`, `/tmp/resus-whisper-measure.log`, `/tmp/resus-final-snapshot.log`
- WSL evidence dirs: `/home/resus/siptest/stageE-20261027T191721Z` (per-call uplink/downlink WAVs + truth text), `/home/resus/siptest/whisper-20261027T195445Z` (input WAVs + `results.tsv`), `/home/resus/siptest/probe-postrestore-20261027T194656Z`
- Database artifacts: `/home/resus/resus-deploy-src-backup-20261027T190645Z.tar.gz` (pre-sync backup), `…/prisma/dev.db.postincident-20261027T194440Z` (clobbered copy, kept for forensics), `/home/resus/resus-db-restore-20261027T194440Z/` (extracted good DB)

---

## 10. Manual instructions where a human (or device) is required

### A. Human-audible two-way audio test (clears the §6 BLOCKED item)
1. Start the stack inside one WSL session: `wsl -e bash -lc 'sudo systemctl start asterisk resus-server; sleep 4; systemctl is-active asterisk resus-server; curl -s http://127.0.0.1:4000/api/health'` → expect `active active` and `{"status":"ok"…}`. (The WSL instance powers itself off ≈30 s after the last session ends, so keep everything in one session.)
2. Start MicroSIP on Windows (extension `1001`; the PBX last saw contact `1001/sip:1001@127.0.0.1:50880;ob`).
3. Place a call to the **test** extension `sip:1000@127.0.0.1` (loopback only — never a real number).
4. **Listen:** do you hear the protocol question spoken by espeak? Is it intelligible? Record what you actually hear, verbatim.
5. **Speak:** say `the exact location is building alpha, floor two, near the main gate`. In the operator console check `GET /api/emergencies/:id/transcripts` — was your speech transcribed correctly, and did the session step advance?
6. Repeat with `twelve main street` (expected per Task 4: likely mis-transcribed → system must re-ask, not guess).
7. Hang up; cancel any leftover session: `POST /api/protocol-sessions/:id/cancel` with `{"reason":"manual audio test complete"}`.
8. Record the three outcomes: (a) TTS audibility, (b) ASR accuracy, (c) protocol advancement. Until a human records (a), two-way audio stays **BLOCKED**.

### B. Physical driver-app UI (clears the §11 NOT TESTED item)
1. Connect an Android device with USB debugging, **or** `flutter emulators --launch Medium_Phone_API_36.1`.
2. `cd apps\driver` → configure the backend base URL for your environment → `flutter run -d <device-id>`.
3. Exercise login → available/assigned status → milestone screen, capture screenshots, and confirm API errors surface as UI messages.
4. Optionally `flutter drive --driver=test_driver/app_driver.dart --target=lib/main.dart` for scripted UI.

### C. Clinical review (clears UNREVIEWED)
Have a clinician review the 5 protocols and resolve the 3 CRITICAL escalation warnings (§7), then set `review_status` accordingly. Nothing in this repository changes that status without that human step.

---

## 11. Environment notes

- **WSL service cycling (pre-existing, not caused by this run):** `systemd-logind` powers the WSL instance off ≈30 s after the last session ends (`The system will power off now!` in the journal — observed as early as 06:47/07:48/10:29/15:19 today), and a fresh systemd boots on the next `wsl` command, starting `resus-server` + `asterisk` (`WantedBy=multi-user.target`). Kernel uptime persists across these cycles. Consequence: all live checks must run inside a single `wsl` invocation, and SIP registrations drop while idle — this explains `No objects found` in `pjsip show registrations` between calls.
- Active providers at snapshot (2026-10-27T20:12Z): LLM `ollama/qwen3:8b` unavailable → `heuristic-fallback` (degraded, logged); ASR `whisper` (`ggml-base.en`) live; TTS `espeak` live; transport `asterisk` live with 0 call legs; `minConfidence 0.45`.
- Runtime DB: `DATABASE_URL=file:./dev.db` resolved by Prisma relative to the schema → `/home/resus/resus/modules/module_11_database_event_system/prisma/dev.db` (11 migrations, integrity ok, 0 errors since restore).
