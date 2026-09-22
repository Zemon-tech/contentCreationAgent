"""Application configuration.

All settings come from environment variables (or a local ``.env`` file for
development). Secrets are never hardcoded and never logged by value.

See ``spec.md`` section 10 for the authoritative list of variables.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, HttpUrl, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "production"]
LogRenderer = Literal["console", "json"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


class Settings(BaseSettings):
    """Typed application settings loaded from the environment.

    Field names are lower-case; the matching environment variable is the
    upper-case form (e.g. ``DESIGN_AGENT_API_KEY``). ``pydantic-settings`` is
    case-insensitive when matching.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- runtime / observability -------------------------------------------
    environment: Environment = "development"
    log_level: LogLevel = "INFO"
    # Renderer defaults follow the environment: pretty console locally,
    # machine-readable JSON in production. Override explicitly if needed.
    log_renderer: LogRenderer | None = None

    # --- auth ---------------------------------------------------------------
    design_agent_api_key: SecretStr = Field(
        default=SecretStr(""),
        description="Value clients must send in the X-API-Key header.",
    )

    # --- Sarvam (LLM) -------------------------------------------------------
    sarvam_api_key: SecretStr = Field(default=SecretStr(""))
    sarvam_base_url: HttpUrl = Field(default=HttpUrl("https://api.sarvam.ai"))
    sarvam_model: str = "sarvam-105b"

    # --- ComfyUI ------------------------------------------------------------
    comfyui_base_url: HttpUrl = Field(default=HttpUrl("http://127.0.0.1:8188"))
    comfyui_timeout_s: int = Field(default=300, ge=1)

    # --- filesystem ---------------------------------------------------------
    output_dir: Path = Path("./output")
    templates_dir: Path = Path("./templates")
    brand_file: Path = Path("./brand.yaml")

    # --- concurrency --------------------------------------------------------
    render_concurrency: int = Field(default=2, ge=1)
    job_workers: int = Field(default=1, ge=1)

    @property
    def is_production(self) -> bool:
        """True when running in the production environment."""
        return self.environment == "production"

    @property
    def resolved_log_renderer(self) -> LogRenderer:
        """The effective log renderer.

        Falls back to JSON in production and console elsewhere when
        ``log_renderer`` is not set explicitly.
        """
        if self.log_renderer is not None:
            return self.log_renderer
        return "json" if self.is_production else "console"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the cached, process-wide settings instance."""
    return Settings()
