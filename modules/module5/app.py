"""FastAPI entry point for the Bystander Assistance Engine.

Run:  uvicorn app:app --reload
No telephony code lives here: a call controller (Asterisk/Twilio/Exotel/...)
calls this API with caller text and speaks back `instruction_text` via TTS.
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

load_dotenv()  # reads .env (never committed); real env vars still win

import llm  # noqa: E402  (after load_dotenv on purpose)
from engine import (QUESTIONS, InMemorySessionStore, ProtocolEngine,  # noqa: E402
                    is_repeat_request)
from models import (BystanderError, BystanderResponse, ConfirmRequest,  # noqa: E402
                    MessageRequest, Session, StartRequest)

BASE_DIR = Path(__file__).parent
MAX_LLM_FAILURES = 2          # consecutive LLM failures before handing to a human
RETRY_TEXT = "Sorry, I did not catch that. Please tell me again what has happened."

store = InMemorySessionStore()
engine = ProtocolEngine(
    BASE_DIR / "protocols",
    require_reviewed=llm._env_bool("REQUIRE_REVIEWED_PROTOCOLS", False),
    # look up at call time so the renderer/mocks can be swapped in tests
    renderer=lambda text, action: llm.render_instruction(text, action),
)

app = FastAPI(title="Bystander Assistance Engine", version="0.1.0",
              description="PROTOTYPE. Placeholder protocols. Not for real emergency use.")


# --------------------------------------------------------------------------
# Structured errors
# --------------------------------------------------------------------------
@app.exception_handler(BystanderError)
async def bystander_error_handler(_: Request, exc: BystanderError) -> JSONResponse:
    return JSONResponse(status_code=exc.http_status, content=exc.to_dict())


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    err = BystanderError("REQUEST_VALIDATION_ERROR", "Request body/params are invalid.", 422,
                         {"errors": jsonable_encoder(exc.errors())})
    return JSONResponse(status_code=422, content=err.to_dict())


# --------------------------------------------------------------------------
# Core message flow (LLM only ever produces validated facts)
# --------------------------------------------------------------------------
def process_message(session: Session, text: str) -> BystanderResponse:
    text = (text or "").strip()
    if not text:
        raise BystanderError("EMPTY_MESSAGE", "Caller message is empty.", 422)
    engine._require_open(session)

    # "Can you repeat that?" is handled without the LLM and never advances anything.
    if is_repeat_request(text):
        return engine.repeat(session)

    if session.protocol is not None:
        return engine.handle_caller_response(session, text)

    # No protocol yet: use the LLM to understand the caller.
    try:
        facts = llm.understand_caller(text, asked_about=QUESTIONS.get(session.pending_field or ""))
    except BystanderError as exc:            # LLMError is a BystanderError
        session.llm_failures += 1
        if session.llm_failures >= MAX_LLM_FAILURES:
            return engine.escalate(session, f"LLM_FAILURE:{exc.code}")
        raise BystanderError(exc.code, exc.message, 503,
                             {"instruction_text": RETRY_TEXT, "escalate": False,
                              "llm_failures": session.llm_failures,
                              "session_status": session.status.value}) from exc
    session.llm_failures = 0
    return engine.handle_facts(session, facts)


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------
@app.get("/health")
def health() -> dict:
    return {"status": "ok", "mock_mode": llm.mock_mode(),
            "protocols_loaded": sorted(engine.protocols)}


@app.get("/protocols")
def list_protocols() -> list[dict]:
    return [{"protocol_id": p.protocol_id, "version": p.version, "reviewed": p.reviewed,
             "steps": len(p.steps)} for p in engine.protocols.values()]


@app.post("/session/start", response_model=BystanderResponse)
def start_session(body: StartRequest) -> BystanderResponse:
    return engine.start_session(store, body.call_id)


@app.post("/session/{session_id}/message", response_model=BystanderResponse)
def post_message(session_id: str, body: MessageRequest) -> BystanderResponse:
    session = store.get(session_id)
    response = process_message(session, body.text)
    store.save(session)
    return response


@app.post("/session/{session_id}/confirm", response_model=BystanderResponse)
def post_confirm(session_id: str, body: ConfirmRequest) -> BystanderResponse:
    session = store.get(session_id)
    engine._require_open(session)
    response = engine.confirm(session, body.result)
    store.save(session)
    return response


@app.post("/session/{session_id}/repeat", response_model=BystanderResponse)
def post_repeat(session_id: str) -> BystanderResponse:
    session = store.get(session_id)
    response = engine.repeat(session)
    store.save(session)
    return response


@app.get("/session/{session_id}", response_model=Session)
def get_session(session_id: str) -> Session:
    return store.get(session_id)


@app.post("/session/{session_id}/end", response_model=BystanderResponse)
def end_session(session_id: str) -> BystanderResponse:
    session = store.get(session_id)
    response = engine.end(session)
    store.save(session)
    return response
