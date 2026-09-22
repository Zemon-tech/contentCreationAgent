"""Unit tests for KeilHQ brand loader and banned words scanner (spec.md §8)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.brand import build_prompt_rules, load_brand, scan_banned_words
from app.exceptions import ConfigurationError


def test_load_brand_valid() -> None:
    """Load and validate the repository's brand.yaml."""
    brand = load_brand("brand.yaml")

    assert brand.name == "KeilHQ"
    assert len(brand.voice.principles) >= 4
    assert "revolutionary" in brand.banned_words
    assert "🔥" in brand.banned_words
    assert brand.colors.warm_ink == "#171514"
    assert brand.colors.cotton_paper == "#F7F4EE"
    assert brand.typography.headline_font == "DM Sans"
    assert brand.typography.body_font == "Inter"

    # Verify template tokens
    tokens = brand.template_tokens
    assert tokens["brand_name"] == "KeilHQ"
    assert tokens["css_colors"]["--color-warm-ink"] == "#171514"
    assert tokens["headline_font"] == "DM Sans"


def test_load_brand_missing_file(tmp_path: Path) -> None:
    """Missing brand file raises ConfigurationError."""
    missing_path = tmp_path / "nonexistent.yaml"
    with pytest.raises(ConfigurationError, match="not found"):
        load_brand(missing_path)


def test_load_brand_invalid_yaml(tmp_path: Path) -> None:
    """Malformed brand file raises ConfigurationError."""
    bad_file = tmp_path / "bad_brand.yaml"
    bad_file.write_text("invalid: yaml: content: [unclosed", encoding="utf-8")

    with pytest.raises(ConfigurationError, match="Failed to load brand configuration"):
        load_brand(bad_file)


def test_build_prompt_rules() -> None:
    """Ensure prompt rules string contains voice principles and banned words."""
    brand = load_brand("brand.yaml")
    rules = build_prompt_rules(brand)

    assert "BRAND VOICE & GUIDELINES (KeilHQ)" in rules
    assert "Calm over stimulation" in rules
    assert '"revolutionary"' in rules
    assert '"🔥"' in rules
    assert "DM Sans" in rules


def test_scan_banned_words_clean_text() -> None:
    """Clean text produces no banned word hits."""
    text = "Careful editorial craft and deliberate typography for thoughtful readers."
    hits = scan_banned_words(text)
    assert hits == []


def test_scan_banned_words_case_insensitivity() -> None:
    """Scanner detects banned words regardless of casing."""
    text = "This REVOLUTIONARY idea will transform everything."
    hits = scan_banned_words(text)
    assert "revolutionary" in hits


def test_scan_banned_words_hyphen_and_space() -> None:
    """Scanner detects hyphenated and space-separated variants."""
    text1 = "A true game-changer in design."
    assert "game-changer" in scan_banned_words(text1)

    text2 = "A true game changer in design."
    assert "game changer" in scan_banned_words(text2)


def test_scan_banned_words_emoji() -> None:
    """Scanner detects emoji banned tokens like 🔥."""
    text = "Our new release is finally out! 🔥"
    assert "🔥" in scan_banned_words(text)


def test_scan_banned_words_substring_boundary_safety() -> None:
    """Scanner does not trigger on substrings inside legitimate words."""
    text = "We studied counterrevolutionary movements in twentieth-century literature."
    hits = scan_banned_words(text)
    assert "revolutionary" not in hits


def test_scan_banned_words_multiple_texts() -> None:
    """Scanner checks lists of strings across different fields."""
    texts = [
        "Headline text about patience",
        "Body copy with insane claims",
        "Caption with an emoji 🔥",
    ]
    hits = scan_banned_words(texts)
    assert "insane" in hits
    assert "🔥" in hits
