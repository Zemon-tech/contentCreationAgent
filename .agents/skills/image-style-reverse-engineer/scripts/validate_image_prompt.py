#!/usr/bin/env python3
"""Validate image-style-reverse-engineer JSON prompts against the schema (stdlib only)."""
import json, re, sys

def fail(msg):
    print(f"[FAIL] {msg}")
    sys.exit(1)

def ok(msg):
    print(f"[OK] {msg}")

def main():
    if len(sys.argv) < 2:
        print("Usage: validate_image_prompt.py <prompt.json> [--extract-prompt]")
        sys.exit(1)
    path = sys.argv[1]
    extract = "--extract-prompt" in sys.argv
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception as e:
        fail(f"invalid JSON: {e}")

    for k in ["meta", "source_analysis", "style_profile", "subject", "master_prompt",
              "higgsfield_soul_block", "model_variants", "negative_prompt", "generation_params"]:
        if k not in d:
            fail(f"missing top-level key: {k}")

    sa = d["source_analysis"]
    if len(sa.get("palette", [])) != 5 or any(not re.fullmatch(r"#[0-9A-Fa-f]{6}", c) for c in sa["palette"]):
        fail("source_analysis.palette must be exactly 5 HEX colors")
    if len(sa.get("textures", [])) < 3:
        fail("source_analysis.textures needs >= 3 tactile entries")
    if "K" not in sa.get("lighting", {}).get("temperature_kelvin", ""):
        fail("lighting.temperature_kelvin must contain a Kelvin value (e.g. 5500K)")
    if not re.search(r"\d{2,3}\s?mm", sa.get("optics", {}).get("lens", "")):
        fail("optics.lens must name a focal length (e.g. 35mm f/2.0)")
    if not sa.get("finish", {}).get("film_stock"):
        fail("finish.film_stock is required (pick from taxonomy)")
    if d["subject"].get("preserve_source_identity") is not False:
        fail("subject.preserve_source_identity must be false (never copy reference identity)")

    mp = d["master_prompt"]
    words = len(mp.split())
    if not (80 <= words <= 220):
        fail(f"master_prompt is {words} words; want 80-220 (100-180 ideal)")
    if "\n" in mp or "- " in mp[:3]:
        fail("master_prompt must be a single flowing paragraph")

    hb = d["higgsfield_soul_block"]
    if hb.get("reference_mode") not in ("style", "composition"):
        fail("higgsfield_soul_block.reference_mode must be style|composition")
    if not (0.7 <= float(hb.get("style_strength", 0)) <= 0.85):
        fail("style_strength must be 0.7-0.85")

    nn = d["style_profile"].get("non_negotiables", [])
    if len(nn) < 3:
        fail("style_profile.non_negotiables needs >= 3 entries")

    ok(f"{path} passed ({words}-word master prompt)")
    if extract:
        print("\n--- master_prompt ---\n" + mp)
        print("\n--- soul_prompt ---\n" + hb.get("soul_prompt", ""))
        print("\n--- midjourney ---\n" + d["model_variants"].get("midjourney", ""))

if __name__ == "__main__":
    main()
