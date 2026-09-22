"""Concurrency and resource cap verification tests (spec.md §9, §15).

Verifies:
1. Single-slot GPU lock serializes ComfyUI diffusion tasks under burst.
2. Compositor bounded semaphore caps concurrent Chromium page rendering.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from app.compositor import composite_post
from app.images import ComfyUIClient
from app.models import AspectRatio, Format, PostPlan, PostPlanSlide


@pytest.mark.asyncio
async def test_gpu_lock_serializes_concurrent_burst() -> None:
    """Under burst requests, the GPU lock guarantees max 1 active ComfyUI diffusion."""
    active_concurrent = 0
    max_concurrent_seen = 0

    client = ComfyUIClient(base_url="http://127.0.0.1:8188")

    async def mock_submit_prompt(*args: Any, **kwargs: Any) -> str:
        nonlocal active_concurrent, max_concurrent_seen
        active_concurrent += 1
        max_concurrent_seen = max(max_concurrent_seen, active_concurrent)
        await asyncio.sleep(0.05)
        return "mock-prompt-id"

    async def mock_wait_for_completion(*args: Any, **kwargs: Any) -> None:
        await asyncio.sleep(0.05)

    async def mock_get_history(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal active_concurrent
        await asyncio.sleep(0.02)
        active_concurrent -= 1
        return {
            "mock-prompt-id": {
                "outputs": {
                    "9": {"images": [{"filename": "out.png", "subfolder": "", "type": "output"}]}
                }
            }
        }

    async def mock_download_image(*args: Any, **kwargs: Any) -> bytes:
        return b"\x89PNG\r\n\x1a\n"

    with (
        patch.object(client, "submit_prompt", side_effect=mock_submit_prompt),
        patch.object(client, "wait_for_completion", side_effect=mock_wait_for_completion),
        patch.object(client, "get_history", side_effect=mock_get_history),
        patch.object(client, "download_image", side_effect=mock_download_image),
        patch("app.images.load_workflow", return_value=({}, AsyncMock())),
        patch("app.images.inject_workflow_params", return_value={}),
    ):
        # Fire 6 concurrent requests
        tasks = [
            client.generate_image(
                workflow_filename="keilhq-bg.json",
                prompt=f"burst-prompt-{i}",
                width=1080,
                height=1350,
            )
            for i in range(6)
        ]
        results = await asyncio.gather(*tasks)

        assert len(results) == 6
        assert max_concurrent_seen == 1, (
            f"Expected max 1 concurrent GPU diffusion, got {max_concurrent_seen}"
        )


@pytest.mark.asyncio
async def test_compositor_semaphore_bounds_rendering_concurrency() -> None:
    """Compositor bounds active page rendering concurrency via semaphore."""
    active_concurrent_pages = 0
    max_pages_seen = 0

    slides = [
        PostPlanSlide(
            text={"headline": f"Slide {i} Headline", "body": "Body copy paragraph."},
            images={},
        )
        for i in range(6)
    ]

    plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.CAROUSEL,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=slides,
        caption="Caption test",
        hashtags=["test"],
        alt_texts=["Alt"] * 6,
    )

    mock_browser = AsyncMock()

    async def mock_new_page(*args: Any, **kwargs: Any) -> Any:
        nonlocal active_concurrent_pages, max_pages_seen
        active_concurrent_pages += 1
        max_pages_seen = max(max_pages_seen, active_concurrent_pages)
        page = AsyncMock()

        async def page_close() -> None:
            nonlocal active_concurrent_pages
            active_concurrent_pages -= 1

        page.close = AsyncMock(side_effect=page_close)
        return page

    mock_browser.new_page = AsyncMock(side_effect=mock_new_page)

    async def mock_render_screenshot(*args: Any, **kwargs: Any) -> tuple[bytes, list[str]]:
        await asyncio.sleep(0.05)
        # 1080x1350 transparent 1x1 png
        import io

        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (1080, 1350), color="white").save(buf, format="PNG")
        return buf.getvalue(), []

    with patch("app.compositor.render_slide_screenshot", side_effect=mock_render_screenshot):
        result = await composite_post(
            post_plan=plan,
            browser=mock_browser,
            concurrency=2,  # Bound concurrency to 2
        )

        assert len(result.slides) == 6
        assert max_pages_seen <= 2, f"Expected max 2 concurrent pages, got {max_pages_seen}"
