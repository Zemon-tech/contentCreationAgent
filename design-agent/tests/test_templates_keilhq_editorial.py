"""Unit tests for the starter template keilhq-editorial (spec.md §5.1, §7.1)."""

from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from app.brand import load_brand
from app.templates_loader import build_postplan_schema, get_template


def test_keilhq_editorial_manifest_loads() -> None:
    """Validate that the real keilhq-editorial template loads and validates."""
    manifest = get_template("keilhq-editorial")

    assert manifest.id == "keilhq-editorial"
    assert manifest.name == "KeilHQ Editorial"
    assert manifest.slides.min == 1
    assert manifest.slides.max == 10

    # Validate declared text slots
    slot_ids = {s.id for s in manifest.text_slots}
    assert {"eyebrow", "headline", "body", "cta"}.issubset(slot_ids)

    # Validate declared image slots
    assert len(manifest.image_slots) == 1
    bg_slot = manifest.image_slots[0]
    assert bg_slot.id == "background"
    assert bg_slot.prompt_slot is True
    assert bg_slot.comfy_workflow == "keilhq-bg.json"


def test_keilhq_editorial_html_renders() -> None:
    """Validate that template.html.j2 renders cleanly with Jinja2 context."""
    templates_dir = Path("templates")
    template_dir = templates_dir / "keilhq-editorial"
    style_css = (template_dir / "style.css").read_text(encoding="utf-8")

    env = Environment(loader=FileSystemLoader(str(template_dir)), autoescape=True)
    tmpl = env.get_template("template.html.j2")

    brand = load_brand("brand.yaml")

    context = {
        "text": {
            "eyebrow": "Architecture of Craft",
            "headline": "Patience as an Editorial Method",
            "body": "Knowledge done well is careful, not fast. Deliberate, patient, and unhurried.",
            "cta": "Read the essay at keilhq.com",
        },
        "images": {
            "background": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        },
        "brand_name": brand.name,
        "width": 1080,
        "height": 1350,
        "slide_index": 0,
        "total_slides": 3,
        "style_content": style_css,
        "css_colors": brand.template_tokens["css_colors"],
    }

    html = tmpl.render(context)

    # Validate core DOM elements
    assert '<div id="canvas"' in html
    assert "width: 1080px; height: 1350px;" in html
    assert "Architecture of Craft" in html
    assert "Patience as an Editorial Method" in html
    assert 'data-slot="headline"' in html
    assert 'data-slot="body"' in html
    assert "01 / 03" in html
    assert "bg-image" in html


def test_keilhq_editorial_single_slide_rendering() -> None:
    """Single-slide posts do not display slide count fractions."""
    template_dir = Path("templates/keilhq-editorial")
    env = Environment(loader=FileSystemLoader(str(template_dir)), autoescape=True)
    tmpl = env.get_template("template.html.j2")

    html = tmpl.render(
        {
            "text": {"headline": "Standalone Thought"},
            "width": 1080,
            "height": 1080,
            "slide_index": 0,
            "total_slides": 1,
        }
    )

    assert "01 / 01" not in html
    assert "Standalone Thought" in html


def test_keilhq_editorial_postplan_schema() -> None:
    """Verify PostPlan strict schema generation for keilhq-editorial."""
    manifest = get_template("keilhq-editorial")
    schema = build_postplan_schema(manifest)

    assert schema["properties"]["template_id"]["enum"] == ["keilhq-editorial"]
    assert (
        "background" in schema["properties"]["slides"]["items"]["properties"]["images"]["required"]
    )
