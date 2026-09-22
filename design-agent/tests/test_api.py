"""Tests for the HTTP API: health, auth, and error envelope."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.conftest import TEST_API_KEY


def test_health_is_public_and_reports_comfyui(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Force the ComfyUI reachability probe to fail deterministically.
    async def _boom(*_args: object, **_kwargs: object) -> httpx.Response:
        raise httpx.ConnectError("unreachable")

    monkeypatch.setattr(httpx.AsyncClient, "get", _boom)

    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["comfyui"] == "unreachable"


def test_root_requires_api_key(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "authentication_error"


def test_root_rejects_wrong_api_key(client: TestClient) -> None:
    resp = client.get("/", headers={"X-API-Key": "wrong"})
    assert resp.status_code == 401


def test_root_accepts_valid_api_key(client: TestClient) -> None:
    resp = client.get("/", headers={"X-API-Key": TEST_API_KEY})
    assert resp.status_code == 200
    assert resp.json()["service"] == "design-agent"


def test_request_id_header_is_returned(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.headers.get("X-Request-ID")


def test_request_id_is_echoed_when_provided(client: TestClient) -> None:
    resp = client.get("/health", headers={"X-Request-ID": "abc-123"})
    assert resp.headers.get("X-Request-ID") == "abc-123"
