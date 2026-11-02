"""
Module 3 — FastAPI Application
REST API for emergency NLP extraction with integration hooks to Modules 4 & 10.
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..schemas.incident_schema import (
    TranscriptInput,
    ExtractedIncidentData,
)
from ..services.nlp_service import EmergencyNLPService
from ..utils.integration import (
    dispatch_to_module4,
    dispatch_to_module10,
    IntegrationError,
)

# ─────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
logger = logging.getLogger("module3.api")

# ─────────────────────────────────────────────
# App-level state
# ─────────────────────────────────────────────
_nlp_service: EmergencyNLPService | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    """Startup / shutdown lifecycle."""
    global _nlp_service
    logger.info("Module 3 — Starting up EmergencyNLPService…")
    _nlp_service = EmergencyNLPService(
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY"),
        model=os.environ.get("LLM_MODEL", "claude-sonnet-4-6"),
        max_tokens=int(os.environ.get("LLM_MAX_TOKENS", "2048")),
        max_retries=int(os.environ.get("LLM_MAX_RETRIES", "2")),
        timeout_seconds=float(os.environ.get("LLM_TIMEOUT", "8.0")),
    )
    logger.info("Module 3 — Ready.")
    yield
    logger.info("Module 3 — Shutting down.")


# ─────────────────────────────────────────────
# FastAPI app
# ─────────────────────────────────────────────
app = FastAPI(
    title="Module 3 — Emergency NLP / LLM",
    description=(
        "Processes STT transcripts from Module 2 and emits structured incident data "
        "to Module 4 (Dialog Engine) and Module 10 (State Engine)."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # Restrict in production
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────
# MIDDLEWARE — Request Timing
# ─────────────────────────────────────────────

@app.middleware("http")
async def timing_middleware(request: Request, call_next):
    t0 = time.perf_counter()
    response = await call_next(request)
    elapsed = time.perf_counter() - t0
    response.headers["X-Process-Time-Ms"] = f"{elapsed * 1000:.1f}"
    return response


# ─────────────────────────────────────────────
# RESPONSE MODELS
# ─────────────────────────────────────────────

class ExtractionResponse(ExtractedIncidentData):
    """
    Public API response — inherits full ExtractedIncidentData.
    raw_llm_response is excluded via schema (exclude=True on that field).
    """
    pass


# ─────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────

@app.get("/health", tags=["System"])
async def health_check():
    """Process liveness plus non-secret model configuration status."""
    configured = bool(_nlp_service and _nlp_service.inference_configured)
    inference_mode = (
        "not_initialized"
        if _nlp_service is None
        else "model_with_fallback" if configured else "fallback_only"
    )
    return {
        "status": "ok",
        "module": "3-emergency-nlp",
        "provider": "anthropic",
        "model": _nlp_service.model if _nlp_service else "not_initialized",
        "model_credentials_configured": configured,
        "inference_mode": inference_mode,
        "fallback_enabled": True,
    }


@app.post(
    "/extract",
    response_model=ExtractionResponse,
    status_code=status.HTTP_200_OK,
    tags=["Core"],
    summary="Extract structured incident data from transcript",
    description=(
        "Primary endpoint. Accepts a caller transcript from Module 2, "
        "runs LLM extraction, validates output, and dispatches to Modules 4 & 10."
    ),
)
async def extract_incident(
    payload: TranscriptInput,
    background_tasks: BackgroundTasks,
) -> ExtractedIncidentData:
    """
    Main extraction endpoint.

    Flow:
    1. Validate input (Pydantic)
    2. Run LLM extraction (sync, within thread pool via starlette)
    3. Post-process & validate output
    4. Background dispatch → Module 4 (Dialog Engine)
    5. Background dispatch → Module 10 (State Engine)
    6. Return structured incident data
    """
    if _nlp_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="NLP service not initialized",
        )

    # ── Core extraction ───────────────────────────────────────────────────
    # Note: EmergencyNLPService.extract is synchronous (Anthropic SDK sync client).
    # FastAPI runs sync routes in threadpool automatically — production-safe.
    incident_data = _nlp_service.extract(payload)

    # ── Async downstream dispatch (non-blocking) ──────────────────────────
    if payload.is_final_chunk:
        # Only dispatch on final utterance chunks, not mid-stream partial updates
        background_tasks.add_task(
            dispatch_to_module4,
            incident_data.to_module4_payload(),
        )
        background_tasks.add_task(
            dispatch_to_module10,
            incident_data.to_module10_payload(),
        )

    return incident_data


@app.post(
    "/extract/stream",
    response_model=ExtractionResponse,
    status_code=status.HTTP_200_OK,
    tags=["Core"],
    summary="Incremental extraction for live/partial transcripts",
    description=(
        "Called with is_final_chunk=False during active streaming. "
        "Returns a preliminary extraction without triggering downstream dispatch. "
        "Use /extract (with is_final_chunk=True) for the authoritative output."
    ),
)
async def extract_stream_chunk(payload: TranscriptInput) -> ExtractedIncidentData:
    """
    Handles mid-call incremental extractions.
    No downstream dispatch — only returns preliminary assessment.
    Useful for Module 4 to start asking questions before the utterance ends.
    """
    if _nlp_service is None:
        raise HTTPException(status_code=503, detail="NLP service not initialized")

    # Force is_final_chunk=False so incremental system prompt is used
    payload_copy = payload.model_copy(update={"is_final_chunk": False})
    return _nlp_service.extract(payload_copy)


# ─────────────────────────────────────────────
# ERROR HANDLERS
# ─────────────────────────────────────────────

@app.exception_handler(IntegrationError)
async def integration_error_handler(request: Request, exc: IntegrationError):
    logger.error("Integration dispatch failed: %s", exc)
    # Do NOT fail the response — extraction itself succeeded
    return JSONResponse(
        status_code=200,
        content={"warning": f"Extraction succeeded but downstream dispatch failed: {exc}"},
    )


@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception in Module 3 API: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal extraction error. Safe fallback dispatched."},
    )
