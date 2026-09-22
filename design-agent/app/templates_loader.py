"""Template discovery, loading, validation, and JSON Schema generation.

Discovers hand-authored templates under TEMPLATES_DIR and generates
strict JSON Schemas for Sarvam structured output (spec.md §5.1, §5.2).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError as PydanticValidationError

from app.config import get_settings
from app.exceptions import TemplateError
from app.models import TemplateManifest


def discover_templates(templates_dir: Path | str | None = None) -> dict[str, TemplateManifest]:
    """Scan templates directory and load all valid template manifests.

    A template directory must contain:
    - manifest.json (valid against TemplateManifest)
    - template.html.j2 (the Jinja2 template)

    Directories beginning with '_' (e.g. '_shared') are ignored.

    Returns:
        Mapping of template_id to TemplateManifest.

    Raises:
        TemplateError: If a template directory is invalid or contains malformed manifest.
    """
    path = Path(templates_dir) if templates_dir is not None else get_settings().templates_dir

    if not path.is_dir():
        return {}

    manifests: dict[str, TemplateManifest] = {}

    for entry in sorted(path.iterdir()):
        if not entry.is_dir() or entry.name.startswith("_"):
            continue

        manifest_file = entry / "manifest.json"
        template_file = entry / "template.html.j2"

        if not manifest_file.is_file():
            continue

        if not template_file.is_file():
            raise TemplateError(
                f"Template directory '{entry.name}' is missing required 'template.html.j2'.",
                details={"template_id": entry.name, "path": str(entry)},
            )

        try:
            content = manifest_file.read_text(encoding="utf-8")
            raw_data = json.loads(content)
            if not isinstance(raw_data, dict):
                raise ValueError("manifest.json must contain a JSON object.")
            manifest = TemplateManifest.model_validate(raw_data)
        except (json.JSONDecodeError, PydanticValidationError, ValueError) as exc:
            raise TemplateError(
                f"Failed to load manifest for template '{entry.name}': {exc}",
                details={"template_id": entry.name, "error": str(exc)},
            ) from exc

        if manifest.id != entry.name:
            raise TemplateError(
                f"Template manifest ID '{manifest.id}' does not match directory name '{entry.name}'.",
                details={"manifest_id": manifest.id, "dir_name": entry.name},
            )

        manifests[manifest.id] = manifest

    return manifests


def list_templates(templates_dir: Path | str | None = None) -> list[TemplateManifest]:
    """Return a list of all discovered template manifests."""
    return list(discover_templates(templates_dir).values())


def get_template(
    template_id: str,
    templates_dir: Path | str | None = None,
) -> TemplateManifest:
    """Retrieve a specific template manifest by its ID.

    Raises:
        TemplateError: If template_id is not found.
    """
    templates = discover_templates(templates_dir)
    if template_id not in templates:
        available = list(templates.keys())
        raise TemplateError(
            f"Template '{template_id}' not found.",
            details={"requested_id": template_id, "available_templates": available},
        )
    return templates[template_id]


def build_postplan_schema(manifest: TemplateManifest) -> dict[str, Any]:
    """Generate a strict JSON Schema for PostPlan constrained to the given template manifest.

    Complies with OpenAI / Sarvam strict structured output requirements:
    - 'additionalProperties': false on every object schema.
    - All defined properties must be listed in 'required'.
    - Slot keys, min/max lengths, and slide count bounds are tailored to the manifest.
    """
    min_slides = manifest.slides.fixed if manifest.slides.fixed is not None else manifest.slides.min
    max_slides = manifest.slides.fixed if manifest.slides.fixed is not None else manifest.slides.max

    # Build text slots properties
    text_properties: dict[str, Any] = {}
    text_required: list[str] = []
    for t_slot in manifest.text_slots:
        text_properties[t_slot.id] = {
            "type": "string",
            "minLength": t_slot.min_chars,
            "maxLength": t_slot.max_chars,
            "description": f"{t_slot.role.value} text slot (max {t_slot.max_chars} chars)",
        }
        text_required.append(t_slot.id)

    # Build image slots properties for prompt_slot=True slots
    image_properties: dict[str, Any] = {}
    image_required: list[str] = []
    for img_slot in manifest.image_slots:
        if img_slot.prompt_slot:
            image_properties[img_slot.id] = {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": f"AI generation prompt for {img_slot.id} ({img_slot.fit.value})",
                    }
                },
                "required": ["prompt"],
                "additionalProperties": False,
            }
            image_required.append(img_slot.id)

    slide_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "text": {
                "type": "object",
                "properties": text_properties,
                "required": text_required,
                "additionalProperties": False,
            },
            "images": {
                "type": "object",
                "properties": image_properties,
                "required": image_required,
                "additionalProperties": False,
            },
        },
        "required": ["text", "images"],
        "additionalProperties": False,
    }

    return {
        "type": "object",
        "properties": {
            "template_id": {
                "type": "string",
                "enum": [manifest.id],
                "description": "ID of the chosen template",
            },
            "format": {
                "type": "string",
                "enum": [f.value for f in manifest.supports.formats],
                "description": "Post format",
            },
            "aspect_ratio": {
                "type": "string",
                "enum": [ar.value for ar in manifest.supports.aspect_ratios],
                "description": "Aspect ratio for all slides in this post",
            },
            "slides": {
                "type": "array",
                "minItems": min_slides,
                "maxItems": max_slides,
                "items": slide_schema,
                "description": f"Slides for the post (between {min_slides} and {max_slides} slides)",
            },
            "alt_texts": {
                "type": "array",
                "minItems": min_slides,
                "maxItems": max_slides,
                "items": {
                    "type": "string",
                    "maxLength": 1000,
                    "description": "Accessibility alt text per slide (<= 1000 chars)",
                },
                "description": "List of alt texts matching slide count exactly",
            },
            "caption": {
                "type": "string",
                "maxLength": 2200,
                "description": "Instagram post caption (<= 2200 chars)",
            },
            "hashtags": {
                "type": "array",
                "maxItems": 30,
                "items": {
                    "type": "string",
                    "pattern": r"^[A-Za-z0-9_]+$",
                    "description": "Single hashtag without '#'",
                },
                "description": "List of up to 30 hashtags without leading '#'",
            },
        },
        "required": [
            "template_id",
            "format",
            "aspect_ratio",
            "slides",
            "alt_texts",
            "caption",
            "hashtags",
        ],
        "additionalProperties": False,
    }


def build_sarvam_response_format(manifest: TemplateManifest) -> dict[str, Any]:
    """Wrap schema into Sarvam's strict response_format envelope."""
    return {
        "type": "json_schema",
        "json_schema": {
            "name": f"post_plan_{manifest.id.replace('-', '_')}",
            "strict": True,
            "schema": build_postplan_schema(manifest),
        },
    }
