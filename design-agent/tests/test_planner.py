"""Unit and integration tests for Stage 1 Planner (spec.md §6)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
from playwright.async_api import async_playwright

from app.compositor import composite_post
from app.config import get_settings
from app.exceptions import PlanningError
from app.models import AspectRatio, CreateJobRequest, Format
from app.planner import plan_post, select_template
from app.sarvam import SarvamClient


def _make_valid_sarvam_response() -> dict[str, Any]:
    """Return a valid PostPlan JSON dictionary for keilhq-editorial."""
    return {
        "template_id": "keilhq-editorial",
        "format": "single",
        "aspect_ratio": "4:5",
        "slides": [
            {
                "text": {
                    "eyebrow": "Quiet Architecture",
                    "headline": "Systems Built with Deliberate Method",
                    "body": "Knowledge done well is careful, not fast. Deliberate, patient, unhurried.",
                    "cta": "Explore notes at keilhq.com",
                },
                "images": {
                    "background": {
                        "prompt": "Minimalist architectural limestone texture, subtle shadows"
                    }
                },
            }
        ],
        "caption": "A reflection on quiet craft and enduring systems.",
        "hashtags": ["editorial", "systems", "craft"],
        "alt_texts": ["Cover slide with thoughtful typography and subtle texture"],
    }


class MockSarvamClient(SarvamClient):
    """Mock SarvamClient for deterministic tests."""

    def __init__(self, responses: list[dict[str, Any]]) -> None:
        super().__init__(api_key="mock-key")
        self.responses = list(responses)
        self.call_count = 0
        self.recorded_messages: list[Any] = []

    async def chat_completion(
        self,
        messages: Any,
        response_format: dict[str, Any] | None = None,
        temperature: float = 0.3,
    ) -> dict[str, Any]:
        self.call_count += 1
        self.recorded_messages.append(messages)
        if not self.responses:
            raise RuntimeError("No more mocked responses available.")
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_plan_post_happy_path() -> None:
    """Planner generates a valid PostPlan from content on first attempt."""
    mock_client = MockSarvamClient([_make_valid_sarvam_response()])

    request = CreateJobRequest(
        content="Patience in software design is rare but transformative.",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        template_id="keilhq-editorial",
    )

    plan, manifest = await plan_post(request, sarvam_client=mock_client)

    assert mock_client.call_count == 1
    assert plan.template_id == "keilhq-editorial"
    assert manifest.id == "keilhq-editorial"
    assert len(plan.slides) == 1
    assert plan.slides[0].text["headline"] == "Systems Built with Deliberate Method"


@pytest.mark.asyncio
async def test_plan_post_over_max_chars_retry_succeeds() -> None:
    """Over-max_chars response triggers a retry with errors, and succeeds if corrected."""
    # Attempt 1: headline with 95 chars (max allowed for headline is 80)
    bad_resp = _make_valid_sarvam_response()
    bad_resp["slides"][0]["text"]["headline"] = "X" * 95

    # Attempt 2: valid response
    good_resp = _make_valid_sarvam_response()

    mock_client = MockSarvamClient([bad_resp, good_resp])

    request = CreateJobRequest(
        content="Article text",
        template_id="keilhq-editorial",
    )

    plan, _ = await plan_post(request, sarvam_client=mock_client)

    # Assert retry was called
    assert mock_client.call_count == 2
    assert len(plan.slides[0].text["headline"]) <= 80


@pytest.mark.asyncio
async def test_plan_post_over_max_chars_retry_fails() -> None:
    """Over-max_chars on both attempts raises PlanningError without silent truncation."""
    bad_resp1 = _make_valid_sarvam_response()
    bad_resp1["slides"][0]["text"]["headline"] = "X" * 95

    bad_resp2 = _make_valid_sarvam_response()
    bad_resp2["slides"][0]["text"]["headline"] = "Y" * 95

    mock_client = MockSarvamClient([bad_resp1, bad_resp2])

    request = CreateJobRequest(
        content="Article text",
        template_id="keilhq-editorial",
    )

    with pytest.raises(PlanningError, match="exceeds max_chars"):
        await plan_post(request, sarvam_client=mock_client)

    assert mock_client.call_count == 2


@pytest.mark.asyncio
async def test_plan_post_banned_word_retry() -> None:
    """Banned word in copy triggers a retry, failing if uncorrected."""
    bad_resp = _make_valid_sarvam_response()
    bad_resp["caption"] = "A revolutionary approach to design! 🔥"

    good_resp = _make_valid_sarvam_response()
    good_resp["caption"] = "A quiet, patient approach to design."

    mock_client = MockSarvamClient([bad_resp, good_resp])

    request = CreateJobRequest(
        content="Article text",
        template_id="keilhq-editorial",
    )

    plan, _ = await plan_post(request, sarvam_client=mock_client)
    assert mock_client.call_count == 2
    assert "revolutionary" not in plan.caption
    assert "🔥" not in plan.caption


@pytest.mark.asyncio
async def test_select_template_explicit_and_auto() -> None:
    """Template selection works explicitly and defaults cleanly."""
    manifest = await select_template(
        content="Sample content",
        template_id="keilhq-editorial",
    )
    assert manifest.id == "keilhq-editorial"

    # Auto-selection among multiple candidates queries Sarvam
    mock_client = MockSarvamClient([{"template_id": "keilhq-editorial", "rationale": "Best fit"}])
    auto_manifest = await select_template(
        content="Sample content",
        format_req=Format.SINGLE,
        sarvam_client=mock_client,
    )
    assert auto_manifest.id == "keilhq-editorial"
    assert mock_client.call_count == 1


@pytest.mark.asyncio
async def test_select_template_unsupported_format_or_aspect() -> None:
    """Explicit template selection raises TemplateError when requested format or aspect ratio is unsupported."""
    from app.exceptions import TemplateError

    with pytest.raises(TemplateError, match="does not support format"):
        await select_template(
            content="Sample",
            template_id="keilhq-editorial",
            format_req="unsupported_format",  # type: ignore[arg-type]
        )


@pytest.mark.asyncio
async def test_select_template_sarvam_choice(tmp_path: Path) -> None:
    """When multiple templates match, Sarvam is called to select the best one."""
    import json

    from app.models import (
        AspectRatio,
        TemplateManifest,
        TemplateSlides,
        TemplateSupports,
        TextSlot,
        TextSlotRole,
    )

    # Create two templates in tmp_path
    for tid, name in [("tmpl-a", "Template A"), ("tmpl-b", "Template B")]:
        tdir = tmp_path / tid
        tdir.mkdir()
        manifest = TemplateManifest(
            id=tid,
            name=name,
            description="desc",
            supports=TemplateSupports(
                formats=[Format.SINGLE],
                aspect_ratios=[AspectRatio.FOUR_BY_FIVE],
            ),
            slides=TemplateSlides(min=1, max=1),
            text_slots=[TextSlot(id="headline", role=TextSlotRole.HEADLINE, max_chars=50)],
            image_slots=[],
        )
        (tdir / "manifest.json").write_text(
            json.dumps(manifest.model_dump(mode="json")), encoding="utf-8"
        )
        (tdir / "template.html.j2").write_text("<div></div>", encoding="utf-8")

    mock_client = MockSarvamClient([{"template_id": "tmpl-b", "rationale": "Better fit"}])
    chosen = await select_template(
        content="Editorial content",
        sarvam_client=mock_client,
        templates_dir=tmp_path,
    )
    assert chosen.id == "tmpl-b"
    assert mock_client.call_count == 1


def test_validate_plan_against_manifest_slot_errors() -> None:
    """Directly test validation error cases for slide counts and slots."""
    from app.models import PostPlan, PostPlanSlide
    from app.planner import validate_plan_against_manifest
    from app.templates_loader import get_template

    manifest = get_template("keilhq-editorial")

    # Missing text slot
    plan = PostPlan(
        template_id="keilhq-editorial",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[PostPlanSlide(text={"headline": "Test"}, images={})],
        caption="Caption",
        hashtags=["tag"],
        alt_texts=["Alt"],
    )

    errors = validate_plan_against_manifest(plan, manifest)
    assert any("missing required text slot" in e for e in errors)
    assert any("missing required generation prompt" in e for e in errors)


@pytest.mark.asyncio
async def test_plan_and_composite_pipeline() -> None:
    """Phase 3 Exit: Mocked planner produces a PostPlan that composites with placeholders into valid JPEG."""
    mock_client = MockSarvamClient([_make_valid_sarvam_response()])

    request = CreateJobRequest(
        content="Deliberate and quiet craftsmanship in knowledge systems.",
        template_id="keilhq-editorial",
    )

    plan, _ = await plan_post(request, sarvam_client=mock_client)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            result = await composite_post(plan, browser)
        finally:
            await browser.close()

    assert len(result.slides) == 1
    assert result.slides[0].image_bytes[:2] == b"\xff\xd8"  # JPEG magic bytes
    assert len(result.slides[0].image_bytes) <= 1_400_000


@pytest.mark.integration
@pytest.mark.asyncio
async def test_live_sarvam_planner() -> None:
    """Gated live integration test against Sarvam API. Skipped if SARVAM_API_KEY is not set."""
    api_key = os.environ.get("SARVAM_API_KEY") or get_settings().sarvam_api_key.get_secret_value()
    if not api_key:
        pytest.skip("SARVAM_API_KEY not configured; skipping live integration test.")

    client = SarvamClient(api_key=api_key)
    request = CreateJobRequest(
        content="Careful and patient craft in software systems creates enduring calm.",
        format=Format.SINGLE,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        template_id="keilhq-editorial",
    )

    plan, manifest = await plan_post(request, sarvam_client=client)
    assert plan.template_id == "keilhq-editorial"
    assert manifest.id == "keilhq-editorial"
    assert len(plan.slides) == 1
