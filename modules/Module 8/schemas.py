"""
Pydantic v2 schemas for Module 8: Route Optimization.

Defines all data models used across routing, ETA calculation,
and inter-module event publishing.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class PriorityLevel(str, Enum):
    """Emergency priority levels that influence ETA calculation."""

    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class RouteStatus(str, Enum):
    """Lifecycle status of a computed route."""

    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    RECALCULATING = "RECALCULATING"


class Coordinate(BaseModel):
    """WGS-84 geographic coordinate."""

    lat: float = Field(..., ge=-90.0, le=90.0, description="Latitude in decimal degrees")
    lon: float = Field(..., ge=-180.0, le=180.0, description="Longitude in decimal degrees")

    model_config = {"frozen": True}

    def __repr__(self) -> str:
        return f"Coordinate(lat={self.lat}, lon={self.lon})"


class RouteRequest(BaseModel):
    """
    Inbound request to compute an optimized ambulance route.

    Submitted by the dispatch module after an emergency is confirmed
    and an ambulance has been assigned.
    """

    emergency_id: str = Field(..., description="Unique identifier for the emergency event")
    ambulance_id: str = Field(..., description="Unique identifier for the dispatched ambulance")
    ambulance_location: Coordinate = Field(..., description="Current GPS position of the ambulance")
    hospital_id: str = Field(..., description="Target hospital identifier")
    hospital_location: Coordinate = Field(..., description="GPS position of the hospital entrance")
    priority_level: PriorityLevel = Field(..., description="Emergency priority that affects speed factors")
    request_time: datetime = Field(
        default_factory=datetime.utcnow,
        description="UTC timestamp when the route request was issued",
    )

    @field_validator("emergency_id", "ambulance_id", "hospital_id")
    @classmethod
    def must_not_be_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("ID fields must not be blank")
        return v.strip()


class GeoJSONLineString(BaseModel):
    """
    RFC 7946-compliant GeoJSON LineString geometry.

    Coordinates are ordered as [longitude, latitude] per the GeoJSON spec.
    """

    type: Literal["LineString"] = "LineString"
    coordinates: list[list[float]] = Field(
        ...,
        min_length=2,
        description="Array of [lon, lat] position arrays",
    )

    @field_validator("coordinates")
    @classmethod
    def validate_coordinate_pairs(cls, v: list[list[float]]) -> list[list[float]]:
        for pair in v:
            if len(pair) < 2:
                raise ValueError("Each coordinate must have at least [lon, lat]")
            lon, lat = pair[0], pair[1]
            if not (-180.0 <= lon <= 180.0):
                raise ValueError(f"Longitude {lon} out of range [-180, 180]")
            if not (-90.0 <= lat <= 90.0):
                raise ValueError(f"Latitude {lat} out of range [-90, 90]")
        return v


class RouteGeometry(BaseModel):
    """
    Geometric representation of a computed route.

    Includes both GeoJSON for map rendering and optionally an
    encoded polyline for compact transport.
    """

    geojson: GeoJSONLineString = Field(..., description="Full GeoJSON geometry")
    encoded_polyline: str | None = Field(
        default=None,
        description="Google Encoded Polyline Algorithm string (optional)",
    )


class ETAUpdate(BaseModel):
    """
    Real-time ETA update emitted as an ambulance moves along its route.

    Published to Module 10 whenever a GPS position update is received.
    """

    emergency_id: str
    ambulance_id: str
    current_location: Coordinate = Field(..., description="Latest GPS fix for the ambulance")
    distance_remaining_km: float = Field(..., ge=0.0, description="Great-circle distance to destination")
    eta_minutes: float = Field(..., ge=0.0, description="Estimated time to arrival in minutes")
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    speed_kmh: float = Field(..., gt=0.0, description="Current or assumed speed in km/h")


class RouteResponse(BaseModel):
    """
    Fully computed route returned to the caller and broadcast downstream.

    Contains the route geometry, distance, base and adjusted ETAs,
    and metadata used by corridor management (Module 9) and the
    state engine (Module 10).
    """

    emergency_id: str
    ambulance_id: str
    hospital_id: str
    geometry: RouteGeometry
    total_distance_km: float = Field(..., ge=0.0)
    base_eta_minutes: float = Field(..., ge=0.0, description="Raw ETA from routing engine")
    adjusted_eta_minutes: float = Field(..., ge=0.0, description="ETA after applying priority factor")
    priority_factor: float = Field(..., gt=0.0, le=1.0, description="Speed multiplier applied for priority")
    route_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    calculated_at: datetime = Field(default_factory=datetime.utcnow)
    status: RouteStatus = Field(default=RouteStatus.ACTIVE)


class RerouteEvent(BaseModel):
    """
    Audit record emitted whenever a route is recalculated mid-transit.

    Captured by the event log and forwarded to Module 10.
    """

    route_id: str
    emergency_id: str
    trigger: str = Field(..., description="Human-readable reason for reroute (e.g. 'road_closure')")
    old_eta: float = Field(..., ge=0.0)
    new_eta: float = Field(..., ge=0.0)
    timestamp: datetime = Field(default_factory=datetime.utcnow)

    @model_validator(mode="after")
    def validate_eta_change(self) -> "RerouteEvent":
        if self.old_eta == self.new_eta:
            # Not an error, but worth noting; caller may filter these out
            pass
        return self
