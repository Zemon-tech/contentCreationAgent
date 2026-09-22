#!/usr/bin/env python3
"""
Storyboard to LTX-2.3 Handoff & Exporter Tool
Converts commercial storyboard JSON scenes into production-grade LTX-2.3 JSON scene prompts
and generates beautiful Two-Column Audio-Visual (AV) script tables.
"""

import sys
import os
import json
import argparse

def load_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"[-] Error loading JSON from {path}: {e}")
        sys.exit(1)

def generate_av_script_markdown(storyboard):
    meta = storyboard.get("campaign_metadata", {})
    prod = storyboard.get("product_and_audience", {})
    concept = storyboard.get("creative_concept", {})
    scenes = storyboard.get("scenes", [])
    brand_card = storyboard.get("brand_end_card", {})

    lines = []
    lines.append(f"# 🎬 Commercial Script & Storyboard: {meta.get('campaign_title', 'Untitled Campaign')}")
    lines.append(f"**Runtime**: {meta.get('target_runtime_seconds', 30)}s | **Aspect Ratio**: {meta.get('aspect_ratio', '16:9')} | **Archetype**: {meta.get('creative_archetype', 'Custom')}")
    lines.append(f"**Product**: {prod.get('product_name', 'N/A')} | **Target Audience**: {prod.get('target_audience', 'N/A')}")
    lines.append(f"**Logline**: *{concept.get('logline', 'N/A')}*")
    lines.append(f"**Core Tagline**: **\"{concept.get('core_tagline', 'N/A')}\"**")
    lines.append(f"**Music Direction**: {concept.get('music_direction', 'N/A')}\n")

    lines.append("## 📋 Two-Column Audio-Visual (AV) Production Script\n")
    lines.append("| Timecode & Scene | Visual (Video Column) | Audio (Acoustic Column) |")
    lines.append("| :--- | :--- | :--- |")

    for s in scenes:
        tc = s.get("timecode", "00:00")
        num = s.get("scene_number", 1)
        title = s.get("title", f"Scene {num}")
        dur = s.get("duration_seconds", 5)
        beat = s.get("dramatic_beat", "Action")
        fps30 = int(dur * 30 + 1)

        # Visual description
        blocking = s.get("spatial_blocking", {})
        cam = s.get("camera", {})
        light = s.get("lighting", {})
        perf = s.get("performance", {})
        actions = s.get("action_timeline", [])
        action_summary = " ".join([a.get("action", "") for a in actions])

        visual_cell = (
            f"**SCENE {num}: {title}**<br>"
            f"*Beat: {beat} ({dur}s / {fps30} frames)*<br><br>"
            f"**Action**: {action_summary}<br>"
            f"**Blocking**: FG: {blocking.get('foreground', 'N/A')} &#124; MG: {blocking.get('midground', 'N/A')} &#124; BG: {blocking.get('background', 'N/A')}<br>"
            f"**Camera**: {cam.get('lens', '35mm')} - {cam.get('movement', 'Static')} (Height: {cam.get('starting_height', '1.3m')})<br>"
            f"**Lighting**: {light.get('source', 'Window daylight')} ({light.get('temperature', '5000K')})"
        )

        # Audio description
        aud = s.get("audio", {})
        foley_items = ", ".join(aud.get("foley", [])) if aud.get("foley") else "None"
        vo_dialogue = aud.get("voiceover_or_dialogue", "")
        music_cue = aud.get("music_cue", "")
        acoustics = aud.get("acoustics", "")

        audio_cell = (
            f"**Acoustics**: {acoustics}<br>"
            f"**Foley / SFX**: {foley_items}<br>"
        )
        if vo_dialogue:
            audio_cell += f"**VO / Dialogue**: *\"{vo_dialogue}\"*<br>"
        if music_cue:
            audio_cell += f"**Music**: {music_cue}"

        lines.append(f"| **{tc}**<br>*(Scene {num})* | {visual_cell} | {audio_cell} |")

    lines.append("\n## 🏁 Brand End Card (Post-Compositing)")
    lines.append(f"- **Brand**: {brand_card.get('brand_name', 'N/A')}")
    lines.append(f"- **Tagline**: {brand_card.get('tagline', 'N/A')}")
    lines.append(f"- **Call to Action**: {brand_card.get('call_to_action', 'N/A')}")
    lines.append(f"- **Compositing Note**: {brand_card.get('composition_notes', 'N/A')}")

    return "\n".join(lines)

def convert_scene_to_ltx_json(storyboard, scene_number):
    meta = storyboard.get("campaign_metadata", {})
    prod = storyboard.get("product_and_audience", {})
    scenes = storyboard.get("scenes", [])

    scene_data = next((s for s in scenes if s.get("scene_number") == scene_number), None)
    if not scene_data:
        print(f"[-] Scene {scene_number} not found in storyboard.")
        sys.exit(1)

    dur = scene_data.get("duration_seconds", 6)
    fps = 30
    length_frames = int(dur * fps + 1)
    title = scene_data.get("title", f"SCENE {scene_number}")

    # Build LTX 16-section production JSON
    ltx_dict = {
        "scene": {
            "scene_number": scene_number,
            "title": title,
            "timecode": scene_data.get("timecode", "00:00-00:06"),
            "duration_seconds": dur,
            "generation_target": "LTX-2.3 via ComfyUI",
            "generation_mode": "T2V",
            "aspect_ratio": meta.get("aspect_ratio", "16:9"),
            "purpose": f"Establish {scene_data.get('dramatic_beat', 'commercial')} beat for {prod.get('product_name', 'product')}.",
            "emotional_destination": prod.get("emotional_destination", "Clarity and confidence"),
            "dominant_visual_idea": scene_data.get("spatial_blocking", {}).get("midground", "Character in flow state"),
            "brand_landing": storyboard.get("creative_concept", {}).get("core_tagline", "Brand Landing")
        },
        "important_generation_architecture": {
            "reason": "Ensure physical and temporal continuity inside diffusion. Separate UI graphics, vector logos, and end cards into post-production compositing.",
            "generative_boundaries": "Generate continuous human live-action footage via LTX-2.3. No vector graphic or logo generation inside diffusion.",
            "recommended_method": "Native LTX-2.3 T2V Two-Stage Workflow via ComfyUI."
        },
        "continuity": {
            "character": {
                "identity": f"Hero character representing {prod.get('target_audience', 'target user')}",
                "wardrobe": "High-quality, grounded everyday textures (cotton, wool, denim)",
                "performance": scene_data.get("performance", {}).get("emotional_tone", "Naturalistic and authentic")
            },
            "environment": {
                "location": title,
                "props": scene_data.get("spatial_blocking", {}).get("foreground", "Key scene props")
            }
        },
        "spatial_blocking": {
            "foreground": scene_data.get("spatial_blocking", {}).get("foreground", "Soft out-of-focus framing element"),
            "midground": scene_data.get("spatial_blocking", {}).get("midground", "Primary action and character"),
            "background": scene_data.get("spatial_blocking", {}).get("background", "Environmental room architecture"),
            "camera_relation": f"Eye-level perspective at {scene_data.get('camera', {}).get('starting_height', '1.3m')}"
        },
        "action_timeline": scene_data.get("action_timeline", []),
        "performance": {
            "primary_subject": "Hero protagonist",
            "micro_actions": scene_data.get("performance", {}).get("micro_actions", "Natural breathing and gestures"),
            "emotional_tone": scene_data.get("performance", {}).get("emotional_tone", "Grounded realism"),
            "forbidden": scene_data.get("performance", {}).get("forbidden", [
                "no stock commercial smiling",
                "no looking at camera lens",
                "no frozen mannequin posture"
            ])
        },
        "camera": {
            "camera_type": "Full-frame cinema camera on precision tracking platform",
            "lens": scene_data.get("camera", {}).get("lens", "35mm prime lens"),
            "starting_position": "Medium shot framing character naturally",
            "starting_height": scene_data.get("camera", {}).get("starting_height", "1.3m"),
            "ending_height": scene_data.get("camera", {}).get("starting_height", "1.3m"),
            "depth_of_field": "Shallow depth of field isolating subject from soft background",
            "focus_priority": "Primary eye line of hero",
            "movement": {
                "trajectory": scene_data.get("camera", {}).get("movement", "Observational slow push-in"),
                "speed": "0.12 m/s smooth glide",
                "pacing": "Grounded human physics with gentle ease-in and settle"
            },
            "camera_path": {
                "travel": "0.4m forward translation",
                "speed": "0.12 m/s",
                "acceleration": "feathered"
            },
            "constraints": scene_data.get("camera", {}).get("constraints", [
                "no rapid zoom",
                "no digital shake",
                "no Dutch tilt"
            ])
        },
        "visual_callback": {
            "thematic_prop": "Key physical prop symbolizing the shift from friction to flow.",
            "lighting_symbolism": "Natural light illuminating the breakthrough."
        },
        "lighting": {
            "source": scene_data.get("lighting", {}).get("source", "Large north-facing daylight window"),
            "quality": "Diffused natural commercial daylight",
            "temperature": scene_data.get("lighting", {}).get("temperature", "5200K natural daylight"),
            "direction": "Side-key light with soft ambient fill",
            "subject_lighting": "Clean facial highlights and natural eye catchlights",
            "background_lighting": "Soft shadow fall-off on background wall",
            "important_rule": "Lighting must be motivated by real in-world light fixtures or windows.",
            "forbidden": ["no artificial neon wash", "no blown-out highlights", "no harsh digital rimlight"]
        },
        "color_and_finish": {
            "style": meta.get("visual_style", "Candid editorial commercial realism"),
            "film_character": meta.get("film_stock_profile", "Kodak Portra 400"),
            "grade": "Kodak 2383 print stock LUT emulation with warm skin tones",
            "palette": ["#1A1D20", "#485159", "#D8C7B5", "#F7F4EF", "#6E7A68"],
            "contrast": "Gentle S-curve with lifted, breathable shadows",
            "saturation": "Naturalistic and restrained",
            "grain": "Fine 35mm organic film grain",
            "halation": "Subtle optical halation on highlight boundaries",
            "texture": "Visible skin pores, authentic textile weaves, natural wood grain",
            "avoid": ["plastic skin", "CGI look", "oversaturated colors", "harsh digital sharpness"]
        },
        "audio": {
            "acoustics_and_ambience": scene_data.get("audio", {}).get("acoustics", "Clean modern interior acoustics"),
            "timeline_foley": {
                "foley_cues": scene_data.get("audio", {}).get("foley", ["tactile desk contact", "soft footsteps"])
            },
            "dialogue": [],
            "voiceover": [
                {
                    "line": scene_data.get("audio", {}).get("voiceover_or_dialogue", ""),
                    "delivery": "Intimate, warm, conversational voiceover."
                }
            ] if scene_data.get("audio", {}).get("voiceover_or_dialogue") else [],
            "music": {
                "entry": "Synchronized with scene opening",
                "character": scene_data.get("audio", {}).get("music_cue", "Warm minimalist acoustic bed"),
                "intensity": "Subtle background presence (-16dB under voiceover)",
                "progression": "Flowing naturally through the cut"
            }
        },
        "negative_prompt": {
            "anti_cgi": ["video game", "CGI", "3D render", "Unreal Engine", "cartoon", "plastic skin", "oversaturated"],
            "anatomy_and_physics": ["deformed hands", "mutated fingers", "warped anatomy", "floating objects", "morphing"],
            "camera_and_artifacts": ["erratic camera shake", "whip pan", "rapid zoom", "jitter", "sensor noise"],
            "lighting": ["blown-out highlights", "crushed muddy shadows", "harsh unmotivated neon"],
            "prohibited_elements": ["no UI mockups", "no on-screen logos", "no text overlays in video", "no watermarks"]
        },
        "ltx_2_3_prompt": scene_data.get("ltx_prompt_preview", ""),
        "comfyui_direction": {
            "workflow": "Native LTX-2.3 T2V Two-Stage Workflow.",
            "why_mode": f"Commercial beat: {scene_data.get('dramatic_beat', 'Action')}.",
            "camera_strategy": scene_data.get("camera", {}).get("movement", "Slow push-in"),
            "audio": "Joint audio-visual latent pass with synchronized foley and acoustic space.",
            "prompting": "Chronological narrative flow: action first, camera physics second, motivated light third, film texture fourth.",
            "render_strategy": {
                "pass_1_base": f"640x360 @ 30 FPS, {length_frames} frames ({dur}s * 30 + 1), Euler sampler with 8-step ManualSigmas.",
                "latent_upscale": "2x spatial latent upscaling via ltx-2.3-spatial-upscaler-x2-1.1.safetensors.",
                "pass_2_refine": "1280x720 @ 30 FPS, Euler sampler with 3-step ManualSigmas."
            }
        },
        "generation_priority": [
            "1. Grounded human acting and authentic micro-expressions.",
            "2. Smooth camera movement physics with zero digital wobble.",
            "3. Clean motivated lighting and Kodak film stock texture.",
            "4. Precise audio-visual synchronization."
        ],
        "quality_control": {
            "critical_story_test": f"Audience must feel the {scene_data.get('dramatic_beat', 'story')} beat clearly.",
            "critical_continuity_test": "Hero character wardrobe, hair, and props must match adjacent scenes.",
            "critical_performance_test": "Action must feel effortless and unperformed.",
            "critical_camera_test": "Camera movement must adhere strictly to specified trajectory.",
            "failure_conditions": [
                "plastic skin or airbrushed face",
                "deformed hands or fingers",
                "erratic camera shake",
                "logos or UI generated inside video"
            ]
        }
    }

    return ltx_dict

def main():
    parser = argparse.ArgumentParser(description="Export commercial storyboards to LTX-2.3 scene prompts and AV scripts.")
    parser.add_argument("storyboard_json", help="Path to storyboard JSON file")
    parser.add_argument("--script", action="store_true", help="Print formatted two-column AV script markdown")
    parser.add_argument("--save-script", help="Save formatted AV script markdown to file")
    parser.add_argument("--scene", type=int, help="Export a specific scene number into LTX-2.3 JSON format")
    parser.add_argument("--output", help="Path to save the exported LTX-2.3 scene JSON file")
    args = parser.parse_args()

    storyboard = load_json(args.storyboard_json)

    if args.script or args.save_script:
        md_content = generate_av_script_markdown(storyboard)
        if args.script:
            print(md_content)
        if args.save_script:
            with open(args.save_script, 'w', encoding='utf-8') as f:
                f.write(md_content)
            print(f"[+] AV Script saved to: {args.save_script}")

    if args.scene:
        ltx_scene = convert_scene_to_ltx_json(storyboard, args.scene)
        out_path = args.output if args.output else f"scene_{args.scene}_ltx.json"
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(ltx_scene, f, indent=2)
        print(f"[+] Scene {args.scene} successfully exported to LTX-2.3 JSON: {out_path}")

if __name__ == "__main__":
    main()
