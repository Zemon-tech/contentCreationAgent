"""Stage 1 — Planner (spec.md §6).

Uses Sarvam structured output (sarvam-105b) with a dynamically generated
strict JSON Schema to transform source content into a schema-validated PostPlan.
Applies brand guidelines, character caps, and banned-word enforcement with a single retry.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError as PydanticValidationError

from app.brand import build_prompt_rules, load_brand, scan_banned_words
from app.exceptions import PlanningError, TemplateError
from app.models import (
    AspectRatio,
    CreateJobRequest,
    Format,
    PostPlan,
    TemplateManifest,
)
from app.sarvam import ChatMessage, SarvamClient
from app.templates_loader import (
    build_postplan_schema,
    get_template,
    list_templates,
)


def validate_plan_against_manifest(
    plan: PostPlan,
    manifest: TemplateManifest,
    max_slides_cap: int = 10,
) -> list[str]:
    """Validate a PostPlan against the template manifest and brand constraints.

    Returns:
        List of error descriptions. Empty list means the plan is valid.
    """
    errors: list[str] = []

    # 1. Slide count validation
    min_slides = manifest.slides.fixed if manifest.slides.fixed is not None else manifest.slides.min
    max_slides = (
        manifest.slides.fixed
        if manifest.slides.fixed is not None
        else min(manifest.slides.max, max_slides_cap)
    )

    if not (min_slides <= len(plan.slides) <= max_slides):
        errors.append(
            f"Slide count ({len(plan.slides)}) must be between {min_slides} and {max_slides}."
        )

    # 2. Text slot character limits per slide
    for idx, slide in enumerate(plan.slides):
        for slot in manifest.text_slots:
            if slot.id not in slide.text:
                errors.append(f"Slide {idx + 1} is missing required text slot '{slot.id}'.")
                continue
            text_val = slide.text[slot.id]
            if len(text_val) > slot.max_chars:
                errors.append(
                    f"Slide {idx + 1} slot '{slot.id}' length ({len(text_val)}) exceeds max_chars ({slot.max_chars})."
                )
            if len(text_val) < slot.min_chars:
                errors.append(
                    f"Slide {idx + 1} slot '{slot.id}' length ({len(text_val)}) is below min_chars ({slot.min_chars})."
                )

    # 3. Image prompts for prompt_slot=True
    for idx, slide in enumerate(plan.slides):
        for img_slot in manifest.image_slots:
            if img_slot.prompt_slot and (
                img_slot.id not in slide.images or not slide.images[img_slot.id].prompt.strip()
            ):
                errors.append(
                    f"Slide {idx + 1} is missing required generation prompt for image slot '{img_slot.id}'."
                )

    # 4. Alt texts alignment
    if len(plan.alt_texts) != len(plan.slides):
        errors.append(
            f"Alt texts count ({len(plan.alt_texts)}) does not match slide count ({len(plan.slides)})."
        )

    # 5. Brand banned words check (spec §6.5 & §8)
    all_texts: list[str] = [plan.caption]
    all_texts.extend(plan.hashtags)
    all_texts.extend(plan.alt_texts)
    for slide in plan.slides:
        all_texts.extend(slide.text.values())

    banned_hits = scan_banned_words(all_texts)
    if banned_hits:
        errors.append(
            f"Content contains strictly banned words: {', '.join(repr(w) for w in banned_hits)}. "
            "Please revise without using these words or emojis."
        )

    return errors


async def select_template(
    content: str,
    format_req: Format | None = None,
    aspect_req: AspectRatio | None = None,
    template_id: str | None = None,
    sarvam_client: SarvamClient | None = None,
    templates_dir: Path | None = None,
) -> TemplateManifest:
    """Select the template to use, either by ID or through an LLM choice (spec §6.1)."""
    if template_id:
        manifest = get_template(template_id, templates_dir)
        if format_req and format_req not in manifest.supports.formats:
            fmt_str = format_req.value if isinstance(format_req, Format) else str(format_req)
            raise TemplateError(
                f"Template '{template_id}' does not support format '{fmt_str}'.",
                details={"template_id": template_id, "requested_format": fmt_str},
            )
        if aspect_req and aspect_req not in manifest.supports.aspect_ratios:
            ar_str = aspect_req.value if isinstance(aspect_req, AspectRatio) else str(aspect_req)
            raise TemplateError(
                f"Template '{template_id}' does not support aspect ratio '{ar_str}'.",
                details={"template_id": template_id, "requested_aspect_ratio": ar_str},
            )
        return manifest

    # Discover and filter candidate templates
    candidates = list_templates(templates_dir)
    if format_req:
        candidates = [t for t in candidates if format_req in t.supports.formats]
    if aspect_req:
        candidates = [t for t in candidates if aspect_req in t.supports.aspect_ratios]

    if not candidates:
        raise TemplateError(
            "No templates match the requested format or aspect ratio constraints.",
            details={
                "format": format_req.value if format_req else None,
                "aspect_ratio": aspect_req.value if aspect_req else None,
            },
        )

    if len(candidates) == 1:
        return candidates[0]

    # Ask Sarvam to pick the best template among candidates
    client = sarvam_client or SarvamClient()
    template_choices = [
        {"id": t.id, "name": t.name, "description": t.description} for t in candidates
    ]
    candidate_ids = [t.id for t in candidates]

    schema = {
        "type": "json_schema",
        "json_schema": {
            "name": "select_template",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "template_id": {
                        "type": "string",
                        "enum": candidate_ids,
                        "description": "Selected template ID best suited for the content.",
                    },
                    "rationale": {
                        "type": "string",
                        "description": "Brief reason for choosing this template.",
                    },
                },
                "required": ["template_id", "rationale"],
                "additionalProperties": False,
            },
        },
    }

    system_msg = (
        "You are the visual editor choosing the best layout template for an editorial post. "
        f"Available templates:\n{json.dumps(template_choices, indent=2)}"
    )
    user_msg = f"Choose the best template for this content:\n\n{content}"

    response = await client.chat_completion(
        messages=[
            ChatMessage(role="system", content=system_msg),
            ChatMessage(role="user", content=user_msg),
        ],
        response_format=schema,
        temperature=0.1,
    )

    chosen_id = response.get("template_id")
    if not chosen_id or chosen_id not in candidate_ids:
        # Fallback to first candidate if selection was ambiguous
        return candidates[0]

    return get_template(chosen_id, templates_dir)


def build_planner_schema(
    manifest: TemplateManifest,
    format_req: Format | None = None,
    aspect_req: AspectRatio | None = None,
    max_slides_cap: int = 10,
) -> dict[str, Any]:
    """Build the JSON Schema for the PostPlan call, applying request-specific constraints."""
    schema = build_postplan_schema(manifest)

    # Restrict format enum if caller specified one
    if format_req and format_req in manifest.supports.formats:
        schema["properties"]["format"]["enum"] = [format_req.value]

    # Restrict aspect_ratio enum if caller specified one
    if aspect_req and aspect_req in manifest.supports.aspect_ratios:
        schema["properties"]["aspect_ratio"]["enum"] = [aspect_req.value]

    # Restrict slide count for single format or caller caps
    if format_req == Format.SINGLE:
        schema["properties"]["slides"]["minItems"] = 1
        schema["properties"]["slides"]["maxItems"] = 1
        schema["properties"]["alt_texts"]["minItems"] = 1
        schema["properties"]["alt_texts"]["maxItems"] = 1
    elif manifest.slides.fixed is None and max_slides_cap < manifest.slides.max:
        schema["properties"]["slides"]["maxItems"] = max_slides_cap
        schema["properties"]["alt_texts"]["maxItems"] = max_slides_cap

    return {
        "type": "json_schema",
        "json_schema": {
            "name": f"post_plan_{manifest.id.replace('-', '_')}",
            "strict": True,
            "schema": schema,
        },
    }


async def plan_post(
    request: CreateJobRequest,
    sarvam_client: SarvamClient | None = None,
    templates_dir: Path | None = None,
) -> tuple[PostPlan, TemplateManifest]:
    """Execute Stage 1 (Planner): Content text -> validated PostPlan (spec.md §6).

    Retries once on validation failure or banned words hit.
    """
    client = sarvam_client or SarvamClient()
    brand = load_brand()

    # 1. Select template
    manifest = await select_template(
        content=request.content,
        format_req=request.format,
        aspect_req=request.aspect_ratio,
        template_id=request.template_id,
        sarvam_client=client,
        templates_dir=templates_dir,
    )

    # 2. Build tailored JSON Schema
    schema_wrapper = build_planner_schema(
        manifest=manifest,
        format_req=request.format,
        aspect_req=request.aspect_ratio,
        max_slides_cap=request.max_slides,
    )

    # 3. System and user prompts
    brand_rules = build_prompt_rules(brand)
    system_prompt = f"""You are the principal editorial writer and art director at KeilHQ.
Your task is to transform input content into an Instagram post plan matching the '{manifest.name}' template.
Template brief: {manifest.description}

{brand_rules}

HARD CONSTRAINTS (Strictly Enforced):
1. Character limits (max_chars) on each text slot must be obeyed. NEVER exceed them.
2. Caption must be <= 2200 characters.
3. Hashtags: up to 30 items. NEVER include '#' in any hashtag string.
4. Alt texts: descriptive accessibility text for each slide (<= 1000 characters). Number of alt_texts MUST match number of slides.
5. Image prompts: for slots where AI generation is required, write evocative, restrained visual prompts adhering to brand aesthetics (minimalist, textured, editorial).
"""

    user_parts = [f"Source Content:\n{request.content}"]
    if request.cover_image_url:
        user_parts.append(
            "Cover image is provided directly by URL and used as-is for slide 1 hero. "
            "Still write a slide 1 hero prompt describing it (drives alt text and fallback)."
        )
    if request.language:
        user_parts.append(f"Language hint: {request.language}")
    if request.format:
        user_parts.append(f"Target format: {request.format.value}")
    if request.aspect_ratio:
        user_parts.append(f"Target aspect ratio: {request.aspect_ratio.value}")
    if request.max_slides:
        user_parts.append(f"Max slides allowed: {request.max_slides}")

    user_prompt = "\n\n".join(user_parts)

    messages: list[ChatMessage | dict[str, str]] = [
        ChatMessage(role="system", content=system_prompt),
        ChatMessage(role="user", content=user_prompt),
    ]

    # 4. Attempt 1
    raw_response = await client.chat_completion(
        messages=messages,
        response_format=schema_wrapper,
        temperature=0.3,
    )

    parsed_plan: PostPlan | None = None
    validation_errors: list[str] = []

    try:
        parsed_plan = PostPlan.model_validate(raw_response)
        validation_errors = validate_plan_against_manifest(
            parsed_plan, manifest, request.max_slides
        )
    except PydanticValidationError as exc:
        validation_errors.append(f"Schema deserialization error: {exc}")

    if not validation_errors and parsed_plan is not None:
        return parsed_plan, manifest

    # 5. Retry ONCE with error feedback (spec §6.5)
    error_feedback = "\n".join(f"- {err}" for err in validation_errors)
    retry_prompt = (
        f"Your previous PostPlan contained the following validation errors:\n{error_feedback}\n\n"
        "Please correct these errors. Strictly respect character limits, avoid banned words, "
        "and return a compliant PostPlan."
    )

    retry_messages = [
        ChatMessage(role="system", content=system_prompt),
        ChatMessage(role="user", content=user_prompt),
        ChatMessage(role="assistant", content=json.dumps(raw_response)),
        ChatMessage(role="user", content=retry_prompt),
    ]

    raw_retry = await client.chat_completion(
        messages=retry_messages,
        response_format=schema_wrapper,
        temperature=0.2,
    )

    try:
        parsed_retry = PostPlan.model_validate(raw_retry)
        retry_errors = validate_plan_against_manifest(parsed_retry, manifest, request.max_slides)
        if not retry_errors:
            return parsed_retry, manifest
        validation_errors = retry_errors
    except PydanticValidationError as exc:
        validation_errors.append(f"Schema deserialization error on retry: {exc}")

    raise PlanningError(
        f"Planner failed validation after retry: {'; '.join(validation_errors)}",
        details={"errors": validation_errors, "manifest_id": manifest.id},
    )
