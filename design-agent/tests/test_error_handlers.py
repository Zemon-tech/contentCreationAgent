"""Tests for the FastAPI exception handlers via a throwaway app."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.error_handlers import register_exception_handlers
from app.exceptions import TemplateError


@pytest.fixture
def error_client() -> Iterator[TestClient]:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/known")
    async def _known() -> None:
        raise TemplateError("no such template", details={"template_id": "x"})

    @app.get("/boom")
    async def _boom() -> None:
        raise RuntimeError("secret internal detail")

    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def test_known_error_uses_declared_status_and_code(error_client: TestClient) -> None:
    resp = error_client.get("/known")
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "template_error"
    assert body["error"]["message"] == "no such template"
    assert body["error"]["details"] == {"template_id": "x"}


def test_unexpected_error_is_opaque_500(error_client: TestClient) -> None:
    resp = error_client.get("/boom")
    assert resp.status_code == 500
    body = resp.json()
    assert body["error"]["code"] == "internal_error"
    # The internal exception text must never leak to the client.
    assert "secret internal detail" not in resp.text
