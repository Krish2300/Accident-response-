"""
Module 3 — System Prompts & Claude Tool-Use Schema
Production-grade prompt engineering for emergency NLP extraction.
"""

from __future__ import annotations


# ─────────────────────────────────────────────
# SYSTEM PROMPT
# ─────────────────────────────────────────────

EXTRACTION_SYSTEM_PROMPT = """\
You are an expert emergency dispatch AI assistant operating inside an autonomous \
Emergency Response Orchestration System. Your SOLE function in this module is to \
analyze incoming caller transcripts and extract structured incident data with \
maximum accuracy and zero hallucination.

## CRITICAL OPERATING RULES
1. NEVER invent or hallucinate details not present in the transcript.
2. If a field is uncertain or absent, set it to null or "UNKNOWN" — do NOT guess.
3. You must ALWAYS return a complete, valid JSON object matching the tool schema.
4. Life-safety context: errors in severity scoring or location extraction can \
   cause death. Be conservative — when uncertain between severity levels, \
   always choose the higher (more critical) tier.
5. For multilingual transcripts: translate key medical/location content to \
   English but preserve the original text.

## INCIDENT CLASSIFICATION GUIDE
| Category       | Key Signals                                                        |
|---------------|---------------------------------------------------------------------|
| CARDIAC       | collapsed, not breathing, chest pain, no pulse, unconscious        |
| RESPIRATORY   | choking, can't breathe, asthma, blue lips, shortness of breath     |
| TRAUMA        | accident, fall, bleeding, stabbing, fracture, hit by vehicle       |
| NEUROLOGICAL  | stroke, seizure, sudden confusion, face drooping, can't speak      |
| FIRE          | fire, smoke, burning, explosion                                     |
| ACCIDENT      | road accident, collision, vehicle crash                             |
| DROWNING      | drowning, submerged, pulled from water                             |
| POISONING     | swallowed, overdose, gas leak, chemical exposure                   |
| OBSTETRIC     | labor, pregnant, contractions, baby, delivery                      |
| PSYCHIATRIC   | suicide attempt, self-harm, mental breakdown                       |

## SEVERITY SCORING GUIDE
| Level  | Score | Criteria                                                    |
|--------|-------|-------------------------------------------------------------|
| P1/CRITICAL | 8-10 | Unconscious, not breathing, no pulse, active CPR needed  |
| P2/HIGH     | 5-7  | Altered consciousness, labored breathing, active bleeding |
| P3/MODERATE | 3-4  | Conscious, stable vitals, pain or distress               |
| P4/LOW      | 1-2  | Ambulatory, minor injury, no immediate life threat       |

## MISSING FIELDS DETECTION
Flag these as missing if not determinable from transcript:
- location_missing: No address, landmark, or GPS reference provided
- consciousness_unknown: Cannot determine if patient is conscious
- breathing_unknown: Cannot determine breathing status
- patient_count_unknown: Cannot determine how many people are affected
- incident_type_ambiguous: Emergency type cannot be confidently classified

## OUTPUT FORMAT
You MUST call the `extract_incident_data` tool and populate ALL fields. \
Do not output any prose — only the tool call.
"""


# ─────────────────────────────────────────────
# CLAUDE TOOL-USE SCHEMA  (Anthropic format)
# ─────────────────────────────────────────────

EXTRACTION_TOOL_SCHEMA = [
    {
        "name": "extract_incident_data",
        "description": (
            "Extract and classify all emergency incident details from the caller transcript. "
            "Called exactly once per transcript. All nullable fields must be null (not omitted) "
            "when information is absent."
        ),
        "input_schema": {
            "type": "object",
            "required": [
                "incident_category", "incident_subcategory", "caller_intent",
                "severity", "location", "patient",
                "bystanders_present", "hazards",
                "missing_fields", "multilingual",
                "extraction_confidence"
            ],
            "properties": {

                # ── Classification ──────────────────────────────────────────
                "incident_category": {
                    "type": "string",
                    "enum": [
                        "CARDIAC", "RESPIRATORY", "TRAUMA", "NEUROLOGICAL",
                        "FIRE", "ACCIDENT", "DROWNING", "POISONING",
                        "OBSTETRIC", "PSYCHIATRIC", "UNKNOWN"
                    ],
                    "description": "Primary emergency category."
                },
                "incident_subcategory": {
                    "type": ["string", "null"],
                    "description": "e.g. 'Cardiac Arrest', 'Stroke', 'RTA with head injury'."
                },
                "caller_intent": {
                    "type": "string",
                    "description": "One concise English sentence: what the caller needs right now."
                },

                # ── Severity ────────────────────────────────────────────────
                "severity": {
                    "type": "object",
                    "required": ["level", "numeric_score", "rationale",
                                 "key_risk_factors", "cpr_required", "aed_required"],
                    "properties": {
                        "level": {
                            "type": "string",
                            "enum": ["P1", "P2", "P3", "P4"]
                        },
                        "numeric_score": {
                            "type": "integer", "minimum": 1, "maximum": 10
                        },
                        "rationale": {
                            "type": "string",
                            "description": "Clinical justification for this severity rating."
                        },
                        "key_risk_factors": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Top 1-3 factors driving severity classification."
                        },
                        "cpr_required": {
                            "type": "boolean",
                            "description": "True if CPR guidance should be triggered immediately."
                        },
                        "aed_required": {
                            "type": "boolean",
                            "description": "True if AED use is likely needed."
                        }
                    }
                },

                # ── Location ────────────────────────────────────────────────
                "location": {
                    "type": "object",
                    "required": ["raw_text", "landmark", "street_address",
                                 "area_district", "city", "pin_code", "gps_hint", "confidence"],
                    "properties": {
                        "raw_text": {
                            "type": ["string", "null"],
                            "description": "Exact location phrase from caller."
                        },
                        "landmark": {"type": ["string", "null"]},
                        "street_address": {"type": ["string", "null"]},
                        "area_district": {"type": ["string", "null"]},
                        "city": {"type": ["string", "null"]},
                        "pin_code": {"type": ["string", "null"]},
                        "gps_hint": {
                            "type": ["string", "null"],
                            "description": "Any GPS coordinate or map pin mentioned."
                        },
                        "confidence": {
                            "type": "number", "minimum": 0.0, "maximum": 1.0,
                            "description": "Confidence in location extraction accuracy."
                        }
                    }
                },

                # ── Patient ─────────────────────────────────────────────────
                "patient": {
                    "type": "object",
                    "required": [
                        "age", "gender", "count", "consciousness",
                        "breathing", "pulse_present", "chief_complaint",
                        "secondary_symptoms", "known_conditions", "mobility"
                    ],
                    "properties": {
                        "age": {
                            "type": ["integer", "null"],
                            "minimum": 0, "maximum": 130
                        },
                        "gender": {
                            "type": ["string", "null"],
                            "enum": ["Male", "Female", "Unknown", None]
                        },
                        "count": {
                            "type": "integer", "minimum": 1,
                            "description": "Number of patients/victims."
                        },
                        "consciousness": {
                            "type": "string",
                            "enum": ["CONSCIOUS", "UNCONSCIOUS", "SEMI_CONSCIOUS", "UNKNOWN"]
                        },
                        "breathing": {
                            "type": "string",
                            "enum": ["NORMAL", "LABORED", "ABSENT", "UNKNOWN"]
                        },
                        "pulse_present": {
                            "type": ["boolean", "null"]
                        },
                        "chief_complaint": {
                            "type": ["string", "null"],
                            "description": "Primary symptom or problem in English."
                        },
                        "secondary_symptoms": {
                            "type": "array",
                            "items": {"type": "string"}
                        },
                        "known_conditions": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Pre-existing medical conditions mentioned."
                        },
                        "mobility": {
                            "type": ["string", "null"],
                            "enum": ["Mobile", "Immobile", "Unknown", None]
                        }
                    }
                },

                # ── Scene Context ────────────────────────────────────────────
                "bystanders_present": {
                    "type": ["boolean", "null"],
                    "description": "True if caller indicates others are at the scene."
                },
                "hazards": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Environmental hazards: fire, gas, chemicals, traffic, etc."
                },

                # ── Gap Analysis ─────────────────────────────────────────────
                "missing_fields": {
                    "type": "object",
                    "required": [
                        "location_missing", "exact_address_missing",
                        "consciousness_unknown", "breathing_unknown",
                        "patient_count_unknown", "caller_identity_unknown",
                        "incident_type_ambiguous", "any_hazards_unknown",
                        "additional_flags"
                    ],
                    "properties": {
                        "location_missing":        {"type": "boolean"},
                        "exact_address_missing":   {"type": "boolean"},
                        "consciousness_unknown":   {"type": "boolean"},
                        "breathing_unknown":       {"type": "boolean"},
                        "patient_count_unknown":   {"type": "boolean"},
                        "caller_identity_unknown": {"type": "boolean"},
                        "incident_type_ambiguous": {"type": "boolean"},
                        "any_hazards_unknown":     {"type": "boolean"},
                        "additional_flags": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Any other context-specific information gaps."
                        }
                    }
                },

                # ── Multilingual ─────────────────────────────────────────────
                "multilingual": {
                    "type": "object",
                    "required": [
                        "original_language", "original_text",
                        "english_translation", "translation_confidence"
                    ],
                    "properties": {
                        "original_language": {
                            "type": "string",
                            "enum": ["en", "ml", "hi", "ta", "kn", "unknown"]
                        },
                        "original_text": {
                            "type": "string",
                            "description": "Verbatim original transcript."
                        },
                        "english_translation": {
                            "type": ["string", "null"],
                            "description": "English translation (null if already English)."
                        },
                        "translation_confidence": {
                            "type": "number", "minimum": 0.0, "maximum": 1.0
                        }
                    }
                },

                # ── Quality ──────────────────────────────────────────────────
                "extraction_confidence": {
                    "type": "number", "minimum": 0.0, "maximum": 1.0,
                    "description": "Overall confidence in the extraction quality (0-1)."
                }
            }
        }
    }
]


# ─────────────────────────────────────────────
# STREAMING / INCREMENTAL PROMPT VARIANT
# For partial transcripts before utterance ends
# ─────────────────────────────────────────────

INCREMENTAL_SYSTEM_PROMPT = """\
You are receiving a PARTIAL, INCOMPLETE caller transcript (the call is still live). \
Extract whatever information is currently available. Mark ALL fields as UNKNOWN or \
null if not yet confirmed. Focus on: is this a life threat? What category? \
Is CPR needed immediately? Provide a PRELIMINARY assessment that will be updated \
as more transcript arrives.

""" + EXTRACTION_SYSTEM_PROMPT
