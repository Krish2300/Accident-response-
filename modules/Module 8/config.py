"""
Application configuration for Module 8: Route Optimization.

All values are sourced from environment variables (with sensible
defaults for local development).  A .env file is supported via
pydantic-settings' dotenv integration.
"""

from __future__ import annotations

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Centralised settings loaded from environment variables.

    Override any setting by setting the corresponding env var.
    Example::

        OSRM_BASE_URL=http://my-osrm:5000 uvicorn module8.main:app
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ------------------------------------------------------------------
    # Routing backend
    # ------------------------------------------------------------------
    osrm_base_url: str = Field(
        default="http://router.project-osrm.org",
        description="Base URL of the OSRM HTTP API",
    )
    osrm_timeout_seconds: int = Field(
        default=10,
        ge=1,
        le=60,
        description="Request timeout for OSRM calls in seconds",
    )

    # ------------------------------------------------------------------
    # Downstream modules
    # ------------------------------------------------------------------
    module9_corridor_url: str = Field(
        default="http://module9-corridor-service/api/v1/corridors/activate",
        description="Module 9 corridor activation endpoint",
    )
    module10_state_url: str = Field(
        default="http://module10-state-engine/api/v1/events",
        description="Module 10 state-engine event ingestion endpoint",
    )

    # ------------------------------------------------------------------
    # Service network
    # ------------------------------------------------------------------
    service_host: str = Field(default="0.0.0.0", description="Bind host for uvicorn")
    service_port: int = Field(default=8008, ge=1024, le=65535, description="Bind port for uvicorn")

    # ------------------------------------------------------------------
    # Observability
    # ------------------------------------------------------------------
    log_level: str = Field(
        default="INFO",
        description="Python logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)",
    )

    # ------------------------------------------------------------------
    # Routing parameters
    # ------------------------------------------------------------------
    route_cache_ttl_seconds: int = Field(
        default=300,
        ge=10,
        description="TTL for in-memory route cache entries",
    )
    ambulance_avg_speed_kmph: float = Field(
        default=60.0,
        gt=0.0,
        description="Default assumed ambulance speed used when GPS speed is unavailable",
    )

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, v: str) -> str:
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        upper = v.upper()
        if upper not in allowed:
            raise ValueError(f"log_level must be one of {allowed}, got {v!r}")
        return upper


# Module-level singleton — import this in other modules.
settings = Settings()
