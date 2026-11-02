"""
Downstream event publisher for Module 8.

Fires-and-forgets integration payloads to:
- Module 9 (Signal Corridor Management): route geometry + metadata
- Module 10 (State Engine): state transitions and ETA updates

All publishes are non-blocking.  Errors are logged and swallowed so
that a downstream outage never prevents route computation from completing.
Tenacity provides exponential-backoff retry on transient failures.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from schemas import ETAUpdate, RouteResponse

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Service endpoints — overridden at runtime via environment variables.
# ---------------------------------------------------------------------------
MODULE9_CORRIDOR_URL: str = os.getenv(
    "MODULE9_CORRIDOR_URL",
    "http://module9-corridor-service/api/v1/corridors/activate",
)
MODULE10_STATE_ENGINE_URL: str = os.getenv(
    "MODULE10_STATE_ENGINE_URL",
    "http://module10-state-engine/api/v1/events",
)

# Shared retry policy for transient HTTP failures
_RETRY_POLICY = dict(
    retry=retry_if_exception_type((httpx.RequestError, httpx.HTTPStatusError)),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    stop=stop_after_attempt(3),
    reraise=False,  # Swallow after exhaustion — caller must not depend on success
)


class EventPublisher:
    """
    Publishes route and ETA events to downstream modules.

    Parameters
    ----------
    http_client:
        Shared ``httpx.AsyncClient`` injected from the app lifespan.
        Caller is responsible for closing it.
    """

    def __init__(self, http_client: httpx.AsyncClient) -> None:
        self._client = http_client

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def publish_route_optimized(self, route_response: RouteResponse) -> None:
        """
        Notify Module 9 and Module 10 that a new route has been computed.

        Module 9 receives the geometry so it can pre-clear traffic signals
        along the corridor.  Module 10 receives a state-transition event
        to advance the emergency FSM from DISPATCHED → ROUTE_ASSIGNED.

        Parameters
        ----------
        route_response:
            The fully computed RouteResponse to broadcast.
        """
        await self._notify_module9(route_response)
        await self._notify_module10_route_generated(route_response)

    async def publish_eta_update(self, eta_update: ETAUpdate) -> None:
        """
        Broadcast a real-time ETA update to Module 10.

        Called on every GPS position tick while the ambulance is en-route.

        Parameters
        ----------
        eta_update:
            Current ETA snapshot for the ambulance.
        """
        await self._notify_module10_eta(eta_update)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _notify_module9(self, route_response: RouteResponse) -> None:
        """POST corridor activation payload to Module 9."""
        payload = {
            "route_id": route_response.route_id,
            "emergency_id": route_response.emergency_id,
            "ambulance_id": route_response.ambulance_id,
            "hospital_id": route_response.hospital_id,
            "geometry": route_response.geometry.geojson.model_dump(),
            "eta_minutes": route_response.adjusted_eta_minutes,
            "priority_level": route_response.status.value,
            "requested_at": route_response.calculated_at.isoformat(),
        }
        await self._post_with_retry(MODULE9_CORRIDOR_URL, payload, label="Module9/corridor")

    async def _notify_module10_route_generated(self, route_response: RouteResponse) -> None:
        """POST ROUTE_GENERATED state-transition event to Module 10."""
        payload = {
            "emergency_id": route_response.emergency_id,
            "event": "ROUTE_GENERATED",
            "route_id": route_response.route_id,
            "eta_minutes": route_response.adjusted_eta_minutes,
            "ambulance_id": route_response.ambulance_id,
            "hospital_id": route_response.hospital_id,
            "timestamp": datetime.utcnow().isoformat(),
        }
        await self._post_with_retry(MODULE10_STATE_ENGINE_URL, payload, label="Module10/ROUTE_GENERATED")

    async def _notify_module10_eta(self, eta_update: ETAUpdate) -> None:
        """POST ETA_UPDATED event to Module 10."""
        payload = {
            "emergency_id": eta_update.emergency_id,
            "event": "ETA_UPDATED",
            "ambulance_id": eta_update.ambulance_id,
            "eta_minutes": eta_update.eta_minutes,
            "distance_remaining_km": eta_update.distance_remaining_km,
            "speed_kmh": eta_update.speed_kmh,
            "current_location": {
                "lat": eta_update.current_location.lat,
                "lon": eta_update.current_location.lon,
            },
            "timestamp": eta_update.updated_at.isoformat(),
        }
        await self._post_with_retry(MODULE10_STATE_ENGINE_URL, payload, label="Module10/ETA_UPDATED")

    async def _post_with_retry(self, url: str, payload: dict, label: str) -> None:
        """
        POST *payload* to *url* with exponential-backoff retry.

        Swallows all exceptions after exhausting retries so that a
        downstream failure never propagates to the route response.
        """
        @retry(**_RETRY_POLICY)
        async def _attempt() -> None:
            response = await self._client.post(url, json=payload, timeout=5.0)
            response.raise_for_status()

        try:
            await _attempt()
            logger.info("Published event to %s [%s]", label, url)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Failed to publish event to %s after retries: %s — continuing without downstream ack",
                label,
                exc,
            )
