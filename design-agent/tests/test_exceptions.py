"""Tests for the exception hierarchy."""

from __future__ import annotations

from app.exceptions import (
    AuthenticationError,
    DesignAgentError,
    ValidationError,
)


def test_base_payload_shape() -> None:
    err = DesignAgentError("boom", details={"k": "v"})
    payload = err.to_payload()
    assert payload == {
        "error": {"code": "internal_error", "message": "boom", "details": {"k": "v"}}
    }


def test_subclasses_carry_status_and_code() -> None:
    assert AuthenticationError("no").status_code == 401
    assert AuthenticationError("no").code == "authentication_error"
    assert ValidationError("bad").status_code == 422
    assert ValidationError("bad").code == "validation_error"


def test_details_default_to_empty_dict() -> None:
    assert DesignAgentError("x").details == {}
