"""Unit tests for Stage 4 Assembler (spec.md §12, §13)."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from app.assembler import (
    assemble_job_output,
    format_caption_file,
    validate_instagram_constraints,
)
from app.compositor import RenderedSlide, RenderResult
from app.exceptions import CompositionError
from app.models import (
    AspectRatio,
    Format,
    PostPlan,
    PostPlanSlide,
    SlideImagePrompt,
)


def _make_dummy_jpeg(width: int = 1080, height: int = 1350) -> bytes:
    """Helper to generate dummy JPEG bytes."""
    img = Image.new("RGB", (width, height), color="#171514")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def test_format_caption_file() -> None:
    """Validate caption.txt format with caption, blank line, and '#' hashtags."""
    caption = "A reflection on quiet craft."
    hashtags = ["editorial", "design", "craft"]
    formatted = format_caption_file(caption, hashtags)

    expected = "A reflection on quiet craft.\n\n#editorial #design #craft\n"
    assert formatted == expected


def test_validate_instagram_constraints_valid() -> None:
    """Properly sized 1080x1350 sRGB JPEGs produce no hard errors."""
    post_plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[PostPlanSlide(text={"h": "Title"}, images={})],
        caption="Short caption",
        hashtags=["tag1"],
        alt_texts=["Alt 1"],
    )

    jpeg_bytes = _make_dummy_jpeg(1080, 1350)
    render_result = RenderResult(
        slides=[RenderedSlide(index=0, image_bytes=jpeg_bytes)],
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
    )

    warnings = validate_instagram_constraints(post_plan, render_result)
    assert warnings == []


def test_validate_instagram_constraints_invalid_width() -> None:
    """Images with width != 1080 raise CompositionError (hard constraint)."""
    post_plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[PostPlanSlide(text={"h": "Title"}, images={})],
        caption="Caption",
        hashtags=["tag"],
        alt_texts=["Alt"],
    )

    jpeg_bytes = _make_dummy_jpeg(1000, 1250)  # Wrong width
    render_result = RenderResult(
        slides=[RenderedSlide(index=0, image_bytes=jpeg_bytes)],
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
    )

    with pytest.raises(CompositionError, match="must be 1080"):
        validate_instagram_constraints(post_plan, render_result)


def test_assemble_job_output(tmp_path: Path) -> None:
    """Assembler creates output folder with slide JPEGs, caption.txt, plan.json, and post.json."""
    post_plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={"headline": "Craft in Software"},
                images={"background": SlideImagePrompt(prompt="Stone texture")},
            )
        ],
        caption="Careful and quiet work.",
        hashtags=["craft", "design"],
        alt_texts=["Cover slide description"],
    )

    jpeg_bytes = _make_dummy_jpeg(1080, 1350)
    render_result = RenderResult(
        slides=[RenderedSlide(index=0, image_bytes=jpeg_bytes)],
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        warnings=["Safe zone advisory"],
    )

    job_id = "test-job-uuid-123"
    content = "Original article source text."

    manifest = assemble_job_output(
        job_id=job_id,
        content=content,
        post_plan=post_plan,
        render_result=render_result,
        output_base_dir=tmp_path,
    )

    job_dir = tmp_path / job_id
    assert job_dir.is_dir()
    assert (job_dir / "slide_01.jpg").is_file()
    assert (job_dir / "caption.txt").is_file()
    assert (job_dir / "post.json").is_file()
    assert (job_dir / "plan.json").is_file()

    # Verify caption.txt contents
    caption_txt = (job_dir / "caption.txt").read_text(encoding="utf-8")
    assert "Careful and quiet work." in caption_txt
    assert "#craft #design" in caption_txt

    # Verify post.json manifest contents
    assert manifest.job_id == job_id
    assert len(manifest.slides) == 1
    assert manifest.slides[0].file == "slide_01.jpg"
    assert manifest.slides[0].alt_text == "Cover slide description"
    assert "Safe zone advisory" in manifest.warnings
    assert len(manifest.source_content_sha256) == 64
