"""Unit tests for the Tech Announcement template (tech-announcement)."""

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


def test_tech_announcement_manifest_loads() -> None:
    """Validate that tech-announcement manifest loads with zero image slots."""
    manifest = get_template("tech-announcement")

    assert manifest.id == "tech-announcement"
    assert manifest.name == "Tech Announcement"
    assert manifest.slides.min == 1
    assert manifest.slides.max == 10

    slot_ids = {s.id for s in manifest.text_slots}
    assert {"eyebrow", "headline", "body", "cta"}.issubset(slot_ids)
    assert len(manifest.image_slots) == 0


def test_tech_announcement_html_renders() -> None:
    """Validate that template.html.j2 renders cleanly with Jinja context."""
    templates_dir = Path("templates")
    template_dir = templates_dir / "tech-announcement"
    style_css = (template_dir / "style.css").read_text(encoding="utf-8")

    env = Environment(loader=FileSystemLoader(str(template_dir)), autoescape=True)
    tmpl = env.get_template("template.html.j2")
    brand = load_brand("brand.yaml")

    context = {
        "text": {
            "eyebrow": "SLM360X",
            "headline": "Deterministic, multimodal AI for wearables and edge devices",
            "body": "Our CTO, Saurabh Kumar, has developed SLM360X: a deterministic, multimodal small language model designed to run entirely on wearables and edge devices, including in denied or degraded environments.",
            "cta": "Read more on our website at 360labs.ai",
        },
        "images": {},
        "brand_slug": "360Labs",
        "brand_name": brand.name,
        "width": 1080,
        "height": 1080,
        "aspect_ratio": "1:1",
        "slide_index": 0,
        "total_slides": 1,
        "style_content": style_css,
        "css_colors": brand.template_tokens["css_colors"],
    }

    html = tmpl.render(context)

    assert '<div id="canvas"' in html
    assert "width: 1080px; height: 1080px;" in html
    assert "[360Labs]" in html
    assert "SLM360X" in html
    assert "Deterministic, multimodal AI for wearables and edge devices" in html
    assert "Saurabh Kumar" in html
    assert "Read more on our website at 360labs.ai" in html
    assert 'data-slot="eyebrow"' in html
    assert 'data-slot="headline"' in html
    assert 'data-slot="body"' in html
    assert 'data-slot="cta"' in html


def test_tech_announcement_postplan_schema() -> None:
    """Verify PostPlan strict schema generation for tech-announcement."""
    manifest = get_template("tech-announcement")
    schema = build_postplan_schema(manifest)

    assert schema["properties"]["template_id"]["enum"] == ["tech-announcement"]
    slide_images_schema = schema["properties"]["slides"]["items"]["properties"]["images"]
    assert slide_images_schema["properties"] == {}
    assert slide_images_schema["required"] == []


@pytest.mark.asyncio
async def test_tech_announcement_compositor_square_rendering() -> None:
    """End-to-end compositor test rendering a square (1:1) slide."""
    post_plan = PostPlan(
        template_id="tech-announcement",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.ONE_BY_ONE,
        slides=[
            PostPlanSlide(
                text={
                    "eyebrow": "SLM360X",
                    "headline": "Deterministic, multimodal AI for wearables and edge devices",
                    "body": "Our CTO, Saurabh Kumar, has developed SLM360X: a deterministic, multimodal small language model designed to run entirely on wearables and edge devices, including in denied or degraded environments.",
                    "cta": "Read more on our website at 360labs.ai",
                },
                images={},
            )
        ],
        caption="Introducing SLM360X — deterministic multimodal AI for edge devices.",
        hashtags=["slm360x", "edgeai", "wearables", "ai", "360labs"],
        alt_texts=["Product announcement for SLM360X deterministic multimodal AI for edge devices"],
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            result = await composite_post(post_plan, browser)
        finally:
            await browser.close()

    assert len(result.slides) == 1
    assert result.warnings == []

    slide = result.slides[0]
    img = Image.open(io.BytesIO(slide.image_bytes))
    assert img.format == "JPEG"
    assert img.size == (1080, 1080)


@pytest.mark.asyncio
async def test_tech_announcement_compositor_portrait_rendering() -> None:
    """End-to-end compositor test rendering a portrait (4:5) slide."""
    post_plan = PostPlan(
        template_id="tech-announcement",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={
                    "eyebrow": "SLM360X",
                    "headline": "Deterministic, multimodal AI for wearables and edge devices",
                    "body": "Our CTO, Saurabh Kumar, has developed SLM360X: a deterministic, multimodal small language model designed to run entirely on wearables and edge devices, including in denied or degraded environments.",
                    "cta": "Read more on our website at 360labs.ai",
                },
                images={},
            )
        ],
        caption="Introducing SLM360X in portrait format.",
        hashtags=["slm360x", "edgeai", "ai"],
        alt_texts=["Portrait card announcing SLM360X edge AI"],
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            result = await composite_post(post_plan, browser)
        finally:
            await browser.close()

    assert len(result.slides) == 1
    assert result.warnings == []

    slide = result.slides[0]
    img = Image.open(io.BytesIO(slide.image_bytes))
    assert img.format == "JPEG"
    assert img.size == (1080, 1350)
