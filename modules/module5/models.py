"""Shared data models, enums and the structured error type.

Nothing in here talks to an LLM or to HTTP; it is plain data.
"""
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# --------------------------------------------------------------------------
# Errors (always returned to the API caller as {"error": {...}})
# --------------------------------------------------------------------------
class BystanderError(Exception):
    def __init__(self, code: str, message: str, http_status: int = 400,
                 details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message,
                          "details": self.details}}


# --------------------------------------------------------------------------
# Session state machine states
# --------------------------------------------------------------------------
class SessionStatus(str, Enum):
    ACTIVE = "ACTIVE"                                  # started, nothing asked yet
    WAITING_FOR_CALLER = "WAITING_FOR_CALLER"          # a question / info is awaited
    WAITING_FOR_CONFIRMATION = "WAITING_FOR_CONFIRMATION"  # step given, awaiting "done"
    REPEAT_CURRENT_STEP = "REPEAT_CURRENT_STEP"        # transient: re-reading the step
    PAUSED = "PAUSED"                                  # caller asked us to wait
    ESCALATED = "ESCALATED"                            # handed to a human dispatcher
    COMPLETED = "COMPLETED"                            # all steps of the protocol done
    ENDED = "ENDED"                                    # call over


# --------------------------------------------------------------------------
# Structured facts extracted from caller speech (LLM output shape)
# --------------------------------------------------------------------------
BreathingState = Literal["normal", "not_normal", "unknown"]
BleedingState = Literal["none", "present", "unknown"]

# The four facts the protocol selector reasons about.
FACT_FIELDS = ("conscious", "breathing", "choking", "bleeding")


class CallerFacts(BaseModel):
    """Strict schema. Missing fields, wrong types or extra keys are all
    rejected, so a malformed LLM answer can never reach the protocol engine."""
    model_config = ConfigDict(extra="forbid", strict=True)

    incident_type: str
    conscious: bool | None
    breathing: BreathingState
    bleeding: BleedingState
    choking: bool | None
    mechanism: str
    uncertainties: list[str]

    @classmethod
    def unknown(cls) -> "CallerFacts":
        return cls(incident_type="unknown", conscious=None, breathing="unknown",
                   bleeding="unknown", choking=None, mechanism="unknown",
                   uncertainties=[])


# --------------------------------------------------------------------------
# Protocol definition (loaded from protocols/*.json)
# --------------------------------------------------------------------------
class ProtocolStep(BaseModel):
    id: str
    action: str                       # reviewed action identifier
    requires_confirmation: bool
    approved_text: str                # reviewed, caller-friendly wording


class Protocol(BaseModel):
    protocol_id: str
    version: str
    title: str
    reviewed: bool = False            # flip to true ONLY after professional review
    review_notice: str = ""
    steps: list[ProtocolStep]


# --------------------------------------------------------------------------
# Session
# --------------------------------------------------------------------------
def _now() -> datetime:
    return datetime.now(timezone.utc)


class Session(BaseModel):
    session_id: str
    call_id: str
    protocol: str | None = None
    protocol_version: str | None = None
    current_step: int | None = None            # 1-based; None until a protocol is chosen
    status: SessionStatus = SessionStatus.ACTIVE
    completed_steps: list[str] = Field(default_factory=list)   # step ids
    last_instruction: str = ""                 # exact text last given to the caller
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
    # --- bookkeeping ---
    facts: CallerFacts = Field(default_factory=lambda: CallerFacts.unknown())
    pending_field: str | None = None           # which fact we last asked about
    clarification_count: int = 0
    llm_failures: int = 0
    resume_status: SessionStatus | None = None
    escalation_reason: str | None = None
    history: list[str] = Field(default_factory=list)  # state transition log


# --------------------------------------------------------------------------
# API request / response models
# --------------------------------------------------------------------------
class StartRequest(BaseModel):
    call_id: str


class MessageRequest(BaseModel):
    text: str


class ConfirmRequest(BaseModel):
    result: Literal["completed", "not_completed", "unclear", "cannot_do"]


class BystanderResponse(BaseModel):
    """Single response shape used by every session endpoint.

    `instruction_text` is what the call controller sends to TTS.
    """
    session_id: str
    call_id: str
    status: SessionStatus
    event: str                                 # what just happened (see README)
    protocol: str | None = None
    protocol_version: str | None = None
    step: int | None = None                    # 1-based
    total_steps: int | None = None
    action: str | None = None                  # approved action identifier
    instruction_text: str = ""
    wait_for_response: bool = False
    needs_clarification: bool = False
    clarification_field: str | None = None
    escalate: bool = False                     # True => hand over to a human now
    escalation_reason: str | None = None
    facts: CallerFacts | None = None
