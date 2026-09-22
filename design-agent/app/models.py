"""Pydantic v2 data contracts for the Design Agent.

Covers:
- Enums for formats, aspect ratios, slot roles, image fits, and job statuses.
- Template manifest contracts (spec.md §5.1).
- PostPlan schema (spec.md §5.2).
- Final post.json manifest (spec.md §5.3).
- HTTP API request and response envelopes (spec.md §4).
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

# ============================================================================
# Enums
# ============================================================================


class Format(StrEnum):
    """Supported Instagram post formats."""

    SINGLE = "single"
    CAROUSEL = "carousel"


class AspectRatio(StrEnum):
    """Supported Instagram aspect ratios."""

    FOUR_BY_FIVE = "4:5"
    THREE_BY_FOUR = "3:4"
    ONE_BY_ONE = "1:1"

    @property
    def dimensions(self) -> tuple[int, int]:
        """Return target pixel (width, height)."""
        match self:
            case AspectRatio.FOUR_BY_FIVE:
                return (1080, 1350)
            case AspectRatio.THREE_BY_FOUR:
                return (1080, 1440)
            case AspectRatio.ONE_BY_ONE:
                return (1080, 1080)


class TextSlotRole(StrEnum):
    """Semantic role of a text slot in a template."""

    HEADLINE = "headline"
    BODY = "body"
    EYEBROW = "eyebrow"
    CTA = "cta"
    CAPTION_LINE = "caption_line"


class ImageSlotFit(StrEnum):
    """CSS-equivalent object-fit for an image slot."""

    COVER = "cover"
    CONTAIN = "contain"


class JobStatus(StrEnum):
    """Lifecycle statuses for generation jobs."""

    QUEUED = "queued"
    PLANNING = "planning"
    GENERATING_IMAGES = "generating_images"
    COMPOSITING = "compositing"
    DONE = "done"
    FAILED = "failed"


# ============================================================================
# 5.1 Template Manifest
# ============================================================================


class TemplateSupports(BaseModel):
    """Formats and aspect ratios supported by a template."""

    model_config = ConfigDict(frozen=True)

    formats: list[Format] = Field(min_length=1)
    aspect_ratios: list[AspectRatio] = Field(min_length=1)


class TemplateSlides(BaseModel):
    """Slide count constraints for a template."""

    model_config = ConfigDict(frozen=True)

    min: int = Field(default=1, ge=1, le=10)
    max: int = Field(default=10, ge=1, le=10)
    fixed: int | None = Field(default=None, ge=1, le=10)

    @model_validator(mode="after")
    def validate_slide_bounds(self) -> TemplateSlides:
        """Ensure min <= max and fixed aligns with bounds."""
        if self.min > self.max:
            raise ValueError(f"slides.min ({self.min}) cannot exceed slides.max ({self.max})")
        if self.fixed is not None and not (self.min <= self.fixed <= self.max):
            raise ValueError(
                f"slides.fixed ({self.fixed}) must be between min ({self.min}) and max ({self.max})"
            )
        return self


class TextSlot(BaseModel):
    """A single declared text slot in a template."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1)
    role: TextSlotRole
    max_chars: int = Field(gt=0, description="Hard character limit enforced at planning time.")
    min_chars: int = Field(default=0, ge=0)
    multiline: bool = True
    per_slide: bool = True

    @model_validator(mode="after")
    def validate_char_limits(self) -> TextSlot:
        """Ensure min_chars <= max_chars."""
        if self.min_chars > self.max_chars:
            raise ValueError(
                f"text_slot '{self.id}': min_chars ({self.min_chars}) cannot exceed max_chars ({self.max_chars})"
            )
        return self


class ImageSlot(BaseModel):
    """A single declared image slot in a template."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1)
    fit: ImageSlotFit = ImageSlotFit.COVER
    per_slide: bool = True
    comfy_workflow: str | None = None
    prompt_slot: bool = True

    @model_validator(mode="after")
    def validate_workflow_requirement(self) -> ImageSlot:
        """When prompt_slot is True, a comfy_workflow file must be declared."""
        if self.prompt_slot and not self.comfy_workflow:
            raise ValueError(
                f"image_slot '{self.id}': comfy_workflow must be specified when prompt_slot is True"
            )
        return self


class TemplateManifest(BaseModel):
    """Full template manifest loaded from templates/<template_id>/manifest.json."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    supports: TemplateSupports
    slides: TemplateSlides
    text_slots: list[TextSlot] = Field(min_length=1)
    image_slots: list[ImageSlot] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_unique_slot_ids(self) -> TemplateManifest:
        """Ensure text and image slot IDs are unique within their lists."""
        text_ids = [slot.id for slot in self.text_slots]
        if len(text_ids) != len(set(text_ids)):
            raise ValueError(f"Duplicate text slot IDs in template '{self.id}': {text_ids}")
        image_ids = [slot.id for slot in self.image_slots]
        if len(image_ids) != len(set(image_ids)):
            raise ValueError(f"Duplicate image slot IDs in template '{self.id}': {image_ids}")
        return self


# ============================================================================
# 5.2 PostPlan (Sarvam structured output)
# ============================================================================


class SlideImagePrompt(BaseModel):
    """Prompt payload for an image slot."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    prompt: str = Field(min_length=1)


class PostPlanSlide(BaseModel):
    """Content for a single slide in a PostPlan."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    text: dict[str, str] = Field(
        description="Text slot values keyed by text_slot.id.",
    )
    images: dict[str, SlideImagePrompt] = Field(
        default_factory=dict,
        description="Generation prompts keyed by image_slot.id.",
    )


class PostPlan(BaseModel):
    """Structured output from Stage 1 (Planner)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    template_id: str
    format: Format
    aspect_ratio: AspectRatio
    slides: list[PostPlanSlide] = Field(min_length=1, max_length=10)
    caption: str = Field(max_length=2200)
    hashtags: list[str] = Field(max_length=30)
    alt_texts: list[str] = Field(
        description="Alt text per slide (<= 1000 chars each).",
    )

    @field_validator("hashtags")
    @classmethod
    def validate_hashtags(cls, hashtags: list[str]) -> list[str]:
        """Validate hashtags do not contain '#' and are within limits."""
        cleaned: list[str] = []
        for tag in hashtags:
            tag_stripped = tag.strip()
            if not tag_stripped:
                continue
            if tag_stripped.startswith("#"):
                raise ValueError(
                    f"Hashtag '{tag}' must not include leading '#'. The assembler adds '#' when writing caption.txt."
                )
            if "#" in tag_stripped:
                raise ValueError(f"Hashtag '{tag}' contains invalid '#' character.")
            cleaned.append(tag_stripped)
        return cleaned

    @field_validator("alt_texts")
    @classmethod
    def validate_alt_texts(cls, alt_texts: list[str]) -> list[str]:
        """Validate each alt text is <= 1000 characters."""
        for text in alt_texts:
            if len(text) > 1000:
                raise ValueError(f"Alt text exceeds 1000 characters ({len(text)} chars)")
        return alt_texts

    @model_validator(mode="after")
    def validate_slides_and_alt_texts(self) -> PostPlan:
        """Validate alignment between format, slides, and alt_texts count."""
        if self.format == Format.SINGLE and len(self.slides) != 1:
            raise ValueError(
                f"Single format post must have exactly 1 slide, got {len(self.slides)}"
            )
        if len(self.alt_texts) != len(self.slides):
            raise ValueError(
                f"Number of alt_texts ({len(self.alt_texts)}) must match number of slides ({len(self.slides)})"
            )
        return self


# ============================================================================
# 5.3 post.json (Final output manifest)
# ============================================================================


class SlideManifest(BaseModel):
    """Record of a rendered slide in post.json."""

    model_config = ConfigDict(frozen=True)

    index: int = Field(ge=0)
    file: str = Field(min_length=1)
    alt_text: str


class PostManifest(BaseModel):
    """Full manifest written to OUTPUT_DIR/<job_id>/post.json."""

    model_config = ConfigDict(frozen=True)

    job_id: str
    created_at: datetime
    template_id: str
    format: Format
    aspect_ratio: AspectRatio
    slides: list[SlideManifest] = Field(min_length=1)
    caption: str
    hashtags: list[str]
    source_content_sha256: str
    warnings: list[str] = Field(default_factory=list)


# ============================================================================
# 4. HTTP API Request & Response Models
# ============================================================================


class CreateJobRequest(BaseModel):
    """Request payload for POST /jobs."""

    model_config = ConfigDict(extra="forbid")

    content: str = Field(
        min_length=1,
        max_length=20000,
        description="The source text content for the post.",
    )
    format: Format | None = Field(
        default=None,
        description="Desired format. If omitted, planner decides.",
    )
    aspect_ratio: AspectRatio = Field(
        default=AspectRatio.FOUR_BY_FIVE,
        description="Target aspect ratio. Defaults to 4:5.",
    )
    template_id: str | None = Field(
        default=None,
        description="Optional template ID. If omitted, planner selects.",
    )
    max_slides: int = Field(
        default=10,
        ge=1,
        le=10,
        description="Slide cap (default 10, hard cap 10).",
    )
    language: str | None = Field(
        default=None,
        description="Optional BCP-47 language hint, e.g. 'en', 'hi'.",
    )
    cover_image_url: HttpUrl | None = Field(
        default=None,
        description="Optional direct image URL used as-is for the cover (slide 0) hero instead of AI generation.",
    )

    @field_validator("content")
    @classmethod
    def validate_content_non_empty(cls, value: str) -> str:
        """Ensure content contains non-whitespace text."""
        if not value.strip():
            raise ValueError("Content must not be empty or whitespace only.")
        return value


class CreateJobResponse(BaseModel):
    """Response returned with 202 Accepted on POST /jobs."""

    model_config = ConfigDict(frozen=True)

    job_id: str
    status: JobStatus = JobStatus.QUEUED


class JobStatusResponse(BaseModel):
    """Response returned on GET /jobs/{job_id}."""

    model_config = ConfigDict(frozen=True)

    job_id: str
    status: JobStatus
    output_dir: str | None = None
    error: str | None = None
    post: PostManifest | dict[str, Any] | None = None
