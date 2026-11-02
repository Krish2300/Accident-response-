"""
Module 3 — Emergency NLP/LLM Core Service
Handles LLM orchestration, structured extraction, validation, and fallback logic.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Optional

import anthropic
from pydantic import ValidationError

from ..schemas.incident_schema import (
    ExtractedIncidentData,
    TranscriptInput,
    SeverityScore,
    SeverityLevel,
    MissingFields,
    Location,
    PatientInfo,
    MultilingualMeta,
    IncidentCategory,
    ConsciousnessState,
    BreathingStatus,
    DetectedLanguage,
)
from ..prompts.extraction_prompt import (
    EXTRACTION_SYSTEM_PROMPT,
    EXTRACTION_TOOL_SCHEMA,
    INCREMENTAL_SYSTEM_PROMPT,
)

logger = logging.getLogger("module3.nlp_service")


# ─────────────────────────────────────────────
# SAFE FALLBACK — returned when LLM fails entirely
# ─────────────────────────────────────────────

def _build_fallback_incident(
    transcript_input: TranscriptInput,
    error_reason: str,
) -> ExtractedIncidentData:
    """
    Conservative fallback that never hallucinates.
    Treats all unknowns as critical gaps, escalates to P2 by default
    so the system never silently drops a call.
    """
    logger.error("Falling back to safe default extraction. Reason: %s", error_reason)
    return ExtractedIncidentData(
        session_id=transcript_input.session_id,
        incident_category=IncidentCategory.UNKNOWN,
        severity=SeverityScore(
            level=SeverityLevel.HIGH,   # Conservative — treat as HIGH when unknown
            numeric_score=6,
            rationale="Fallback: LLM extraction failed. Defaulting to HIGH severity for safety.",
            key_risk_factors=["extraction_failure"],
            cpr_required=False,
            aed_required=False,
        ),
        caller_intent="Emergency call received — automated extraction failed, human review required.",
        location=Location(raw_text=None, confidence=0.0),
        patient=PatientInfo(
            consciousness=ConsciousnessState.UNKNOWN,
            breathing=BreathingStatus.UNKNOWN,
        ),
        missing_fields=MissingFields(
            location_missing=True,
            consciousness_unknown=True,
            breathing_unknown=True,
            patient_count_unknown=True,
            incident_type_ambiguous=True,
            additional_flags=[f"extraction_error: {error_reason}"],
        ),
        multilingual=MultilingualMeta(
            original_language=transcript_input.detected_language or DetectedLanguage.UNKNOWN,
            original_text=transcript_input.transcript_text,
        ),
        extraction_confidence=0.0,
        validation_warnings=[f"FALLBACK TRIGGERED: {error_reason}"],
    )


# ─────────────────────────────────────────────
# POST-EXTRACTION VALIDATION & ENRICHMENT
# ─────────────────────────────────────────────

def _validate_and_enrich(
    data: ExtractedIncidentData,
    original_input: TranscriptInput,
) -> ExtractedIncidentData:
    """
    Rule-based post-processing layer.
    Catches LLM inconsistencies and enforces domain logic.
    """
    warnings: list[str] = list(data.validation_warnings)

    # Rule 1: Unconscious + not breathing → must be at least P1
    if (
        data.patient.consciousness == ConsciousnessState.UNCONSCIOUS
        and data.patient.breathing == BreathingStatus.ABSENT
        and data.severity.level not in (SeverityLevel.CRITICAL,)
    ):
        warnings.append("AUTO-ESCALATED: Unconscious + absent breathing → P1 override")
        data.severity.level = SeverityLevel.CRITICAL
        data.severity.numeric_score = max(data.severity.numeric_score, 9)
        data.severity.cpr_required = True
        data.severity.key_risk_factors.append("auto_escalation_rule_unconscious_apneic")

    # Rule 2: CPR flagged → severity cannot be below P2
    if data.severity.cpr_required and data.severity.level not in (
        SeverityLevel.CRITICAL, SeverityLevel.HIGH
    ):
        warnings.append("AUTO-ESCALATED: CPR required → minimum P2")
        data.severity.level = SeverityLevel.HIGH
        data.severity.numeric_score = max(data.severity.numeric_score, 5)

    # Rule 3: Sync missing_fields.consciousness_unknown with patient state
    if data.patient.consciousness == ConsciousnessState.UNKNOWN:
        data.missing_fields.consciousness_unknown = True
    if data.patient.breathing == BreathingStatus.UNKNOWN:
        data.missing_fields.breathing_unknown = True

    # Rule 4: No location at all → flag it
    loc = data.location
    if not any([loc.raw_text, loc.landmark, loc.street_address, loc.city]):
        data.missing_fields.location_missing = True

    # Rule 5: Confidence guard — low confidence forces HIGH gap flags
    if data.extraction_confidence < 0.4:
        warnings.append("LOW CONFIDENCE extraction — treating category as ambiguous")
        data.missing_fields.incident_type_ambiguous = True

    data.validation_warnings = warnings
    return data


# ─────────────────────────────────────────────
# CORE EXTRACTION SERVICE
# ─────────────────────────────────────────────

class EmergencyNLPService:
    """
    Module 3: Emergency NLP/LLM Extraction Service.

    Consumes TranscriptInput from Module 2.
    Produces ExtractedIncidentData for Modules 4 & 10.
    """

    def __init__(
        self,
        anthropic_api_key: Optional[str] = None,
        model: str = "claude-sonnet-4-6",
        max_tokens: int = 2048,
        max_retries: int = 2,
        timeout_seconds: float = 8.0,
    ) -> None:
        self.model = model
        self.max_tokens = max_tokens
        self.max_retries = max_retries
        self.timeout = timeout_seconds

        # Report configuration without exposing the credential or claiming that
        # the remote provider is reachable. The SDK otherwise reads this env var
        # implicitly when the explicit argument is omitted.
        api_key = anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
        self.inference_configured = bool(api_key)

        self._client = anthropic.Anthropic(
            api_key=api_key
        )
        logger.info("EmergencyNLPService initialized — model=%s", model)

    # ── Public Interface ──────────────────────────────────────────────────

    def extract(self, transcript_input: TranscriptInput) -> ExtractedIncidentData:
        """
        Primary extraction method. Synchronous. Called by FastAPI endpoint.
        Returns ExtractedIncidentData or a safe fallback on any failure.
        """
        t0 = time.perf_counter()
        try:
            raw_json = self._call_llm_with_retry(transcript_input)
            incident = self._parse_and_map(raw_json, transcript_input)
            incident = _validate_and_enrich(incident, transcript_input)
            elapsed = time.perf_counter() - t0
            logger.info(
                "Extraction OK session=%s category=%s severity=%s confidence=%.2f elapsed=%.2fs",
                incident.session_id,
                incident.incident_category,
                incident.severity.level,
                incident.extraction_confidence,
                elapsed,
            )
            return incident

        except anthropic.APIConnectionError as exc:
            logger.error("Anthropic connection error: %s", exc)
            return _build_fallback_incident(transcript_input, f"API connection error: {exc}")
        except anthropic.RateLimitError as exc:
            logger.error("Anthropic rate limit hit: %s", exc)
            return _build_fallback_incident(transcript_input, "rate_limit")
        except anthropic.APIStatusError as exc:
            logger.error("Anthropic API error status=%s body=%s", exc.status_code, exc.message)
            return _build_fallback_incident(transcript_input, f"api_error_{exc.status_code}")
        except (KeyError, ValueError, ValidationError) as exc:
            logger.error("Schema validation error: %s", exc)
            return _build_fallback_incident(transcript_input, f"schema_error: {exc}")
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected extraction failure: %s", exc)
            return _build_fallback_incident(transcript_input, f"unexpected: {type(exc).__name__}")

    # ── LLM Interaction ───────────────────────────────────────────────────

    def _call_llm_with_retry(self, transcript_input: TranscriptInput) -> dict:
        """
        Calls Claude with tool-use schema. Retries up to max_retries times
        on transient failures. Returns the raw extracted dict from tool_use block.
        """
        system_prompt = (
            INCREMENTAL_SYSTEM_PROMPT
            if not transcript_input.is_final_chunk
            else EXTRACTION_SYSTEM_PROMPT
        )

        user_message = self._build_user_message(transcript_input)

        last_exc: Optional[Exception] = None
        for attempt in range(1, self.max_retries + 1):
            try:
                response = self._client.messages.create(
                    model=self.model,
                    max_tokens=self.max_tokens,
                    system=system_prompt,
                    tools=EXTRACTION_TOOL_SCHEMA,
                    tool_choice={"type": "any"},   # Force tool use — no prose output
                    messages=[{"role": "user", "content": user_message}],
                )
                return self._extract_tool_result(response)
            except (anthropic.APIConnectionError, anthropic.InternalServerError) as exc:
                last_exc = exc
                logger.warning("Attempt %d/%d failed: %s", attempt, self.max_retries, exc)
                time.sleep(0.5 * attempt)   # Backoff

        raise last_exc  # type: ignore[misc]

    @staticmethod
    def _build_user_message(t: TranscriptInput) -> str:
        """Constructs the user-turn message sent to the LLM."""
        parts = [
            f"**SESSION ID**: {t.session_id}",
            f"**DETECTED LANGUAGE**: {t.detected_language.value if t.detected_language else 'unknown'}",
            f"**TRANSCRIPT** (is_final={t.is_final_chunk}):",
            f'"{t.transcript_text}"',
        ]
        if t.cumulative_transcript and t.cumulative_transcript != t.transcript_text:
            parts += [
                "",
                "**FULL CONVERSATION SO FAR** (for context):",
                f'"{t.cumulative_transcript}"',
            ]
        return "\n".join(parts)

    @staticmethod
    def _extract_tool_result(response: anthropic.types.Message) -> dict:
        """
        Pulls the `extract_incident_data` tool_use input block from the response.
        Raises ValueError if the model deviated from forced tool-use.
        """
        for block in response.content:
            if block.type == "tool_use" and block.name == "extract_incident_data":
                return block.input  # Already a dict (Anthropic SDK parses JSON)
        # Fallback: try to parse any JSON from text blocks (shouldn't happen with tool_choice=any)
        for block in response.content:
            if block.type == "text":
                try:
                    return json.loads(block.text)
                except json.JSONDecodeError:
                    pass
        raise ValueError("LLM did not return expected tool_use block")

    # ── Schema Mapping ────────────────────────────────────────────────────

    @staticmethod
    def _parse_and_map(raw: dict, t: TranscriptInput) -> ExtractedIncidentData:
        """
        Maps LLM raw output dict → validated ExtractedIncidentData Pydantic model.
        All field coercions and type casting happen here.
        """
        sev_raw = raw["severity"]
        loc_raw = raw["location"]
        pat_raw = raw["patient"]
        mf_raw  = raw["missing_fields"]
        ml_raw  = raw["multilingual"]

        return ExtractedIncidentData(
            session_id=t.session_id,
            incident_category=IncidentCategory(raw["incident_category"]),
            incident_subcategory=raw.get("incident_subcategory"),
            caller_intent=raw["caller_intent"],
            severity=SeverityScore(
                level=SeverityLevel(sev_raw["level"]),
                numeric_score=int(sev_raw["numeric_score"]),
                rationale=sev_raw["rationale"],
                key_risk_factors=sev_raw.get("key_risk_factors", []),
                cpr_required=bool(sev_raw.get("cpr_required", False)),
                aed_required=bool(sev_raw.get("aed_required", False)),
            ),
            location=Location(
                raw_text=loc_raw.get("raw_text"),
                landmark=loc_raw.get("landmark"),
                street_address=loc_raw.get("street_address"),
                area_district=loc_raw.get("area_district"),
                city=loc_raw.get("city"),
                pin_code=loc_raw.get("pin_code"),
                gps_hint=loc_raw.get("gps_hint"),
                confidence=float(loc_raw.get("confidence", 0.0)),
            ),
            patient=PatientInfo(
                age=pat_raw.get("age"),
                gender=pat_raw.get("gender"),
                count=int(pat_raw.get("count", 1)),
                consciousness=ConsciousnessState(
                    pat_raw.get("consciousness", "UNKNOWN")
                ),
                breathing=BreathingStatus(
                    pat_raw.get("breathing", "UNKNOWN")
                ),
                pulse_present=pat_raw.get("pulse_present"),
                chief_complaint=pat_raw.get("chief_complaint"),
                secondary_symptoms=pat_raw.get("secondary_symptoms", []),
                known_conditions=pat_raw.get("known_conditions", []),
                mobility=pat_raw.get("mobility"),
            ),
            bystanders_present=raw.get("bystanders_present"),
            hazards=raw.get("hazards", []),
            missing_fields=MissingFields(
                location_missing=bool(mf_raw.get("location_missing", False)),
                exact_address_missing=bool(mf_raw.get("exact_address_missing", False)),
                consciousness_unknown=bool(mf_raw.get("consciousness_unknown", False)),
                breathing_unknown=bool(mf_raw.get("breathing_unknown", False)),
                patient_count_unknown=bool(mf_raw.get("patient_count_unknown", False)),
                caller_identity_unknown=bool(mf_raw.get("caller_identity_unknown", False)),
                incident_type_ambiguous=bool(mf_raw.get("incident_type_ambiguous", False)),
                any_hazards_unknown=bool(mf_raw.get("any_hazards_unknown", False)),
                additional_flags=mf_raw.get("additional_flags", []),
            ),
            multilingual=MultilingualMeta(
                original_language=DetectedLanguage(
                    ml_raw.get("original_language", "unknown")
                ),
                original_text=ml_raw.get("original_text", t.transcript_text),
                english_translation=ml_raw.get("english_translation"),
                translation_confidence=float(ml_raw.get("translation_confidence", 1.0)),
            ),
            extraction_confidence=float(raw.get("extraction_confidence", 0.0)),
            raw_llm_response=json.dumps(raw),
        )
