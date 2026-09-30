"""Tests for the v2 news pipeline: cover_prompt override, preview + bundle."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.assembler import assemble_job_output
from app.compositor import RenderedSlide, RenderResult
from app.models import (
    AspectRatio,
    CreateJobRequest,
    Format,
    JobStatus,
    PostPlan,
    PostPlanSlide,
    SlideImagePrompt,
)
from app.queue import JobManager
from tests.conftest import TEST_API_KEY


def _make_dummy_jpeg(width: int = 1080, height: int = 1350) -> bytes:
    img = Image.new("RGB", (width, height), color="#171514")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _plan() -> PostPlan:
    return PostPlan(
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


def _render() -> RenderResult:
    return RenderResult(
        slides=[RenderedSlide(index=0, image_bytes=_make_dummy_jpeg())],
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
    )


def test_assembler_writes_preview_and_bundle(tmp_path: Path) -> None:
    manifest = assemble_job_output(
        job_id="preview-job",
        content="source text",
        post_plan=_plan(),
        render_result=_render(),
        output_base_dir=tmp_path,
    )
    job_dir = tmp_path / "preview-job"
    assert (job_dir / "preview.html").is_file()
    assert (job_dir / "bundle.zip").is_file()
    assert manifest.preview_file == "preview.html"
    assert manifest.bundle_file == "bundle.zip"

    html = (job_dir / "preview.html").read_text(encoding="utf-8")
    assert "slide_01.jpg" in html
    assert "bundle.zip" in html

    with zipfile.ZipFile(job_dir / "bundle.zip") as zf:
        names = set(zf.namelist())
    assert {"slide_01.jpg", "caption.txt", "plan.json", "post.json"} <= names


def test_cover_prompt_request_field_accepted() -> None:
    req = CreateJobRequest(
        content="Some news content here.",
        cover_prompt="Twin server towers diverting glowing scroll streams, engraved editorial collage",
    )
    assert req.cover_prompt is not None and len(req.cover_prompt) > 10


def test_preview_and_download_endpoints(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    from app import queue as queue_module

    manifest = assemble_job_output(
        job_id="endpoint-job",
        content="source text",
        post_plan=_plan(),
        render_result=_render(),
        output_base_dir=tmp_path,
    )
    assert manifest.preview_file and manifest.bundle_file

    mgr = JobManager()
    record = mgr.enqueue(
        job_id="endpoint-job",
        request=CreateJobRequest(content="Some news content here."),
    )
    record.status = JobStatus.DONE
    record.output_dir = str(tmp_path / "endpoint-job")
    record.post = manifest  # type: ignore[assignment]

    monkeypatch.setattr(queue_module, "_job_manager", mgr)

    headers = {"X-API-Key": TEST_API_KEY}
    preview = client.get("/jobs/endpoint-job/preview", headers=headers)
    assert preview.status_code == 200
    assert "slide_01.jpg" in preview.text

    bundle = client.get("/jobs/endpoint-job/download", headers=headers)
    assert bundle.status_code == 200
    assert bundle.headers["content-type"] == "application/zip"
    assert len(bundle.content) > 1000


def test_preview_requires_auth(client: TestClient) -> None:
    resp = client.get("/jobs/whatever/preview")
    assert resp.status_code == 401
