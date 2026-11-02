"""
Module 3 — Integration Pipeline
Dispatch hooks for pushing ExtractedIncidentData to downstream modules.

Module 4 (Conversation Engine) — receives slim dialog payload
Module 10 (State Engine / Orchestrator) — receives full incident payload

Both dispatches are async, non-blocking, and fault-tolerant.
Extraction response is NEVER held waiting on these dispatches.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger("module3.integration")


# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────

MODULE4_URL  = os.environ.get("MODULE4_URL",  "http://module4-dialog:8004")
MODULE10_URL = os.environ.get("MODULE10_URL", "http://module10-state:8010")

DISPATCH_TIMEOUT = float(os.environ.get("DISPATCH_TIMEOUT_SECONDS", "3.0"))
DISPATCH_RETRIES = int(os.environ.get("DISPATCH_RETRIES", "2"))


class IntegrationError(Exception):
    """Raised when downstream dispatch fails after all retries."""
    pass


# ─────────────────────────────────────────────
# Internal HTTP helper
# ─────────────────────────────────────────────

async def _post_with_retry(
    url: str,
    payload: dict[str, Any],
    service_name: str,
) -> None:
    """
    Non-blocking async POST with retry logic.
    Never raises to caller — logs and raises IntegrationError instead.
    """
    last_exc: Exception | None = None
    async with httpx.AsyncClient(timeout=DISPATCH_TIMEOUT) as client:
        for attempt in range(1, DISPATCH_RETRIES + 1):
            try:
                resp = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json",
                             "X-Source": "module3-nlp"},
                )
                resp.raise_for_status()
                logger.info(
                    "Dispatched to %s — session=%s status=%d",
                    service_name, payload.get("session_id"), resp.status_code
                )
                return
            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "Dispatch to %s attempt %d/%d HTTP error %d: %s",
                    service_name, attempt, DISPATCH_RETRIES,
                    exc.response.status_code, exc.response.text[:200],
                )
                last_exc = exc
            except httpx.RequestError as exc:
                logger.warning(
                    "Dispatch to %s attempt %d/%d connection error: %s",
                    service_name, attempt, DISPATCH_RETRIES, exc,
                )
                last_exc = exc

    raise IntegrationError(
        f"Failed to dispatch to {service_name} after {DISPATCH_RETRIES} attempts: {last_exc}"
    )


# ─────────────────────────────────────────────
# Module 4 — Dialog Engine
# ─────────────────────────────────────────────

async def dispatch_to_module4(payload: dict[str, Any]) -> None:
    """
    Sends the slim dialog payload to Module 4 (Conversation Engine).

    Module 4 uses this to:
    - Decide which questions to ask (based on missing_fields)
    - Set initial dialog context (severity, incident type)
    - Trigger CPR guidance if cpr_required=True

    Endpoint: POST {MODULE4_URL}/api/v1/dialog/initialize
    """
    url = f"{MODULE4_URL}/api/v1/dialog/initialize"
    logger.info(
        "Dispatching to Module 4 — session=%s category=%s missing=%s",
        payload.get("session_id"),
        payload.get("incident_category"),
        [k for k, v in payload.get("missing_fields", {}).items() if v is True],
    )
    await _post_with_retry(url, payload, "Module4-Dialog")


# ─────────────────────────────────────────────
# Module 10 — State Engine / Orchestrator
# ─────────────────────────────────────────────

async def dispatch_to_module10(payload: dict[str, Any]) -> None:
    """
    Sends the full incident payload to Module 10 (State Engine).

    Module 10 uses this to:
    - Transition state: NEW → ANALYZING → CLASSIFIED
    - Trigger ambulance assignment (Module 6)
    - Trigger hospital matching (Module 7)
    - Begin route optimization (Module 8)

    Endpoint: POST {MODULE10_URL}/api/v1/state/transition
    """
    url = f"{MODULE10_URL}/api/v1/state/transition"
    logger.info(
        "Dispatching to Module 10 — session=%s trigger_state=%s severity=%s",
        payload.get("session_id"),
        payload.get("trigger_state"),
        payload.get("severity", {}).get("level"),
    )
    await _post_with_retry(url, payload, "Module10-State")


# ─────────────────────────────────────────────
# (Optional) Module 5 — Bystander Protocol
# Only triggered immediately on CPR_REQUIRED = True
# ─────────────────────────────────────────────

MODULE5_URL = os.environ.get("MODULE5_URL", "http://module5-protocol:8005")


async def dispatch_cpr_alert_to_module5(session_id: str, patient_payload: dict) -> None:
    """
    Fast-path dispatch to Module 5 (Bystander Protocol Engine).
    Called immediately when severity.cpr_required=True — does not wait
    for Module 10 state transition.
    """
    url = f"{MODULE5_URL}/api/v1/protocol/cpr/start"
    payload = {
        "session_id": session_id,
        "patient": patient_payload,
        "protocol": "CPR_30_2",
    }
    logger.info("CPR ALERT → Module 5 — session=%s", session_id)
    await _post_with_retry(url, payload, "Module5-Protocol")
