"""
ETA calculation logic for Module 8.

Applies priority-based speed multipliers, optional traffic factors,
and haversine geometry to produce accurate arrival estimates for
in-progress ambulance routes.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime

from schemas import Coordinate, ETAUpdate, PriorityLevel

logger = logging.getLogger(__name__)


class ETACalculator:
    """
    Calculates and adjusts estimated times of arrival for ambulances.

    Priority factors model the reality that emergency vehicles operating
    under lights-and-sirens travel faster than ordinary traffic:

    * CRITICAL → 40 % faster than base (factor 0.6)
    * HIGH     → 25 % faster (factor 0.75)
    * MEDIUM   → 10 % faster (factor 0.9)
    * LOW      → baseline speed (factor 1.0)

    The traffic factor is a multiplier > 1.0 representing congestion
    (e.g. 1.3 means 30 % slower than free-flow).  Emergency priority
    partially offsets this.
    """

    PRIORITY_FACTORS: dict[PriorityLevel, float] = {
        PriorityLevel.LOW: 1.0,
        PriorityLevel.MEDIUM: 0.9,
        PriorityLevel.HIGH: 0.75,
        PriorityLevel.CRITICAL: 0.6,
    }

    # Minimum plausible ETA to avoid floating-point underflow artefacts
    _MIN_ETA_MINUTES = 0.1

    # ------------------------------------------------------------------
    # Public methods
    # ------------------------------------------------------------------

    def calculate_adjusted_eta(
        self,
        base_eta_minutes: float,
        priority_level: PriorityLevel,
        traffic_factor: float = 1.0,
    ) -> float:
        """
        Apply priority and traffic adjustments to a raw routing ETA.

        Parameters
        ----------
        base_eta_minutes:
            Unadjusted ETA in minutes from the routing engine.
        priority_level:
            Emergency priority that determines the speed multiplier.
        traffic_factor:
            Real-time congestion multiplier (1.0 = free flow, 1.5 = heavy
            congestion).  Emergency vehicles partially offset this through
            their priority factor.

        Returns
        -------
        float
            Adjusted ETA in minutes, floored at ``_MIN_ETA_MINUTES``.
        """
        if base_eta_minutes < 0:
            raise ValueError(f"base_eta_minutes must be non-negative, got {base_eta_minutes}")
        if traffic_factor <= 0:
            raise ValueError(f"traffic_factor must be positive, got {traffic_factor}")

        priority_factor = self.PRIORITY_FACTORS[priority_level]

        # Traffic slows everyone; priority partially counteracts it.
        # Net effect: adjusted = base * traffic_factor * priority_factor
        adjusted = base_eta_minutes * traffic_factor * priority_factor

        result = max(adjusted, self._MIN_ETA_MINUTES)
        logger.debug(
            "ETA adjustment: base=%.2f min, traffic_factor=%.2f, "
            "priority=%s (factor=%.2f) → adjusted=%.2f min",
            base_eta_minutes,
            traffic_factor,
            priority_level.value,
            priority_factor,
            result,
        )
        return round(result, 2)

    def calculate_eta_update(
        self,
        route_id: str,  # noqa: ARG002 — included for caller traceability
        emergency_id: str,
        ambulance_id: str,
        current_location: Coordinate,
        destination: Coordinate,
        speed_kmh: float,
        priority_level: PriorityLevel,
    ) -> ETAUpdate:
        """
        Produce a real-time ETA update from the ambulance's current position.

        Parameters
        ----------
        route_id:
            Identifier of the active route (for traceability in logs).
        emergency_id:
            Emergency event identifier.
        ambulance_id:
            Ambulance unit identifier.
        current_location:
            Latest GPS fix.
        destination:
            Hospital entrance coordinate.
        speed_kmh:
            Reported or assumed current speed in km/h.  Must be > 0.
        priority_level:
            Priority level used to scale effective speed.

        Returns
        -------
        ETAUpdate
            Snapshot of remaining distance and predicted arrival time.
        """
        if speed_kmh <= 0:
            raise ValueError(f"speed_kmh must be positive, got {speed_kmh}")

        distance_remaining_km = self.haversine_distance(current_location, destination)
        priority_factor = self.PRIORITY_FACTORS[priority_level]

        # Effective speed accounts for emergency driving behaviour
        effective_speed_kmh = speed_kmh / priority_factor

        eta_minutes = (distance_remaining_km / effective_speed_kmh) * 60.0
        eta_minutes = max(eta_minutes, self._MIN_ETA_MINUTES)

        logger.debug(
            "ETA update: route=%s, dist_remaining=%.3f km, speed=%.1f km/h "
            "(effective=%.1f km/h), eta=%.2f min",
            route_id,
            distance_remaining_km,
            speed_kmh,
            effective_speed_kmh,
            eta_minutes,
        )

        return ETAUpdate(
            emergency_id=emergency_id,
            ambulance_id=ambulance_id,
            current_location=current_location,
            distance_remaining_km=round(distance_remaining_km, 4),
            eta_minutes=round(eta_minutes, 2),
            updated_at=datetime.utcnow(),
            speed_kmh=round(speed_kmh, 1),
        )

    # ------------------------------------------------------------------
    # Geometry helper
    # ------------------------------------------------------------------

    @staticmethod
    def haversine_distance(coord1: Coordinate, coord2: Coordinate) -> float:
        """
        Compute the great-circle distance between two WGS-84 coordinates.

        Uses the haversine formula for numerical stability at short distances.

        Parameters
        ----------
        coord1:
            First coordinate.
        coord2:
            Second coordinate.

        Returns
        -------
        float
            Distance in kilometres.
        """
        R = 6371.0  # Earth mean radius in km
        lat1 = math.radians(coord1.lat)
        lat2 = math.radians(coord2.lat)
        dlat = math.radians(coord2.lat - coord1.lat)
        dlon = math.radians(coord2.lon - coord1.lon)

        a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        c = 2 * math.asin(math.sqrt(a))
        return R * c
