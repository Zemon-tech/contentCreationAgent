"""Unit tests for Stage 3 Compositor (spec.md §7)."""

from __future__ import annotations

import base64
import io
from pathlib import Path

import pytest
from PIL import Image
from playwright.async_api import async_playwright

from app.compositor import (
    composite_post,
    create_placeholder_image,
    image_file_to_data_uri,
    normalize_to_jpeg,
)
from app.models import (
    AspectRatio,
    Format,
    PostPlan,
    PostPlanSlide,
    SlideImagePrompt,
)


def test_create_placeholder_image() -> None:
    """Placeholder image provider generates a valid base64 PNG data URI."""
    uri = create_placeholder_image(color="#F1EEE8", width=1080, height=1350)
    assert uri.startswith("data:image/png;base64,")

    # Decode and check dimensions
    raw_b64 = uri.split(",", 1)[1]
    raw_bytes = base64.b64decode(raw_b64)
    img = Image.open(io.BytesIO(raw_bytes))
    assert img.size == (1080, 1350)
    assert img.format == "PNG"


def test_image_file_to_data_uri(tmp_path: Path) -> None:
    """Image file to data URI converter produces expected MIME types."""
    sample_file = tmp_path / "sample.jpg"
    img = Image.new("RGB", (100, 100), color="#2B6F6A")
    img.save(sample_file, format="JPEG")

    uri = image_file_to_data_uri(sample_file)
    assert uri.startswith("data:image/jpeg;base64,")


def test_normalize_to_jpeg_dimensions_and_size() -> None:
    """Normalization ensures exact dimensions, RGB mode, and <= 1.4 MB JPEG."""
    # Create an oversized RGBA test image
    raw = Image.new("RGBA", (1200, 1500), color=(23, 21, 20, 255))
    buf = io.BytesIO()
    raw.save(buf, format="PNG")

    jpeg_bytes, warnings = normalize_to_jpeg(
        png_bytes=buf.getvalue(),
        target_dimensions=(1080, 1350),
        max_bytes=1_400_000,
    )

    out_img = Image.open(io.BytesIO(jpeg_bytes))
    assert out_img.format == "JPEG"
    assert out_img.mode == "RGB"
    assert out_img.size == (1080, 1350)
    assert len(jpeg_bytes) <= 1_400_000
    assert warnings == []


@pytest.mark.asyncio
async def test_composite_post_single_slide(tmp_path: Path) -> None:
    """End-to-end compositor test for a single portrait 4:5 post."""
    post_plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={
                    "eyebrow": "Quiet Architecture",
                    "headline": "Software Built with Patience",
                    "body": "Knowledge done well is careful, not fast. Deliberate, patient, unhurried.",
                    "cta": "Explore our notes at keilhq.com",
                },
                images={"background": SlideImagePrompt(prompt="Stone texture")},
            )
        ],
        caption="A reflection on quiet craft.",
        hashtags=["editorial", "design", "craft"],
        alt_texts=["Cover slide displaying title and thoughtful typography"],
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            result = await composite_post(post_plan, browser)
        finally:
            await browser.close()

    assert len(result.slides) == 1
    assert result.aspect_ratio == AspectRatio.FOUR_BY_FIVE

    slide = result.slides[0]
    assert slide.index == 0

    # Verify JPEG properties
    img = Image.open(io.BytesIO(slide.image_bytes))
    assert img.format == "JPEG"
    assert img.mode == "RGB"
    assert img.size == (1080, 1350)
    assert len(slide.image_bytes) <= 1_400_000

    # Save to disk for inspection verification
    output_dir = Path("./output/test_compositor")
    output_dir.mkdir(parents=True, exist_ok=True)  # noqa: ASYNC240
    (output_dir / "slide_01.jpg").write_bytes(slide.image_bytes)


@pytest.mark.asyncio
async def test_composite_post_carousel() -> None:
    """Compositor renders all slides in a carousel with consistent aspect ratio."""
    post_plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.CAROUSEL,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={
                    "eyebrow": "Part I",
                    "headline": "The Deliberate Method",
                    "body": "First thoughts on restraint and precision.",
                    "cta": "Swipe for Part II",
                },
                images={},
            ),
            PostPlanSlide(
                text={
                    "eyebrow": "Part II",
                    "headline": "The Artifacts",
                    "body": "Second thoughts on enduring systems.",
                    "cta": "Read more at keilhq.com",
                },
                images={},
            ),
        ],
        caption="A two-part reflection.",
        hashtags=["restraint", "quality"],
        alt_texts=["Slide 1 on method", "Slide 2 on artifacts"],
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            result = await composite_post(post_plan, browser)
        finally:
            await browser.close()

    assert len(result.slides) == 2
    for slide in result.slides:
        img = Image.open(io.BytesIO(slide.image_bytes))
        assert img.format == "JPEG"
        assert img.size == (1080, 1350)
        assert len(slide.image_bytes) <= 1_400_000


@pytest.mark.asyncio
async def test_composite_overflow_auto_fit() -> None:
    """Compositor auto-fits overflowing text without crashing."""
    # Extremely long text that forces auto-fit shrinking
    very_long_body = (
        "In the design of durable intellectual tools, we prioritize clarity over novelty. " * 15
    )
    post_plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={
                    "eyebrow": "Deep Essay",
                    "headline": "A Very Significant And Substantial Exploration Of Systems",
                    "body": very_long_body,
                    "cta": "Learn more",
                },
                images={},
            )
        ],
        caption="Dense reflection.",
        hashtags=["longform"],
        alt_texts=["Dense essay slide"],
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            result = await composite_post(post_plan, browser)
        finally:
            await browser.close()

    assert len(result.slides) == 1
    # Auto-fit executes and either fits or records a warning, producing valid JPEG
    slide = result.slides[0]
    img = Image.open(io.BytesIO(slide.image_bytes))
    assert img.size == (1080, 1350)
