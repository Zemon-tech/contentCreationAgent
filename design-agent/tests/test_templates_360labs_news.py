"""Unit tests for the RAS News template (360labs-news)."""

from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from app.brand import load_brand
from app.models import AspectRatio, Format, PostPlan, PostPlanSlide
from app.templates_loader import build_postplan_schema, get_template


def test_360labs_news_manifest_loads() -> None:
    """Validate that 360labs-news manifest loads with hero image slot + cover/content guidance."""
    manifest = get_template("360labs-news")

    assert manifest.id == "360labs-news"
    assert manifest.slides.min == 1
    assert manifest.slides.max == 10

    slot_ids = {s.id for s in manifest.text_slots}
    assert {"eyebrow", "headline", "body", "cta"}.issubset(slot_ids)
    assert [s.id for s in manifest.image_slots] == ["hero"]
    assert "Slide 1 of N is the COVER" in manifest.description
    assert "Slides 2 to N are CONTENT" in manifest.description


def test_360labs_news_logo_assets_exist() -> None:
    """Official RAS lockups must ship inside the template dir (self-contained for data-URI embedding)."""
    template_dir = Path("templates") / "360labs-news"
    assert (template_dir / "ras-by-keilhq-light-mode.png").is_file()
    assert (template_dir / "ras-by-keilhq-dark-mode.png").is_file()


def test_360labs_news_html_renders() -> None:
    """Validate that template.html.j2 renders cover + content variants."""
    templates_dir = Path("templates")
    template_dir = templates_dir / "360labs-news"
    style_css = (template_dir / "style.css").read_text(encoding="utf-8")

    env = Environment(loader=FileSystemLoader(str(template_dir)), autoescape=True)
    tmpl = env.get_template("template.html.j2")
    brand = load_brand("brand.yaml")

    base_context = {
        "images": {"hero": "data:image/png;base64,iVBORw0KGgo="},
        "logo_light": "data:image/png;base64,iVBORw0KGgo=",
        "logo_dark": None,
        "brand_slug": "RAS",
        "brand_name": brand.name,
        "width": 1080,
        "height": 1350,
        "aspect_ratio": "4:5",
        "total_slides": 5,
        "style_content": style_css,
        "css_colors": brand.template_tokens["css_colors"],
    }

    cover_html = tmpl.render(
        {
            **base_context,
            "text": {
                "eyebrow": "AI NEWS",
                "headline": "TypeSafe AI launches Jev, its first System One AI model",
                "body": "<strong>TypeSafe AI</strong> has come out of stealth with <strong>$40 million</strong>.",
                "cta": "",
            },
            "slide_index": 0,
        }
    )

    assert '<div id="canvas"' in cover_html
    assert "is-cover" in cover_html
    assert "cat-ai" in cover_html
    assert "AI NEWS" in cover_html
    assert "TypeSafe AI launches Jev" in cover_html
    assert 'class="brand-logo"' in cover_html
    assert 'alt="RAS by KeilHQ"' in cover_html
    assert "signal-dot" in cover_html
    assert "#F4F0E6" in cover_html or "Satoshi" in cover_html
    assert "01 / 05" in cover_html
    assert 'data-slot="eyebrow"' in cover_html
    assert 'data-slot="headline"' in cover_html
    assert 'data-slot="body"' in cover_html
    assert "hero-card" in cover_html
    assert "hero-cover" in cover_html
    assert "corner tl" in cover_html

    content_html = tmpl.render(
        {
            **base_context,
            "text": {
                "eyebrow": "AI NEWS",
                "headline": "Led by Diogo Almeida, Ex-researcher at OpenAI",
                "body": "At OpenAI, Almeida helped build the methods behind <strong>ChatGPT</strong>.",
                "cta": "",
            },
            "slide_index": 1,
        }
    )

    assert "is-content" in content_html
    assert "02 / 05" in content_html
    assert "hero-content" in content_html
    assert "corner tl" not in content_html

    fallback_html = tmpl.render(
        {
            **base_context,
            "logo_light": None,
            "text": {
                "eyebrow": "AI NEWS",
                "headline": "Fallback badge",
                "body": "Logo file missing.",
                "cta": "",
            },
            "slide_index": 0,
        }
    )
    assert 'class="brand-logo"' not in fallback_html
    assert "<span>RAS</span>" in fallback_html


def test_360labs_news_cover_content_styles_differ() -> None:
    """Cover hero must contain (logotype uncropped); content hero must cover + grayscale."""
    css = (Path("templates") / "360labs-news" / "style.css").read_text(encoding="utf-8")
    assert ".hero-cover .hero-img" in css
    assert "object-fit: contain" in css
    assert ".hero-content .hero-img" in css
    assert "object-fit: cover" in css
    assert "grayscale(100%)" in css


def test_360labs_news_postplan_schema() -> None:
    """Verify PostPlan strict schema requires hero prompt."""
    manifest = get_template("360labs-news")
    schema = build_postplan_schema(manifest)

    assert schema["properties"]["template_id"]["enum"] == ["360labs-news"]
    slide_images_schema = schema["properties"]["slides"]["items"]["properties"]["images"]
    assert "hero" in slide_images_schema["properties"]
    assert "hero" in slide_images_schema["required"]


def test_360labs_news_plan_validates() -> None:
    """PostPlan model accepts a minimal 360labs-news carousel plan."""
    plan = PostPlan(
        template_id="360labs-news",
        format=Format.CAROUSEL,
        aspect_ratio=AspectRatio.FOUR_BY_FIVE,
        slides=[
            PostPlanSlide(
                text={
                    "eyebrow": "AI NEWS",
                    "headline": "TypeSafe AI launches Jev",
                    "body": "Stealth exit with funding.",
                    "cta": "",
                },
                images={"hero": {"prompt": "minimal black TypeSafe AI logotype centered on light grey studio background, editorial"}},
            ),
            PostPlanSlide(
                text={
                    "eyebrow": "AI NEWS",
                    "headline": "Why it matters",
                    "body": "Automation needs dependable interfaces.",
                    "cta": "",
                },
                images={"hero": {"prompt": "black and white editorial portrait, soft window light, blurred office"}},
            ),
        ],
        caption="TypeSafe AI launches Jev.",
        hashtags=["ainews", "360labs"],
        alt_texts=["Cover headline", "Content headline"],
    )
    assert len(plan.slides) == 2
