"""
Module 3 — Emergency NLP/LLM: Core Data Schemas
Defines all typed data structures for the incident extraction pipeline.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field, field_validator
import uuid
from datetime import datetime, timezone


# ─────────────────────────────────────────────
# ENUMERATIONS
# ─────────────────────────────────────────────

class IncidentCategory(str, Enum):
    CARDIAC       = "CARDIAC"
    RESPIRATORY   = "RESPIRATORY"
    TRAUMA        = "TRAUMA"
    NEUROLOGICAL  = "NEUROLOGICAL"
    FIRE          = "FIRE"
    ACCIDENT      = "ACCIDENT"
    DROWNING      = "DROWNING"
    POISONING     = "POISONING"
    OBSTETRIC     = "OBSTETRIC"
    PSYCHIATRIC   = "PSYCHIATRIC"
    UNKNOWN       = "UNKNOWN"


class SeverityLevel(str, Enum):
    CRITICAL  = "P1"   # Immediate threat to life
    HIGH      = "P2"   # Urgent, deteriorating
    MODERATE  = "P3"   # Stable but needs attention
    LOW       = "P4"   # Non-urgent


class ConsciousnessState(str, Enum):
    CONSCIOUS       = "CONSCIOUS"
    UNCONSCIOUS     = "UNCONSCIOUS"
    SEMI_CONSCIOUS  = "SEMI_CONSCIOUS"
    UNKNOWN         = "UNKNOWN"


class BreathingStatus(str, Enum):
    NORMAL    = "NORMAL"
    LABORED   = "LABORED"
    ABSENT    = "ABSENT"
    UNKNOWN   = "UNKNOWN"


class DetectedLanguage(str, Enum):
    ENGLISH   = "en"
    MALAYALAM = "ml"
    HINDI     = "hi"
    TAMIL     = "ta"
    KANNADA   = "kn"
    UNKNOWN   = "unknown"


# ─────────────────────────────────────────────
# INPUT SCHEMA  (from Module 2 → Module 3)
# ─────────────────────────────────────────────

class TranscriptInput(BaseModel):
    """
    Payload received from Module 2 (Speech Processing).
    """
    session_id:         str       = Field(default_factory=lambda: str(uuid.uuid4()),
                                          description="Unique call/session identifier")
    transcript_text:    str       = Field(..., min_length=1, max_length=4096,
                                          description="Raw caller transcript from STT")
    detected_language:  Optional[DetectedLanguage] = Field(
                                          default=DetectedLanguage.UNKNOWN,
                                          description="ISO 639-1 language code from STT")
    timestamp:          datetime  = Field(default_factory=lambda: datetime.now(timezone.utc),
                                          description="UTC timestamp of transcript chunk")
    is_final_chunk:     bool      = Field(default=True,
                                          description="False during streaming, True on utterance end")
    caller_phone:       Optional[str] = Field(default=None,
                                          description="Caller phone number if available from telephony")
    cumulative_transcript: Optional[str] = Field(
                                          default=None,
                                          description="Full conversation so far (for multi-turn context)")

    @field_validator("transcript_text")
    @classmethod
    def strip_whitespace(cls, v: str) -> str:
        return v.strip()


# ─────────────────────────────────────────────
# INTERMEDIATE SCHEMAS
# ─────────────────────────────────────────────

class Location(BaseModel):
    raw_text:        Optional[str] = Field(default=None, description="As mentioned by caller")
    landmark:        Optional[str] = Field(default=None, description="Nearest landmark")
    street_address:  Optional[str] = Field(default=None)
    area_district:   Optional[str] = Field(default=None)
    city:            Optional[str] = Field(default=None)
    pin_code:        Optional[str] = Field(default=None)
    gps_hint:        Optional[str] = Field(default=None, description="Any GPS/map reference if stated")
    confidence:      float         = Field(default=0.0, ge=0.0, le=1.0)


class PatientInfo(BaseModel):
    age:                  Optional[int]    = Field(default=None, ge=0, le=130)
    gender:               Optional[str]    = Field(default=None)
    count:                int              = Field(default=1, ge=1, description="Number of patients/victims")
    consciousness:        ConsciousnessState = Field(default=ConsciousnessState.UNKNOWN)
    breathing:            BreathingStatus    = Field(default=BreathingStatus.UNKNOWN)
    pulse_present:        Optional[bool]   = Field(default=None)
    chief_complaint:      Optional[str]    = Field(default=None, description="Primary symptom in English")
    secondary_symptoms:   list[str]        = Field(default_factory=list)
    known_conditions:     list[str]        = Field(default_factory=list,
                                                    description="Pre-existing conditions if mentioned")
    mobility:             Optional[str]    = Field(default=None, description="Mobile / Immobile / Unknown")


class SeverityScore(BaseModel):
    level:            SeverityLevel = Field(..., description="Priority tier")
    numeric_score:    int           = Field(..., ge=1, le=10,
                                           description="1=lowest urgency, 10=maximum critical")
    rationale:        str           = Field(..., description="One-sentence clinical justification")
    key_risk_factors: list[str]     = Field(default_factory=list,
                                           description="Top signals that determined severity")
    cpr_required:     bool          = Field(default=False)
    aed_required:     bool          = Field(default=False)


class MissingFields(BaseModel):
    """
    Flags fed to Module 4 (Dialog Engine) to generate targeted follow-up questions.
    All True = gap that MUST be filled before dispatch decision.
    """
    location_missing:         bool = Field(default=False)
    exact_address_missing:    bool = Field(default=False)
    consciousness_unknown:    bool = Field(default=False)
    breathing_unknown:        bool = Field(default=False)
    patient_count_unknown:    bool = Field(default=False)
    caller_identity_unknown:  bool = Field(default=False)
    incident_type_ambiguous:  bool = Field(default=False)
    any_hazards_unknown:      bool = Field(default=False)   # fire/gas/chemical near scene
    additional_flags:         list[str] = Field(default_factory=list,
                                                description="Other context-specific gaps")

    @property
    def has_critical_gaps(self) -> bool:
        """Returns True if ANY critical question is unanswered."""
        return any([
            self.location_missing,
            self.consciousness_unknown and self.breathing_unknown,
        ])


class MultilingualMeta(BaseModel):
    original_language:      DetectedLanguage = Field(default=DetectedLanguage.UNKNOWN)
    original_text:          str              = Field(default="")
    english_translation:    Optional[str]    = Field(default=None)
    translation_confidence: float            = Field(default=1.0, ge=0.0, le=1.0)


# ─────────────────────────────────────────────
# MASTER OUTPUT SCHEMA  (Module 3 → Modules 4 & 10)
# ─────────────────────────────────────────────

class ExtractedIncidentData(BaseModel):
    """
    Primary output of Module 3.
    Downstream consumers: Module 4 (Conversation Engine), Module 10 (State Engine).
    """
    # Identifiers
    session_id:          str      = Field(..., description="Inherited from TranscriptInput")
    extraction_id:       str      = Field(default_factory=lambda: str(uuid.uuid4()))
    extracted_at:        datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    # Core classification
    incident_category:   IncidentCategory   = Field(..., description="Primary emergency type")
    incident_subcategory: Optional[str]     = Field(default=None,
                                                     description="e.g., 'Ventricular Fibrillation' under CARDIAC")
    severity:            SeverityScore      = Field(...)
    caller_intent:       str                = Field(..., description="One-line summary of what caller wants")

    # Extracted entities
    location:            Location           = Field(default_factory=Location)
    patient:             PatientInfo        = Field(default_factory=PatientInfo)
    bystanders_present:  Optional[bool]     = Field(default=None)
    hazards:             list[str]          = Field(default_factory=list,
                                                    description="Environmental hazards at scene")

    # Gap analysis for Module 4
    missing_fields:      MissingFields      = Field(default_factory=MissingFields)

    # Multilingual
    multilingual:        MultilingualMeta   = Field(default_factory=MultilingualMeta)

    # Quality / confidence
    extraction_confidence: float            = Field(default=0.0, ge=0.0, le=1.0,
                                                    description="Overall LLM confidence in extraction")
    raw_llm_response:    Optional[str]      = Field(default=None, exclude=True,
                                                    description="Raw LLM JSON (debug only, not forwarded)")
    validation_warnings: list[str]          = Field(default_factory=list,
                                                    description="Non-fatal schema validation notes")

    def to_module4_payload(self) -> dict:
        """Slim payload for Module 4 — only fields needed for dialog generation."""
        return {
            "session_id":          self.session_id,
            "incident_category":   self.incident_category.value,
            "severity_level":      self.severity.level.value,
            "severity_score":      self.severity.numeric_score,
            "cpr_required":        self.severity.cpr_required,
            "patient":             self.patient.model_dump(),
            "missing_fields":      self.missing_fields.model_dump(),
            "caller_intent":       self.caller_intent,
            "location_raw":        self.location.raw_text,
        }

    def to_module10_payload(self) -> dict:
        """Full structured payload for Module 10 — State Engine."""
        return {
            "session_id":          self.session_id,
            "extraction_id":       self.extraction_id,
            "incident_category":   self.incident_category.value,
            "severity":            self.severity.model_dump(),
            "location":            self.location.model_dump(),
            "patient":             self.patient.model_dump(),
            "hazards":             self.hazards,
            "missing_fields":      self.missing_fields.model_dump(),
            "extraction_confidence": self.extraction_confidence,
            "extracted_at":        self.extracted_at.isoformat(),
            "trigger_state":       "ANALYZING",   # Module 10 state machine hint
        }
