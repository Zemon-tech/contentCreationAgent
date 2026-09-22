"""Stage 4 — Assembler (spec.md §12, §13).

Validates final output against Instagram constraints and writes the per-job
output directory containing slide JPEGs, human-readable caption.txt,
validated plan.json, and the authoritative post.json manifest.
"""

from __future__ import annotations

import hashlib
import io
from datetime import UTC, datetime
from pathlib import Path

from PIL import Image

from app.compositor import RenderResult
from app.config import get_settings
from app.exceptions import CompositionError
from app.models import (
    PostManifest,
    PostPlan,
    SlideManifest,
)


def validate_instagram_constraints(
    post_plan: PostPlan,
    render_result: RenderResult,
) -> list[str]:
    """Verify Instagram constraints and return any non-fatal warnings (spec §12).

    Hard violations (wrong width, invalid slide count) raise CompositionError.
    """
    warnings: list[str] = list(render_result.warnings)
    expected_width, expected_height = post_plan.aspect_ratio.dimensions

    # 1. Slide count validation
    if not (1 <= len(render_result.slides) <= 10):
        raise CompositionError(
            f"Instagram allows 1 to 10 slides in a carousel; got {len(render_result.slides)} slides."
        )

    # 2. Check each slide image
    for idx, slide in enumerate(render_result.slides):
        try:
            img = Image.open(io.BytesIO(slide.image_bytes))
        except Exception as exc:
            raise CompositionError(f"Slide {idx + 1} image data is unreadable: {exc}") from exc

        # Hard constraint: Width MUST be exactly 1080 (spec §12)
        if img.width != 1080:
            raise CompositionError(
                f"Instagram hard constraint violation: Slide {idx + 1} width is {img.width} (must be 1080)."
            )

        if (img.width, img.height) != (expected_width, expected_height):
            raise CompositionError(
                f"Slide {idx + 1} dimensions ({img.width}x{img.height}) do not match target "
                f"aspect ratio {post_plan.aspect_ratio.value} ({expected_width}x{expected_height})."
            )

        if img.mode != "RGB":
            warnings.append(
                f"Slide {idx + 1} color mode is '{img.mode}', Instagram prefers sRGB RGB."
            )

        # Soft cap: 1.4 MB
        if len(slide.image_bytes) > 1_400_000:
            warnings.append(
                f"Slide {idx + 1} size ({len(slide.image_bytes)} bytes) exceeds 1.4 MB Instagram re-compression threshold."
            )

    # 3. Caption and hashtags checks
    if len(post_plan.caption) > 2200:
        warnings.append(
            f"Caption length ({len(post_plan.caption)} chars) exceeds Instagram 2200 character cap."
        )
    if len(post_plan.hashtags) > 30:
        warnings.append(
            f"Hashtags count ({len(post_plan.hashtags)}) exceeds Instagram 30 hashtags limit."
        )

    return warnings


def format_caption_file(caption: str, hashtags: list[str]) -> str:
    """Format human-usable caption.txt: caption text, blank line, space-separated '#' hashtags (spec §13)."""
    clean_caption = caption.strip()
    formatted_tags = " ".join(f"#{tag.lstrip('#')}" for tag in hashtags if tag.strip())

    if formatted_tags:
        return f"{clean_caption}\n\n{formatted_tags}\n"
    return f"{clean_caption}\n"


def assemble_job_output(
    job_id: str,
    content: str,
    post_plan: PostPlan,
    render_result: RenderResult,
    output_base_dir: Path | str | None = None,
) -> PostManifest:
    """Write all job deliverables to OUTPUT_DIR/<job_id>/ and return PostManifest (spec §13)."""
    base_dir = Path(output_base_dir) if output_base_dir is not None else get_settings().output_dir
    job_dir = base_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # Validate Instagram constraints
    all_warnings = validate_instagram_constraints(post_plan, render_result)

    # 1. Write slide JPEGs
    slide_manifests: list[SlideManifest] = []
    for idx, slide in enumerate(render_result.slides):
        file_name = f"slide_{idx + 1:02d}.jpg"
        slide_path = job_dir / file_name
        slide_path.write_bytes(slide.image_bytes)

        alt_text = post_plan.alt_texts[idx] if idx < len(post_plan.alt_texts) else ""
        slide_manifests.append(
            SlideManifest(
                index=idx,
                file=file_name,
                alt_text=alt_text,
            )
        )

    # 2. Write caption.txt
    caption_txt_content = format_caption_file(post_plan.caption, post_plan.hashtags)
    (job_dir / "caption.txt").write_text(caption_txt_content, encoding="utf-8")

    # 3. Write plan.json (for inspection / debugging)
    plan_json_content = post_plan.model_dump_json(indent=2)
    (job_dir / "plan.json").write_text(plan_json_content, encoding="utf-8")

    # 4. Compute source content SHA-256
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()

    # 5. Build and write post.json
    manifest = PostManifest(
        job_id=job_id,
        created_at=datetime.now(UTC),
        template_id=post_plan.template_id,
        format=post_plan.format,
        aspect_ratio=post_plan.aspect_ratio,
        slides=slide_manifests,
        caption=post_plan.caption,
        hashtags=post_plan.hashtags,
        source_content_sha256=content_hash,
        warnings=all_warnings,
    )

    manifest_json = manifest.model_dump_json(indent=2)
    (job_dir / "post.json").write_text(manifest_json, encoding="utf-8")

    return manifest
