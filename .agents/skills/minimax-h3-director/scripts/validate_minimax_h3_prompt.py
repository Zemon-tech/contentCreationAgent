#!/usr/bin/env python3
"""
MiniMax H3 Scene Prompt Validator & ComfyUI Extractor
Audits MiniMax H3 scene prompt JSON files against production standards,
validates Higgsfield optical rig parameters, verifies H3 prompt blocks
(integrated_multimodal_description, overall_soundscape, non_diegetic_music, <d> dialogue),
calculates ComfyUI 17-frame latent chunks, and extracts prompts for Node 140:131.
"""

import sys
import os
import json
import argparse
import re

def compute_h3_frames(duration_sec: float, fps: int = 24) -> int:
    """Calculates ComfyUI frame count matching Node 140:132 math expression:
    max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17
    """
    raw = max(5, round(duration_sec * fps))
    remainder = raw % 17
    adjustment = (5 - remainder) % 17
    return raw + adjustment

def audit_minimax_h3_prompt(data: dict, schema_data: dict = None):
    issues = []
    warnings = []
    info = []

    # 1. Required Sections
    required_sections = [
        "scene", "important_generation_architecture", "higgsfield_optical_rig",
        "continuity", "spatial_blocking", "action_timeline", "performance",
        "camera", "lighting", "color_and_finish", "audio",
        "negative_prompt", "minimax_h3_prompt", "comfyui_direction",
        "generation_priority", "quality_control"
    ]

    for sec in required_sections:
        if sec not in data:
            issues.append(f"Missing required top-level section: '{sec}'")

    # 2. Scene Metadata Audit
    scene = data.get("scene", {})
    duration = scene.get("duration_seconds")
    mode = scene.get("generation_mode", "T2VA")
    fps = scene.get("fps", 24)

    if duration is None or not isinstance(duration, (int, float)) or duration <= 0:
        issues.append("Scene 'duration_seconds' must be a positive number.")
    else:
        calculated_frames = compute_h3_frames(duration, fps)
        stated_frames = scene.get("frame_count_comfyui")
        info.append(f"Duration: {duration}s | Mode: {mode} | FPS: {fps}")
        info.append(f"Quantized H3 Latent Frames (17-chunk): {calculated_frames} frames")
        if stated_frames is not None and stated_frames != calculated_frames:
            warnings.append(
                f"Scene 'frame_count_comfyui' ({stated_frames}) differs from Node 140:132 calculation ({calculated_frames})."
            )

    valid_modes = ["T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"]
    if mode not in valid_modes:
        issues.append(f"Invalid 'generation_mode': '{mode}'. Must be one of {valid_modes}.")

    # 3. Higgsfield Optical Rig Audit
    rig = data.get("higgsfield_optical_rig", {})
    if rig:
        lens = rig.get("lens_profile", "")
        aperture = rig.get("aperture", "")
        focal = rig.get("focal_length", "")
        info.append(f"Higgsfield Optical Rig: Lens={lens}, Focal={focal}, Aperture={aperture}")
        if not lens or not aperture:
            warnings.append("Higgsfield optical rig should specify both 'lens_profile' and 'aperture'.")

    # 4. Action Timeline Audit
    timeline = data.get("action_timeline", [])
    if not isinstance(timeline, list) or len(timeline) == 0:
        issues.append("'action_timeline' must be a non-empty list of chronological beats.")
    else:
        info.append(f"Action Timeline: {len(timeline)} sequential beats.")

    # 5. Master MiniMax H3 Prompt Audit
    h3_prompt = data.get("minimax_h3_prompt")
    if not h3_prompt or not isinstance(h3_prompt, str):
        issues.append("Missing master prompt string ('minimax_h3_prompt').")
    else:
        prompt_text = h3_prompt.strip()
        word_count = len(prompt_text.split())
        info.append(f"MiniMax H3 Master Prompt Word Count: {word_count} words")

        # Mode-specific header validation
        if mode == "I2VA":
            expected_i2va_prefix = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."
            if not prompt_text.startswith(expected_i2va_prefix):
                warnings.append(
                    "I2VA prompt should begin with: 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'"
                )
        elif mode == "FL2VA":
            if not prompt_text.startswith("How the reference pictures align with the target video — Picture 1"):
                warnings.append(
                    "FL2VA prompt should begin with: 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark...'"
                )

        # Core blocks check
        if mode != "Ref2VA":
            if "integrated_multimodal_description:" not in prompt_text:
                issues.append("Master prompt is missing 'integrated_multimodal_description:' block.")
        else:
            if "detailed_description:" not in prompt_text:
                issues.append("Ref2VA master prompt is missing 'detailed_description:' block.")

        if "overall_soundscape:" not in prompt_text:
            issues.append("Master prompt is missing 'overall_soundscape:' block.")

        if "non_diegetic_music:" not in prompt_text:
            issues.append("Master prompt is missing 'non_diegetic_music:' block.")

        # Dialogue tags audit
        audio_sec = data.get("audio", {})
        dialogue_items = audio_sec.get("dialogue", [])
        if dialogue_items:
            for item in dialogue_items:
                line = item.get("line", "")
                if line and line not in prompt_text:
                    warnings.append(f"Dialogue line \"{line[:40]}...\" not found inside master prompt.")
            if "<d>" not in prompt_text:
                warnings.append("Dialogue was defined in 'audio' but no '<d>' tags were found in master prompt.")

    return issues, warnings, info

def main():
    parser = argparse.ArgumentParser(description="Validate MiniMax H3 Scene Prompts and extract for ComfyUI.")
    parser.add_argument("json_path", help="Path to the scene prompt JSON file.")
    parser.add_argument("--schema", help="Path to schema JSON (optional).", default=None)
    parser.add_argument("--extract-prompt", action="store_true", help="Print the raw synthesized H3 prompt for ComfyUI Node 140:131.")
    parser.add_argument("--update-workflow", help="Path to ComfyUI workflow (e.g. video_minimax_h3_t2v.json) to update Node 140:131 in place.", default=None)

    args = parser.parse_args()

    if not os.path.exists(args.json_path):
        print(f"[-] Error: JSON file not found: {args.json_path}")
        sys.exit(1)

    try:
        with open(args.json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f"[-] Error parsing JSON: {e}")
        sys.exit(1)

    issues, warnings, info = audit_minimax_h3_prompt(data)

    print("==================================================")
    print(f" MiniMax H3 Prompt Audit: {os.path.basename(args.json_path)}")
    print("==================================================")

    for item in info:
        print(f" [*] {item}")

    if warnings:
        print("\nWarnings:")
        for w in warnings:
            print(f" [!] {w}")

    if issues:
        print("\nErrors / Validation Failures:")
        for err in issues:
            print(f" [-] {err}")
        print("\nAudit Status: FAILED")
        if not args.extract_prompt:
            sys.exit(1)
    else:
        print("\nAudit Status: PASSED (100% Compliant with MiniMax H3 Directing Standard)")

    if args.extract_prompt:
        prompt = data.get("minimax_h3_prompt", "")
        print("\n--- Extracted Master Prompt for ComfyUI Node 140:131 ---\n")
        print(prompt)
        print("\n--------------------------------------------------------")

    if args.update_workflow:
        wf_path = args.update_workflow
        if not os.path.exists(wf_path):
            print(f"[-] Error: Workflow file not found: {wf_path}")
            sys.exit(1)
        try:
            with open(wf_path, 'r', encoding='utf-8') as wf:
                wf_data = json.load(wf)
            if "140:131" in wf_data and "inputs" in wf_data["140:131"]:
                wf_data["140:131"]["inputs"]["prompt"] = json.dumps(data, indent=2)
                with open(wf_path, 'w', encoding='utf-8') as wf_out:
                    json.dump(wf_data, wf_out, indent=2)
                print(f"[+] Successfully injected prompt JSON into Node 140:131 in {wf_path}")
            else:
                print("[-] Could not find Node '140:131' in workflow JSON.")
        except Exception as e:
            print(f"[-] Error updating workflow: {e}")

if __name__ == "__main__":
    main()
