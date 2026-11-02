"""
Async OSRM routing client for Module 8.

Provides primary routing via an OSRM instance and a haversine-based
fallback client used when OSRM is unreachable.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import httpx

from schemas import Coordinate

logger = logging.getLogger(__name__)


class RoutingServiceError(Exception):
    """Raised when the routing backend returns an unexpected response."""


def _haversine_km(coord1: Coordinate, coord2: Coordinate) -> float:
    """
    Compute the great-circle distance between two WGS-84 coordinates.

    Returns distance in kilometres.
    """
    R = 6371.0  # Earth radius in km
    lat1, lon1 = math.radians(coord1.lat), math.radians(coord1.lon)
    lat2, lon2 = math.radians(coord2.lat), math.radians(coord2.lon)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


class OSRMRoutingClient:
    """
    Async client for the OSRM HTTP API.

    Calls the /route/v1/driving endpoint and normalises the response
    into a plain dict consumed by RouteOptimizer.

    Parameters
    ----------
    base_url:
        Root URL of the OSRM service, e.g. ``http://router.project-osrm.org``.
    timeout:
        Request timeout in seconds.
    """

    def __init__(self, base_url: str, timeout: int = 10) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            headers={"Accept": "application/json"},
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_route(self, origin: Coordinate, destination: Coordinate) -> dict[str, Any]:
        """
        Retrieve a driving route between *origin* and *destination*.

        Parameters
        ----------
        origin:
            Starting coordinate (ambulance position).
        destination:
            Target coordinate (hospital entrance).

        Returns
        -------
        dict with keys:
            ``geometry``  – GeoJSON LineString dict
            ``distance_km`` – total route length in kilometres
            ``duration_minutes`` – estimated travel time in minutes

        Raises
        ------
        RoutingServiceError
            If OSRM returns an error code or an unexpected payload.
        """
        url = (
            f"{self._base_url}/route/v1/driving/"
            f"{origin.lon},{origin.lat};{destination.lon},{destination.lat}"
            "?overview=full&geometries=geojson&steps=true"
        )

        try:
            response = await self._client.get(url)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RoutingServiceError(
                f"OSRM returned HTTP {exc.response.status_code} for route request"
            ) from exc
        except httpx.RequestError as exc:
            raise RoutingServiceError(f"Network error contacting OSRM: {exc}") from exc

        payload = response.json()

        if payload.get("code") != "Ok":
            raise RoutingServiceError(
                f"OSRM routing failed: code={payload.get('code')}, "
                f"message={payload.get('message', 'unknown')}"
            )

        try:
            route = payload["routes"][0]
            geometry = route["geometry"]          # GeoJSON LineString
            distance_m = route["distance"]        # metres
            duration_s = route["duration"]        # seconds
        except (KeyError, IndexError) as exc:
            raise RoutingServiceError(f"Unexpected OSRM response structure: {exc}") from exc

        return {
            "geometry": geometry,
            "distance_km": distance_m / 1000.0,
            "duration_minutes": duration_s / 60.0,
        }

    async def health_check(self) -> bool:
        """
        Verify OSRM is reachable by calling its nearest-neighbour endpoint.

        Returns ``True`` if healthy, ``False`` otherwise (never raises).
        """
        # Use a fixed point near the prime meridian for a lightweight probe
        url = f"{self._base_url}/nearest/v1/driving/0.0,51.5"
        try:
            response = await self._client.get(url, timeout=5)
            data = response.json()
            return data.get("code") == "Ok"
        except Exception as exc:  # noqa: BLE001
            logger.warning("OSRM health check failed: %s", exc)
            return False

    async def aclose(self) -> None:
        """Release underlying HTTP connections."""
        await self._client.aclose()


class FallbackRoutingClient:
    """
    Straight-line haversine routing used when OSRM is unavailable.

    Produces a two-point GeoJSON LineString and derives a rough
    travel time by assuming an average urban speed of 60 km/h.

    This client is automatically selected by RouteOptimizer after
    OSRMRoutingClient raises RoutingServiceError.
    """

    _FALLBACK_SPEED_KMH = 60.0

    async def get_route(self, origin: Coordinate, destination: Coordinate) -> dict[str, Any]:
        """
        Return a straight-line route between *origin* and *destination*.

        The distance is the haversine great-circle distance.  Duration
        assumes ``_FALLBACK_SPEED_KMH`` with no traffic adjustment.
        """
        logger.warning(
            "FallbackRoutingClient: computing straight-line route from %s to %s",
            origin,
            destination,
        )
        distance_km = _haversine_km(origin, destination)
        duration_minutes = (distance_km / self._FALLBACK_SPEED_KMH) * 60.0

        geometry = {
            "type": "LineString",
            "coordinates": [
                [origin.lon, origin.lat],
                [destination.lon, destination.lat],
            ],
        }

        return {
            "geometry": geometry,
            "distance_km": distance_km,
            "duration_minutes": duration_minutes,
            "_fallback": True,
        }

    async def health_check(self) -> bool:
        """Fallback client is always 'healthy' as it has no external dependency."""
        return True

    async def aclose(self) -> None:
        """No-op; nothing to release."""
