"""
Core orchestration service for Module 8: Route Optimization.

RouteOptimizer ties together the OSRM routing client, ETA calculator,
and event publisher to produce a complete RouteResponse for each
dispatch request and to handle mid-route recalculations from GPS ticks.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

from eta_calculator import ETACalculator
from event_publisher import EventPublisher
from routing_client import FallbackRoutingClient, OSRMRoutingClient, RoutingServiceError
from schemas import (
    Coordinate,
    ETAUpdate,
    GeoJSONLineString,
    PriorityLevel,
    RouteGeometry,
    RouteRequest,
    RouteResponse,
    RouteStatus,
)

logger = logging.getLogger(__name__)


class RouteOptimizer:
    """
    High-level service that orchestrates route computation and publication.

    Parameters
    ----------
    routing_client:
        Primary OSRM client.  Falls back to ``FallbackRoutingClient``
        automatically on ``RoutingServiceError``.
    eta_calculator:
        ETA computation and adjustment logic.
    event_publisher:
        Downstream event broadcaster (Module 9, Module 10).
    default_speed_kmh:
        Assumed ambulance speed used when no real-time GPS speed is provided.
    """

    def __init__(
        self,
        routing_client: OSRMRoutingClient,
        eta_calculator: ETACalculator,
        event_publisher: EventPublisher,
        default_speed_kmh: float = 60.0,
    ) -> None:
        self._routing_client = routing_client
        self._fallback_client = FallbackRoutingClient()
        self._eta_calculator = eta_calculator
        self._publisher = event_publisher
        self._default_speed_kmh = default_speed_kmh

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def optimize_route(self, request: RouteRequest) -> RouteResponse:
        """
        Compute and publish an optimised ambulance route.

        Orchestration steps:
        1. Call OSRM (with automatic fallback to haversine on failure).
        2. Build RouteGeometry from the raw routing response.
        3. Compute base and priority-adjusted ETAs.
        4. Assemble and return a RouteResponse.
        5. Asynchronously publish events to Module 9 and Module 10.

        Parameters
        ----------
        request:
            Validated RouteRequest from the dispatch system.

        Returns
        -------
        RouteResponse
            Complete route with geometry, distances, and ETAs.
        """
        logger.info(
            "Optimising route: emergency=%s, ambulance=%s, priority=%s",
            request.emergency_id,
            request.ambulance_id,
            request.priority_level.value,
        )

        osrm_response = await self._call_routing_backend(
            request.ambulance_location,
            request.hospital_location,
        )

        geometry = self._build_route_geometry(osrm_response)
        distance_km: float = osrm_response["distance_km"]
        base_eta: float = osrm_response["duration_minutes"]

        priority_factor = ETACalculator.PRIORITY_FACTORS[request.priority_level]
        adjusted_eta = self._eta_calculator.calculate_adjusted_eta(
            base_eta,
            request.priority_level,
        )

        route_id = self._generate_route_id()

        response = RouteResponse(
            emergency_id=request.emergency_id,
            ambulance_id=request.ambulance_id,
            hospital_id=request.hospital_id,
            geometry=geometry,
            total_distance_km=round(distance_km, 4),
            base_eta_minutes=round(base_eta, 2),
            adjusted_eta_minutes=adjusted_eta,
            priority_factor=priority_factor,
            route_id=route_id,
            calculated_at=datetime.utcnow(),
            status=RouteStatus.ACTIVE,
        )

        # Publish non-blocking — failures are logged, never raised
        await self._publisher.publish_route_optimized(response)

        logger.info(
            "Route %s ready: %.2f km, ETA %.1f min (adjusted from %.1f min)",
            route_id,
            distance_km,
            adjusted_eta,
            base_eta,
        )
        return response

    async def recalculate_route(
        self,
        route_id: str,
        current_location: Coordinate,
        emergency_id: str,
        ambulance_id: str,
        destination: Coordinate,
        speed_kmh: float | None = None,
        priority_level: PriorityLevel = PriorityLevel.HIGH,
    ) -> ETAUpdate:
        """
        Produce a fresh ETA from the ambulance's current GPS position.

        Called on each GPS position tick while the ambulance is en-route.
        Does NOT re-query OSRM — uses haversine for the remaining distance
        to keep latency low for high-frequency updates.

        Parameters
        ----------
        route_id:
            Active route identifier.
        current_location:
            Latest GPS fix.
        emergency_id:
            Emergency event identifier.
        ambulance_id:
            Ambulance unit identifier.
        destination:
            Hospital entrance coordinate.
        speed_kmh:
            Current speed from the GPS unit; defaults to ``default_speed_kmh``.
        priority_level:
            Active priority level for speed-factor lookup.

        Returns
        -------
        ETAUpdate
            Updated distance-remaining and ETA snapshot.
        """
        effective_speed = speed_kmh if speed_kmh and speed_kmh > 0 else self._default_speed_kmh

        eta_update = self._eta_calculator.calculate_eta_update(
            route_id=route_id,
            emergency_id=emergency_id,
            ambulance_id=ambulance_id,
            current_location=current_location,
            destination=destination,
            speed_kmh=effective_speed,
            priority_level=priority_level,
        )

        await self._publisher.publish_eta_update(eta_update)

        logger.debug(
            "Recalculated ETA for route %s: %.3f km remaining, %.2f min ETA",
            route_id,
            eta_update.distance_remaining_km,
            eta_update.eta_minutes,
        )
        return eta_update

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _call_routing_backend(
        self,
        origin: Coordinate,
        destination: Coordinate,
    ) -> dict:
        """
        Query OSRM and transparently fall back to haversine on failure.

        Returns the normalised routing dict from whichever backend responds.
        """
        try:
            return await self._routing_client.get_route(origin, destination)
        except RoutingServiceError as exc:
            logger.warning(
                "OSRM unavailable (%s); switching to fallback haversine client",
                exc,
            )
            return await self._fallback_client.get_route(origin, destination)

    def _build_route_geometry(self, osrm_response: dict) -> RouteGeometry:
        """
        Convert the raw OSRM geometry dict into a typed RouteGeometry.

        Parameters
        ----------
        osrm_response:
            Normalised routing response dict from the client.

        Returns
        -------
        RouteGeometry
            Validated geometry ready for storage and downstream publishing.

        Raises
        ------
        ValueError
            If the geometry is missing or malformed.
        """
        raw_geom = osrm_response.get("geometry")
        if not raw_geom:
            raise ValueError("Routing response contains no geometry")

        geojson = GeoJSONLineString(
            type=raw_geom.get("type", "LineString"),
            coordinates=raw_geom["coordinates"],
        )
        return RouteGeometry(geojson=geojson, encoded_polyline=None)

    @staticmethod
    def _generate_route_id() -> str:
        """Generate a unique route identifier using UUID v4."""
        return str(uuid.uuid4())
