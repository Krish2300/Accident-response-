# Bystander Assistance Engine (V1 prototype)

A standalone Python API that coaches a frightened, untrained caller through an emergency **one small step at a time**.

> ## ⚠️ Medical safety notice
> This is a **research / college prototype. It is NOT safe for real emergency use.**
> All protocol text in `protocols/*.json` is **placeholder**. **Protocol content must be populated from current authoritative first-aid/CPR guidance and reviewed by an appropriately qualified medical/first-aid professional before real-world use.**
> A real deployment must always connect the caller to actual emergency services / a human dispatcher; this engine only assists, and it hands over (`escalate: true`) whenever it is unsure.

## What it does

A caller phones an emergency number on a normal phone. The (future) call controller turns speech into text and sends it to this API. The API answers with **one** instruction or question, which the controller turns back into speech (TTS).

```
CALLER (normal phone) → Telephony/SIP/Asterisk → Call controller → STT
        → POST /session/{id}/message  ← THIS PROJECT
        ← instruction_text → TTS → same phone call → CALLER HEARS IT
```

**Core rule: the LLM is never the medical decision-maker.**

```
Caller speech
   ↓
Gemini (llm.py)            understands words only → structured facts
   ↓
Pydantic validation        strict schema; garbage/extra keys/missing fields rejected
   ↓
Deterministic engine       select_protocol() = plain Python rules (engine.py)
   ↓
Approved protocol step     text comes from protocols/*.json
   ↓
instruction_text → TTS (later)
```

* Gemini only produces `CallerFacts` (incident type, conscious, breathing, bleeding, choking, mechanism, uncertainties). It never sees the protocols and cannot name a treatment.
* If Gemini fails, times out or returns invalid JSON, **nothing changes** in the session and no step is issued.
* Once a protocol is running, replies like "done", "repeat", "hold on", "I can't" are interpreted by **keyword rules, not the LLM**, so nothing said mid-protocol can add, skip or reorder steps.
* Optional: Gemini may *reword* an approved step (`SIMPLIFY_WITH_LLM=true`, off by default). The engine still picks the action; the reworded text is only used if a mechanical guard passes (numbers unchanged, length sane) and never for placeholder text. This guard cannot prove meaning is unchanged, which is why it is off by default; write the approved text in plain language instead.

## Files

```
bystander-assistance/
├── app.py            FastAPI routes + message flow
├── engine.py         Deterministic engine: selection, state machine, sessions (no LLM imports)
├── llm.py            Gemini caller-understanding, validation, MOCK mode, optional simplifier
├── models.py         Pydantic models, enums, structured error type
├── protocols/        cpr.json  choking.json  severe_bleeding.json  unconscious_breathing.json
├── tests/            test_protocol_engine.py  test_api.py  test_validation.py
├── conftest.py  pytest.ini
├── requirements.txt  .env.example  .gitignore  README.md
```

## Installation

Requires **Python 3.11+**.

```bash
cd bystander-assistance
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                 # Windows: copy .env.example .env
```

### `.env` and MOCK_MODE

```
GEMINI_API_KEY=
MOCK_MODE=true
```

* `MOCK_MODE=true` (default): **no Gemini call, no API key needed.** A simple keyword parser stands in for the LLM so you can develop the whole flow offline.
* `MOCK_MODE=false`: uses Gemini. Get a key at <https://aistudio.google.com/apikey>, put it in `.env` as `GEMINI_API_KEY=...`. The key is only read from the environment; it is never in the code. `.env` is git-ignored.
* Optional: `GEMINI_MODEL` (default `gemini-2.5-flash`), `LLM_TIMEOUT_SECONDS` (10), `REQUIRE_REVIEWED_PROTOCOLS` (false), `SIMPLIFY_WITH_LLM` (false).

## Run and test

```bash
uvicorn app:app --reload             # http://127.0.0.1:8000  (interactive docs at /docs)
pytest -v                            # all tests; no API key or network needed
```

## API

All session endpoints return the same **BystanderResponse**:

| Field | Meaning |
|---|---|
| `session_id`, `call_id` | identifiers |
| `status` | `ACTIVE`, `WAITING_FOR_CALLER`, `WAITING_FOR_CONFIRMATION`, `REPEAT_CURRENT_STEP`, `PAUSED`, `ESCALATED`, `COMPLETED`, `ENDED` |
| `event` | `SESSION_STARTED`, `CLARIFICATION_NEEDED`, `CONTRADICTION`, `PROTOCOL_STARTED`, `STEP_ADVANCED`, `STEP_NOT_CONFIRMED`, `REPEATED`, `PAUSED`, `RESUMED`, `PROTOCOL_COMPLETED`, `ESCALATED`, `CALL_ENDED` |
| `instruction_text` | **what to send to TTS** |
| `wait_for_response` | true if the controller should listen for the caller next |
| `protocol`, `protocol_version`, `step` (1-based), `total_steps`, `action` | current protocol position (`null` before selection) |
| `needs_clarification`, `clarification_field` | we are asking for a missing fact |
| `escalate`, `escalation_reason` | **true ⇒ hand the call to a human dispatcher now** |
| `facts` | merged structured facts understood so far |

| Endpoint | Purpose |
|---|---|
| `GET /health` | status, `mock_mode`, loaded protocols |
| `GET /protocols` | loaded protocols and their `reviewed` flag |
| `POST /session/start` `{"call_id": "..."}` | new session; returns the opening question |
| `POST /session/{id}/message` `{"text": "..."}` | caller speech (as text) |
| `POST /session/{id}/confirm` `{"result": "completed" \| "not_completed" \| "unclear" \| "cannot_do"}` | explicit step result. Only `completed` advances; `cannot_do` escalates |
| `POST /session/{id}/repeat` | re-speak the exact current instruction; never changes `current_step`/`completed_steps` |
| `GET /session/{id}` | full session state |
| `POST /session/{id}/end` | call finished |

**Errors** are always `{"error": {"code": "...", "message": "...", "details": {...}}}`. Codes: `SESSION_NOT_FOUND` (404), `EMPTY_MESSAGE` / `REQUEST_VALIDATION_ERROR` / `INVALID_CALL_ID` (422), `INVALID_STATE_TRANSITION` / `NO_ACTIVE_PROTOCOL` / `SESSION_NOT_ACTIVE` / `PROTOCOL_ALREADY_ACTIVE` (409), `PROTOCOL_NOT_FOUND` (404), `PROTOCOL_NOT_REVIEWED` (409), and `LLM_TIMEOUT` / `LLM_API_FAILURE` / `LLM_INVALID_JSON` / `LLM_INVALID_OUTPUT` / `LLM_NOT_CONFIGURED` (503). An LLM error's `details.instruction_text` is a safe "please say that again" line; after **2 consecutive** LLM failures the session escalates to a human instead.

### Example curl calls

```bash
curl -s localhost:8000/health
curl -s -X POST localhost:8000/session/start -H 'content-type: application/json' -d '{"call_id":"CALL001"}'
# → {"session_id":"SESSION-AB12CD34","status":"ACTIVE", ...}

SID=SESSION-AB12CD34
curl -s -X POST localhost:8000/session/$SID/message -H 'content-type: application/json' \
     -d '{"text":"My father collapsed and he isnt responding."}'
curl -s -X POST localhost:8000/session/$SID/message -H 'content-type: application/json' -d '{"text":"No"}'
curl -s -X POST localhost:8000/session/$SID/repeat
curl -s -X POST localhost:8000/session/$SID/confirm -H 'content-type: application/json' -d '{"result":"completed"}'
curl -s localhost:8000/session/$SID
curl -s -X POST localhost:8000/session/$SID/end
```

### Example mock conversation (real output, MOCK_MODE=true)

```
start                       -> ACTIVE                    | Tell me what has happened.
"My father collapsed and he isn't responding."
                            -> WAITING_FOR_CALLER        | Is the person breathing normally?      (clarification, no protocol yet)
"No"                        -> WAITING_FOR_CONFIRMATION  | step 1: [PLACEHOLDER CPR step 1: ...]
"Can you repeat that?"      -> WAITING_FOR_CONFIRMATION  | step 1 again (event REPEATED, nothing advanced)
POST /repeat                -> WAITING_FOR_CONFIRMATION  | step 1 again
POST /confirm completed     -> WAITING_FOR_CONFIRMATION  | step 2
"done"                      -> WAITING_FOR_CALLER        | step 3 (this step has requires_confirmation:false)
POST /confirm completed     -> COMPLETED                 | "That was the last step. Please stay on the line with the emergency operator."
```

## How protocol selection works (`engine.select_protocol`)

Pure function of the validated facts; it never guesses:

| Facts | Result |
|---|---|
| `choking = true` | `CHOKING` |
| unconscious + breathing not normal | `CPR` |
| unconscious + breathing normal | `UNCONSCIOUS_BREATHING` |
| unconscious + breathing unknown | **ask** "Is the person breathing normally?" |
| bleeding present (not unconscious) | `SEVERE_BLEEDING` |
| consciousness unknown | **ask** "Is the person awake and answering you?" |
| nothing understood | **ask** "Tell me what has happened." |
| awake, nothing matches | **escalate** (`NO_MATCHING_PROTOCOL`) |

Also deterministic: facts the LLM lists under `uncertainties` are treated as unknown; contradictory facts (e.g. unconscious *and* choking, or an answer that disagrees with an earlier one) are reset and re-asked, never resolved by guessing; after 3 questions the engine escalates rather than keep asking; a running protocol can never be switched by later LLM output.

## How protocols work / adding your reviewed content

Each `protocols/*.json` file:

```json
{
  "protocol_id": "CPR",
  "version": "0.0-PLACEHOLDER",
  "title": "...",
  "reviewed": false,
  "steps": [
    {"id": "step_001", "action": "CPR_ACTION_01_PLACEHOLDER",
     "requires_confirmation": true,
     "approved_text": "[PLACEHOLDER CPR step 1: insert medically reviewed instruction here]"}
  ]
}
```

To use real content: replace `approved_text` (plain, short, phone-friendly wording), rename `action` ids, set the real `version`, set `"reviewed": true` **only after professional sign-off**. Then set `REQUIRE_REVIEWED_PROTOCOLS=true` so the engine refuses (and escalates) any unreviewed protocol. To add a protocol: drop a new JSON file in `protocols/` **and** add a rule to `select_protocol()` plus a test. Files are validated at startup (duplicate ids/steps rejected).

`requires_confirmation: true` ⇒ status `WAITING_FOR_CONFIRMATION`; the step advances only on `confirm(completed)` or a spoken "done/finished/yes". `false` ⇒ status `WAITING_FOR_CALLER`, same advance rule.

The fixed question/hand-over sentences (e.g. "Is the person breathing normally?", "Please stay on the line…") live at the top of `engine.py` and **also need review**. Yes/No answers are interpreted against the exact question asked.

## Connecting it to the main emergency-call system later

The API has no telephony dependency. Your call controller (Asterisk/AGI/ARI, Twilio, Exotel, …) should, per call:

1. `POST /session/start` with your call id; speak `instruction_text`.
2. Each time STT returns caller speech: `POST /session/{id}/message {"text": ...}`; speak `instruction_text`; if `wait_for_response` is false, stop listening for step replies.
3. **If `escalate` is true, transfer/bridge to a human dispatcher immediately.** Also do this if the API is unreachable (HTTP error/timeout). The human dispatcher should be alerted from the start of the call, independent of this engine.
4. Use `/repeat` or `/confirm` if the controller has its own intent detection (e.g. DTMF "1 = done").
5. `POST /session/{id}/end` on hangup.

## Known limitations / still needed

**Medical review (required):** all protocol text, the fixed question wording, the "bleeding present ⇒ SEVERE_BLEEDING" simplification (the schema has no severity), the choking-while-unconscious handling (currently treated as a contradiction and re-asked), and the keyword lists for "done / can't / wait".

**Telephony:** SIP/Asterisk/provider integration, STT, TTS, barge-in and silence timeouts, call-recording/consent, dispatcher hand-over and location sharing are all *not* implemented.

**Engineering:** sessions are in-memory (lost on restart, single process; `InMemorySessionStore` has the interface to swap for Redis/Postgres); no authentication; no per-session locking; in-protocol replies use keywords only (English), and new facts mentioned mid-protocol (e.g. "he stopped breathing") do not re-plan, so a real system needs a reviewed policy for that (currently: repeat/escalate); the mock parser is a rough keyword stand-in, not a substitute for evaluating Gemini on real emergency speech (accents, noise, panic).

## Verification status of this delivery

The code was self-reviewed and the deterministic engine, LLM-output validation, mock parser, error handling and API flow logic were exercised (98 test cases) in a sandbox **without network access**, using minimal stand-ins for pytest/Pydantic/FastAPI. Not yet run: the suite under real `pytest` + real `fastapi`/`pydantic` (run `pytest -v` after installing), and the **live Gemini call** (`MOCK_MODE=false`); the request uses the `google-genai` SDK with a JSON schema, so confirm it against your SDK version and API key first.
