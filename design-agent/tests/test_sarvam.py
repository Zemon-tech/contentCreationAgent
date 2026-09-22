"""Unit tests for Sarvam Chat Completion client (spec.md §2, §6)."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.config import Settings
from app.exceptions import PlanningError
from app.sarvam import ChatMessage, SarvamClient


@pytest.mark.asyncio
async def test_sarvam_client_missing_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing API key raises PlanningError."""
    monkeypatch.setattr(
        "app.sarvam.get_settings",
        lambda: Settings(sarvam_api_key=""),
    )
    client = SarvamClient(api_key="")
    with pytest.raises(PlanningError, match="Sarvam API key is not configured"):
        await client.chat_completion([ChatMessage(role="user", content="Hello")])


@pytest.mark.asyncio
async def test_sarvam_client_success_mock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Successful chat completion parses response content."""
    client = SarvamClient(api_key="test-key", base_url="https://api.sarvam.ai")

    mock_response = {
        "id": "chatcmpl-123",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": '{"headline": "Careful Craft"}',
                }
            }
        ],
    }

    async def mock_post(
        self: httpx.AsyncClient,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json: dict[str, object] | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        assert headers is not None and headers["api-subscription-key"] == "test-key"
        return httpx.Response(200, json=mock_response, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

    result = await client.chat_completion(
        messages=[ChatMessage(role="user", content="Test")],
        response_format={"type": "json_schema"},
    )
    assert result == {"headline": "Careful Craft"}


@pytest.mark.asyncio
async def test_sarvam_client_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """HTTP error status from Sarvam API raises PlanningError."""
    client = SarvamClient(api_key="test-key")

    async def mock_post(
        self: httpx.AsyncClient,
        url: str,
        **kwargs: Any,
    ) -> httpx.Response:
        return httpx.Response(
            500,
            text="Internal upstream error",
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

    with pytest.raises(PlanningError, match="Sarvam API error"):
        await client.chat_completion([ChatMessage(role="user", content="Test")])


@pytest.mark.asyncio
async def test_sarvam_client_transport_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Network connection failure raises PlanningError."""
    client = SarvamClient(api_key="test-key")

    async def mock_post(
        self: httpx.AsyncClient,
        url: str,
        **kwargs: Any,
    ) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

    with pytest.raises(PlanningError, match="Sarvam HTTP transport failure"):
        await client.chat_completion([ChatMessage(role="user", content="Test")])
