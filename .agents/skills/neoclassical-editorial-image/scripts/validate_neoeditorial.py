#!/usr/bin/env python3
"""Validate neoclassical-editorial-image canonical JSON (stdlib only)."""
import json, re, sys

HOUSE = {"#087FEA","#0B0C0C","#F3EFE5","#F4E900","#18A8C7","#FF8A00","#6A39D7","#C4CF36","#D96532","#253F25"}
VENDOR_RE = re.compile(r"--(ar|chaos|c|stylize|s|sref|sw|no|style|v|q|raw|chaos|weird|tile|seed)\b|::\d|--v\s+\d")
HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

def fail(m):
    print(f"[FAIL] {m}"); sys.exit(1)
def ok(m):
    print(f"[OK] {m}")

def main():
    if len(sys.argv) < 2:
        print("Usage: validate_neoeditorial.py <prompt.json>"); sys.exit(1)
    path = sys.argv[1]
    try:
        with open(path, encoding="utf-8") as f: d = json.load(f)
    except Exception as e:
        fail(f"invalid JSON: {e}")
    for k in ["meta","creative_brief","art_direction","visual_spec","style_constraints","reference_strategy","prompt_strategy","prompts","negative_prompt","generation_parameters","validation"]:
        if k not in d: fail(f"missing top-level key: {k}")
    m = d["meta"]
    if m.get("skill") != "neoclassical-editorial-image": fail("meta.skill must be neoclassical-editorial-image")
    if m.get("style_system") != "contemporary-neoclassical-editorial-collage": fail("meta.style_system fixed value violated")
    if m.get("target_model") not in ("general","midjourney","openai","flux","google"): fail("invalid target_model")
    if m.get("prompt_complexity") not in ("concise","standard","detailed"): fail("invalid prompt_complexity")
    cb = d["creative_brief"]
    for f in ["topic","thesis","visual_metaphor"]:
        if not cb.get(f) or len(cb[f]) < 5: fail(f"creative_brief.{f} missing/weak (need visual metaphor, not literal)")
    ad = d["art_direction"]
    if ad.get("style_name") != "Contemporary Neoclassical Editorial Collage": fail("style_name is a house rule")
    if ad.get("style_archetype") != "neoclassical-pop-editorial": fail("style_archetype is a house rule")
    for f in ["historical_language","contemporary_language","medium","rendering_language","composition_language","color_strategy","texture_strategy","mood"]:
        if not ad.get(f): fail(f"art_direction.{f} required")
    vs = d["visual_spec"]
    if len(vs.get("hero_subject","")) < 10: fail("visual_spec.hero_subject required (>=10 chars)")
    if not vs.get("composition"): fail("visual_spec.composition required")
    if len(vs.get("supporting_elements",[])) < 1: fail("need >=1 supporting element")
    pal = vs.get("color_palette",[])
    if not (2 <= len(pal) <= 5) or any(not HEX_RE.match(c) for c in pal): fail("color_palette must be 2-5 HEX")
    if not any(c.upper() in {h.upper() for h in HOUSE} for c in pal):
        fail("color_palette must include >=1 house color (or justify in validation.warnings)")
    if len(vs.get("textures",[])) < 2: fail("textures needs >=2 print textures (non-negotiable)")
    if not vs.get("typography"): fail("typography required (use 'no text...' default)")
    sc = d["style_constraints"]
    if len(sc.get("non_negotiables",[])) < 3: fail("non_negotiables needs >=3")
    if len(sc.get("avoid",[])) < 2: fail("avoid needs >=2")
    pr = d["prompts"]
    if len(pr.get("primary","")) < 200: fail("prompts.primary too short (<200 chars) — add art direction")
    if len(pr.get("compact","")) < 40 or len(pr.get("model_specific","")) < 40: fail("compact/model_specific required")
    if m["target_model"] == "general" and VENDOR_RE.search(pr["primary"] + pr["model_specific"]):
        fail("general mode must not contain vendor syntax (--ar/--sref/:: etc.)")
    if m["target_model"] == "flux" and d["negative_prompt"].get("enabled") is True:
        fail("FLUX has no negative prompts: negative_prompt.enabled must be false")
    ok(f"{path} passed [{m['target_model']}/{m['prompt_complexity']}] primary={len(pr['primary'])}ch palette={','.join(pal)}")
    print("\n--- primary (copy-paste) ---\n" + pr["primary"][:1200])
if __name__ == "__main__":
    main()
