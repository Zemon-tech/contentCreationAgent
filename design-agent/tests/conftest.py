"""Shared test fixtures."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings

TEST_API_KEY = "test-key"


@pytest.fixture
def settings() -> Settings:
    """Deterministic settings for tests, independent of the ambient env."""
    return Settings(
        environment="development",
        design_agent_api_key=TEST_API_KEY,
        sarvam_api_key="unused",
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    """A TestClient whose app uses the test settings.

    ``get_settings`` is overridden via FastAPI's dependency system, and the
    module-level cache is cleared so the app factory picks up test values.
    """
    get_settings.cache_clear()

    from app.main import create_app

    app = create_app()
    app.dependency_overrides[get_settings] = lambda: settings
    # raise_server_exceptions=False so the 500 handler is exercised instead of
    # the exception propagating into the test.
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client

    app.dependency_overrides.clear()
    get_settings.cache_clear()
