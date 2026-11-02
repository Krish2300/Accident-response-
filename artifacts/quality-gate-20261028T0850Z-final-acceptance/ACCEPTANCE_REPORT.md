# RESUS — Final Software Acceptance Report

**Generated (UTC):** 2026-10-28T08:50Z  
**Workspace:** `F:\minor` · branch `main` · HEAD `121d7933ae3edcd478089343fdc493f2757d2ad8` (unchanged)  
**Scope:** Final acceptance pass on the existing workspace. No file was reset, cleaned, committed or pushed. Every modified/untracked file and all prior reports are preserved.

> **Verdict — academic/engineering prototype, NOT production-validated.**  
> The *simulated software workflow* is accepted and fully proven. Real-world clinical, telephony-integration, physical-device and live-LLM capabilities remain **BLOCKED/UNVERIFIED** (§6). No clinical protocol has been marked reviewed. This report does not assert production readiness.

---

## 1. Acceptance decision

| Area | Status | Basis |
|---|---|---|
| Simulated end-to-end workflow | **ACCEPTED** | §5 demo 32/32 + §4 gated suite |
| Database integrity & migration state | **ACCEPTED (restored runtime DB)** | §3 |
| Safety: fallback naming, no fabrication, escalation/override | **ACCEPTED** | §4 safety probes |
| Protocol progression (engine/extraction) | **ACCEPTED** | §4 probes (advance + no-advance) |
| Live telephony: signalling/media/teardown (automated) | **ACCEPTED (automated layers only)** | §6 — carried from Stage E; **no new human call test this pass** |
| Speech-recognition fidelity | **BLOCKED** | §6 — Whisper quality unchanged |
| Live LLM | **UNVERIFIED (degraded fallback active)** | §4, §6 |
| Clinical protocol content | **UNREVIEWED** | §7 — all 5 protocols |
| Human-audible audio, physical device UI | **UNVERIFIED** | §6 |

**Human call test this pass: NOT performed.** No qualified human operator was available to listen/speak during this automated pass. The human-audible two-way audio gate therefore stays **BLOCKED**; §8A gives the exact manual steps.

---

## 2. What changed this pass (no product code edited)

This pass edited **no** source, test, protocol or config file. The only writes were:
- Deleted one temporary debug artifact I had created earlier in the repo root during Vite diagnosis (`resus-dashlive-repro.mjs`); it was linted out and removed. Its removal restored lint to 0 errors.
- Two throwaway diagnostic shell/mjs scripts written **outside** the repo under `%TEMP%\opencode\`.

Git state is identical to the prior report: **71 modified, 103 untracked**, HEAD unchanged, nothing staged/committed/pushed.

---

## 3. Database integrity status (rule 3 — verified, no writes)

Two distinct databases exist; neither was written to during this pass.

**(a) Workspace `dev.db` (the file whose rsync caused the prior incident)**  
- Path: `modules/module_11_database_event_system/prisma/dev.db`, `DATABASE_URL="file:./dev.db"`  
- Size 602 112 B, **mtime 2026-10-04 17:45** — this is the *stale pre-incident* file; it was **not** re-synced, **not** overwritten, **not** migrated this pass. No backup was needed because no write was performed against it.

**(b) Restored live runtime DB (WSL deployment, `/home/resus/resus/.../prisma/dev.db`)** — verified read-only:
- `PRAGMA integrity_check` = **ok**
- Migrations = **11**, incl. `20261027120000_ambulance_offer_expiry` (applied)  
- `ambulance_assignments.expiresAt` column present  
- Emergencies = **70**, Stage D row `EMG-19DC93E7620017` present  
- Post-incident forensic copy `dev.db.postincident-*` still retained (1)  
- **0 error-level journal lines** for `resus-server.service` since the last known-good marker (2026-10-27 19:45Z)

**Operator note:** the restored runtime DB (11 migrations) and the stale workspace `dev.db` (4 migrations, Oct-04 mtime) are intentionally different files. The sync guard that excludes `*.db*` remains the control that prevents the workspace copy from clobbering the runtime DB. No migration/reset was run this pass.

---

## 4. Safety & fallback — proven this pass

Probes executed against the live local stack (synthetic, loopback, simulation-flagged, cancelled after capture).

**4.1 Fallback is explicitly identified (never silently substituted)**  
`/api/health/llm` returns: `provider=ollama`, `available=false`, `degraded=true`, `reason="Model 'qwen3:8b' is not pulled"`, `registered=["ollama","heuristic-fallback"]`, `fallbackEnabled=true`.  
The **primary provider is named as `ollama`** and the active fallback is **named `heuristic-fallback`** — the system reports both the unavailable real LLM and the deterministic fallback in use. No heuristic is ever presented as an LLM.

**4.2 Uncertainty never fabricates facts or unsafe actions**  
- **Vague location** → `action=CLARIFY`, `currentStep` unchanged (`confirm-location` → `confirm-location`), `caller_location=null`, `location-resolutions` = `{"items":[]}` (no candidate, no invented coordinates), emergency coords unchanged at `12.9716 / 77.5946`. (`EMG-A3FC8583B70001` / `PSE-45C613B64C0005`)  
- **Low-confidence ASR** is discarded below `minConfidence=0.45` (speech floor unchanged).  
- **Missing/uncertain info** triggers re-prompt, never a guessed fact.

**4.3 Protocol progression — correct step, both directions**  
- **Known answer advances the right step:** `the exact location is building alpha, floor two, near the main gate` → `action=ADVANCED`, `confirm-location` → **`confirm-safety`**, verbatim `caller_location` recorded. (`EMG-A07714CE1E0011` / `PSE-197C89CBEB0015`)  
- **Vague/garbled answer is not accepted as a fact** (4.2). ASR accuracy and protocol progression are kept as **separate** results (§6).

**4.4 Human escalation & override path**  
- `POST /api/protocol-sessions/:id/escalate` exists and is operator-gated: anonymous request → **HTTP 401**.  
- Operator `cancel`/`escalate` override routes confirmed working; both probe sessions were cancelled (no lingering open sessions).  
- **No new clinical instruction was authored or approved** (§7).

**4.5 Zero leaked call legs** — transport reports `0 call leg(s) tracked` before and after all probes.

---

## 5. End-to-end synthetic workflow — proven

`npm run demo:verify` (isolated demo backend :4021 + Vite :5175, disposable SQLite, Edge/CDP browser) → **32/32 checks passed, exit 0**. Covers: intake, incident/session persistence, structured facts, location resolution, ambulance eligibility/assignment, offer expiry fixture (future expiry, simulated), driver status + GPS freshness, route provenance (mock, non-live), all four operator-reported lifecycle milestones, dashboard projection & browser rendering, idempotent duplicate milestone, role/authorization denials (403/401/404/422), learning-sample isolation, and a clean browser console (0 unexpected JS/console/network errors; only expected rejected-sign-in 401 and superseded-fetch cancellations).

**Failure cases exercised:** unavailable/ambiguous location (no candidate, CLARIFY) · rejected sign-in (401) · unknown emergency (404) · unknown milestone (422) · driver cannot record milestones (403) · premature route (409) · duplicate milestone (idempotent 200).  
**Provider timeout / call disconnect:** covered by the gated suite's owned-isolated-DB event tests (event-write failure rollback, post-commit retry, fail-closed authorization) and the loopback transport's hangup path — not by a live telephony disconnect this pass.  
**Isolation from real dispatch:** every record is `isSimulation=true`/`NODE_ENV=test`, loopback transport, disposable DB, no real numbers, no police/corridor/dispatch triggered.

**Full verification chain (final):**
| Gate | Result | Exit |
|---|---|---|
| Baseline suite | 93 files: **83 passed / 10 skipped** · 887 tests: **818 passed / 69 skipped** | 0 |
| Gated suite (5 flags) | 93 files: **92 passed / 1 skipped** · 887 tests: **886 passed / 1 skipped** | 0 |
| `npm run typecheck` | clean | 0 |
| `npm run lint` | **0 errors**, 50 pre-existing `no-explicit-any` warnings | 0 |
| `npm run build` | `[build] ok` | 0 |
| `npx prisma validate` | schema valid | 0 |
| `npm run protocols:validate` | 5 protocols / 33 steps / 0 errors / 3 warnings | 0 |
| `flutter analyze --no-pub` | No issues found | 0 |
| `flutter test` | All tests passed (4) | 0 |
| `npm run demo:verify` | **32/32** | 0 |
| `git diff --check` | clean (LF/CRLF warnings only) | 0 |

**Transparency note — the one failure seen and how it was resolved (not hidden):** the first gated run today failed **1/887**: `tests/dashboardLiveProxy.integration.test.ts` threw `ECONNRESET` fetching `/src/main.tsx` from the Vite dev server. Root cause: the machine had **rebooted ~30 min earlier** (13:16 local), killing all services and cold-starting Vite's dep-optimizer, which logged "Re-optimizing dependencies". I did **not** weaken the test. I (a) reproduced the exact harness standalone — it served `/src/main.tsx` in 23 ms once warm, proving no logic break; (b) re-ran the single test in isolation after warm-up — **PASS**; (c) re-ran the **full** gated suite — **886 passed / 1 skipped, exit 0**. Same test, same assertions, no exclusions.

---

## 6. Explicitly BLOCKED / UNVERIFIED (never claimed as passing)

| Capability | Status | Exact blocker / required human action |
|---|---|---|
| **Human-audible two-way audio** | **BLOCKED** | No qualified human listened/spoke this pass. `isAudible`/`durationMs` are provider flags, not human evidence. → §8A |
| **Live telephony end-to-end (ASR in path)** | **BLOCKED by ASR fidelity** | Whisper deterministically mangles the location phrase (measured word accuracy 0.167/0.143 live; 0.439 mean over 6 phrases direct). Signalling, media both directions, teardown and zero-leaked-legs are accepted (automated layers, Stage E); the human intelligibility + recognized-answer advancement over a **real call** is unverified. → §8A |
| **Speech-recognition fidelity** | **BLOCKED** | Unchanged this pass; confidence miscalibrated (garbage accepted above 0.45 floor). Requires a better model/threshold policy decision. |
| **Live LLM** | **UNVERIFIED (degraded)** | `ollama/qwen3:8b` not pulled; deterministic `heuristic-fallback` active and **named**. → `ollama pull qwen3:8b` to enable real-LLM verification |
| **Clinical protocol content** | **UNREVIEWED** | All 5 protocols `reviewStatus=UNREVIEWED`, 3 CRITICAL escalation warnings. Needs qualified clinician review. §7 |
| **Physical driver-app UI** | **UNVERIFIED** | Only `flutter analyze`/`flutter test` run; no Android device/emulator interaction. → §8B |
| **Caller-location → coordinates** | **UNAVAILABLE by design** | Resolver unconfigured; candidates recorded `UNAVAILABLE` with null coords; only authenticated operator confirm attaches one. No coordinate ever invented. |
| **Live dispatch / notifications** | **NOT EXERCISED (by design)** | No real numbers, no driver/police/corridor dispatch; all records simulation-flagged. |
| **Live Module 3 NLP classifier** | **NOT TESTED** | Pre-existing single opt-in skip, unchanged. |

---

## 7. Clinical protocols — unchanged, unreviewed

All **5 protocols (33 steps)** remain **`UNREVIEWED`**; validation passes with **0 errors / 3 warnings** and the live API serves `reviewStatus=UNREVIEWED` ×5. The 3 CRITICAL escalation warnings (rules naming no `escalation_step`): `active-seizure` → `status-epilepticus-risk`, `repeated-seizures`; `choking-adult` → `unresponsive-choking-patient`. These require a **qualified clinician** to resolve and a documented **human override**; none was created, edited or approved this pass (`git status` over `protocols/` is clean of new edits). The public utterance route accepts no force-escalation; escalation is an operator action behind an authenticated role check.

---

## 8. Exact manual steps where a human/device/provider is required

**A. Human-audible two-way audio + recognized-answer advancement over a real call (clears §6 BLOCKED items)**  
1. In one WSL session: `sudo systemctl start asterisk resus-server; systemctl is-active asterisk resus-server; curl -s http://127.0.0.1:4000/api/health` → `active active`, `{"status":"ok"...}`. (The WSL instance powers off ~30 s after the last session; keep it in one session.)  
2. Start MicroSIP (extension `1001`) on Windows.  
3. Call the **test** extension `sip:1000@127.0.0.1` (loopback only — never a real number).  
4. **Listen:** is the espeak TTS question intelligible? Record what you actually hear, verbatim.  
5. **Speak:** `the exact location is building alpha, floor two, near the main gate`. Check `GET /api/emergencies/:id/transcripts` — correct transcription? Did the step advance `confirm-location → confirm-safety`?  
6. Repeat with `twelve main street` (expected: mis-transcribed → system must re-ask, not guess).  
7. Hang up; cancel any leftover session (`POST /api/protocol-sessions/:id/cancel`).  
8. Record three outcomes: (a) TTS audibility, (b) ASR accuracy, (c) protocol advancement. Until a human records (a), two-way audio stays **BLOCKED**.

**B. Physical driver-app UI (clears §6 NOT TESTED)**  
1. Connect an Android device (USB debugging) **or** `flutter emulators --launch Medium_Phone_API_36.1`.  
2. `cd apps\driver` → set the backend base URL → `flutter run -d <device-id>`.  
3. Exercise login → available/assigned status → milestone screen; capture screenshots; confirm API errors surface as UI messages.  
4. Optional scripted UI: `flutter drive --driver=test_driver/app_driver.dart --target=lib/main.dart`.

**C. Enable real-LLM verification**  
`ollama pull qwen3:8b` (or set `LLM_PROVIDER` to a reachable provider), then re-check `/api/health/llm` for `available=true, degraded=false`.

**D. Clinical review (clears UNREVIEWED)**  
Have a qualified clinician review the 5 protocols, resolve the 3 CRITICAL escalation warnings, and set `review_status`. No repository change flips this status without that human step.

---

## 9. Evidence & logs

- **Windows `%TEMP%\`:** `resus-acc-gated.log` (1 transient fail), `resus-acc-gated2.log` (886 pass), `resus-acc-baseline.log` (818 pass), `resus-acc-dashlive-1.log` (fail), `resus-acc-dashlive-2.log` (pass), `resus-demo-server-4021-20261028T1414Z.log`, `resus-demo-vite-5175-*.log`.  
- **WSL `/tmp/`:** `resus-accept-inspect.log`, `resus-accept-telephony.log`, `resus-accept-safety.log`, `resus-accept-final.log`.  
- **WSL evidence dirs:** `/home/resus/siptest/whisper-20261027T195445Z` (Whisper accuracy: 0/12 exact, mean word accuracy 0.439), `/home/resus/siptest/stageE-*` (per-call uplink/downlink WAVs).  
- **DB artifacts:** restored runtime `dev.db` (11 migrations, integrity ok), retained `dev.db.postincident-*` forensic copy, pre-sync backup tar.

*All numbers above are read back from the named command/log, not asserted. Nothing was committed or pushed; no service was stopped except the demo backend I restarted to replace processes the reboot had already killed.*
