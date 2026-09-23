#!/usr/bin/env python3
"""Suite: validate all examples + edge-case checks (stdlib only)."""
import json, subprocess, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[1]
VAL = ROOT / "scripts" / "validate_neoeditorial.py"
EX = ROOT / "examples"

CASES = ["example_ai_article_general.json", "example_business_midjourney.json",
         "example_philosophical_general.json", "example_technology_flux.json",
         "example_reference_transfer_openai.json"]

fails = 0
for c in CASES:
    p = EX / c
    r = subprocess.run([sys.executable, str(VAL), str(p)], capture_output=True, text=True)
    print(r.stdout.strip().splitlines()[0] if r.stdout else r.stderr.strip())
    if r.returncode != 0:
        fails += 1; print(r.stdout + r.stderr)

# Edge: photorealistic request must keep metaphor+palette but allow photo medium
d = json.loads((EX / "example_ai_article_general.json").read_text(encoding="utf-8"))
assert d["creative_brief"]["visual_metaphor"] and len(d["visual_spec"]["color_palette"]) >= 2, "core invariant"
# Edge: flux must not enable negatives
f = json.loads((EX / "example_technology_flux.json").read_text(encoding="utf-8"))
assert f["negative_prompt"]["enabled"] is False, "FLUX negatives must be disabled"
# Edge: midjourney params live in model_specific, general has no vendor flags
mj = json.loads((EX / "example_business_midjourney.json").read_text(encoding="utf-8"))
assert "--ar" in mj["prompts"]["model_specific"], "midjourney params expected"
g = json.loads((EX / "example_philosophical_general.json").read_text(encoding="utf-8"))
assert "--ar" not in g["prompts"]["primary"] and "--sref" not in g["prompts"]["primary"], "general must be vendor-free"
print("[OK] edge checks passed (photoreal-invariant, flux-negative, vendor-syntax isolation)")
sys.exit(1 if fails else 0)
