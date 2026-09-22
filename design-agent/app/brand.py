"""KeilHQ brand guide loader and validation.

Loads `brand.yaml`, enforces brand voice guidelines, and performs
case-insensitive banned-word scanning across generated content.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field

from app.config import get_settings
from app.exceptions import ConfigurationError


class BrandVoice(BaseModel):
    """Voice guidelines and editorial style constraints."""

    model_config = ConfigDict(frozen=True)

    principles: list[str] = Field(min_length=1)
    prefer: list[str] = Field(min_length=1)
    avoid: list[str] = Field(min_length=1)


class BrandColors(BaseModel):
    """Brand color palette hex codes."""

    model_config = ConfigDict(frozen=True)

    warm_ink: str
    cotton_paper: str
    linen: str
    limestone: str
    weathered_slate: str
    oxidized_copper: str
    monsoon_forest: str
    jaipur_sandstone: str
    harvest_marigold: str
    indigo_dye: str
    terracotta_clay: str

    def as_css_variables(self) -> dict[str, str]:
        """Return CSS custom property mapping, e.g. '--color-warm-ink': '#171514'."""
        return {f"--color-{k.replace('_', '-')}": v for k, v in self.model_dump().items()}


class BrandTypography(BaseModel):
    """Brand typography rules and font names."""

    model_config = ConfigDict(frozen=True)

    headline_font: str = "DM Sans"
    body_font: str = "Inter"
    rules: list[str] = Field(default_factory=list)


class BrandConfig(BaseModel):
    """Full parsed brand specification from brand.yaml."""

    model_config = ConfigDict(frozen=True)

    name: str
    voice: BrandVoice
    banned_words: list[str] = Field(min_length=1)
    colors: BrandColors
    typography: BrandTypography
    color_usage_rules: list[str] = Field(default_factory=list)

    @property
    def template_tokens(self) -> dict[str, Any]:
        """Dictionary of brand tokens exposed to Jinja2 template contexts."""
        return {
            "brand_name": self.name,
            "colors": self.colors.model_dump(),
            "css_colors": self.colors.as_css_variables(),
            "headline_font": self.typography.headline_font,
            "body_font": self.typography.body_font,
        }


def load_brand(brand_file: Path | str | None = None) -> BrandConfig:
    """Load and validate the brand YAML file.

    Raises:
        ConfigurationError: If the brand file is missing or contains invalid schema.
    """
    path = Path(brand_file) if brand_file is not None else get_settings().brand_file

    if not path.is_file():
        raise ConfigurationError(
            f"Brand configuration file not found at: {path.resolve()}",
            details={"brand_file": str(path)},
        )

    try:
        content = path.read_text(encoding="utf-8")
        raw_data = yaml.safe_load(content)
        if not isinstance(raw_data, dict):
            raise ValueError("YAML content must be a mapping")
        return BrandConfig.model_validate(raw_data)
    except Exception as exc:
        raise ConfigurationError(
            f"Failed to load brand configuration from {path}: {exc}",
            details={"brand_file": str(path), "error": str(exc)},
        ) from exc


@lru_cache(maxsize=1)
def get_brand() -> BrandConfig:
    """Return the cached, process-wide BrandConfig instance."""
    return load_brand()


def build_prompt_rules(brand: BrandConfig | None = None) -> str:
    """Build the brand guidelines text to inject into the planner's system prompt."""
    cfg = brand or get_brand()

    principles = "\n".join(f"- {p}" for p in cfg.voice.principles)
    prefer = "\n".join(f"- {p}" for p in cfg.voice.prefer)
    avoid = "\n".join(f"- {a}" for a in cfg.voice.avoid)
    banned = ", ".join(f'"{w}"' for w in cfg.banned_words)
    typo_rules = "\n".join(f"- {r}" for r in cfg.typography.rules)

    return f"""BRAND VOICE & GUIDELINES ({cfg.name}):
Principles:
{principles}

Preferences:
{prefer}

Avoid:
{avoid}

Strictly Banned Words / Tokens (NEVER use these anywhere in headlines, body copy, caption, or hashtags):
{banned}

Typography / Layout Rules:
{typo_rules}
"""


def scan_banned_words(
    texts: str | list[str],
    banned_words: list[str] | None = None,
) -> list[str]:
    """Scan texts for banned words, case-insensitively.

    Uses word boundaries when terms start/end with word characters,
    while allowing symbols/emojis (e.g. '🔥') to match anywhere.

    Returns:
        A list of distinct banned words that matched.
    """
    if banned_words is None:
        banned_words = get_brand().banned_words

    search_space = [texts] if isinstance(texts, str) else texts

    combined_text = "\n".join(search_space)
    hits: list[str] = []

    for word in banned_words:
        # If word begins/ends with a word char, use \b boundary to avoid partial matches
        # (e.g. prevent "revolutionary" matching inside "counterrevolutionary")
        prefix = r"\b" if re.match(r"^\w", word) else ""
        suffix = r"\b" if re.match(r"\w$", word) else ""
        pattern = f"{prefix}{re.escape(word)}{suffix}"

        if re.search(pattern, combined_text, re.IGNORECASE):
            hits.append(word)

    return hits
