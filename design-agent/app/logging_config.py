"""Structured logging setup.

Uses ``structlog`` as the front end and routes everything — including
third-party stdlib loggers (uvicorn, httpx) — through one processor chain via
``ProcessorFormatter``. This yields flat JSON in production and colorized
console output in development, with per-request context bound through
``contextvars`` so it is isolated across concurrent async requests.

Call :func:`configure_logging` exactly once, at process startup, before any
logger is used.
"""

from __future__ import annotations

import logging
import sys

import structlog
from structlog.types import Processor

from app.config import LogLevel, LogRenderer

# Third-party loggers that are noisy at INFO; pinned to WARNING.
_NOISY_LOGGERS = ("uvicorn.access", "httpx", "httpcore", "watchfiles")


def _shared_processors() -> list[Processor]:
    """Processors applied to every event, from both structlog and stdlib."""
    return [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]


def configure_logging(
    *,
    level: LogLevel = "INFO",
    renderer: LogRenderer = "console",
) -> None:
    """Configure structlog and the stdlib root logger.

    Args:
        level: Minimum level to emit.
        renderer: ``"json"`` for machine-readable output, ``"console"`` for
            colorized human-readable output.
    """
    shared = _shared_processors()

    # structlog hands its event dict to ProcessorFormatter, which then runs the
    # final renderer. This is what lets stdlib records share the same pipeline.
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    final_renderer: Processor = (
        structlog.processors.JSONRenderer()
        if renderer == "json"
        else structlog.dev.ConsoleRenderer(colors=True)
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        # These run only on records that did NOT come from structlog.
        foreign_pre_chain=shared,
        # These run on all records after the pre-chain.
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            final_renderer,
        ],
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    # Route uvicorn through the root handler; silence its access log noise.
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True
    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Return a bound structlog logger.

    Args:
        name: Optional logger name; defaults to the caller's module via
            structlog's standard resolution.
    """
    return structlog.stdlib.get_logger(name)
