"""Stage 4 — Assembler (spec.md §12, §13).

Validates final output against Instagram constraints and writes the per-job
output directory containing slide JPEGs, human-readable caption.txt,
validated plan.json, and the authoritative post.json manifest.
"""

from __future__ import annotations

import hashlib
import html
import io
import zipfile
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


def write_preview_html(
    job_dir: Path,
    job_id: str,
    post_plan: PostPlan,
    slide_files: list[str],
    caption: str,
    hashtags: list[str],
) -> str:
    """Write a self-contained preview gallery (preview.html) next to the slides.

    Images are referenced by relative filename so the file works when opened
    from the job directory or served statically.
    """
    tag_row = " ".join(f"#{html.escape(t.lstrip('#'))}" for t in hashtags if t.strip())
    figures = "\n".join(
        f'    <figure><img src="{html.escape(f)}" alt="Slide {i + 1}" loading="lazy"/>'
        f"<figcaption>Slide {i + 1} — {html.escape(f)}</figcaption></figure>"
        for i, f in enumerate(slide_files)
    )
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Preview — {html.escape(job_id)}</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 24px; background: #111; color: #eee; }}
header {{ max-width: 720px; }}
.meta {{ color: #aaa; font-size: 14px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 16px; }}
figure {{ margin: 0; background: #1c1c1c; border-radius: 12px; overflow: hidden; }}
img {{ width: 100%; display: block; }}
figcaption {{ padding: 8px 12px; font-size: 13px; color: #bbb; }}
.caption {{ max-width: 720px; white-space: pre-wrap; background: #1c1c1c; padding: 16px; border-radius: 12px; }}
.tags {{ color: #7dd3fc; }}
a.dl {{ display: inline-block; margin-top: 12px; padding: 10px 18px; background: #7dd3fc; color: #111; border-radius: 8px; text-decoration: none; font-weight: 600; }}
</style>
</head>
<body>
<header>
<h1>Post preview</h1>
<p class="meta">job {html.escape(job_id)} · template {html.escape(post_plan.template_id)} · {html.escape(post_plan.format.value)} · {html.escape(post_plan.aspect_ratio.value)}</p>
<a class="dl" href="bundle.zip" download>Download bundle.zip</a>
</header>
<div class="grid">
{figures}
</div>
<h2>Caption</h2>
<div class="caption">{html.escape(caption)}<br/><br/><span class="tags">{tag_row}</span></div>
</body>
</html>
"""
    (job_dir / "preview.html").write_text(page, encoding="utf-8")
    return "preview.html"


def write_bundle_zip(job_dir: Path, member_files: list[str]) -> str:
    """Zip the deliverables (slides + caption + manifests) for one-click download."""
    zip_path = job_dir / "bundle.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in member_files:
            p = job_dir / name
            if p.is_file():
                zf.write(p, arcname=name)
    return "bundle.zip"


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

    # 5. Build and write post.json (preview + bundle written first so the
    # manifest can reference them)
    preview_name = write_preview_html(
        job_dir=job_dir,
        job_id=job_id,
        post_plan=post_plan,
        slide_files=[s.file for s in slide_manifests],
        caption=post_plan.caption,
        hashtags=post_plan.hashtags,
    )
    bundle_name = write_bundle_zip(
        job_dir,
        [s.file for s in slide_manifests] + ["caption.txt", "plan.json"],
    )
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
        preview_file=preview_name,
        bundle_file=bundle_name,
    )

    manifest_json = manifest.model_dump_json(indent=2)
    (job_dir / "post.json").write_text(manifest_json, encoding="utf-8")

    # Re-zip including post.json so the bundle is complete.
    write_bundle_zip(
        job_dir,
        [s.file for s in slide_manifests] + ["caption.txt", "plan.json", "post.json"],
    )

    return manifest
