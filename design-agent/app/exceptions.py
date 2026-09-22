"""Application exception hierarchy.

Every expected failure mode is a subclass of :class:`DesignAgentError`, which
carries an HTTP status, a stable machine-readable ``code``, and an optional
``details`` mapping that is safe to return to the caller. Unexpected
exceptions (anything not derived from this base) are treated as 500s and their
internals are never leaked to the client — see ``app/error_handlers.py``.
"""

from __future__ import annotations

from typing import Any


class DesignAgentError(Exception):
    """Base class for all application errors.

    Args:
        message: Human-readable summary, safe to return to the caller.
        details: Optional structured context, safe to return to the caller.
    """

    status_code: int = 500
    code: str = "internal_error"

    def __init__(
        self,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = details or {}

    def to_payload(self) -> dict[str, Any]:
        """Serialize to the JSON error envelope returned by the API."""
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
            }
        }


class ConfigurationError(DesignAgentError):
    """A required setting or resource is missing or invalid at startup."""

    status_code = 500
    code = "configuration_error"


class AuthenticationError(DesignAgentError):
    """The request is missing or presented an invalid API key."""

    status_code = 401
    code = "authentication_error"


class ValidationError(DesignAgentError):
    """Caller input failed validation (bad request body or parameters)."""

    status_code = 422
    code = "validation_error"


class TemplateError(DesignAgentError):
    """A template is missing, malformed, or unsuitable for the request."""

    status_code = 400
    code = "template_error"


class PlanningError(DesignAgentError):
    """The planner (LLM) failed to produce a valid PostPlan."""

    status_code = 502
    code = "planning_error"


class ImageGenerationError(DesignAgentError):
    """The ComfyUI image stage failed."""

    status_code = 502
    code = "image_generation_error"


class CompositionError(DesignAgentError):
    """The compositor failed to render a slide to a valid image."""

    status_code = 500
    code = "composition_error"


class JobNotFoundError(DesignAgentError):
    """The requested job id does not exist."""

    status_code = 404
    code = "job_not_found"
