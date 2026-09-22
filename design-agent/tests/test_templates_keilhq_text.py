"""Unit tests for the pure text template keilhq-text."""

from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from app.brand import load_brand
from app.templates_loader import build_postplan_schema, get_template


def test_keilhq_text_manifest_loads() -> None:
    """Validate that the keilhq-text template loads and has no image slots."""
    manifest = get_template("keilhq-text")

    assert manifest.id == "keilhq-text"
    assert manifest.name == "KeilHQ Text"
    assert manifest.slides.min == 1
    assert manifest.slides.max == 10

    # Validate declared text slots
    slot_ids = {s.id for s in manifest.text_slots}
    assert {"eyebrow", "headline", "body", "cta"}.issubset(slot_ids)

    # Validate zero image slots
    assert len(manifest.image_slots) == 0


def test_keilhq_text_html_renders() -> None:
    """Validate that template.html.j2 renders cleanly with Jinja2 context."""
    templates_dir = Path("templates")
    template_dir = templates_dir / "keilhq-text"
    style_css = (template_dir / "style.css").read_text(encoding="utf-8")

    env = Environment(loader=FileSystemLoader(str(template_dir)), autoescape=True)
    tmpl = env.get_template("template.html.j2")

    brand = load_brand("brand.yaml")

    context = {
        "text": {
            "eyebrow": "Systems Thinking",
            "headline": "Readability over Cleverness",
            "body": "Clear code and clear prose share the same discipline: removing what obscures the intent.",
            "cta": "Read more at keilhq.com",
        },
        "images": {},
        "brand_name": brand.name,
        "width": 1080,
        "height": 1350,
        "slide_index": 0,
        "total_slides": 2,
        "style_content": style_css,
        "css_colors": brand.template_tokens["css_colors"],
    }

    html = tmpl.render(context)

    # Validate core DOM elements
    assert '<div id="canvas"' in html
    assert "width: 1080px; height: 1350px;" in html
    assert "Readability over Cleverness" in html
    assert 'data-slot="headline"' in html
    assert 'data-slot="body"' in html
    assert "01 / 02" in html
    assert "text-card" in html
    assert "editorial-divider" in html


def test_keilhq_text_postplan_schema() -> None:
    """Verify PostPlan strict schema generation for keilhq-text has empty images required."""
    manifest = get_template("keilhq-text")
    schema = build_postplan_schema(manifest)

    assert schema["properties"]["template_id"]["enum"] == ["keilhq-text"]
    slide_images_schema = schema["properties"]["slides"]["items"]["properties"]["images"]
    assert slide_images_schema["properties"] == {}
    assert slide_images_schema["required"] == []
