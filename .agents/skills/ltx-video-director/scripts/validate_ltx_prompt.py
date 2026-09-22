#!/usr/bin/env python3
"""
LTX-2.3 Scene Prompt Validator & Extractor
Validates an LTX-2.3 JSON prompt against the production schema, audits directorial integrity,
and extracts the final cinematographic prompt ready for ComfyUI.
"""

import sys
import os
import json
import argparse
import re

def load_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"[-] Error loading JSON from {path}: {e}")
        sys.exit(1)

def audit_ltx_prompt(data, schema_data=None):
    issues = []
    warnings = []
    info = []

    # 1. Top-level or sub-scene required sections check
    required_sections = [
        "scene", "important_generation_architecture", "continuity",
        "spatial_blocking", "action_timeline", "performance",
        "camera", "lighting", "color_and_finish", "audio",
        "negative_prompt", "ltx_2_3_prompt", "comfyui_direction",
        "generation_priority", "quality_control"
    ]

    # Check if sub-scene object exists (e.g. "scene_8a", "shot_1")
    sub_scenes = [v for k, v in data.items() if (k.startswith("scene_") or k.startswith("shot_")) and isinstance(v, dict)]

    for section in required_sections:
        found = False
        if section in data:
            found = True
        else:
            # Check prefix matches at top level
            if any(k.startswith(section) for k in data.keys()):
                found = True
            # Check nested inside sub-scenes
            elif any(section in s for s in sub_scenes):
                found = True
        if not found:
            issues.append(f"Missing required section: '{section}' (not found at top level or in sub-scene)")

    # 2. Scene metadata audit
    scene = data.get("scene", {})
    duration = scene.get("duration_seconds")
    if duration is None or not isinstance(duration, (int, float)) or duration <= 0:
        issues.append("Scene 'duration_seconds' must be a positive number.")
    else:
        info.append(f"Duration: {duration}s")
        # Check standard ComfyUI frame calculations
        fps_30_frames = int(duration * 30 + 1)
        fps_24_frames = int(duration * 24 + 1)
        fps_50_frames = int(duration * 50 + 1)
        info.append(f"Frame Counts: @30fps = {fps_30_frames} frames | @24fps = {fps_24_frames} frames | @50fps = {fps_50_frames} frames")

    # 3. Action timeline chronological audit
    timeline = data.get("action_timeline")
    if not timeline and sub_scenes:
        for s in sub_scenes:
            if "action_timeline" in s:
                timeline = s["action_timeline"]
                break

    if not isinstance(timeline, list) or len(timeline) == 0:
        issues.append("'action_timeline' must be a non-empty list of chronological beats.")
    else:
        info.append(f"Timeline Beats: {len(timeline)} sequential beats.")

    # 4. Master Synthesized Prompt Audit
    prompt_key = None
    for k in data.keys():
        if k == "ltx_2_3_prompt" or k.startswith("ltx_2_3_prompt"):
            prompt_key = k
            break

    if not prompt_key or not isinstance(data.get(prompt_key), str):
        issues.append("Missing master prompt string ('ltx_2_3_prompt').")
    else:
        prompt_text = data[prompt_key].strip()
        words = prompt_text.split()
        word_count = len(words)
        info.append(f"Master Prompt Word Count: {word_count} words")

        if word_count < 60:
            warnings.append(f"Master prompt is relatively short ({word_count} words). LTX-2.3 performs best with 100-220 words.")
        elif word_count > 250:
            warnings.append(f"Master prompt exceeds 250 words ({word_count} words). Consider condensing to avoid prompt dilution.")

        # Check for paragraph breaks (LTX requires a single cohesive paragraph)
        if "\n\n" in prompt_text or "\r\n\r\n" in prompt_text:
            warnings.append("Master prompt contains multiple paragraphs. LTX-2.3 DiT achieves better temporal coherence as a single flowing paragraph.")

        # Check for domain terminology
        cinematic_terms = ["lens", "camera", "lighting", "grain", "focus", "dolly", "track", "shot", "light", "mm"]
        matched_terms = [t for t in cinematic_terms if re.search(r'\b' + t + r'\b', prompt_text, re.IGNORECASE)]
        if len(matched_terms) < 4:
            warnings.append(f"Low density of cinematography terms in master prompt (matched only: {matched_terms}).")

    # 5. Negative prompt audit
    neg_key = None
    for k in data.keys():
        if k == "negative_prompt" or k.startswith("negative_prompt"):
            neg_key = k
            break

    if not neg_key:
        issues.append("Missing 'negative_prompt' section.")
    else:
        neg_data = data[neg_key]
        if isinstance(neg_data, dict):
            categories = list(neg_data.keys())
            info.append(f"Negative Prompt Categories: {', '.join(categories)}")
        elif isinstance(neg_data, str):
            info.append("Negative prompt provided as raw string.")

    # 6. Audio layer audit
    audio = data.get("audio", {})
    if not audio:
        warnings.append("Missing 'audio' design specifications. LTX-2.3 generates synchronized audio latents.")
    else:
        info.append("Audio layer specified.")

    return issues, warnings, info

def main():
    parser = argparse.ArgumentParser(description="Validate and inspect LTX-2.3 scene prompt JSON files.")
    parser.add_argument("json_file", help="Path to the LTX-2.3 scene JSON file")
    parser.add_argument("--extract-prompt", action="store_true", help="Print the synthesized master prompt to stdout")
    parser.add_argument("--save-prompt", help="Save the extracted prompt to a target text file")
    args = parser.parse_args()

    if not os.path.exists(args.json_file):
        print(f"[-] File not found: {args.json_file}")
        sys.exit(1)

    data = load_json(args.json_file)
    issues, warnings, info = audit_ltx_prompt(data)

    print("============================================================")
    print(f"🎬 LTX-2.3 Scene Prompt Audit: {os.path.basename(args.json_file)}")
    print("============================================================")

    for item in info:
        print(f"  [i] {item}")

    if warnings:
        print("\n⚠️  Warnings:")
        for w in warnings:
            print(f"  [!] {w}")

    if issues:
        print("\n❌ Errors / Missing Requirements:")
        for err in issues:
            print(f"  [-] {err}")
        print("\n[!] Audit Result: FAILED")
        sys.exit(1)
    else:
        print("\n✅ Audit Result: PASSED (Production Ready)")

    prompt_key = next((k for k in data.keys() if k == "ltx_2_3_prompt" or k.startswith("ltx_2_3_prompt")), None)
    if prompt_key and data.get(prompt_key):
        prompt_str = data[prompt_key]
        if args.extract_prompt:
            print("\n------------------- EXTRACTED LTX-2.3 PROMPT -------------------")
            print(prompt_str)
            print("----------------------------------------------------------------")

        if args.save_prompt:
            with open(args.save_prompt, 'w', encoding='utf-8') as out_f:
                out_f.write(prompt_str)
            print(f"\n[+] Master prompt saved to: {args.save_prompt}")

if __name__ == "__main__":
    main()
