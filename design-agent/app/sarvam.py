"""Thin async client for Sarvam Chat Completions API (spec.md §2, §6).

Endpoint: POST https://api.sarvam.ai/v1/chat/completions
Header: api-subscription-key: <key>
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from app.config import get_settings
from app.exceptions import PlanningError


class ChatMessage(BaseModel):
    """Chat completion message."""

    model_config = ConfigDict(frozen=True)

    role: str
    content: str


class SarvamClient:
    """Async HTTP client for Sarvam Chat Completions."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        settings = get_settings()
        self.api_key = api_key or settings.sarvam_api_key.get_secret_value()
        self.base_url = (base_url or str(settings.sarvam_base_url)).rstrip("/")
        self.model = model or settings.sarvam_model
        self.timeout = timeout

    async def chat_completion(
        self,
        messages: Sequence[ChatMessage | dict[str, Any]],
        response_format: dict[str, Any] | None = None,
        temperature: float = 0.3,
    ) -> dict[str, Any]:
        """Send a chat completion request to Sarvam with strict JSON schema response_format.

        Raises:
            PlanningError: On network, HTTP, or API response errors.
        """
        if not self.api_key:
            raise PlanningError(
                "Sarvam API key is not configured. Set SARVAM_API_KEY environment variable.",
                details={"error": "missing_api_key"},
            )

        url = f"{self.base_url}/v1/chat/completions"
        headers = {
            "api-subscription-key": self.api_key,
            "Content-Type": "application/json",
        }

        formatted_messages = [m.model_dump() if isinstance(m, ChatMessage) else m for m in messages]

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": formatted_messages,
            "temperature": temperature,
            "max_tokens": 4096,
            "reasoning_effort": None,
        }

        if response_format is not None:
            payload["response_format"] = response_format

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(url, headers=headers, json=payload)

            if response.status_code != httpx.codes.OK:
                raise PlanningError(
                    f"Sarvam API error (status {response.status_code}): {response.text}",
                    details={
                        "status_code": response.status_code,
                        "response_body": response.text,
                    },
                )

            data = response.json()
            if not isinstance(data, dict) or "choices" not in data or not data["choices"]:
                raise PlanningError(
                    "Malformed response structure from Sarvam API.",
                    details={"response": data},
                )

            choice = data["choices"][0]
            message_obj = choice.get("message", {})
            raw_content = message_obj.get("content")

            if raw_content is None:
                raise PlanningError(
                    "Sarvam API returned empty content in message choice.",
                    details={"choice": choice},
                )

            # If response_format was requested, parse the JSON content
            if response_format is not None and isinstance(raw_content, str):
                try:
                    clean_content = re.sub(
                        r"^```(?:json)?\s*|\s*```$",
                        "",
                        raw_content.strip(),
                        flags=re.MULTILINE,
                    )
                    start_idx = clean_content.find("{")
                    end_idx = clean_content.rfind("}")
                    if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
                        clean_content = clean_content[start_idx : end_idx + 1]
                    try:
                        parsed: dict[str, Any] = json.loads(clean_content, strict=False)
                    except json.JSONDecodeError:
                        sanitized = re.sub(r"(?<!\\)[\r\n]+", " ", clean_content)
                        parsed = json.loads(sanitized, strict=False)
                    return parsed
                except json.JSONDecodeError as exc:
                    raise PlanningError(
                        f"Failed to parse JSON response from Sarvam: {exc}",
                        details={"raw_content": raw_content},
                    ) from exc

            return {"content": raw_content}

        except httpx.HTTPError as exc:
            raise PlanningError(
                f"Sarvam HTTP transport failure: {exc}",
                details={"error": str(exc)},
            ) from exc
