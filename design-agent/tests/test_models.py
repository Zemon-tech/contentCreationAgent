"""Unit tests for Pydantic contracts and data models (spec.md §4, §5)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.models import (
    AspectRatio,
    CreateJobRequest,
    CreateJobResponse,
    Format,
    ImageSlot,
    ImageSlotFit,
    JobStatus,
    JobStatusResponse,
    PostManifest,
    PostPlan,
    PostPlanSlide,
    SlideImagePrompt,
    SlideManifest,
    TemplateManifest,
    TemplateSlides,
    TemplateSupports,
    TextSlot,
    TextSlotRole,
)


def test_aspect_ratio_dimensions() -> None:
    """Check Instagram target pixel dimensions."""
    assert AspectRatio.FOUR_BY_FIVE.dimensions == (1080, 1350)
    assert AspectRatio.THREE_BY_FOUR.dimensions == (1080, 1440)
    assert AspectRatio.ONE_BY_ONE.dimensions == (1080, 1080)


def test_template_manifest_valid() -> None:
    """Validate a properly formed template manifest."""
    manifest = TemplateManifest(
        id="sample-template",
        name="Sample Template",
        description="A clean editorial template",
        supports=TemplateSupports(
            formats=[Format.SINGLE, Format.CAROUSEL],
            aspect_ratios=[AspectRatio.FOUR_BY_FIVE],
        ),
        slides=TemplateSlides(min=1, max=10, fixed=None),
        text_slots=[
            TextSlot(id="headline", role=TextSlotRole.HEADLINE, max_chars=60),
            TextSlot(id="body", role=TextSlotRole.BODY, max_chars=200, min_chars=10),
        ],
        image_slots=[
            ImageSlot(
                id="bg",
                fit=ImageSlotFit.COVER,
                prompt_slot=True,
                comfy_workflow="workflow.json",
            )
        ],
    )
    assert manifest.id == "sample-template"
    assert manifest.text_slots[0].max_chars == 60


def test_template_slides_bounds_validation() -> None:
    """Slide constraints must enforce min <= max and valid fixed."""
    with pytest.raises(ValidationError, match=r"slides\.min"):
        TemplateSlides(min=5, max=3)

    with pytest.raises(ValidationError, match=r"slides\.fixed"):
        TemplateSlides(min=2, max=6, fixed=8)

    with pytest.raises(ValidationError, match=r"slides\.fixed"):
        TemplateSlides(min=3, max=6, fixed=2)


def test_template_text_slot_char_limits() -> None:
    """Text slot min_chars cannot exceed max_chars."""
    with pytest.raises(ValidationError, match="min_chars"):
        TextSlot(id="title", role=TextSlotRole.HEADLINE, min_chars=50, max_chars=40)


def test_template_image_slot_workflow_requirement() -> None:
    """When prompt_slot is True, comfy_workflow is required."""
    with pytest.raises(ValidationError, match="comfy_workflow must be specified"):
        ImageSlot(id="bg", prompt_slot=True, comfy_workflow=None)

    # Allowed when prompt_slot is False
    slot = ImageSlot(id="logo", prompt_slot=False, comfy_workflow=None)
    assert not slot.prompt_slot


def test_template_manifest_unique_slot_ids() -> None:
    """Manifest must reject duplicate slot IDs."""
    with pytest.raises(ValidationError, match="Duplicate text slot IDs"):
        TemplateManifest(
            id="test",
            name="Test",
            description="desc",
            supports=TemplateSupports(
                formats=[Format.SINGLE],
                aspect_ratios=[AspectRatio.ONE_BY_ONE],
            ),
            slides=TemplateSlides(min=1, max=1),
            text_slots=[
                TextSlot(id="headline", role=TextSlotRole.HEADLINE, max_chars=50),
                TextSlot(id="headline", role=TextSlotRole.BODY, max_chars=100),
            ],
        )


def test_post_plan_valid() -> None:
    """Validate a schema-compliant PostPlan."""
    plan = PostPlan(
        template_id="sample-template",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={"headline": "Deliberate Thought"},
                images={"bg": SlideImagePrompt(prompt="Earthy minimal texture")},
            )
        ],
        caption="A quiet reflection on work and craft.",
        hashtags=["editorial", "keilhq", "craft"],
        alt_texts=["Cover slide featuring minimal texture and typography"],
    )
    assert plan.format == Format.SINGLE
    assert len(plan.slides) == 1
    assert plan.hashtags == ["editorial", "keilhq", "craft"]


def test_post_plan_hashtag_validation() -> None:
    """Hashtags must not include '#' and cannot exceed 30 items."""
    with pytest.raises(ValidationError, match="must not include leading '#'"):
        PostPlan(
            template_id="t1",
            format=Format.SINGLE,
            aspect_ratio=AspectRatio.FOUR_BY_FIVE,
            slides=[PostPlanSlide(text={"headline": "Test"}, images={})],
            caption="Caption",
            hashtags=["#design"],
            alt_texts=["Alt"],
        )

    with pytest.raises(ValidationError, match="invalid '#' character"):
        PostPlan(
            template_id="t1",
            format=Format.SINGLE,
            aspect_ratio=AspectRatio.FOUR_BY_FIVE,
            slides=[PostPlanSlide(text={"headline": "Test"}, images={})],
            caption="Caption",
            hashtags=["de#sign"],
            alt_texts=["Alt"],
        )


def test_post_plan_slide_and_alt_counts() -> None:
    """Single posts must have 1 slide, and alt_texts count must match slides."""
    with pytest.raises(ValidationError, match="must have exactly 1 slide"):
        PostPlan(
            template_id="t1",
            format=Format.SINGLE,
            aspect_ratio=AspectRatio.FOUR_BY_FIVE,
            slides=[
                PostPlanSlide(text={"h": "Slide 1"}, images={}),
                PostPlanSlide(text={"h": "Slide 2"}, images={}),
            ],
            caption="Caption",
            hashtags=["art"],
            alt_texts=["Alt 1", "Alt 2"],
        )

    with pytest.raises(ValidationError, match=r"Number of alt_texts .* must match"):
        PostPlan(
            template_id="t1",
            format=Format.CAROUSEL,
            aspect_ratio=AspectRatio.FOUR_BY_FIVE,
            slides=[
                PostPlanSlide(text={"h": "Slide 1"}, images={}),
                PostPlanSlide(text={"h": "Slide 2"}, images={}),
            ],
            caption="Caption",
            hashtags=["art"],
            alt_texts=["Alt 1"],  # only 1 alt text for 2 slides
        )


def test_post_manifest_roundtrip() -> None:
    """Validate post.json output contract."""
    manifest = PostManifest(
        job_id="123e4567-e89b-12d3-a456-426614174000",
        created_at=datetime.now(UTC),
        template_id="sample-template",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[SlideManifest(index=0, file="slide_01.jpg", alt_text="Slide 1 description")],
        caption="Sample caption",
        hashtags=["tag1", "tag2"],
        source_content_sha256="abcdef0123456789",
        warnings=["Safe zone overflow warning"],
    )
    dumped = manifest.model_dump()
    assert dumped["job_id"] == "123e4567-e89b-12d3-a456-426614174000"
    assert len(dumped["slides"]) == 1
    assert dumped["warnings"] == ["Safe zone overflow warning"]


def test_create_job_request_validation() -> None:
    """Validate API request body constraints."""
    # Empty / whitespace content is rejected
    with pytest.raises(ValidationError, match="Content must not be empty"):
        CreateJobRequest(content="   \n\t  ")

    # Content > 20000 chars rejected
    with pytest.raises(ValidationError):
        CreateJobRequest(content="a" * 20001)

    # max_slides > 10 rejected
    with pytest.raises(ValidationError):
        CreateJobRequest(content="Valid content", max_slides=11)

    # Valid request with defaults
    req = CreateJobRequest(content="Some source article text")
    assert req.aspect_ratio == AspectRatio.FOUR_BY_FIVE
    assert req.max_slides == 10
    assert req.format is None


def test_api_responses() -> None:
    """Validate API response structures."""
    create_resp = CreateJobResponse(job_id="abc-123")
    assert create_resp.status == JobStatus.QUEUED

    status_resp = JobStatusResponse(
        job_id="abc-123",
        status=JobStatus.DONE,
        output_dir="./output/abc-123",
    )
    assert status_resp.status == JobStatus.DONE
    assert status_resp.output_dir == "./output/abc-123"
