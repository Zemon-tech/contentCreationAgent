"""Unit tests for template discovery, loading, and schema generation (spec.md §5.1, §5.2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.exceptions import TemplateError
from app.models import (
    AspectRatio,
    Format,
    ImageSlot,
    ImageSlotFit,
    TemplateManifest,
    TemplateSlides,
    TemplateSupports,
    TextSlot,
    TextSlotRole,
)
from app.templates_loader import (
    build_postplan_schema,
    build_sarvam_response_format,
    discover_templates,
    get_template,
    list_templates,
)


def _make_sample_manifest(template_id: str = "sample-card") -> TemplateManifest:
    """Helper to create a valid manifest."""
    return TemplateManifest(
        id=template_id,
        name="Sample Card",
        description="A quiet editorial card for essays.",
        supports=TemplateSupports(
            formats=[Format.SINGLE, Format.CAROUSEL],
            aspect_ratios=[AspectRatio.FOUR_BY_FIVE, AspectRatio.ONE_BY_ONE],
        ),
        slides=TemplateSlides(min=1, max=5, fixed=None),
        text_slots=[
            TextSlot(id="eyebrow", role=TextSlotRole.EYEBROW, max_chars=30),
            TextSlot(id="headline", role=TextSlotRole.HEADLINE, max_chars=80),
            TextSlot(id="body", role=TextSlotRole.BODY, max_chars=300),
        ],
        image_slots=[
            ImageSlot(
                id="artwork",
                fit=ImageSlotFit.COVER,
                prompt_slot=True,
                comfy_workflow="workflow.json",
            ),
            ImageSlot(
                id="logo",
                fit=ImageSlotFit.CONTAIN,
                prompt_slot=False,
                comfy_workflow=None,
            ),
        ],
    )


def test_discover_templates_empty(tmp_path: Path) -> None:
    """Empty directory yields an empty mapping."""
    assert discover_templates(tmp_path) == {}


def test_discover_templates_valid(tmp_path: Path) -> None:
    """A valid template directory with manifest and template.html.j2 is loaded."""
    tmpl_dir = tmp_path / "editorial-post"
    tmpl_dir.mkdir()

    manifest_data = _make_sample_manifest("editorial-post").model_dump(mode="json")
    (tmpl_dir / "manifest.json").write_text(json.dumps(manifest_data), encoding="utf-8")
    (tmpl_dir / "template.html.j2").write_text("<h1>{{ text.headline }}</h1>", encoding="utf-8")

    # Ignored directory starting with '_'
    shared_dir = tmp_path / "_shared"
    shared_dir.mkdir()
    (shared_dir / "manifest.json").write_text("{}", encoding="utf-8")

    templates = discover_templates(tmp_path)
    assert "editorial-post" in templates
    assert "_shared" not in templates
    assert templates["editorial-post"].name == "Sample Card"

    all_list = list_templates(tmp_path)
    assert len(all_list) == 1
    assert all_list[0].id == "editorial-post"

    retrieved = get_template("editorial-post", tmp_path)
    assert retrieved.id == "editorial-post"


def test_discover_templates_missing_template_html(tmp_path: Path) -> None:
    """Manifest without template.html.j2 raises TemplateError."""
    tmpl_dir = tmp_path / "broken-post"
    tmpl_dir.mkdir()
    manifest_data = _make_sample_manifest("broken-post").model_dump(mode="json")
    (tmpl_dir / "manifest.json").write_text(json.dumps(manifest_data), encoding="utf-8")

    with pytest.raises(TemplateError, match=r"missing required 'template\.html\.j2'"):
        discover_templates(tmp_path)


def test_discover_templates_id_mismatch(tmp_path: Path) -> None:
    """Manifest ID must match directory name."""
    tmpl_dir = tmp_path / "dir-name"
    tmpl_dir.mkdir()
    manifest_data = _make_sample_manifest("different-id").model_dump(mode="json")
    (tmpl_dir / "manifest.json").write_text(json.dumps(manifest_data), encoding="utf-8")
    (tmpl_dir / "template.html.j2").write_text("<div></div>", encoding="utf-8")

    with pytest.raises(TemplateError, match="does not match directory name"):
        discover_templates(tmp_path)


def test_get_template_not_found(tmp_path: Path) -> None:
    """Requesting an unknown template ID raises TemplateError with details."""
    with pytest.raises(TemplateError, match="Template 'missing' not found") as exc_info:
        get_template("missing", tmp_path)
    assert exc_info.value.details["requested_id"] == "missing"


def test_build_postplan_schema_strict_compliance() -> None:
    """Verify generated JSON Schema complies with Sarvam strict mode requirements."""
    manifest = _make_sample_manifest("editorial-post")
    schema = build_postplan_schema(manifest)

    # Root object assertions
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {
        "template_id",
        "format",
        "aspect_ratio",
        "slides",
        "caption",
        "hashtags",
        "alt_texts",
    }

    # template_id enum
    assert schema["properties"]["template_id"]["enum"] == ["editorial-post"]

    # format & aspect_ratio enums
    assert schema["properties"]["format"]["enum"] == ["single", "carousel"]
    assert schema["properties"]["aspect_ratio"]["enum"] == ["4:5", "1:1"]

    # slides bounds
    slides = schema["properties"]["slides"]
    assert slides["type"] == "array"
    assert slides["minItems"] == 1
    assert slides["maxItems"] == 5

    # slide item schema
    slide_item = slides["items"]
    assert slide_item["type"] == "object"
    assert slide_item["additionalProperties"] is False
    assert set(slide_item["required"]) == {"text", "images"}

    # text slots
    text_obj = slide_item["properties"]["text"]
    assert text_obj["additionalProperties"] is False
    assert set(text_obj["required"]) == {"eyebrow", "headline", "body"}
    assert text_obj["properties"]["headline"]["maxLength"] == 80
    assert text_obj["properties"]["body"]["maxLength"] == 300

    # image slots (only prompt_slot=True should be in schema)
    images_obj = slide_item["properties"]["images"]
    assert images_obj["additionalProperties"] is False
    assert set(images_obj["required"]) == {"artwork"}  # 'logo' had prompt_slot=False
    assert "logo" not in images_obj["properties"]
    assert images_obj["properties"]["artwork"]["properties"]["prompt"]["type"] == "string"

    # caption & hashtags
    assert schema["properties"]["caption"]["maxLength"] == 2200
    assert schema["properties"]["hashtags"]["maxItems"] == 30

    # alt_texts bounds
    alt_texts = schema["properties"]["alt_texts"]
    assert alt_texts["minItems"] == 1
    assert alt_texts["maxItems"] == 5
    assert alt_texts["items"]["maxLength"] == 1000


def test_build_postplan_schema_fixed_slides() -> None:
    """Templates with fixed slide counts set minItems == maxItems == fixed."""
    manifest = TemplateManifest(
        id="fixed-template",
        name="Fixed Template",
        description="Requires exactly 3 slides",
        supports=TemplateSupports(
            formats=[Format.CAROUSEL],
            aspect_ratios=[AspectRatio.FOUR_BY_FIVE],
        ),
        slides=TemplateSlides(min=1, max=10, fixed=3),
        text_slots=[TextSlot(id="copy", role=TextSlotRole.BODY, max_chars=120)],
        image_slots=[],
    )
    schema = build_postplan_schema(manifest)
    assert schema["properties"]["slides"]["minItems"] == 3
    assert schema["properties"]["slides"]["maxItems"] == 3
    assert schema["properties"]["alt_texts"]["minItems"] == 3
    assert schema["properties"]["alt_texts"]["maxItems"] == 3


def test_build_sarvam_response_format() -> None:
    """Verify the Sarvam response_format wrapper envelope."""
    manifest = _make_sample_manifest("sample-card")
    resp_fmt = build_sarvam_response_format(manifest)

    assert resp_fmt["type"] == "json_schema"
    json_schema = resp_fmt["json_schema"]
    assert json_schema["strict"] is True
    assert json_schema["name"] == "post_plan_sample_card"
    assert "schema" in json_schema
    assert json_schema["schema"]["type"] == "object"
