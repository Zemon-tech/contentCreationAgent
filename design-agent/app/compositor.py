"""Stage 3 — Compositor (spec.md §7).

Renders PostPlan slides to HTML/CSS via Jinja2, captures pixel-perfect
screenshots using headless Chromium (Playwright), performs text overflow auto-fit,
and normalizes output to Instagram-compliant JPEGs using Pillow.
"""

from __future__ import annotations

import asyncio
import base64
import io
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader
from PIL import Image
from playwright.async_api import Browser, Page
from pydantic import BaseModel, ConfigDict

from app.brand import load_brand
from app.config import get_settings
from app.exceptions import CompositionError
from app.models import AspectRatio, PostPlan
from app.templates_loader import get_template


class RenderedSlide(BaseModel):
    """Output for a single rendered slide."""

    model_config = ConfigDict(frozen=True)

    index: int
    image_bytes: bytes
    warnings: list[str] = []


class RenderResult(BaseModel):
    """Output of the compositor stage."""

    model_config = ConfigDict(frozen=True)

    slides: list[RenderedSlide]
    aspect_ratio: AspectRatio
    warnings: list[str] = []


def create_placeholder_image(
    color: str = "#F1EEE8",
    width: int = 1080,
    height: int = 1350,
) -> str:
    """Generate a solid brand-colored PNG image as a base64 data URI (spec D10)."""
    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def image_file_to_data_uri(image_path: Path | str) -> str:
    """Read an image file from disk and convert to a base64 data URI (spec §7.1)."""
    path = Path(image_path)
    if not path.is_file():
        raise CompositionError(
            f"Image asset file not found at: {path}",
            details={"image_path": str(path)},
        )

    suffix = path.suffix.lower().lstrip(".")
    mime_type = "image/jpeg" if suffix in ("jpg", "jpeg") else "image/png"
    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def normalize_to_jpeg(
    png_bytes: bytes,
    target_dimensions: tuple[int, int],
    max_bytes: int = 1_400_000,
) -> tuple[bytes, list[str]]:
    """Normalize screenshot to target dimensions, sRGB RGB, and JPEG <= 1.4 MB (spec §7.4)."""
    warnings: list[str] = []
    img: Image.Image = Image.open(io.BytesIO(png_bytes))

    if img.size != target_dimensions:
        img = img.resize(target_dimensions, Image.Resampling.LANCZOS)

    if img.mode != "RGB":
        img = img.convert("RGB")

    # Step down JPEG quality from 88 to 72 to stay <= 1.4 MB
    quality = 88
    buf = io.BytesIO()
    while quality >= 72:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        if len(buf.getvalue()) <= max_bytes or quality == 72:
            break
        quality -= 4

    jpeg_bytes = buf.getvalue()
    if len(jpeg_bytes) > max_bytes:
        warnings.append(
            f"Slide JPEG size ({len(jpeg_bytes)} bytes) exceeds target cap of {max_bytes} bytes at quality 72"
        )

    return jpeg_bytes, warnings


async def auto_fit_text_slots(page: Page) -> list[str]:
    """Detect and auto-fit overflowing text slots by reducing font size down to --min-font-size floor.

    Never modifies text content (spec §7.3).
    """
    js_code = """
    () => {
        const warnings = [];
        const slots = document.querySelectorAll('[data-slot]');

        for (const el of slots) {
            const slotId = el.getAttribute('data-slot');
            const style = window.getComputedStyle(el);
            let fontSize = parseFloat(style.fontSize);
            const minVar = style.getPropertyValue('--min-font-size').trim();
            const minFontSize = minVar ? parseFloat(minVar) : 14;

            // Check if element overflows vertically or horizontally
            let isOverflowing = (el.scrollHeight > el.clientHeight + 1) || (el.scrollWidth > el.clientWidth + 1);

            while (isOverflowing && fontSize > minFontSize) {
                fontSize = Math.max(minFontSize, fontSize * 0.94);
                el.style.fontSize = fontSize + 'px';
                isOverflowing = (el.scrollHeight > el.clientHeight + 1) || (el.scrollWidth > el.clientWidth + 1);
            }

            if (isOverflowing) {
                warnings.push(
                    `Slot '${slotId}' overflows container despite reducing font-size to floor (${minFontSize}px).`
                );
            }
        }

        // Also check main editorial content container
        const contentContainer = document.querySelector('.editorial-content');
        if (contentContainer && (contentContainer.scrollHeight > contentContainer.clientHeight + 2)) {
            // Shrink headline and body cooperatively
            const headline = contentContainer.querySelector('[data-slot="headline"]');
            const body = contentContainer.querySelector('[data-slot="body"]');

            for (let step = 0; step < 10; step++) {
                if (contentContainer.scrollHeight <= contentContainer.clientHeight + 2) break;

                if (headline) {
                    const hStyle = window.getComputedStyle(headline);
                    const hMin = parseFloat(hStyle.getPropertyValue('--min-font-size')) || 24;
                    let hSize = parseFloat(hStyle.fontSize);
                    if (hSize > hMin) {
                        headline.style.fontSize = Math.max(hMin, hSize * 0.94) + 'px';
                    }
                }

                if (body) {
                    const bStyle = window.getComputedStyle(body);
                    const bMin = parseFloat(bStyle.getPropertyValue('--min-font-size')) || 16;
                    let bSize = parseFloat(bStyle.fontSize);
                    if (bSize > bMin) {
                        body.style.fontSize = Math.max(bMin, bSize * 0.94) + 'px';
                    }
                }
            }

            if (contentContainer.scrollHeight > contentContainer.clientHeight + 2) {
                warnings.push(
                    "Editorial content block overflows safe-zone container at minimum font sizes."
                );
            }
        }

        return warnings;
    }
    """
    result = await page.evaluate(js_code)
    return list(result) if isinstance(result, list) else []


async def render_slide_screenshot(
    page: Page,
    html: str,
    width: int,
    height: int,
) -> tuple[bytes, list[str]]:
    """Load HTML into Chromium, await fonts, auto-fit overflow, and capture #canvas screenshot (spec §7.1)."""
    await page.set_viewport_size({"width": width, "height": height})
    await page.set_content(html, wait_until="load")

    # Await font loading before screenshot (spec §7.1)
    await page.evaluate("document.fonts.ready")

    # Evaluate text overflow and auto-fit font sizes (spec §7.3)
    overflow_warnings = await auto_fit_text_slots(page)

    canvas_el = await page.wait_for_selector("#canvas")
    if not canvas_el:
        raise CompositionError("Template root element '#canvas' not found in rendered DOM.")

    png_bytes = await canvas_el.screenshot(type="png")
    return png_bytes, overflow_warnings


async def composite_post(
    post_plan: PostPlan,
    browser: Browser,
    images: dict[tuple[int, str], Path | str] | None = None,
    templates_dir: Path | None = None,
    concurrency: int | None = None,
) -> RenderResult:
    """Composite copy + imagery for all slides in a PostPlan into normalized JPEGs.

    Enforces:
    - Target pixel dimensions per aspect ratio (1080x1350 for 4:5, 1080x1440 for 3:4, 1080x1080 for 1:1).
    - Aspect ratio consistency across all carousel slides (spec §7.5).
    - Concurrency semaphore (spec §9).
    - Quality step-down for <= 1.4 MB JPEG (spec §7.4).
    """
    settings = get_settings()
    manifest = get_template(post_plan.template_id, templates_dir)
    brand = load_brand()

    tmpl_dir = (templates_dir or settings.templates_dir) / manifest.id
    if not tmpl_dir.is_dir():
        raise CompositionError(
            f"Template directory not found: {tmpl_dir}",
            details={"template_id": manifest.id},
        )

    # Load template files
    env = Environment(loader=FileSystemLoader(str(tmpl_dir)), autoescape=True)
    jinja_tmpl = env.get_template("template.html.j2")
    style_css_file = tmpl_dir / "style.css"
    style_css = style_css_file.read_text(encoding="utf-8") if style_css_file.is_file() else ""

    target_width, target_height = post_plan.aspect_ratio.dimensions
    semaphore = asyncio.Semaphore(concurrency or settings.render_concurrency)

    shared_jpg = (templates_dir or settings.templates_dir) / "shared.jpg"
    shared_image_uri = image_file_to_data_uri(shared_jpg) if shared_jpg.is_file() else None

    # Template-local brand logos (e.g. RAS by KeilHQ light/dark). Preferred
    # location is the template dir so templates stay self-contained; falls
    # back to the repo-level assets/ dir. Exposed as Jinja vars; None when
    # absent so templates can fall back to a text badge.
    tmpl_base = templates_dir or settings.templates_dir
    assets_base = Path(__file__).resolve().parent.parent / "assets"
    logo_light_candidates = [
        tmpl_dir / "ras-by-keilhq-light-mode.png",
        tmpl_base / "ras-by-keilhq-light-mode.png",
        assets_base / "ras-by-keilhq-light-mode.png",
    ]
    logo_dark_candidates = [
        tmpl_dir / "ras-by-keilhq-dark-mode.png",
        tmpl_base / "ras-by-keilhq-dark-mode.png",
        assets_base / "ras-by-keilhq-dark-mode.png",
    ]
    logo_light_file = next((p for p in logo_light_candidates if p.is_file()), None)
    logo_dark_file = next((p for p in logo_dark_candidates if p.is_file()), None)
    logo_light_uri = image_file_to_data_uri(logo_light_file) if logo_light_file else None
    logo_dark_uri = image_file_to_data_uri(logo_dark_file) if logo_dark_file else None

    all_warnings: list[str] = []
    rendered_slides: list[RenderedSlide] = []

    async def _render_one_slide(idx: int) -> RenderedSlide:
        async with semaphore:
            slide = post_plan.slides[idx]
            slide_warnings: list[str] = []

            # Prepare image data URIs
            slide_images: dict[str, str] = {}
            for img_slot in manifest.image_slots:
                custom_img = images.get((idx, img_slot.id)) if images else None
                if custom_img is not None:
                    slide_images[img_slot.id] = image_file_to_data_uri(custom_img)
                else:
                    # Provide solid brand-color placeholder image (D10)
                    slide_images[img_slot.id] = create_placeholder_image(
                        color=brand.colors.linen,
                        width=target_width,
                        height=target_height,
                    )

            # Build Jinja context
            context: dict[str, Any] = {
                "text": slide.text,
                "images": slide_images,
                "shared_image": shared_image_uri,
                "logo_light": logo_light_uri,
                "logo_dark": logo_dark_uri,
                "brand_name": brand.name,
                "aspect_ratio": post_plan.aspect_ratio.value,
                "width": target_width,
                "height": target_height,
                "slide_index": idx,
                "total_slides": len(post_plan.slides),
                "style_content": style_css,
                "css_colors": brand.template_tokens["css_colors"],
            }

            html = jinja_tmpl.render(context)

            # Open a fresh Chromium page for isolation
            page = await browser.new_page(
                viewport={"width": target_width, "height": target_height},
                device_scale_factor=1,
            )
            try:
                png_bytes, fit_warnings = await render_slide_screenshot(
                    page=page,
                    html=html,
                    width=target_width,
                    height=target_height,
                )
                slide_warnings.extend(fit_warnings)
            finally:
                await page.close()

            # Normalize to sRGB JPEG <= 1.4 MB
            jpeg_bytes, norm_warnings = normalize_to_jpeg(
                png_bytes=png_bytes,
                target_dimensions=(target_width, target_height),
            )
            slide_warnings.extend(norm_warnings)

            return RenderedSlide(
                index=idx,
                image_bytes=jpeg_bytes,
                warnings=slide_warnings,
            )

    # Render all slides
    tasks = [_render_one_slide(i) for i in range(len(post_plan.slides))]
    slides_output = await asyncio.gather(*tasks)

    # Sort in slide order
    for s in sorted(slides_output, key=lambda x: x.index):
        rendered_slides.append(s)
        all_warnings.extend(s.warnings)

    return RenderResult(
        slides=rendered_slides,
        aspect_ratio=post_plan.aspect_ratio,
        warnings=all_warnings,
    )
