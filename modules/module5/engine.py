"""Deterministic protocol engine.

This module NEVER imports or calls an LLM. It receives already-validated
CallerFacts (or plain caller text for in-protocol replies) and decides, with
plain Python rules, which protocol to run and which step to speak next.

Everything a caller hears comes from one of:
  * approved step text in protocols/*.json          (medical content)
  * the fixed, non-medical prompts defined below    (questions / hand-over)
"""
import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from pydantic import ValidationError

from models import (FACT_FIELDS, BystanderError, BystanderResponse, CallerFacts,
                    Protocol, ProtocolStep, Session, SessionStatus, _now)

S = SessionStatus

# --------------------------------------------------------------------------
# Fixed caller-facing prompts.
# REVIEW: these are information-gathering / hand-over sentences, not treatment,
# but they are spoken to a real caller, so they need review too.
# Yes/No answers are interpreted using the wording below ("yes" = the thing asked).
# --------------------------------------------------------------------------
START_PROMPT = "Tell me what has happened."
QUESTIONS = {
    "description": "Tell me what has happened.",
    "conscious": "Is the person awake and answering you?",
    "breathing": "Is the person breathing normally?",
    "choking": "Is the person choking on something?",
    "bleeding": "Is there any bleeding?",
}
CONTRADICTION_PREFIX = "I want to make sure I understood."
ESCALATION_TEXT = "Please stay on the line. An emergency operator will help you now."
PAUSE_TEXT = "Okay. I will wait. Say something when you are ready."
COMPLETED_TEXT = "That was the last step. Please stay on the line with the emergency operator."
UNCLEAR_PREFIX = "Sorry, I did not understand."
NOT_DONE_PREFIX = "Okay, take your time."

MAX_CLARIFICATIONS = 3   # after this many questions we stop asking and escalate

# --------------------------------------------------------------------------
# State machine
# --------------------------------------------------------------------------
ALLOWED_TRANSITIONS: dict[SessionStatus, set[SessionStatus]] = {
    S.ACTIVE: {S.WAITING_FOR_CALLER, S.WAITING_FOR_CONFIRMATION, S.PAUSED, S.ESCALATED, S.ENDED},
    S.WAITING_FOR_CALLER: {S.WAITING_FOR_CALLER, S.WAITING_FOR_CONFIRMATION, S.REPEAT_CURRENT_STEP,
                           S.PAUSED, S.ESCALATED, S.COMPLETED, S.ENDED},
    S.WAITING_FOR_CONFIRMATION: {S.WAITING_FOR_CALLER, S.WAITING_FOR_CONFIRMATION,
                                 S.REPEAT_CURRENT_STEP, S.PAUSED, S.ESCALATED, S.COMPLETED, S.ENDED},
    S.REPEAT_CURRENT_STEP: {S.WAITING_FOR_CALLER, S.WAITING_FOR_CONFIRMATION, S.ESCALATED, S.ENDED},
    S.PAUSED: {S.WAITING_FOR_CALLER, S.WAITING_FOR_CONFIRMATION, S.ESCALATED, S.ENDED},
    S.ESCALATED: {S.ENDED},
    S.COMPLETED: {S.ENDED},
    S.ENDED: set(),
}
WAITING_STATES = {S.WAITING_FOR_CALLER, S.WAITING_FOR_CONFIRMATION}


# --------------------------------------------------------------------------
# Fact handling (pure functions)
# --------------------------------------------------------------------------
def is_unknown(facts: CallerFacts, field: str) -> bool:
    return getattr(facts, field) in (None, "unknown")


def _set_unknown(data: dict, field: str) -> None:
    data[field] = "unknown" if field in ("breathing", "bleeding") else None


def normalise_facts(facts: CallerFacts) -> CallerFacts:
    """Anything the LLM itself flagged as uncertain is treated as unknown."""
    data = facts.model_dump()
    for name in facts.uncertainties:
        if name in FACT_FIELDS:
            _set_unknown(data, name)
    data["incident_type"] = (data["incident_type"] or "").strip().lower() or "unknown"
    data["mechanism"] = (data["mechanism"] or "").strip().lower() or "unknown"
    return CallerFacts(**data)


def detect_contradictions(facts: CallerFacts) -> list[str]:
    """Fields that cannot both be trusted."""
    if facts.conscious is False and facts.choking is True:
        return ["conscious", "choking"]
    return []


def merge_facts(old: CallerFacts, new: CallerFacts) -> tuple[CallerFacts, list[str]]:
    """Combine facts across turns. Known-vs-known disagreement is a conflict:
    the field is reset to unknown (we never pick a side) and reported."""
    data = old.model_dump()
    conflicts: list[str] = []
    for f in FACT_FIELDS:
        if is_unknown(new, f):
            continue
        if is_unknown(old, f):
            data[f] = getattr(new, f)
        elif getattr(old, f) != getattr(new, f):
            conflicts.append(f)
            _set_unknown(data, f)
    for f in ("incident_type", "mechanism"):
        if data[f] in ("unknown", "") and getattr(new, f) not in ("unknown", ""):
            data[f] = getattr(new, f)
    data["uncertainties"] = list(new.uncertainties)
    merged = CallerFacts(**data)
    for f in detect_contradictions(merged):
        if f not in conflicts:
            conflicts.append(f)
        _set_unknown(data, f)
    merged = CallerFacts(**data)
    conflicts.sort(key=FACT_FIELDS.index)
    return merged, conflicts


# --------------------------------------------------------------------------
# Protocol selection (deterministic, no LLM)
# --------------------------------------------------------------------------
@dataclass
class Selection:
    protocol_id: str | None = None      # run this protocol
    ask_field: str | None = None        # need this fact first
    escalate_reason: str | None = None  # no safe automatic choice
    reason: str = ""


def select_protocol(facts: CallerFacts) -> Selection:
    """Pure function: facts in, decision out. Never guesses."""
    if facts.choking is True:
        return Selection(protocol_id="CHOKING", reason="choking reported")

    if facts.conscious is False:
        if facts.breathing == "not_normal":
            return Selection(protocol_id="CPR", reason="unresponsive, breathing not normal")
        if facts.breathing == "normal":
            return Selection(protocol_id="UNCONSCIOUS_BREATHING",
                             reason="unresponsive, breathing normally")
        return Selection(ask_field="breathing", reason="unresponsive, breathing unknown")

    if facts.bleeding == "present":
        return Selection(protocol_id="SEVERE_BLEEDING", reason="bleeding reported")

    if facts.conscious is None:
        if facts.incident_type == "unknown":
            return Selection(ask_field="description", reason="nothing understood yet")
        return Selection(ask_field="conscious", reason="consciousness unknown")

    # conscious is True from here on
    if facts.breathing == "not_normal" and facts.choking is None:
        return Selection(ask_field="choking", reason="awake, breathing not normal")
    if facts.bleeding == "unknown":
        return Selection(ask_field="bleeding", reason="awake, bleeding unknown")
    return Selection(escalate_reason="NO_MATCHING_PROTOCOL",
                     reason="facts do not match any available protocol")


# --------------------------------------------------------------------------
# In-protocol caller reply classification (deterministic keywords)
# --------------------------------------------------------------------------
_REPEAT = re.compile(
    r"\b(repeat|pardon|come again)\b|say (that|it) again|what did you say|"
    r"(didn'?t|did not|couldn'?t|could not|can'?t|cannot) (hear|catch|understand)|"
    r"^\W*(what|sorry|huh)\W*$")
_CANNOT = re.compile(
    r"\bi (can'?t|cannot|can not|am unable|won'?t)\b|\b(unable|can'?t|cannot) do (it|this|that)\b|"
    r"\bnobody\b|no one (is )?(here|around)")
_PAUSE = re.compile(r"\b(wait|hold on|(one|just a|give me a) (sec|second|moment|minute))\b")
_NOT_DONE = re.compile(r"\b(not yet|haven'?t|have not|hasn'?t|not done|didn'?t|did not|no)\b")
_DONE = re.compile(r"\b(done|finished|completed|did it|i did|yes|yeah|yep)\b")


def _clean(text: str) -> str:
    return text.lower().replace("\u2019", "'").strip()


def is_repeat_request(text: str) -> bool:
    return bool(_REPEAT.search(_clean(text)))


def classify_response(text: str) -> str:
    """-> repeat | cannot | pause | not_done | done | unclear"""
    t = _clean(text)
    if _REPEAT.search(t):
        return "repeat"
    if _CANNOT.search(t):
        return "cannot"
    if _PAUSE.search(t):
        return "pause"
    if _NOT_DONE.search(t):
        return "not_done"
    if _DONE.search(t):
        return "done"
    return "unclear"


# --------------------------------------------------------------------------
# Session store (in-memory; same interface could be backed by Redis/Postgres)
# --------------------------------------------------------------------------
class InMemorySessionStore:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}

    def create(self, call_id: str) -> Session:
        session = Session(session_id=f"SESSION-{uuid.uuid4().hex[:8].upper()}", call_id=call_id)
        self.sessions[session.session_id] = session
        return session

    def get(self, session_id: str) -> Session:
        try:
            return self.sessions[session_id]
        except KeyError:
            raise BystanderError("SESSION_NOT_FOUND", f"No session with id '{session_id}'.", 404)

    def save(self, session: Session) -> None:
        self.sessions[session.session_id] = session

    def clear(self) -> None:
        self.sessions.clear()


# --------------------------------------------------------------------------
# The engine
# --------------------------------------------------------------------------
class ProtocolEngine:
    def __init__(self, protocol_dir: str | Path, require_reviewed: bool = False,
                 renderer: Callable[[str, str], str] | None = None):
        """`renderer(approved_text, action_id)` may reword approved text; default
        is identity. The engine picks the action; the renderer cannot."""
        self.protocol_dir = Path(protocol_dir)
        self.require_reviewed = require_reviewed
        self.renderer = renderer or (lambda text, action: text)
        self.protocols: dict[str, Protocol] = {}
        self.load_protocols()

    # ---- protocol storage -------------------------------------------------
    def load_protocols(self) -> None:
        self.protocols = {}
        for path in sorted(self.protocol_dir.glob("*.json")):
            try:
                protocol = Protocol.model_validate(json.loads(path.read_text(encoding="utf-8")))
            except (ValidationError, json.JSONDecodeError) as exc:
                raise BystanderError("PROTOCOL_FILE_INVALID", f"{path.name}: {exc}", 500)
            ids = [s.id for s in protocol.steps]
            if not ids or len(ids) != len(set(ids)):
                raise BystanderError("PROTOCOL_FILE_INVALID",
                                     f"{path.name}: needs >=1 step and unique step ids.", 500)
            if protocol.protocol_id in self.protocols:
                raise BystanderError("PROTOCOL_FILE_INVALID",
                                     f"{path.name}: duplicate protocol_id.", 500)
            self.protocols[protocol.protocol_id] = protocol

    def get_protocol(self, protocol_id: str) -> Protocol:
        try:
            return self.protocols[protocol_id]
        except KeyError:
            raise BystanderError("PROTOCOL_NOT_FOUND", f"Unknown protocol '{protocol_id}'.", 404)

    # ---- helpers ----------------------------------------------------------
    def transition(self, session: Session, new: SessionStatus) -> None:
        if new not in ALLOWED_TRANSITIONS[session.status]:
            raise BystanderError(
                "INVALID_STATE_TRANSITION",
                f"Cannot go from {session.status.value} to {new.value}.", 409,
                {"from": session.status.value, "to": new.value})
        session.history.append(f"{session.status.value}->{new.value}")
        session.status = new
        self._touch(session)

    @staticmethod
    def _touch(session: Session) -> None:
        session.updated_at = _now()

    def current_step(self, session: Session) -> ProtocolStep:
        if session.protocol is None or session.current_step is None:
            raise BystanderError("NO_ACTIVE_PROTOCOL",
                                 "No protocol has been selected for this session yet.", 409)
        return self.get_protocol(session.protocol).steps[session.current_step - 1]

    def _response(self, session: Session, event: str, instruction: str, **kw) -> BystanderResponse:
        protocol = self.protocols.get(session.protocol) if session.protocol else None
        step = None
        if protocol is not None and session.current_step is not None:
            step = protocol.steps[session.current_step - 1]
        kw.setdefault("action", step.action if step else None)
        return BystanderResponse(
            session_id=session.session_id, call_id=session.call_id, status=session.status,
            event=event, protocol=session.protocol, protocol_version=session.protocol_version,
            step=session.current_step, total_steps=len(protocol.steps) if protocol else None,
            instruction_text=instruction, facts=session.facts, **kw)

    def _require_open(self, session: Session) -> None:
        if session.status in (S.ENDED, S.COMPLETED, S.ESCALATED):
            raise BystanderError("SESSION_NOT_ACTIVE",
                                 f"Session is {session.status.value}.", 409,
                                 {"status": session.status.value})

    # ---- session lifecycle ------------------------------------------------
    def start_session(self, store: InMemorySessionStore, call_id: str) -> BystanderResponse:
        if not call_id or not call_id.strip():
            raise BystanderError("INVALID_CALL_ID", "call_id must not be empty.", 422)
        session = store.create(call_id.strip())
        session.last_instruction = START_PROMPT
        session.pending_field = "description"
        return self._response(session, "SESSION_STARTED", START_PROMPT, wait_for_response=True)

    def end(self, session: Session) -> BystanderResponse:
        self.transition(session, S.ENDED)
        return self._response(session, "CALL_ENDED", "", wait_for_response=False)

    def escalate(self, session: Session, reason: str) -> BystanderResponse:
        self.transition(session, S.ESCALATED)
        session.escalation_reason = reason
        session.last_instruction = ESCALATION_TEXT
        session.resume_status = None
        return self._response(session, "ESCALATED", ESCALATION_TEXT,
                              escalate=True, escalation_reason=reason)

    # ---- protocol start / step delivery -----------------------------------
    def start_protocol(self, session: Session, protocol_id: str) -> BystanderResponse:
        """Raises PROTOCOL_NOT_FOUND / PROTOCOL_NOT_REVIEWED for bad ids."""
        protocol = self.get_protocol(protocol_id)
        if self.require_reviewed and not protocol.reviewed:
            raise BystanderError("PROTOCOL_NOT_REVIEWED",
                                 f"Protocol '{protocol_id}' is not marked reviewed.", 409)
        session.protocol = protocol.protocol_id
        session.protocol_version = protocol.version
        session.current_step = 1
        session.completed_steps = []
        session.pending_field = None
        return self._deliver_step(session, "PROTOCOL_STARTED")

    def _deliver_step(self, session: Session, event: str) -> BystanderResponse:
        step = self.current_step(session)
        text = self.renderer(step.approved_text, step.action)
        session.last_instruction = text
        self.transition(session, S.WAITING_FOR_CONFIRMATION if step.requires_confirmation
                        else S.WAITING_FOR_CALLER)
        return self._response(session, event, text, wait_for_response=True)

    def _advance(self, session: Session) -> BystanderResponse:
        step = self.current_step(session)
        protocol = self.get_protocol(session.protocol)
        session.completed_steps.append(step.id)
        if session.current_step >= len(protocol.steps):
            session.last_instruction = COMPLETED_TEXT
            self.transition(session, S.COMPLETED)
            return self._response(session, "PROTOCOL_COMPLETED", COMPLETED_TEXT,
                                  wait_for_response=False)
        session.current_step += 1
        return self._deliver_step(session, "STEP_ADVANCED")

    # ---- caller facts (pre-protocol) --------------------------------------
    def handle_facts(self, session: Session, new_facts: CallerFacts) -> BystanderResponse:
        """Feed VALIDATED facts in; get protocol start / question / escalation out."""
        self._require_open(session)
        if session.protocol is not None:
            raise BystanderError("PROTOCOL_ALREADY_ACTIVE",
                                 "A protocol is already running; facts cannot change it.", 409)
        merged, conflicts = merge_facts(session.facts, normalise_facts(new_facts))
        session.facts = merged

        if conflicts:
            ask, event = conflicts[0], "CONTRADICTION"
            prefix = CONTRADICTION_PREFIX + " "
        else:
            sel = select_protocol(merged)
            if sel.protocol_id:
                try:
                    return self.start_protocol(session, sel.protocol_id)
                except BystanderError as exc:
                    if exc.code in ("PROTOCOL_NOT_FOUND", "PROTOCOL_NOT_REVIEWED"):
                        return self.escalate(session, exc.code)   # never leave caller hanging
                    raise
            if sel.escalate_reason:
                return self.escalate(session, sel.escalate_reason)
            ask, event, prefix = sel.ask_field, "CLARIFICATION_NEEDED", ""

        if session.clarification_count >= MAX_CLARIFICATIONS:
            return self.escalate(session, "TOO_MANY_CLARIFICATIONS")
        session.clarification_count += 1
        session.pending_field = ask
        text = prefix + QUESTIONS[ask]
        session.last_instruction = text
        self.transition(session, S.WAITING_FOR_CALLER)
        return self._response(session, event, text, wait_for_response=True,
                              needs_clarification=True, clarification_field=ask)

    # ---- repeat -----------------------------------------------------------
    def repeat(self, session: Session) -> BystanderResponse:
        """Re-speak the exact last instruction. Never touches step/completed_steps."""
        if session.status == S.ENDED:
            raise BystanderError("INVALID_STATE_TRANSITION", "Session has ended.", 409)
        if session.status == S.PAUSED:
            self.transition(session, session.resume_status or S.WAITING_FOR_CALLER)
            session.resume_status = None
        elif session.status in WAITING_STATES:
            previous = session.status
            self.transition(session, S.REPEAT_CURRENT_STEP)
            self.transition(session, previous)
        waiting = session.status in WAITING_STATES or session.status == S.ACTIVE
        return self._response(session, "REPEATED", session.last_instruction,
                              wait_for_response=waiting)

    # ---- confirm ----------------------------------------------------------
    def confirm(self, session: Session, result: str) -> BystanderResponse:
        if session.protocol is None:
            raise BystanderError("NO_ACTIVE_PROTOCOL",
                                 "Nothing to confirm: no protocol step is active.", 409)
        if session.status not in WAITING_STATES:
            raise BystanderError("INVALID_STATE_TRANSITION",
                                 f"Cannot confirm while {session.status.value}.", 409,
                                 {"status": session.status.value})
        if result == "completed":
            return self._advance(session)
        if result == "cannot_do":
            return self.escalate(session, "CALLER_CANNOT_PERFORM_STEP")
        # not_completed / unclear: never advance, ask again
        prefix = NOT_DONE_PREFIX if result == "not_completed" else UNCLEAR_PREFIX
        return self._response(session, "STEP_NOT_CONFIRMED",
                              f"{prefix} {session.last_instruction}",
                              wait_for_response=True, needs_clarification=True)

    # ---- caller reply during a protocol -----------------------------------
    def handle_caller_response(self, session: Session, text: str) -> BystanderResponse:
        """Caller speech while a protocol is running. Keyword rules only; the LLM
        is not involved, so nothing said here can invent or skip a step."""
        self._require_open(session)
        if session.protocol is None:
            raise BystanderError("NO_ACTIVE_PROTOCOL", "No protocol is running.", 409)
        intent = classify_response(text)

        if session.status == S.PAUSED:                 # any speech resumes
            if intent == "cannot":
                return self.escalate(session, "CALLER_CANNOT_PERFORM_STEP")
            response = self.repeat(session)
            response.event = "RESUMED"
            return response
        if intent == "repeat":
            return self.repeat(session)
        if intent == "cannot":
            return self.escalate(session, "CALLER_CANNOT_PERFORM_STEP")
        if intent == "pause":
            session.resume_status = session.status
            self.transition(session, S.PAUSED)
            return self._response(session, "PAUSED", PAUSE_TEXT, wait_for_response=True)
        if intent == "done":
            return self.confirm(session, "completed")
        return self.confirm(session, "not_completed" if intent == "not_done" else "unclear")
