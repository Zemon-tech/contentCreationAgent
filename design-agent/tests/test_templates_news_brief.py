"""Unit tests for the News Brief template (news-brief)."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from jinja2 import Environment, FileSystemLoader
from PIL import Image
from playwright.async_api import async_playwright

from app.brand import load_brand
from app.compositor import composite_post
from app.models import AspectRatio, Format, PostPlan, PostPlanSlide
from app.templates_loader import build_postplan_schema, get_template


def test_news_brief_manifest_loads() -> None:
    """Validate that news-brief manifest loads with 4:5 aspect ratio and hero image slot."""
    manifest = get_template("news-brief")

    assert manifest.id == "news-brief"
    assert manifest.name == "News Brief"
    assert manifest.supports.formats == [Format.SINGLE]
    assert AspectRatio.THREE_BY_FOUR in manifest.supports.aspect_ratios
    assert AspectRatio.FOUR_BY_FIVE in manifest.supports.aspect_ratios
    assert manifest.slides.fixed == 1

    slot_ids = {s.id for s in manifest.text_slots}
    assert {"eyebrow", "headline", "body"}.issubset(slot_ids)
    assert [s.id for s in manifest.image_slots] == ["hero"]

    headline_slot = next(s for s in manifest.text_slots if s.id == "headline")
    assert headline_slot.max_chars <= 120  # Under 15 words


def test_news_brief_logo_assets_exist() -> None:
    """RAS brand lockup PNG assets and fallback back.jpg must exist in the template dir."""
    template_dir = Path("templates") / "news-brief"
    assert (template_dir / "ras-by-keilhq-dark-mode.png").is_file()
    assert (template_dir / "ras-by-keilhq-light-mode.png").is_file()
    assert (template_dir / "back.jpg").is_file()


def test_news_brief_html_renders() -> None:
    """Validate that template.html.j2 renders with Jinja context."""
    templates_dir = Path("templates")
    template_dir = templates_dir / "news-brief"
    style_css = (template_dir / "style.css").read_text(encoding="utf-8")

    env = Environment(loader=FileSystemLoader(str(template_dir)), autoescape=True)
    tmpl = env.get_template("template.html.j2")
    brand = load_brand("brand.yaml")

    context = {
        "text": {
            "eyebrow": "INDONESIA ALERT",
            "headline": "SURABAYA MENCEKAM! Sejarah dan Arsitektur Gedung Grahadi yang Dibakar Massa.",
            "body": "Gedung Grahadi di Surabaya dibakar massa pada Sabtu malam setelah aksi demonstrasi memanas menuntut pembebasan rekan demonstran.",
        },
        "images": {"hero": "data:image/png;base64,iVBORw0KGgo="},
        "logo_dark": "data:image/png;base64,iVBORw0KGgo=",
        "logo_light": None,
        "brand_name": brand.name,
        "width": 1080,
        "height": 1350,
        "aspect_ratio": "4:5",
        "slide_index": 0,
        "total_slides": 1,
        "style_content": style_css,
        "css_colors": brand.template_tokens["css_colors"],
    }

    html = tmpl.render(context)

    assert '<div id="canvas"' in html
    assert "hero-image-container" in html
    assert "gradient-top" in html
    assert "gradient-bottom" in html
    assert "news-header" in html
    assert "header-right" in html
    assert 'class="brand-logo"' in html
    assert 'alt="RAS by KeilHQ"' in html
    assert "INDONESIA ALERT" in html
    assert "SURABAYA MENCEKAM!" in html
    assert "headline-box" in html
    assert "slot-body" in html
    assert 'data-slot="headline"' in html
    assert 'data-slot="body"' in html


def test_news_brief_postplan_schema() -> None:
    """Verify PostPlan schema requires hero prompt and adheres to single slide."""
    manifest = get_template("news-brief")
    schema = build_postplan_schema(manifest)

    assert schema["properties"]["template_id"]["enum"] == ["news-brief"]
    assert set(schema["properties"]["aspect_ratio"]["enum"]) == {"3:4", "4:5"}
    assert schema["properties"]["format"]["enum"] == ["single"]


@pytest.mark.asyncio
async def test_news_brief_compositor_renders_image() -> None:
    """Verify that composite_post successfully renders a 1080x1350 PNG for news-brief."""
    plan = PostPlan(
        template_id="news-brief",
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        format=Format.SINGLE,
        slides=[
            PostPlanSlide(
                text={
                    "eyebrow": "BREAKING NEWS",
                    "headline": "SURABAYA MENCEKAM! Sejarah dan Arsitektur Gedung Grahadi Surabaya Dibakar.",
                    "body": "Gedung Grahadi di Jalan Gubernur Suryo dibakar massa pada Sabtu malam setelah aksi berkumpul di depan gedung menuntut rekannya dibebaskan.",
                }
            )
        ],
    )

    async with async_playwright() as playwright:
        rendered = await composite_post(plan, playwright=playwright)
        assert len(rendered) == 1

        img = Image.open(io.BytesIO(rendered[0].image_bytes))
        assert img.size == (1080, 1350)
