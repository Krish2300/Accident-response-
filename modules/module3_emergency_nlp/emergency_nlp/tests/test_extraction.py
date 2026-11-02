"""
Module 3 — Test Suite
Tests LLM extraction, schema validation, fallback logic, and multilingual support.
Run with: pytest tests/ -v --tb=short
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from ..schemas.incident_schema import (
    ConsciousnessState,
    BreathingStatus,
    DetectedLanguage,
    ExtractedIncidentData,
    IncidentCategory,
    SeverityLevel,
    TranscriptInput,
)
from ..services.nlp_service import (
    EmergencyNLPService,
    _build_fallback_incident,
    _validate_and_enrich,
)
from ..api import main as api_main


# ─────────────────────────────────────────────
# TEST FIXTURES
# ─────────────────────────────────────────────

def make_transcript(
    text: str,
    language: DetectedLanguage = DetectedLanguage.ENGLISH,
    is_final: bool = True,
) -> TranscriptInput:
    return TranscriptInput(
        session_id=str(uuid.uuid4()),
        transcript_text=text,
        detected_language=language,
        timestamp=datetime.now(timezone.utc),
        is_final_chunk=is_final,
    )


# ─────────────────────────────────────────────
# SCENARIO TEST DATA
# ─────────────────────────────────────────────

SCENARIOS = {
    "cardiac_arrest": {
        "transcript": "My father collapsed and is not responding. He's not breathing. Please hurry, we're at the Medical Trust Hospital junction in Ernakulam.",
        "language": DetectedLanguage.ENGLISH,
        "expected_category": IncidentCategory.CARDIAC,
        "expected_severity": SeverityLevel.CRITICAL,
        "expect_cpr": True,
        "expect_location_present": True,
        "expect_consciousness": ConsciousnessState.UNCONSCIOUS,
    },
    "malayalam_chest_pain": {
        "transcript": "എന്റെ അച്ഛന് നെഞ്ചുവേദന. ശ്വസിക്കാൻ ബുദ്ധിമുട്ടുണ്ട്. Kalamassery medical college അടുത്ത് ആണ്.",
        "language": DetectedLanguage.MALAYALAM,
        "expected_category": IncidentCategory.CARDIAC,
        "expected_severity": SeverityLevel.HIGH,
        "expect_cpr": False,
        "expect_location_present": True,
        "expect_consciousness": ConsciousnessState.CONSCIOUS,
    },
    "road_accident_multiple": {
        "transcript": "There's been an accident on the NH66 near Aluva bypass. Two cars crashed. At least 3 people are injured, one is trapped inside the vehicle and not moving.",
        "language": DetectedLanguage.ENGLISH,
        "expected_category": IncidentCategory.ACCIDENT,
        "expected_severity": SeverityLevel.CRITICAL,
        "expect_cpr": False,
        "expect_location_present": True,
    },
    "no_location_cardiac": {
        "transcript": "Someone fainted here. They're on the ground and not waking up.",
        "language": DetectedLanguage.ENGLISH,
        "expected_category": IncidentCategory.CARDIAC,
        "expected_severity": SeverityLevel.CRITICAL,
        "expect_cpr": True,
        "expect_location_present": False,
        "expect_location_missing_flag": True,
    },
    "hindi_choking": {
        "transcript": "Meri beti ka gala mein kuch faas gaya hai, woh saans nahi le sakti, please jaldi aao!",
        "language": DetectedLanguage.HINDI,
        "expected_category": IncidentCategory.RESPIRATORY,
        "expected_severity": SeverityLevel.CRITICAL,
        "expect_cpr": False,
    },
    "moderate_fall": {
        "transcript": "My grandmother fell in the bathroom. She's conscious and talking but her leg hurts a lot. I think it might be broken.",
        "language": DetectedLanguage.ENGLISH,
        "expected_category": IncidentCategory.TRAUMA,
        "expected_severity_not": SeverityLevel.CRITICAL,   # Should NOT be P1
        "expect_cpr": False,
        "expect_consciousness": ConsciousnessState.CONSCIOUS,
    },
    "ambiguous_low_info": {
        "transcript": "Something happened.",
        "language": DetectedLanguage.ENGLISH,
        "expected_category": IncidentCategory.UNKNOWN,
        "expect_all_gaps": True,
    },
}


# ─────────────────────────────────────────────
# MOCK LLM RESPONSES
# ─────────────────────────────────────────────

def _mock_tool_response(extracted_dict: dict) -> MagicMock:
    """Build a mock Anthropic API response with tool_use block."""
    block = MagicMock()
    block.type = "tool_use"
    block.name = "extract_incident_data"
    block.input = extracted_dict
    response = MagicMock()
    response.content = [block]
    return response


MOCK_CARDIAC_RESPONSE = {
    "incident_category": "CARDIAC",
    "incident_subcategory": "Cardiac Arrest",
    "caller_intent": "Caller needs immediate ambulance for unresponsive father who is not breathing.",
    "severity": {
        "level": "P1",
        "numeric_score": 10,
        "rationale": "Unconscious and apneic patient — cardiac arrest highly probable.",
        "key_risk_factors": ["unconscious", "not_breathing", "no_response"],
        "cpr_required": True,
        "aed_required": True,
    },
    "location": {
        "raw_text": "Medical Trust Hospital junction in Ernakulam",
        "landmark": "Medical Trust Hospital junction",
        "street_address": None,
        "area_district": None,
        "city": "Ernakulam",
        "pin_code": None,
        "gps_hint": None,
        "confidence": 0.75,
    },
    "patient": {
        "age": None,
        "gender": "Male",
        "count": 1,
        "consciousness": "UNCONSCIOUS",
        "breathing": "ABSENT",
        "pulse_present": None,
        "chief_complaint": "Collapsed and unresponsive, not breathing",
        "secondary_symptoms": [],
        "known_conditions": [],
        "mobility": "Immobile",
    },
    "bystanders_present": True,
    "hazards": [],
    "missing_fields": {
        "location_missing": False,
        "exact_address_missing": True,
        "consciousness_unknown": False,
        "breathing_unknown": False,
        "patient_count_unknown": False,
        "caller_identity_unknown": True,
        "incident_type_ambiguous": False,
        "any_hazards_unknown": False,
        "additional_flags": ["age_unknown", "exact_street_missing"],
    },
    "multilingual": {
        "original_language": "en",
        "original_text": "My father collapsed and is not responding. He's not breathing.",
        "english_translation": None,
        "translation_confidence": 1.0,
    },
    "extraction_confidence": 0.95,
}

MOCK_NO_LOCATION_RESPONSE = {
    **MOCK_CARDIAC_RESPONSE,
    "location": {
        "raw_text": None,
        "landmark": None,
        "street_address": None,
        "area_district": None,
        "city": None,
        "pin_code": None,
        "gps_hint": None,
        "confidence": 0.0,
    },
    "missing_fields": {
        "location_missing": True,
        "exact_address_missing": True,
        "consciousness_unknown": False,
        "breathing_unknown": False,
        "patient_count_unknown": False,
        "caller_identity_unknown": True,
        "incident_type_ambiguous": False,
        "any_hazards_unknown": False,
        "additional_flags": [],
    },
}


# ─────────────────────────────────────────────
# UNIT TESTS — Schema Validation
# ─────────────────────────────────────────────

class TestSchemas:
    def test_transcript_input_strip(self):
        t = TranscriptInput(
            transcript_text="  Hello emergency  ",
            session_id="test-session",
        )
        assert t.transcript_text == "Hello emergency"

    def test_schema_default_timestamps_are_timezone_aware_utc(self):
        transcript = TranscriptInput(transcript_text="test")
        incident = EmergencyNLPService._parse_and_map(MOCK_CARDIAC_RESPONSE, transcript)

        assert transcript.timestamp.utcoffset() == timezone.utc.utcoffset(None)
        assert incident.extracted_at.utcoffset() == timezone.utc.utcoffset(None)

    def test_transcript_input_empty_rejected(self):
        with pytest.raises(Exception):
            TranscriptInput(transcript_text="", session_id="x")

    def test_health_distinguishes_model_configuration_from_fallback_only(self, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        service = EmergencyNLPService(anthropic_api_key="test-key-not-used")
        monkeypatch.setattr(api_main, "_nlp_service", service)

        configured = asyncio.run(api_main.health_check())
        assert configured["status"] == "ok"  # process liveness, not provider reachability
        assert configured["provider"] == "anthropic"
        assert configured["model_credentials_configured"] is True
        assert configured["inference_mode"] == "model_with_fallback"
        assert configured["fallback_enabled"] is True
        assert "test-key-not-used" not in json.dumps(configured)

        fallback_service = EmergencyNLPService(anthropic_api_key=None)
        monkeypatch.setattr(api_main, "_nlp_service", fallback_service)
        fallback = asyncio.run(api_main.health_check())
        assert fallback["model_credentials_configured"] is False
        assert fallback["inference_mode"] == "fallback_only"

    def test_extracted_incident_to_module4_payload(self):
        service = EmergencyNLPService.__new__(EmergencyNLPService)
        raw = MOCK_CARDIAC_RESPONSE
        t = make_transcript("test")
        incident = EmergencyNLPService._parse_and_map(raw, t)
        payload = incident.to_module4_payload()

        assert "session_id" in payload
        assert "missing_fields" in payload
        assert "cpr_required" in payload
        assert payload["severity_level"] == "P1"
        assert payload["cpr_required"] is True

    def test_extracted_incident_to_module10_payload(self):
        t = make_transcript("test")
        incident = EmergencyNLPService._parse_and_map(MOCK_CARDIAC_RESPONSE, t)
        payload = incident.to_module10_payload()

        assert payload["trigger_state"] == "ANALYZING"
        assert "extraction_id" in payload
        assert "location" in payload
        assert "severity" in payload

    def test_missing_fields_critical_gap_detection(self):
        t = make_transcript("test")
        incident = EmergencyNLPService._parse_and_map(MOCK_NO_LOCATION_RESPONSE, t)
        assert incident.missing_fields.location_missing is True
        assert incident.missing_fields.has_critical_gaps is True


# ─────────────────────────────────────────────
# UNIT TESTS — Validation & Enrichment Rules
# ─────────────────────────────────────────────

class TestValidationRules:
    def _get_base_incident(self, raw=None) -> ExtractedIncidentData:
        t = make_transcript("test")
        return EmergencyNLPService._parse_and_map(raw or MOCK_CARDIAC_RESPONSE, t)

    def test_unconscious_apneic_escalates_to_p1(self):
        """Rule: UNCONSCIOUS + ABSENT breathing → MUST be P1, regardless of LLM output."""
        raw = {
            **MOCK_CARDIAC_RESPONSE,
            "severity": {
                **MOCK_CARDIAC_RESPONSE["severity"],
                "level": "P2",        # LLM underestimated
                "numeric_score": 6,
                "cpr_required": False,
            },
            "patient": {
                **MOCK_CARDIAC_RESPONSE["patient"],
                "consciousness": "UNCONSCIOUS",
                "breathing": "ABSENT",
            },
        }
        t = make_transcript("test")
        incident = EmergencyNLPService._parse_and_map(raw, t)
        incident = _validate_and_enrich(incident, t)

        assert incident.severity.level == SeverityLevel.CRITICAL
        assert incident.severity.numeric_score >= 9
        assert incident.severity.cpr_required is True
        assert any("AUTO-ESCALATED" in w for w in incident.validation_warnings)

    def test_cpr_required_minimum_p2(self):
        """Rule: CPR required → severity cannot be P3 or P4."""
        raw = {
            **MOCK_CARDIAC_RESPONSE,
            "severity": {
                **MOCK_CARDIAC_RESPONSE["severity"],
                "level": "P3",
                "numeric_score": 3,
                "cpr_required": True,
            },
            "patient": {
                **MOCK_CARDIAC_RESPONSE["patient"],
                "consciousness": "CONSCIOUS",  # avoid rule 1 trigger
                "breathing": "NORMAL",
            },
        }
        t = make_transcript("test")
        incident = EmergencyNLPService._parse_and_map(raw, t)
        incident = _validate_and_enrich(incident, t)

        assert incident.severity.level in (SeverityLevel.CRITICAL, SeverityLevel.HIGH)

    def test_no_location_flags_missing(self):
        """Rule: no location fields → location_missing must be True."""
        t = make_transcript("test")
        incident = EmergencyNLPService._parse_and_map(MOCK_NO_LOCATION_RESPONSE, t)
        incident = _validate_and_enrich(incident, t)
        assert incident.missing_fields.location_missing is True

    def test_low_confidence_flags_ambiguous(self):
        """Rule: extraction_confidence < 0.4 → incident_type_ambiguous=True."""
        raw = {**MOCK_CARDIAC_RESPONSE, "extraction_confidence": 0.3}
        t = make_transcript("test")
        incident = EmergencyNLPService._parse_and_map(raw, t)
        incident = _validate_and_enrich(incident, t)
        assert incident.missing_fields.incident_type_ambiguous is True


# ─────────────────────────────────────────────
# UNIT TESTS — Fallback Logic
# ─────────────────────────────────────────────

class TestFallback:
    def test_fallback_on_api_failure(self):
        t = make_transcript("Help!")
        fallback = _build_fallback_incident(t, "api_error_500")

        assert fallback.incident_category == IncidentCategory.UNKNOWN
        assert fallback.severity.level == SeverityLevel.HIGH   # Conservative
        assert fallback.extraction_confidence == 0.0
        assert fallback.missing_fields.location_missing is True
        assert fallback.missing_fields.incident_type_ambiguous is True
        assert len(fallback.validation_warnings) > 0

    def test_fallback_session_id_preserved(self):
        t = make_transcript("Help!")
        fallback = _build_fallback_incident(t, "test_error")
        assert fallback.session_id == t.session_id

    def test_fallback_never_sets_cpr_required(self):
        """Fallback must never falsely trigger CPR guidance."""
        t = make_transcript("Help!")
        fallback = _build_fallback_incident(t, "test_error")
        assert fallback.severity.cpr_required is False


# ─────────────────────────────────────────────
# INTEGRATION TESTS — LLM (mocked)
# ─────────────────────────────────────────────

class TestLLMExtraction:
    @pytest.fixture
    def service(self):
        return EmergencyNLPService(
            anthropic_api_key="test-key",
            model="claude-sonnet-4-6",
        )

    @patch("anthropic.Anthropic")
    def test_cardiac_arrest_extraction(self, mock_anthropic_cls, service):
        mock_client = MagicMock()
        mock_client.messages.create.return_value = _mock_tool_response(MOCK_CARDIAC_RESPONSE)
        service._client = mock_client

        t = make_transcript(SCENARIOS["cardiac_arrest"]["transcript"])
        result = service.extract(t)

        assert result.incident_category == IncidentCategory.CARDIAC
        assert result.severity.level == SeverityLevel.CRITICAL
        assert result.severity.cpr_required is True
        assert result.patient.consciousness == ConsciousnessState.UNCONSCIOUS
        assert result.patient.breathing == BreathingStatus.ABSENT
        assert result.location.city == "Ernakulam"
        assert result.extraction_confidence > 0.8

    @patch("anthropic.Anthropic")
    def test_no_location_sets_missing_flag(self, mock_anthropic_cls, service):
        mock_client = MagicMock()
        mock_client.messages.create.return_value = _mock_tool_response(MOCK_NO_LOCATION_RESPONSE)
        service._client = mock_client

        t = make_transcript(SCENARIOS["no_location_cardiac"]["transcript"])
        result = service.extract(t)

        assert result.missing_fields.location_missing is True
        assert result.missing_fields.has_critical_gaps is True

    @patch("anthropic.Anthropic")
    def test_api_error_returns_fallback(self, mock_anthropic_cls, service):
        import anthropic as anthropic_module
        mock_client = MagicMock()
        mock_client.messages.create.side_effect = anthropic_module.APIConnectionError(
            request=MagicMock()
        )
        service._client = mock_client

        t = make_transcript("My father collapsed")
        result = service.extract(t)

        # Must return safe fallback, never raise
        assert result.incident_category == IncidentCategory.UNKNOWN
        assert result.extraction_confidence == 0.0
        assert len(result.validation_warnings) > 0

    @patch("anthropic.Anthropic")
    def test_module4_payload_shape(self, mock_anthropic_cls, service):
        mock_client = MagicMock()
        mock_client.messages.create.return_value = _mock_tool_response(MOCK_CARDIAC_RESPONSE)
        service._client = mock_client

        t = make_transcript("test cardiac")
        result = service.extract(t)
        payload = result.to_module4_payload()

        required_keys = [
            "session_id", "incident_category", "severity_level",
            "severity_score", "cpr_required", "patient", "missing_fields",
            "caller_intent", "location_raw"
        ]
        for key in required_keys:
            assert key in payload, f"Missing key in Module 4 payload: {key}"

    @patch("anthropic.Anthropic")
    def test_module10_payload_trigger_state(self, mock_anthropic_cls, service):
        mock_client = MagicMock()
        mock_client.messages.create.return_value = _mock_tool_response(MOCK_CARDIAC_RESPONSE)
        service._client = mock_client

        t = make_transcript("test")
        result = service.extract(t)
        payload = result.to_module10_payload()

        assert payload["trigger_state"] == "ANALYZING"
        assert "extraction_id" in payload
        assert "extracted_at" in payload


# ─────────────────────────────────────────────
# MULTILINGUAL TESTS
# ─────────────────────────────────────────────

class TestMultilingual:
    def test_malayalam_transcript_language_detection(self):
        t = make_transcript(
            SCENARIOS["malayalam_chest_pain"]["transcript"],
            language=DetectedLanguage.MALAYALAM,
        )
        assert t.detected_language == DetectedLanguage.MALAYALAM

    def test_multilingual_meta_english_translation_populated(self):
        raw = {
            **MOCK_CARDIAC_RESPONSE,
            "multilingual": {
                "original_language": "ml",
                "original_text": "എന്റെ അച്ഛന് നെഞ്ചുവേദന",
                "english_translation": "My father has chest pain",
                "translation_confidence": 0.92,
            },
        }
        t = make_transcript("ml transcript", language=DetectedLanguage.MALAYALAM)
        incident = EmergencyNLPService._parse_and_map(raw, t)

        assert incident.multilingual.original_language == DetectedLanguage.MALAYALAM
        assert incident.multilingual.english_translation == "My father has chest pain"
        assert incident.multilingual.translation_confidence == 0.92
