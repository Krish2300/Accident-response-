# Conversation E2E Test Report

**Date:** 2026-10-22
**Scope:** End-to-end validation of the telephony conversation stack (Modules 1 / 2 / 5 / 11) plus resolution of three defects found during live conversation testing, with regression tests, failure-path checks, and an honest statement of what was and was not verified against real audio.

This report is a **development / test artifact**. It is not a clinical-validation claim and it does not certify the system for production or patient-care use.

---

## 1. Architecture and the tested call path

### Modules in the conversation path

| Module | Role in a conversation turn |
| --- | --- |
| **Module 1** (`module_01_emergency_call`) | Owns the call session lifecycle (open / active / ended), the emergency link, and the telephony transport. |
| **Module 2** (`module_02_speech_processing`) | STT (Whisper) and TTS (speech synthesis) providers behind a `SpeechService` port. |
| **Module 5** (`module_05_bystander_assistance`) | The **sole clinical decision-maker**. Loads a versioned protocol, runs the step state-machine, extracts entities, and produces the authoritative instruction. |
| **Module 11** (`module_11_database_event_system`) | Persistence (emergencies, call sessions, protocol sessions, transcripts) and the append-only event bus. |
| **Module 4** (conversation layer, in `apps/server`) | Localisation + caller-silence retry budget around the live controller. Inert by default (`MODULE4_SILENCE_TIMEOUT_MS=0`). |

### Two distinct paths reach Module 5's engine

```
                       ┌──────────────────────────────────────────────────────┐
  (A) LIVE AUDIO PATH  │ Asterisk → AudioBridge → AsteriskConversationController
                       │   .onCallerUtterance → module5.sessions.handleUtterance
                       │   (controller owns its own transcript write + TTS)
                       └──────────────────────────────────────────────────────┘

                       ┌──────────────────────────────────────────────────────┐
  (B) HTTP PATH        │ POST /api/protocol-sessions/:id/utterance
                       │   → module5.turnOrchestrator.orchestrateTurn(...)   ← Defect 3 fix
                       │     1. persist CALLER transcript
                       │     2. call Module 5 decide() exactly once
                       │     3. persist SYSTEM transcript + speech.speak()
                       └──────────────────────────────────────────────────────┘
```

- **Path A (live call):** `AsteriskConversationController.onCallerUtterance` already owned its own transcript persistence and TTS. It calls `handleUtterance` **directly** and is **deliberately left untouched** by the Defect 3 fix, so no turn is double-written or spoken twice.
- **Path B (HTTP utterance):** Before the fix this route called `sessions.handleUtterance` directly, so an HTTP-driven turn produced **no transcript row and no TTS**. The fix introduces a thin `ProtocolTurnOrchestrator` port (owned by Module 5) and a server-side implementation that wraps `decide` with transcript persistence + synthesis. Module 5's engine remains the only thing that decides what the protocol does; the orchestrator never replaces or reinterprets `decide`.

**Clinical-authority invariant (verified):** in both paths the decision always comes from `module5.sessions.handleUtterance` / the injected `decide` closure. The orchestrator adds persistence and speech *around* that decision and returns its result untouched. A failed decision is a failed turn — never a substituted one.

---

## 2. The three defects: root cause, fix, regression tests

### Defect 1 — Whisper hallucinations accepted as high-confidence speech

**Root cause.** In `whisperProvider.ts`, `NO_SCORE_CONFIDENCE` was `0.7`, which sits **above** the discard threshold (`VOICE_CONFIDENCE.DISCARD_BELOW = 0.45`). When Whisper returned a segment with no token scores and no `avg_logprob` (typical for silence / non-speech hallucinations such as `"you"`, `"(audience applauding)"`), `scoreOf` fell back to `0.7`, so the hallucination was classified **HIGH** confidence and passed straight into the protocol instead of being discarded.

**Fix** (`modules/module_02_speech_processing/src/providers/whisperProvider.ts`):
- `NO_SCORE_CONFIDENCE` lowered from `0.7` → **`0.2`** (below `DISCARD_BELOW`), so a segment with *no scoring evidence at all* is discarded rather than trusted.
- `scoreOf` now, when there are no token scores / `avg_logprob` **but** a `no_speech_prob` is present, returns `clamp01(1 - no_speech_prob)`. High `no_speech_prob` therefore pushes confidence down toward discard; low `no_speech_prob` can still keep a legitimate short utterance.

**Regression tests** (`modules/module_02_speech_processing/tests/realSpeechProviders.test.ts`) — **42/42 pass**, including 8 new cases:
- Silence hallucination `"you"` with `no_speech_prob 0.95` → **rejected** (was previously HIGH).
- White-noise hallucination `"(audience applauding)"` → **rejected**.
- Valid short `"yes"` with healthy token scores (`avg_logprob` → confidence `0.9506`) → **preserved as HIGH** (short utterances are not over-rejected).
- Moderate / high `no_speech_prob` alone → **rejected**; low `no_speech_prob` alone → **kept**.
- `no_speech_prob` combined with token scores → token scores still applied.
- Totally unscorable segment and malformed segment → **rejected**.

### Defect 2 — Heuristic extraction could not satisfy protocol gates

**Root cause.** The cardiac-arrest protocol gates on `caller_location exists` (step `call-emergency-services`) and `cpr_started eq YES` (step `start-compressions`). Two things blocked both the heuristic **and** the Ollama path:
1. `entitiesSchema` in `llm/contracts.ts` had no `caller_location` or `cpr_started` fields. Zod **stripped** unknown keys, so even a correct LLM/heuristic extraction was dropped before it reached the session — the gates could never be satisfied and the protocol stalled.
2. `heuristicProvider.ts` had **no rules** for either fact, so the fallback extractor produced nothing for them.

**Fix:**
- `llm/contracts.ts` — added `caller_location` (nullable string, max 200, default `null`) and `cpr_started` (TRISTATE `YES`/`NO`/`UNKNOWN`, default `UNKNOWN`) to `entitiesSchema`; added `cpr_started` to `CLOSED_FACT_VALUES` (so it is a closed, auditable fact). `caller_location` is deliberately **unbounded** (a free-text location is not a closed vocabulary).
- `llm/heuristicProvider.ts` — added `VAGUE_LOCATION_WORDS` denylist and two narrow extractors:
  - `callerLocation()` — matches `i am at X`, `address is X` / `address is: X` / `address: X`, stops at clause punctuation, and **rejects** vague/short captures (e.g. "here", "near the park", "somewhere").
  - `cprStarted()` — checks negation **first** (`no`, `not`, `haven't`), then a small set of positive phrases (`started compressions`, `doing cpr`, `pushing on the chest`, …); otherwise returns `UNKNOWN`. Questions and unrelated speech return `UNKNOWN`, never a fabricated `YES`/`NO`.
- `llm/prompts.ts` — added both facts to `jsonSchemas.extraction` so the Ollama path also returns them. (The generic `SYSTEM_EXTRACTION` prompt text is unchanged; it already instructs the model to fill every field in the schema.)

**Heuristic limits (documented):** the rules are intentionally narrow. They capture only explicit first-person location statements and explicit CPR-started statements. Ambiguous speech ("I'm somewhere near the shops") yields `null`/`UNKNOWN` and the protocol **loops/asks again** rather than inferring an exact location or assuming CPR. The heuristic never overrides Module 5's engine and never invents a clinical fact.

**Regression tests** — **64/64 pass**:
- `tests/llm.test.ts` — location extraction (5 positive), vague/absent → null (5), ambiguous → null, CPR `YES` (7), CPR `NO` with negation (5), questions/unrelated → `UNKNOWN` (4).
- `tests/sessionService.test.ts` — protocol-level: advances past `call-emergency-services` on a real location; advances past `start-compressions` on `cpr_started = YES`; does **not** advance on ambiguous CPR or vague location.

**Live evidence (see §3):** both gates were crossed over the real HTTP utterance route using the heuristic fallback (Ollama unavailable).

### Defect 3 — HTTP utterance route bypassed transcript and TTS

**Root cause.** `POST /api/protocol-sessions/:id/utterance` called `sessions.handleUtterance` and returned the decision **directly**. Module 5 holds no persistence or speech port, so an HTTP-driven turn produced **no CALLER transcript, no SYSTEM transcript, and no TTS**. The turn was clinically correct but invisible in the call record and unheard by the caller — the exact opposite of the live AudioBridge path, which already persisted and spoke every turn.

**Fix (minimal orchestration, no second decision engine):**
- `modules/module_05_bystander_assistance/src/session/orchestration.ts` (new) — defines the `ProtocolTurnOrchestrator` port: `orchestrateTurn({ sessionId, utterance, decide }) → SessionTurn`. Module 5 owns the *contract*; it still cannot persist or speak.
- `apps/server/src/conversation/protocolTurnOrchestrator.ts` (new) — `ProtocolTurnOrchestratorImpl`:
  1. Resolves the protocol session → emergency id (via `module11.protocols.getSession`) and the **ACTIVE** call (via `calls.requireSessionFor`).
  2. Persists the caller's words as a `CALLER` transcript row.
  3. Calls `decide()` **exactly once** and returns its result **untouched** (a rejected decision propagates; it is never caught-and-replaced).
  4. Persists the spoken reply as a `SYSTEM` row and calls `speech.speak` (both **best-effort**; failures are logged and swallowed so the decision still reaches the caller, and the decision/turn fields are never mutated).
  - When no ACTIVE call is bound (protocol-only HTTP session), transcript + TTS are **skipped** and the decision is still returned.
- `apps/server/src/app.ts` — wires the orchestrator into Module 5 **only for the HTTP route**. `module2` is constructed before `module5` so `module2.speech` is available at construction time. The live `AsteriskConversationController` path is untouched.
- `modules/module_05_bystander_assistance/src/api/routes.ts` — the utterance handler now delegates to `module5.turnOrchestrator.orchestrateTurn(...)` when present, else falls back to `decide()` directly (unit tests, protocol-only sessions). The clinical outcome is identical either way.
- Auth is unchanged: the route stays **public** (a bystander has no credentials).

**Regression tests** (`tests/protocolTurnOrchestrator.test.ts`) — **12/12 pass**:
- Ordering `CALLER → decide → SYSTEM + TTS`; `decide` called exactly once (including on escalate); a rejected decision propagates; transcript-write failure is isolated; synthesis failure is isolated; unresolvable session / non-ACTIVE call / `requireSessionFor` throw all skip transcript+TTS safely; empty speech persists CALLER but skips TTS; `paraphrased` maps to `verbatimProtocolText = !paraphrased`; 3 repeated requests → 3 CALLER + 3 SYSTEM rows; no double-persist.

---

## 3. Synthetic transcript and protocol-step transitions (live)

Driven over the real HTTP utterance route against the WSL deployment (heuristic fallback; Ollama `qwen3:8b` not pulled). Emergency `EMG-2D9A14E52D0001`, call `CALL-36E41E7F530003` (status `ACTIVE`), protocol session `PSE-505C8B653F0005`, protocol `cardiac-arrest-adult`.

Full persisted transcript (`GET /api/emergencies/EMG-2D9A14E52D0001/transcripts`) — **every turn has a paired CALLER + SYSTEM row**, which is the Defect 3 fix in action:

| # | Speaker | Text | Protocol step after turn |
| --- | --- | --- | --- |
| 1 | CALLER | "The person is unconscious and not breathing" | `confirm-arrest` → **`check-scene-safety`** |
| 2 | SYSTEM | "Before anyone touches the person, check that the scene is safe…" | — |
| 3 | CALLER | "Yes the scene is safe" | `check-scene-safety` → **`call-emergency-services`** |
| 4 | SYSTEM | "Call the emergency number now… give your exact location." | — |
| 5 | CALLER | "I am at 123 Main Street downtown" | `call-emergency-services` → **`start-compressions`** *(Defect 2 gate: `caller_location`)* |
| 6 | SYSTEM | "Lay the person flat… press down hard and fast in the middle of the chest." | — |
| 7 | CALLER | "Yes I have started doing compressions" | `start-compressions` → **`compressions-and-breaths`** *(Defect 2 gate: `cpr_started=YES`)* |
| 8 | SYSTEM | "Keep pressing in the centre of the chest at a steady rate…" | — |
| 9 | CALLER | "zzz qqq xxx blah gibberish" *(invalid input)* | stays on **`compressions-and-breaths`** (safe loop) |
| 10 | SYSTEM | "Keep pressing in the centre of the chest…" *(safe spoken reply)* | — |
| 11 | CALLER | "Yes I have started doing compressions" *(repeat request)* | stays on **`compressions-and-breaths`** (no double effect) |
| 12 | SYSTEM | "Keep pressing in the centre of the chest…" | — |

**Step-transition summary:** `confirm-arrest → check-scene-safety → call-emergency-services → start-compressions → compressions-and-breaths`. Both Defect 2 gates were crossed live.

---

## 4. STT / TTS / media evidence — what was live audio vs API-only

This section deliberately separates *API-level* verification from *real-audio* verification.

| Capability | How verified | Live audio? |
| --- | --- | --- |
| **Greeting playback** | Prior live Asterisk call `CALL-061A4F17A70003` (2026-10-22, earlier session): greeting synthesised and played over the AudioSocket. | **Yes** (prior call) |
| **STT (caller → text)** | Prior live call: real speech transcribed via Whisper over the phone path; also API-level STT E2E (`TRN-49DB743048000E`, `TRN-2882C719600010`). | **Yes** (prior call) |
| **Protocol response (live path)** | Prior live call: protocol advanced 3 steps and the system instruction was spoken back over AudioSocket. | **Yes** (prior call) |
| **HTTP-path transcript persistence (Defect 3)** | This session: 4 CALLER + 4 SYSTEM rows written by `ProtocolTurnOrchestratorImpl` over `POST /api/protocol-sessions/:id/utterance` (see §3). | No — HTTP path has no live audio channel |
| **HTTP-path TTS synthesis (Defect 3)** | This session: for each HTTP turn a SYSTEM row was written (step 3 of the orchestrator) **immediately before** `speech.speak`, and **no** synthesis error was logged. Synthesis was therefore invoked on the real Module 2 port. | **Not independently confirmed as audio delivered to a live phone** — the HTTP path synthesises an artifact/log; it does not push audio to a handset. |
| **Bidirectional live audio** | Not re-verified in this session's HTTP tests. The prior live call verified one full turn (greeting + STT + spoken response); a second independent live bidirectional run was **not** performed. | Partial (prior call only) |

**Honest statement:** the Defect 3 orchestrator's *decision + persistence* behaviour is fully verified (unit + live HTTP). Its *TTS invocation* is verified up to the point of calling Module 2's `speak` with no error. Real-audio delivery of an HTTP-driven turn to a live telephone was **not** demonstrated, because the HTTP utterance route has no attached media channel. The live-audio-capable path (Path A) was verified earlier via call `CALL-061A4F17A70003`.

---

## 5. Failure-path checks (live + test evidence)

| Check | Result | Evidence |
| --- | --- | --- |
| **Hangup mid-protocol → session closure + no further persistence** | **PASS** | `POST /calls/CALL-36E41E7F530003/hangup` → call `status: ENDED`. A subsequent utterance still returned the clinical decision, but the transcript count stayed at **12 → 12** (orchestrator detected non-ACTIVE call and skipped transcript/TTS). |
| **Silence / timeout** | **Confirmed disabled by default** | `MODULE4_SILENCE_TIMEOUT_MS` is **not set** in the deployment `.env` → schema default **`0`** → `SilenceRetryPolicy` is inert (no timer armed). A positive value would arm the retry budget; `0` means the silence path never fires. |
| **Repeated calls with separate `callSessionId`s → no cross-contamination** | **PASS** | `EMG-2D9A14E52D0001` (12 transcript rows) vs `EMG-263EB6F8380036` (separate emergency, its own 1 CALLER row). Transcript rows are keyed to the correct `callSessionId`/`emergencyId`; session 1's count was unchanged. |
| **Invalid / unintelligible input → safe clarification, no crash** | **PASS** | `"zzz qqq xxx blah gibberish"` → protocol **stayed** on `compressions-and-breaths` and returned the safe standing instruction ("Keep pressing…"). No crash, no erroneous advance, no wrong escalation. |
| **Backend / transport failure → fail-closed + cleanup** | **PASS (test-verified)** | Covered by unit/integration tests: provider-unavailable and database-failure paths roll back and emit no success event (e.g. route-recalculation rollback test observed `DATABASE_FAILURE`); Module 5 logs `primary LLM provider unavailable` and degrades to the heuristic fallback rather than inventing facts. Automatic dispatch remains fail-closed. |
| **Repeated identical request → no double clinical effect** | **PASS** | Repeat of `"Yes I have started doing compressions"` while already on `compressions-and-breaths` kept the session on the same step (safe loop); each request produced its own paired transcript rows but no state corruption. |

---

## 6. Exact test commands and counts

All commands run from the repository root (`F:\minor`). npm workspaces are **not** configured, so tests are invoked via `npx vitest run <path>`.

| Command | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | **clean** (exit 0) | `tsc --noEmit -p tsconfig.json` |
| `npx vitest run modules/module_02_speech_processing/tests/realSpeechProviders.test.ts` | **42 passed / 0 failed** | Defect 1 suite |
| `npx vitest run modules/module_05_bystander_assistance/tests/llm.test.ts modules/module_05_bystander_assistance/tests/sessionService.test.ts` | **64 passed / 0 failed** | Defect 2 suites |
| `npx vitest run tests/protocolTurnOrchestrator.test.ts` | **12 passed / 0 failed** | Defect 3 suite |
| `npx vitest run modules/module_01_emergency_call modules/module_02_speech_processing modules/module_05_bystander_assistance tests/protocolTurnOrchestrator.test.ts tests/asteriskConversationController.test.ts tests/module4ConversationSupport.test.ts` | **319 passed / 0 failed** | Conversation-focused suites |
| `npx vitest run` (full regression) | **764 passed / 66 skipped / 0 failed** — duration **180.22 s** | 66 skipped are pre-existing integration tests that self-skip when external infra (live DB fixtures / Ollama / network) is absent. **No timeouts. No failures.** |

**Skipped tests (honest accounting):** the 66 skipped tests are integration suites such as `outcomeGrantAudit`, `outcomeHistory`, `outcomeAccessGrants`, `outcomeEmergencyScope`, `outcomeApi`, `dashboardLiveProxy`, `serverCompositionAmbulanceWorkflow`, `serverCompositionOperationalEvents`, and `module3Classifier.live`. They skip by design when their required infrastructure is not present; they were **not** made to fail and were **not** silently swallowed.

---

## 7. Remaining blockers / limitations

1. **Ollama model unavailable.** `qwen3:8b` is not pulled in the deployment (`/api/health/llm` → `available: false`, `reason: "Model 'qwen3:8b' is not pulled"`). All live conversation turns therefore exercised the **heuristic fallback**, not the LLM extraction path. The Ollama schema fix (Defect 2) is covered by unit tests but was **not** live-verified against a real model.
2. **Real-audio TTS delivery for HTTP-driven turns not demonstrated.** The HTTP utterance route has no media channel; its TTS is invoked on Module 2's port but audio was not pushed to a live handset (see §4).
3. **No independent second live bidirectional call in this session.** The earlier live call `CALL-061A4F17A70003` verified greeting + STT + one spoken protocol response. This session's live checks used the HTTP path (no live audio). A second full live-audio call was not run.
4. **WSL deployment is a reduced build.** The deployment copy at `/home/resus/resus` ships only Modules 01/02/05/06/11/12 (no Module 3 nlp/, Module 7/8/9, or Module 10). Its `apps/server/src/app.ts` was reconstructed to a minimal bootable composition (the 7 mapped packages + the Defect 3 orchestrator wiring) so the live checks could run against the fixed code. Modules 7/8/9/10 and the `ConversationSupportAdapter` are absent from this build and were not exercised live here.
5. **Not a clinical claim.** Nothing in this report certifies the protocols, the extraction, or the guidance for clinical or production use.

---

## 8. Safe, repeatable local demo

> **Safety:** use `isSimulation: true` everywhere. No real emergency numbers are dialled, no real patient data is used, and automatic dispatch remains fail-closed. The development-token route only exists when `NODE_ENV=development`.

### 8.1 Run the regression suites (no live infra needed)

```bash
cd F:\minor
npm run typecheck
npx vitest run modules/module_02_speech_processing/tests/realSpeechProviders.test.ts
npx vitest run modules/module_05_bystander_assistance/tests/llm.test.ts modules/module_05_bystander_assistance/tests/sessionService.test.ts
npx vitest run tests/protocolTurnOrchestrator.test.ts
npx vitest run   # full regression
```

### 8.2 Drive the Defect 3 orchestrator over HTTP (live, heuristic fallback)

Against a running server on `http://127.0.0.1:4000` (development mode):

```bash
BASE=http://127.0.0.1:4000

# 1. Mint a development ADMIN token (development builds only).
TOKEN=$(curl -s -X POST "$BASE/api/auth/dev-token" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
AUTH="Authorization: Bearer $TOKEN"

# 2. Create a simulated emergency; this also opens an ACTIVE call session.
EM=$(curl -s -X POST "$BASE/api/emergencies" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"incidentType":"CARDIAC_ARREST","severity":"CRITICAL","latitude":1.3521,"longitude":103.8198,"isSimulation":true}')
EID=$(echo "$EM" | python3 -c "import sys,json;print(json.load(sys.stdin)['emergency']['id'])")

# 3. Start a protocol session.
SID=$(curl -s -X POST "$BASE/api/protocol-sessions" -H 'Content-Type: application/json' \
  -d "{\"emergencyId\":\"$EID\",\"protocolId\":\"cardiac-arrest-adult\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['session']['id'])")

# 4. Drive turns — each persists CALLER + SYSTEM transcript and synthesises TTS.
curl -s -X POST "$BASE/api/protocol-sessions/$SID/utterance" -H 'Content-Type: application/json' \
  -d '{"utterance":"The person is unconscious and not breathing"}'
curl -s -X POST "$BASE/api/protocol-sessions/$SID/utterance" -H 'Content-Type: application/json' \
  -d '{"utterance":"Yes the scene is safe"}'
curl -s -X POST "$BASE/api/protocol-sessions/$SID/utterance" -H 'Content-Type: application/json' \
  -d '{"utterance":"I am at 123 Main Street downtown"}'          # Defect 2 caller_location gate
curl -s -X POST "$BASE/api/protocol-sessions/$SID/utterance" -H 'Content-Type: application/json' \
  -d '{"utterance":"Yes I have started doing compressions"}'    # Defect 2 cpr_started gate

# 5. Read the paired transcript back.
curl -s "$BASE/api/emergencies/$EID/transcripts" -H "$AUTH"
```

Expected: the transcript contains alternating `CALLER` / `SYSTEM` rows and the protocol advances
`confirm-arrest → check-scene-safety → call-emergency-services → start-compressions → compressions-and-breaths`.

### 8.3 Verify hangup stops persistence

```bash
# Hang up the call (requires an operator-capable token), then utter again.
curl -s -X POST "$BASE/calls/<CALL_SESSION_ID>/hangup" -H "$AUTH" -H 'Content-Type: application/json' -d '{"reason":"demo"}'
curl -s -X POST "$BASE/api/protocol-sessions/$SID/utterance" -H 'Content-Type: application/json' -d '{"utterance":"yes"}'
curl -s "$BASE/api/emergencies/$EID/transcripts" -H "$AUTH"   # row count unchanged
```

---

## 9. Change inventory (files touched by the three fixes)

| File | Change |
| --- | --- |
| `modules/module_02_speech_processing/src/providers/whisperProvider.ts` | `NO_SCORE_CONFIDENCE` 0.7→0.2; `scoreOf` uses `no_speech_prob` fallback. |
| `modules/module_02_speech_processing/tests/realSpeechProviders.test.ts` | 2 stale tests updated + 8 new regression tests (Defect 1). |
| `modules/module_05_bystander_assistance/src/llm/contracts.ts` | `entitiesSchema` + `CLOSED_FACT_VALUES` gain `caller_location` / `cpr_started`. |
| `modules/module_05_bystander_assistance/src/llm/heuristicProvider.ts` | `callerLocation()`, `cprStarted()`, `VAGUE_LOCATION_WORDS`. |
| `modules/module_05_bystander_assistance/src/llm/prompts.ts` | `jsonSchemas.extraction` gains both facts. |
| `modules/module_05_bystander_assistance/tests/llm.test.ts` | Heuristic unit tests (Defect 2). |
| `modules/module_05_bystander_assistance/tests/sessionService.test.ts` | Protocol-level gate tests + `extraction()` helper updated (Defect 2). |
| `modules/module_05_bystander_assistance/src/session/orchestration.ts` | **New** — `ProtocolTurnOrchestrator` port. |
| `modules/module_05_bystander_assistance/src/module.ts` | `Module5Deps.turnOrchestrator` + wiring. |
| `modules/module_05_bystander_assistance/src/api/routes.ts` | Utterance route delegates to the orchestrator. |
| `modules/module_05_bystander_assistance/src/index.ts` | Exports `ProtocolTurnOrchestrator` type. |
| `apps/server/src/conversation/protocolTurnOrchestrator.ts` | **New** — `ProtocolTurnOrchestratorImpl`. |
| `apps/server/src/app.ts` | `module2` moved before `module5`; orchestrator wired (HTTP route only). |
| `tests/protocolTurnOrchestrator.test.ts` | **New** — 12 orchestrator tests (Defect 3). |

**Deployment note:** to run the live checks against the fixed code, the WSL deployment copy (`/home/resus/resus`) had the above source files synced in, and its `apps/server/src/app.ts` was reconstructed to a minimal bootable composition for that reduced build (Modules 01/02/05/06/11/12 only). The live AudioBridge controller was not modified.
