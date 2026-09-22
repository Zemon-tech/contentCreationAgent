"""Integration tests for HTTP /jobs API endpoints and queue processing (spec.md §4, §9)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from playwright.async_api import async_playwright

from app.config import get_settings
from app.main import app
from app.queue import get_job_manager
from app.sarvam import SarvamClient

API_KEY = "test-secret-key-12345"


@pytest.fixture(autouse=True)
def setup_api_key(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Configure API key and temporary output directory for tests."""
    monkeypatch.setenv("DESIGN_AGENT_API_KEY", API_KEY)
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path))
    get_settings.cache_clear()


def test_create_job_unauthenticated() -> None:
    """POST /jobs without X-API-Key returns 401."""
    with TestClient(app) as client:
        res = client.post("/jobs", json={"content": "Hello"})
        assert res.status_code == 401
        assert res.json()["error"]["code"] == "authentication_error"


def test_create_job_invalid_api_key() -> None:
    """POST /jobs with wrong X-API-Key returns 401."""
    with TestClient(app) as client:
        res = client.post(
            "/jobs",
            headers={"X-API-Key": "wrong-key"},
            json={"content": "Hello"},
        )
        assert res.status_code == 401


def test_create_job_invalid_body() -> None:
    """POST /jobs with empty content or invalid parameters returns 422."""
    with TestClient(app) as client:
        headers = {"X-API-Key": API_KEY}

        # Empty content
        res1 = client.post("/jobs", headers=headers, json={"content": "   "})
        assert res1.status_code == 422

        # max_slides > 10
        res2 = client.post(
            "/jobs",
            headers=headers,
            json={"content": "Valid text", "max_slides": 12},
        )
        assert res2.status_code == 422


def test_create_job_and_poll_status_flow() -> None:
    """POST /jobs returns 202 and GET /jobs/{id} returns job status."""
    with TestClient(app) as client:
        headers = {"X-API-Key": API_KEY}

        create_res = client.post(
            "/jobs",
            headers=headers,
            json={
                "content": "A thoughtful exploration of architectural restraint.",
                "format": "single",
                "aspect_ratio": "4:5",
                "template_id": "keilhq-editorial",
            },
        )
        assert create_res.status_code == 202
        data = create_res.json()
        assert "job_id" in data
        assert data["status"] == "queued"

        job_id = data["job_id"]

        # Poll status
        status_res = client.get(f"/jobs/{job_id}", headers=headers)
        assert status_res.status_code == 200
        status_data = status_res.json()
        assert status_data["job_id"] == job_id
        assert status_data["status"] in (
            "queued",
            "planning",
            "generating_images",
            "compositing",
            "done",
            "failed",
        )


def test_get_unknown_job_returns_404() -> None:
    """GET /jobs/{unknown_id} returns 404 job_not_found."""
    with TestClient(app) as client:
        res = client.get("/jobs/nonexistent-uuid-999", headers={"X-API-Key": API_KEY})
        assert res.status_code == 404
        assert res.json()["error"]["code"] == "job_not_found"


@pytest.mark.asyncio
async def test_full_pipeline_mocked_end_to_end(tmp_path: Path) -> None:
    """Execute full pipeline (plan -> composite with placeholders -> assemble) end-to-end."""
    from httpx import ASGITransport, AsyncClient

    mock_plan_data: dict[str, Any] = {
        "template_id": "keilhq-editorial",
        "format": "single",
        "aspect_ratio": "4:5",
        "slides": [
            {
                "text": {
                    "eyebrow": "Architecture of Craft",
                    "headline": "Patience as an Editorial Method",
                    "body": "Knowledge done well is careful, not fast. Deliberate, patient, and unhurried.",
                    "cta": "Read more at keilhq.com",
                },
                "images": {"background": {"prompt": "Earthy minimal texture"}},
            }
        ],
        "caption": "A reflection on patient knowledge work.",
        "hashtags": ["editorial", "keilhq", "craft"],
        "alt_texts": ["Cover slide featuring editorial typography"],
    }

    class PipelineMockSarvam(SarvamClient):
        async def chat_completion(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            return mock_plan_data

    job_mgr = get_job_manager()
    job_mgr.sarvam_client = PipelineMockSarvam(api_key="mock")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        job_mgr.set_browser(browser)

        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                headers = {"X-API-Key": API_KEY}
                res = await client.post(
                    "/jobs",
                    headers=headers,
                    json={
                        "content": "Patience as an editorial method in knowledge systems.",
                        "template_id": "keilhq-editorial",
                    },
                )
                assert res.status_code == 202
                job_id = res.json()["job_id"]

                # Process job directly using the manager
                await job_mgr.process_job(job_id)

                # Poll status
                status_res = await client.get(f"/jobs/{job_id}", headers=headers)
                assert status_res.status_code == 200
                status_data = status_res.json()

                assert status_data["status"] == "done"
                assert status_data["post"] is not None
                assert len(status_data["post"]["slides"]) == 1

                # Verify files were assembled on disk
                out_dir = Path(status_data["output_dir"])
                assert (out_dir / "slide_01.jpg").is_file()
                assert (out_dir / "caption.txt").is_file()
                assert (out_dir / "post.json").is_file()
                assert (out_dir / "plan.json").is_file()

        finally:
            await browser.close()
