"""API-key authentication.

A single shared key (``DESIGN_AGENT_API_KEY``) gates every non-public route.
Use :func:`require_api_key` as a FastAPI dependency.
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import Depends, Security
from fastapi.security import APIKeyHeader

from app.config import Settings, get_settings
from app.exceptions import AuthenticationError

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def require_api_key(
    provided: Annotated[str | None, Security(_api_key_header)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    """Reject the request unless a valid API key was supplied.

    Uses a constant-time comparison to avoid leaking key length/content through
    timing.
    """
    expected = settings.design_agent_api_key.get_secret_value()
    if not expected:
        # Fail closed: if no key is configured, no request is authorized.
        raise AuthenticationError("API key authentication is not configured.")
    if not provided or not hmac.compare_digest(provided, expected):
        raise AuthenticationError("Missing or invalid API key.")
