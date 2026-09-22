"""Tests for application configuration."""

from __future__ import annotations

from app.config import Settings


def test_defaults_are_development() -> None:
    settings = Settings(design_agent_api_key="k")
    assert settings.environment == "development"
    assert settings.is_production is False


def test_renderer_defaults_to_console_in_dev() -> None:
    settings = Settings(environment="development", design_agent_api_key="k")
    assert settings.resolved_log_renderer == "console"


def test_renderer_defaults_to_json_in_prod() -> None:
    settings = Settings(environment="production", design_agent_api_key="k")
    assert settings.is_production is True
    assert settings.resolved_log_renderer == "json"


def test_explicit_renderer_overrides_default() -> None:
    settings = Settings(
        environment="production",
        log_renderer="console",
        design_agent_api_key="k",
    )
    assert settings.resolved_log_renderer == "console"


def test_secret_is_not_exposed_in_repr() -> None:
    settings = Settings(design_agent_api_key="super-secret")
    assert "super-secret" not in repr(settings)
    assert settings.design_agent_api_key.get_secret_value() == "super-secret"
