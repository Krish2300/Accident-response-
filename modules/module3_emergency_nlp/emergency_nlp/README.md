# Module 3 — Emergency NLP / LLM
## Understanding & Classification Engine

Part of the **Autonomous Emergency Response Orchestration System**.

---

## Architecture

```
Module 2 (STT)
     │  TranscriptInput
     ▼
┌─────────────────────────────────────────────┐
│           FastAPI Application               │
│  POST /extract        POST /extract/stream  │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │       EmergencyNLPService           │    │
│  │                                     │    │
│  │  1. Build prompt + user message     │    │
│  │  2. Call Claude (tool_use mode)     │    │
│  │  3. Parse + map → Pydantic schema   │    │
│  │  4. Rule-based validation/enrich    │    │
│  │  5. Return ExtractedIncidentData    │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  Background Tasks:                          │
│  ├── dispatch_to_module4() (Dialog Engine)  │
│  └── dispatch_to_module10() (State Engine)  │
└─────────────────────────────────────────────┘
```

---

## Quickstart

```bash
pip install -r requirements.txt

export ANTHROPIC_API_KEY="sk-ant-..."
export MODULE4_URL="http://localhost:8004"
export MODULE10_URL="http://localhost:8010"

uvicorn emergency_nlp.api.main:app --host 0.0.0.0 --port 8003 --reload
```

---

## Key Endpoints

| Method | Path              | Description                                    |
|--------|-------------------|------------------------------------------------|
| GET    | `/health`         | Health check / readiness probe                 |
| POST   | `/extract`        | Final-chunk extraction + downstream dispatch   |
| POST   | `/extract/stream` | Incremental extraction (no dispatch)           |

---

## Example Request

```json
POST /extract
{
  "session_id": "call-abc-123",
  "transcript_text": "My father collapsed and is not responding. He's not breathing. We're near Medical Trust Hospital in Ernakulam.",
  "detected_language": "en",
  "is_final_chunk": true
}
```

## Example Response (abbreviated)

```json
{
  "session_id": "call-abc-123",
  "incident_category": "CARDIAC",
  "incident_subcategory": "Cardiac Arrest",
  "caller_intent": "Caller needs immediate ambulance for unresponsive father not breathing.",
  "severity": {
    "level": "P1",
    "numeric_score": 10,
    "rationale": "Unconscious and apneic — cardiac arrest.",
    "cpr_required": true,
    "aed_required": true
  },
  "location": {
    "raw_text": "Medical Trust Hospital, Ernakulam",
    "landmark": "Medical Trust Hospital",
    "city": "Ernakulam",
    "confidence": 0.75
  },
  "patient": {
    "consciousness": "UNCONSCIOUS",
    "breathing": "ABSENT",
    "chief_complaint": "Collapsed and unresponsive"
  },
  "missing_fields": {
    "location_missing": false,
    "exact_address_missing": true,
    "consciousness_unknown": false,
    "breathing_unknown": false
  },
  "extraction_confidence": 0.95
}
```

---

## Validation Rules (Post-LLM)

| Rule | Trigger | Action |
|------|---------|--------|
| 1 | UNCONSCIOUS + ABSENT breathing | Force P1, set cpr_required=True |
| 2 | cpr_required=True + severity < P2 | Escalate to P2 minimum |
| 3 | No location fields | Set location_missing=True |
| 4 | Patient consciousness UNKNOWN | Set consciousness_unknown=True |
| 5 | extraction_confidence < 0.4 | Set incident_type_ambiguous=True |

---

## Integration — Downstream Payload Targets

### → Module 4 (Dialog Engine)
Endpoint: `POST {MODULE4_URL}/api/v1/dialog/initialize`

Carries: `session_id`, `incident_category`, `severity`, `cpr_required`, `patient`, `missing_fields`, `caller_intent`, `location_raw`

Module 4 uses `missing_fields` to decide which follow-up questions to ask the caller.

### → Module 10 (State Engine)
Endpoint: `POST {MODULE10_URL}/api/v1/state/transition`

Carries: Full incident data + `trigger_state: "ANALYZING"`

Module 10 transitions: `NEW → ANALYZING → CLASSIFIED` and triggers ambulance, hospital, and route modules.

---

## Running Tests

```bash
pytest emergency_nlp/tests/ -v --tb=short --cov=emergency_nlp
```

---

## File Structure

```
emergency_nlp/
├── schemas/
│   └── incident_schema.py    # All Pydantic models
├── prompts/
│   └── extraction_prompt.py  # System prompts + Claude tool-use schema
├── services/
│   └── nlp_service.py        # Core LLM service + fallback logic
├── api/
│   └── main.py               # FastAPI app + routes
├── utils/
│   └── integration.py        # Module 4 & 10 dispatch hooks
└── tests/
    └── test_extraction.py    # Full test suite
```
