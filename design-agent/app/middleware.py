"""HTTP middleware.

Binds request-scoped context (request id, method, path) into structlog's
``contextvars`` so every log line emitted while handling a request carries it,
isolated across concurrent async requests. The request id is echoed back on the
``X-Request-ID`` response header for client-side correlation.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.logging_config import get_logger

logger = get_logger("app.http")

_REQUEST_ID_HEADER = "X-Request-ID"

# Paths that should not emit request start/complete logs (health checks, etc.).
_QUIET_PATHS = frozenset({"/health"})


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Attach a request id and structured context to every request."""

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        request_id = request.headers.get(_REQUEST_ID_HEADER) or uuid.uuid4().hex

        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=request_id,
            method=request.method,
            path=request.url.path,
        )

        quiet = request.url.path in _QUIET_PATHS
        start = time.perf_counter()
        if not quiet:
            logger.info("request_started")

        try:
            response = await call_next(request)
        except Exception:
            # Exception handlers still run after this; we just record the fault
            # with full request context, then re-raise.
            logger.exception("request_failed")
            raise
        else:
            if not quiet:
                duration_ms = round((time.perf_counter() - start) * 1000, 2)
                logger.info(
                    "request_completed",
                    status_code=response.status_code,
                    duration_ms=duration_ms,
                )
            response.headers[_REQUEST_ID_HEADER] = request_id
            return response
        finally:
            structlog.contextvars.clear_contextvars()
