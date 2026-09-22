"""Unit and integration tests for Stage 2 ComfyUI Image Engine (spec.md §11)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from app.exceptions import ImageGenerationError
from app.images import (
    ComfyUIClient,
    WorkflowMap,
    cover_slot_id,
    download_url_to_image,
    generate_images_for_post,
    inject_workflow_params,
    load_workflow,
)
from app.models import (
    AspectRatio,
    Format,
    PostPlan,
    PostPlanSlide,
    SlideImagePrompt,
)
from app.templates_loader import get_template


def test_load_workflow_and_map() -> None:
    """Verify loading real keilhq-bg.json workflow and companion map."""
    workflow, wf_map = load_workflow("keilhq-bg.json")
    assert "3" in workflow
    assert "6" in workflow
    assert wf_map.prompt_node == "6"
    assert wf_map.seed_node == "3"
    assert wf_map.width_node == "5"
    assert wf_map.height_node == "5"


def test_load_workflow_missing_files(tmp_path: Path) -> None:
    """Missing workflow or companion map raises ImageGenerationError."""
    with pytest.raises(ImageGenerationError, match="Workflow file not found"):
        load_workflow("nonexistent.json", workflows_dir=tmp_path)

    wf_file = tmp_path / "solo.json"
    wf_file.write_text("{}", encoding="utf-8")
    with pytest.raises(ImageGenerationError, match="Companion workflow map file not found"):
        load_workflow("solo.json", workflows_dir=tmp_path)


def test_inject_workflow_params() -> None:
    """Workflow injection correctly sets prompt, seed, and dimensions."""
    raw_wf: dict[str, Any] = {
        "1": {"inputs": {"text": "default"}},
        "2": {"inputs": {"seed": 0}},
        "3": {"inputs": {"width": 512, "height": 512}},
    }
    wf_map = WorkflowMap(
        prompt_node="1",
        seed_node="2",
        width_node="3",
        height_node="3",
    )

    injected = inject_workflow_params(
        workflow=raw_wf,
        wf_map=wf_map,
        prompt="A serene limestone temple",
        seed=99999,
        width=1080,
        height=1350,
    )

    assert injected["1"]["inputs"]["text"] == "A serene limestone temple"
    assert injected["2"]["inputs"]["seed"] == 99999
    assert injected["3"]["inputs"]["width"] == 1080
    assert injected["3"]["inputs"]["height"] == 1350
    # Original should be untouched (deepcopy)
    assert raw_wf["1"]["inputs"]["text"] == "default"


@pytest.mark.asyncio
async def test_comfyui_submit_prompt_node_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """ComfyUI node_errors response raises non-retryable ImageGenerationError."""
    client = ComfyUIClient(base_url="http://127.0.0.1:8188")

    async def mock_post(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        return httpx.Response(
            200,
            json={"node_errors": {"4": ["Missing checkpoint weights"]}},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

    with pytest.raises(ImageGenerationError, match="ComfyUI node validation failed"):
        await client.submit_prompt({}, client_id="test-client")


@pytest.mark.asyncio
async def test_comfyui_wait_for_completion_mock(monkeypatch: pytest.MonkeyPatch) -> None:
    """WebSocket completion message parser successfully detects finish."""
    client = ComfyUIClient(base_url="http://127.0.0.1:8188")

    class MockWebSocket:
        def __init__(self) -> None:
            self.messages: list[str | bytes] = [
                b"\x00\x01\x02",  # Binary preview frame -> should be ignored
                json.dumps({"type": "executing", "data": {"node": "3", "prompt_id": "pid-1"}}),
                json.dumps({"type": "executing", "data": {"node": None, "prompt_id": "pid-1"}}),
            ]

        async def __aenter__(self) -> MockWebSocket:
            return self

        async def __aexit__(self, *args: Any) -> None:
            pass

        def __aiter__(self) -> MockWebSocket:
            return self

        async def __anext__(self) -> str | bytes:
            if not self.messages:
                raise StopAsyncIteration
            return self.messages.pop(0)

    monkeypatch.setattr("websockets.connect", lambda *args, **kwargs: MockWebSocket())

    # Should complete without error
    await client.wait_for_completion(prompt_id="pid-1", client_id="cid-1")


@pytest.mark.asyncio
async def test_comfyui_wait_for_completion_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """WebSocket execution_error raises ImageGenerationError."""
    client = ComfyUIClient(base_url="http://127.0.0.1:8188")

    class MockWebSocket:
        async def __aenter__(self) -> MockWebSocket:
            return self

        async def __aexit__(self, *args: Any) -> None:
            pass

        def __aiter__(self) -> MockWebSocket:
            return self

        async def __anext__(self) -> str:
            return json.dumps(
                {"type": "execution_error", "data": {"exception_message": "CUDA out of memory"}}
            )

    monkeypatch.setattr("websockets.connect", lambda *args, **kwargs: MockWebSocket())

    with pytest.raises(ImageGenerationError, match="CUDA out of memory"):
        await client.wait_for_completion(prompt_id="pid-1", client_id="cid-1")


@pytest.mark.asyncio
async def test_comfyui_submit_prompt_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """Successful /prompt returns prompt_id."""
    client = ComfyUIClient(base_url="http://127.0.0.1:8188")

    async def mock_post(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        return httpx.Response(
            200, json={"prompt_id": "prompt-uuid-123"}, request=httpx.Request("POST", url)
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

    pid = await client.submit_prompt({}, client_id="client-1")
    assert pid == "prompt-uuid-123"


@pytest.mark.asyncio
async def test_comfyui_history_and_download_image(monkeypatch: pytest.MonkeyPatch) -> None:
    """History and image download endpoints behave as expected."""
    client = ComfyUIClient(base_url="http://127.0.0.1:8188")

    async def mock_get(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        if "/history/" in url:
            return httpx.Response(
                200,
                json={"pid-1": {"outputs": {"9": {"images": [{"filename": "out_01.png"}]}}}},
                request=httpx.Request("GET", url),
            )
        if "/view" in url:
            return httpx.Response(
                200,
                content=b"\x89PNG\r\n\x1a\n\x00\x00fake_image",
                request=httpx.Request("GET", url),
            )
        if "/system_stats" in url:
            return httpx.Response(200, json={"status": "ok"}, request=httpx.Request("GET", url))
        return httpx.Response(404, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", mock_get)

    assert await client.check_health() is True
    history = await client.get_history("pid-1")
    assert "pid-1" in history

    data = await client.download_image("out_01.png")
    assert data.startswith(b"\x89PNG")


@pytest.mark.asyncio
async def test_comfyui_generate_image_full_flow(monkeypatch: pytest.MonkeyPatch) -> None:
    """Full generate_image method runs all steps under the GPU lock."""
    client = ComfyUIClient(base_url="http://127.0.0.1:8188")

    # Mock submit_prompt
    monkeypatch.setattr(client, "submit_prompt", AsyncMock(return_value="prompt-test-123"))
    # Mock wait_for_completion
    monkeypatch.setattr(client, "wait_for_completion", AsyncMock(return_value=None))
    # Mock get_history
    mock_history = {
        "prompt-test-123": {
            "outputs": {
                "9": {
                    "images": [
                        {"filename": "generated_keilhq.png", "subfolder": "", "type": "output"}
                    ]
                }
            }
        }
    }
    monkeypatch.setattr(client, "get_history", AsyncMock(return_value=mock_history))
    # Mock download_image
    mock_bytes = b"\x89PNG\r\n\x1a\n\x00\x00test_image"
    monkeypatch.setattr(client, "download_image", AsyncMock(return_value=mock_bytes))

    result = await client.generate_image(
        workflow_filename="keilhq-bg.json",
        prompt="Quiet editorial texture",
        width=1080,
        height=1350,
    )
    assert result == mock_bytes


@pytest.mark.asyncio
async def test_generate_images_for_post_mocked(tmp_path: Path) -> None:
    """Mocked post image generation saves PNG files and maps slots correctly."""
    post_plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={"headline": "Test"},
                images={"background": SlideImagePrompt(prompt="Stone texture")},
            )
        ],
        caption="Caption",
        hashtags=["tag"],
        alt_texts=["Alt"],
    )
    manifest = get_template("keilhq-editorial")

    mock_client = ComfyUIClient()
    mock_png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    mock_client.generate_image = AsyncMock(return_value=mock_png_bytes)  # type: ignore[method-assign]

    out_map = await generate_images_for_post(
        post_plan=post_plan,
        manifest=manifest,
        output_dir=tmp_path,
        comfy_client=mock_client,
    )

    assert (0, "background") in out_map
    saved_path = out_map[(0, "background")]
    assert saved_path.is_file()
    assert saved_path.read_bytes() == mock_png_bytes


def test_cover_slot_id() -> None:
    """First prompt_slot image slot is the cover hero; slot-less templates return None."""
    assert cover_slot_id(get_template("360labs-news")) == "hero"
    assert cover_slot_id(get_template("keilhq-editorial")) == "background"
    assert cover_slot_id(get_template("tech-announcement")) is None


def _sample_png_bytes() -> bytes:
    """Generate a tiny valid PNG in-memory for download tests."""
    import io

    from PIL import Image as PILImage

    buf = io.BytesIO()
    PILImage.new("RGB", (16, 16), color="#F25C3D").save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_download_url_to_image_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Image content-type downloads are saved as PNG and decode cleanly."""
    png = _sample_png_bytes()

    async def mock_get(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        return httpx.Response(
            200,
            content=png,
            headers={"content-type": "image/png"},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "get", mock_get)

    dest = await download_url_to_image("https://example.com/cover.jpg", tmp_path / "cover_source")
    assert dest.suffix == ".png"
    assert dest.is_file()
    assert dest.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.asyncio
async def test_download_url_to_image_rejects_non_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Non-image content-type raises ImageGenerationError."""

    async def mock_get(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"<html>not an image</html>",
            headers={"content-type": "text/html"},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "get", mock_get)

    with pytest.raises(ImageGenerationError, match="did not return image content"):
        await download_url_to_image("https://example.com/page", tmp_path / "cover_source")


@pytest.mark.asyncio
async def test_download_url_to_image_http_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """HTTP failures raise ImageGenerationError."""

    async def mock_get(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        return httpx.Response(404, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", mock_get)

    with pytest.raises(ImageGenerationError, match="HTTP 404"):
        await download_url_to_image("https://example.com/missing.jpg", tmp_path / "cover_source")


@pytest.mark.asyncio
async def test_generate_images_for_post_skip(tmp_path: Path) -> None:
    """Entries in skip are not generated (cover URL override path)."""
    post_plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={"headline": "Test"},
                images={"background": SlideImagePrompt(prompt="Stone texture")},
            )
        ],
        caption="Caption",
        hashtags=["tag"],
        alt_texts=["Alt"],
    )
    manifest = get_template("keilhq-editorial")

    mock_client = ComfyUIClient()
    mock_client.generate_image = AsyncMock(return_value=b"png")  # type: ignore[method-assign]

    out_map = await generate_images_for_post(
        post_plan=post_plan,
        manifest=manifest,
        output_dir=tmp_path,
        comfy_client=mock_client,
        skip={(0, "background")},
    )

    assert out_map == {}
    mock_client.generate_image.assert_not_called()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_live_comfyui_generation(tmp_path: Path) -> None:
    """Gated live integration test against reachable ComfyUI VM. Skipped if unreachable."""
    client = ComfyUIClient()
    reachable = await client.check_health()
    if not reachable:
        pytest.skip(f"ComfyUI at {client.base_url} is unreachable; skipping live test.")

    png_bytes = await client.generate_image(
        workflow_filename="keilhq-bg.json",
        prompt="quiet abstract limestone architectural texture, minimal, editorial",
        width=1080,
        height=1350,
    )

    assert len(png_bytes) > 1000
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"
