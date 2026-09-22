"""Unit tests for 'The Entrepreneur Post' template (entrepreneur-post)."""

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


def test_entrepreneur_post_manifest_loads() -> None:
    """Validate that the entrepreneur-post template manifest loads with zero image slots."""
    manifest = get_template("entrepreneur-post")

    assert manifest.id == "entrepreneur-post"
    assert manifest.name == "The Entrepreneur Post"
    assert manifest.slides.min == 1
    assert manifest.slides.max == 10

    # Validate declared text slots
    slot_ids = {s.id for s in manifest.text_slots}
    assert {"eyebrow", "headline", "body", "cta"}.issubset(slot_ids)

    # Validate zero image slots (text template with fixed shared image)
    assert len(manifest.image_slots) == 0


def test_entrepreneur_post_html_renders() -> None:
    """Validate that template.html.j2 renders cleanly with Jinja2 context."""
    templates_dir = Path("templates")
    template_dir = templates_dir / "entrepreneur-post"
    style_css = (template_dir / "style.css").read_text(encoding="utf-8")

    env = Environment(loader=FileSystemLoader(str(template_dir)), autoescape=True)
    tmpl = env.get_template("template.html.j2")

    brand = load_brand("brand.yaml")

    context = {
        "text": {
            "eyebrow": "Government & Healthcare AI",
            "headline": "How 360 Labs Shipped 41 AI Products Across Government, Defence, and Healthcare in Under Seven Months",
            "body": "From a South Delhi office, 360 Labs has built AI systems for CDAC, the Indian Meteorological Department, a global logistics giant, and defence-focused applications. The company is less than a year old.",
            "cta": "Read full article from link in bio.",
        },
        "images": {},
        "brand_name": brand.name,
        "publication_name": "The Entrepreneur Post",
        "brand_slug": "360Labs",
        "width": 1080,
        "height": 1350,
        "slide_index": 0,
        "total_slides": 1,
        "style_content": style_css,
        "css_colors": brand.template_tokens["css_colors"],
    }

    html = tmpl.render(context)

    # Validate core DOM elements and layout
    assert '<div id="canvas"' in html
    assert "width: 1080px; height: 1350px;" in html
    assert "The Entrepreneur Post" in html
    assert "Home" in html
    assert "About" in html
    assert "How 360 Labs Shipped 41 AI Products" in html
    assert "From a South Delhi office" in html
    assert "Read full article from link in bio." in html
    assert "[360Labs]" in html
    assert "article-image" in html
    assert 'data-slot="headline"' in html
    assert 'data-slot="body"' in html
    assert 'data-slot="cta"' in html


def test_entrepreneur_post_postplan_schema() -> None:
    """Verify PostPlan strict schema generation for entrepreneur-post has empty images."""
    manifest = get_template("entrepreneur-post")
    schema = build_postplan_schema(manifest)

    assert schema["properties"]["template_id"]["enum"] == ["entrepreneur-post"]
    slide_images_schema = schema["properties"]["slides"]["items"]["properties"]["images"]
    assert slide_images_schema["properties"] == {}
    assert slide_images_schema["required"] == []


@pytest.mark.asyncio
async def test_entrepreneur_post_compositor_rendering() -> None:
    """End-to-end compositor test rendering an entrepreneur-post slide to 1080x1350 JPEG."""
    post_plan = PostPlan(
        template_id="entrepreneur-post",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={
                    "eyebrow": "Government & Healthcare AI",
                    "headline": "How 360 Labs Shipped 41 AI Products Across Government, Defence, and Healthcare in Under Seven Months",
                    "body": "From a South Delhi office, 360 Labs has built AI systems for CDAC, the Indian Meteorological Department, a global logistics giant, and defence-focused applications. The company is less than a year old.",
                    "cta": "Read full article from link in bio.",
                },
                images={},
            )
        ],
        caption="How 360 Labs shipped 41 AI products in under seven months.",
        hashtags=["360labs", "ai", "entrepreneurship", "technology"],
        alt_texts=[
            "Editorial article layout showing headline, excerpt, and black and white featured photo"
        ],
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


@pytest.mark.asyncio
async def test_entrepreneur_post_compositor_square_rendering() -> None:
    """End-to-end compositor test rendering an entrepreneur-post slide to 1080x1080 (1:1) JPEG."""
    post_plan = PostPlan(
        template_id="entrepreneur-post",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.ONE_BY_ONE,
        slides=[
            PostPlanSlide(
                text={
                    "eyebrow": "Government & Healthcare AI",
                    "headline": "SoftBank raises $11B to back OpenAI.",
                    "body": "Senior unsecured notes. Junk bond terms. A single corporate debt issuance funding one massive technology bet.",
                    "cta": "Tap to see how the AI buildout is being financed.",
                },
                images={},
            )
        ],
        caption="How SoftBank raised $11B for OpenAI.",
        hashtags=["softbank", "openai", "debt", "ai"],
        alt_texts=[
            "Square editorial article layout showing headline, excerpt, and black and white photo"
        ],
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
