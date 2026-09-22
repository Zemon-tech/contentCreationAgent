"""FastAPI exception handlers.

Maps application and framework exceptions to a consistent JSON error envelope.
Known :class:`DesignAgentError` instances return their declared status/code;
anything unexpected is logged with a full traceback and returned as an opaque
500 so internal details never leak to the caller.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.exceptions import DesignAgentError
from app.logging_config import get_logger

logger = get_logger("app.errors")


async def _handle_design_agent_error(_request: Request, exc: DesignAgentError) -> JSONResponse:
    # Client errors (4xx) are expected; log at warning. Server errors are
    # genuine faults; log at error with the stack.
    if exc.status_code < status.HTTP_500_INTERNAL_SERVER_ERROR:
        logger.warning(exc.code, message=exc.message, details=exc.details)
    else:
        logger.error(exc.code, message=exc.message, details=exc.details, exc_info=exc)
    return JSONResponse(status_code=exc.status_code, content=exc.to_payload())


def _clean_validation_errors(errors: Sequence[Any]) -> list[dict[str, Any]]:
    """Ensure all error entries are cleanly JSON-serializable strings/primitives."""
    cleaned = []
    for err in errors:
        if not isinstance(err, dict):
            cleaned.append({"msg": str(err)})
            continue
        entry: dict[str, Any] = {
            "type": str(err.get("type", "")),
            "loc": list(err.get("loc", ())),
            "msg": str(err.get("msg", "")),
        }
        if "input" in err:
            inp = err["input"]
            entry["input"] = (
                inp if isinstance(inp, (str, int, float, bool, list, dict)) else str(inp)
            )
        cleaned.append(entry)
    return cleaned


async def _handle_request_validation_error(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    cleaned = _clean_validation_errors(exc.errors())
    logger.warning("request_validation_error", errors=cleaned)
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": {
                "code": "validation_error",
                "message": "Request validation failed.",
                "details": {"errors": cleaned},
            }
        },
    )


async def _handle_unexpected_error(_request: Request, exc: Exception) -> JSONResponse:
    # The catch-all. Never expose the exception text to the client.
    logger.error("unhandled_exception", exc_info=exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": {
                "code": "internal_error",
                "message": "An unexpected error occurred.",
                "details": {},
            }
        },
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Attach all application exception handlers to the app."""
    app.add_exception_handler(DesignAgentError, _handle_design_agent_error)  # type: ignore[arg-type]
    app.add_exception_handler(
        RequestValidationError,
        _handle_request_validation_error,  # type: ignore[arg-type]
    )
    app.add_exception_handler(Exception, _handle_unexpected_error)
