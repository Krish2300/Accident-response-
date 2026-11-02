"""
FastAPI application for Module 8: Route Optimization Service.

Exposes endpoints for:
- Route optimisation (POST /api/v1/routes/optimize)
- Real-time ETA recalculation (POST /api/v1/routes/{route_id}/recalculate)
- Route lookup from cache (GET /api/v1/routes/{route_id})
- Service health check (GET /health)

All heavy I/O is async.  Dependencies are wired via FastAPI's
dependency-injection system and initialised in the lifespan context
manager so teardown (connection cleanup) is guaranteed.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator

import httpx
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import settings
from eta_calculator import ETACalculator
from event_publisher import EventPublisher
from route_optimizer import RouteOptimizer
from routing_client import OSRMRoutingClient
from schemas import Coordinate, ETAUpdate, PriorityLevel, RouteRequest, RouteResponse

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory route cache  {route_id: (RouteResponse, stored_at_unix_ts)}
# ---------------------------------------------------------------------------
_route_cache: dict[str, tuple[RouteResponse, float]] = {}


def _cache_put(response: RouteResponse) -> None:
    _route_cache[response.route_id] = (response, time.monotonic())


def _cache_get(route_id: str) -> RouteResponse | None:
    entry = _route_cache.get(route_id)
    if entry is None:
        return None
    response, stored_at = entry
    age = time.monotonic() - stored_at
    if age > settings.route_cache_ttl_seconds:
        del _route_cache[route_id]
        return None
    return response


# ---------------------------------------------------------------------------
# Application state holder (populated in lifespan)
# ---------------------------------------------------------------------------
class _AppState:
    routing_client: OSRMRoutingClient
    eta_calculator: ETACalculator
    event_publisher: EventPublisher
    route_optimizer: RouteOptimizer
    http_client: httpx.AsyncClient


_state = _AppState()


# ---------------------------------------------------------------------------
# Lifespan (startup / shutdown)
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Initialise and cleanly shut down all shared resources."""
    logger.info("Starting Module 8 Route Optimization Service…")

    _state.routing_client = OSRMRoutingClient(
        base_url=settings.osrm_base_url,
        timeout=settings.osrm_timeout_seconds,
    )
    _state.eta_calculator = ETACalculator()
    _state.http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(10.0),
        headers={"Content-Type": "application/json"},
    )
    _state.event_publisher = EventPublisher(http_client=_state.http_client)
    _state.route_optimizer = RouteOptimizer(
        routing_client=_state.routing_client,
        eta_calculator=_state.eta_calculator,
        event_publisher=_state.event_publisher,
        default_speed_kmh=settings.ambulance_avg_speed_kmph,
    )

    logger.info("OSRM URL: %s", settings.osrm_base_url)
    logger.info("Module 9 URL: %s", settings.module9_corridor_url)
    logger.info("Module 10 URL: %s", settings.module10_state_url)
    logger.info("Route cache TTL: %d s", settings.route_cache_ttl_seconds)

    yield  # Application runs here

    logger.info("Shutting down Module 8 Route Optimization Service…")
    await _state.routing_client.aclose()
    await _state.http_client.aclose()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Module 8 — Route Optimization Service",
    description=(
        "Computes optimal ambulance routes using OSRM, applies priority-based "
        "ETA adjustments, and publishes events to downstream modules."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Dependency providers
# ---------------------------------------------------------------------------
def get_route_optimizer() -> RouteOptimizer:
    return _state.route_optimizer


# ---------------------------------------------------------------------------
# Request / response models for endpoints that aren't covered by schemas.py
# ---------------------------------------------------------------------------
class RecalculateRequest(BaseModel):
    """Payload for a mid-route ETA recalculation."""

    current_location: Coordinate
    emergency_id: str
    ambulance_id: str
    destination: Coordinate
    speed_kmh: float | None = None
    priority_level: PriorityLevel = PriorityLevel.HIGH


class HealthResponse(BaseModel):
    status: str
    osrm_healthy: bool
    cached_routes: int
    version: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.post(
    "/api/v1/routes/optimize",
    response_model=RouteResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Compute optimised ambulance route",
    tags=["Routes"],
)
async def optimize_route(
    request: RouteRequest,
    optimizer: RouteOptimizer = Depends(get_route_optimizer),
) -> RouteResponse:
    """
    Accept a dispatch request and return the optimal route with ETAs.

    - Calls OSRM (with haversine fallback on connectivity failure).
    - Applies priority-based speed adjustment.
    - Publishes events to Module 9 (corridor pre-clearing) and Module 10 (state engine).
    - Caches the result for lookup via `GET /api/v1/routes/{route_id}`.
    """
    try:
        response = await optimizer.optimize_route(request)
    except Exception as exc:
        logger.exception("Route optimisation failed for emergency %s", request.emergency_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Route computation failed: {exc}",
        ) from exc

    _cache_put(response)
    return response


@app.post(
    "/api/v1/routes/{route_id}/recalculate",
    response_model=ETAUpdate,
    summary="Recalculate ETA from current GPS position",
    tags=["Routes"],
)
async def recalculate_route(
    route_id: str,
    body: RecalculateRequest,
    optimizer: RouteOptimizer = Depends(get_route_optimizer),
) -> ETAUpdate:
    """
    Produce a fresh ETA for an active route based on the ambulance's latest GPS fix.

    Does not re-query OSRM — uses haversine remaining distance for low latency.
    Publishes `ETA_UPDATED` event to Module 10.
    """
    try:
        eta_update = await optimizer.recalculate_route(
            route_id=route_id,
            current_location=body.current_location,
            emergency_id=body.emergency_id,
            ambulance_id=body.ambulance_id,
            destination=body.destination,
            speed_kmh=body.speed_kmh,
            priority_level=body.priority_level,
        )
    except Exception as exc:
        logger.exception("Recalculation failed for route %s", route_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"ETA recalculation failed: {exc}",
        ) from exc

    return eta_update


@app.get(
    "/api/v1/routes/{route_id}",
    response_model=RouteResponse,
    summary="Retrieve a cached route",
    tags=["Routes"],
)
async def get_route(route_id: str) -> RouteResponse:
    """
    Fetch a previously computed route from the in-memory cache.

    Returns 404 if the route is not found or has expired (TTL controlled
    by ``ROUTE_CACHE_TTL_SECONDS``).
    """
    cached = _cache_get(route_id)
    if cached is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Route '{route_id}' not found or has expired",
        )
    return cached


@app.get(
    "/health",
    response_model=HealthResponse,
    summary="Service health check",
    tags=["Operations"],
)
async def health_check() -> HealthResponse:
    """
    Return service status and OSRM connectivity.

    Always returns HTTP 200; callers should inspect the ``osrm_healthy``
    field to determine routing quality (haversine fallback is still
    available when ``osrm_healthy`` is false).
    """
    osrm_healthy = await _state.routing_client.health_check()
    return HealthResponse(
        status="ok",
        osrm_healthy=osrm_healthy,
        cached_routes=len(_route_cache),
        version=app.version,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.service_host,
        port=settings.service_port,
        reload=False,
        log_level=settings.log_level.lower(),
    )
