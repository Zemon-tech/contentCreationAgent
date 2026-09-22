"""Tests for logging configuration."""

from __future__ import annotations

import json
import logging

from app.logging_config import configure_logging, get_logger


def test_json_renderer_emits_valid_json(capsys) -> None:  # type: ignore[no-untyped-def]
    configure_logging(level="INFO", renderer="json")
    log = get_logger("test.json")
    log.info("event_happened", widget="gizmo", count=3)

    captured = capsys.readouterr().out.strip()
    payload = json.loads(captured)
    assert payload["event"] == "event_happened"
    assert payload["widget"] == "gizmo"
    assert payload["count"] == 3
    assert payload["level"] == "info"


def test_level_threshold_drops_debug(capsys) -> None:  # type: ignore[no-untyped-def]
    configure_logging(level="INFO", renderer="json")
    log = get_logger("test.level")
    log.debug("should_not_appear")
    assert capsys.readouterr().out.strip() == ""


def test_stdlib_logs_are_routed_through_formatter(capsys) -> None:  # type: ignore[no-untyped-def]
    configure_logging(level="INFO", renderer="json")
    logging.getLogger("some.third.party").warning("stdlib_message")

    captured = capsys.readouterr().out.strip()
    payload = json.loads(captured)
    assert payload["event"] == "stdlib_message"
    assert payload["level"] == "warning"
