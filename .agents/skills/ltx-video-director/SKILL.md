---
name: ltx-video-director
description: >-
  Direct professional text-to-video (T2V) and image-to-video (I2V) generation for Lightricks LTX-2.3 models.
  Generates production-grade structured JSON scene prompts implementing cinematography, spatial blocking,
  lens optics, motivated lighting, film stock emulation, LUTs, synchronized audio design, and negative prompt hygiene for ComfyUI.
---

# LTX-2.3 Video Director & Scene Prompt Generator

This skill teaches the agent how to act as a **Director of Photography (DP) and Film Director** for **Lightricks LTX-2.3** (22B Diffusion Transformer) running in **ComfyUI** (with Gemma 3 12B IT text encoder, distilled LoRA, joint audio-visual latents, and two-stage latent upscaling).

When the user asks to generate a video prompt, direct a scene, convert reference images into video prompts, or build JSON prompts for their ComfyUI workflow, use this skill.

---

## 1. Quick Reference & Core Resources

Before generating prompts, review the dedicated guides as needed:
- **Model Architecture & ComfyUI Mapping**: [model_specifications.md](./references/model_specifications.md) & [comfyui_workflow_architecture.md](./references/comfyui_workflow_architecture.md)
- **Cinematography & Camera Control**: [cinematography_guide.md](./references/cinematography_guide.md)
- **Lighting, Film Stocks & LUTs**: [lighting_and_color_grading.md](./references/lighting_and_color_grading.md)
- **Audio Synchronization & Foley**: [audio_synchronization_guide.md](./references/audio_synchronization_guide.md)
- **Negative Prompting & Pre-Render QC**: [negative_prompting_and_qc.md](./references/negative_prompting_and_qc.md)
- **JSON Schema**: [ltx_scene_prompt_schema.json](./resources/ltx_scene_prompt_schema.json)
- **Preset Libraries**:
  - [lut_and_film_stock_library.json](./resources/lut_and_film_stock_library.json)
  - [lighting_presets.json](./resources/lighting_presets.json)
  - [camera_movement_presets.json](./resources/camera_movement_presets.json)

---

## 2. The 8-Step Directing Workflow

When tasked with creating an LTX-2.3 scene prompt, execute this 8-step sequence:

```
┌────────────────────────────────────────────────────────┐
│ 1. Scene Breakdown & Dramatic Purpose                  │
├────────────────────────────────────────────────────────┤
│ 2. Spatial Blocking & Continuity Anchors               │
├────────────────────────────────────────────────────────┤
│ 3. Micro-Action Timeline (Chronological Beats)        │
├────────────────────────────────────────────────────────┤
│ 4. Camera Choreography (Lens, Path, Speed, Horizon)    │
├────────────────────────────────────────────────────────┤
│ 5. Lighting Design & Color Science (Kelvin, Stock, LUT)│
├────────────────────────────────────────────────────────┤
│ 6. Synchronized Multi-Track Sound Design               │
├────────────────────────────────────────────────────────┤
│ 7. Synthesize Master Flowing Narrative Paragraph       │
├────────────────────────────────────────────────────────┤
│ 8. Negative Prompt Formulation & Schema Validation     │
└────────────────────────────────────────────────────────┘
```

### Step 1: Scene Breakdown & Dramatic Purpose
- Determine scene number, title, timecode, target duration in seconds, aspect ratio (16:9, 9:16, 2.39:1).
- Identify the **emotional destination** and **dominant visual idea**.
- Enforce generative boundaries: separate live-action diffusion from 2D vector graphics, UI dashboards, and logos (which belong in post-compositing).

### Step 2: Spatial Blocking & Continuity Anchors
- Divide the set into three planes:
  - **Foreground (FG)**: Contextual out-of-focus framing elements (door frame, cup rim, rain drops).
  - **Midground (MG)**: Primary subject interaction plane.
  - **Background (BG)**: Environmental anchors, windows, architecture, atmosphere.
- Lock character continuity: exact age, hair texture/styling, specific wardrobe materials (e.g. *"merino wool sweater"*, *"worn olive cotton henley"*), and physical props.

### Step 3: Micro-Action Timeline (Chronological Beats)
- Break the scene duration into millisecond-accurate chronological beats (e.g., `00:00.0 - 00:01.5`, `00:01.5 - 00:03.0`, etc.).
- Translate emotions into **observable physical biomechanics**:
  - *Never say*: "He feels anxious and burned out."
  - *Say*: "He rubs his temples with thumb and forefinger, lowers his gaze to the desk, and exhales slowly through parted lips."
- Include the "Forbidden" director list: no stock commercial grins, no mannequin freezing, no looking into the lens.

### Step 4: Camera Choreography & Physics
- Specify lens focal length (e.g. 35mm Cooke S4 prime, 50mm Zeiss, 85mm portrait, 35mm 2x anamorphic).
- Establish starting height (e.g. 1.1m desk level, 1.4m seated eye level, 1.65m standing eye level).
- Define trajectory, speed (in m/s), and terminal settle:
  - *Example*: Smooth forward dolly push-in traveling 0.4m at 0.12 m/s over 3 seconds, decelerating to a gentle settle.
- Enforce camera constraints: no erratic handheld shake, no digital zoom, no unmotivated Dutch tilt.

### Step 5: Lighting Design & Color Science
- Specify motivated in-world light source (north-facing window, incandescent practical desk lamp).
- Dictate color temperature in Kelvin (e.g., 2700K tungsten vs 5500K daylight).
- Choose film stock emulation:
  - **Kodak Portra 400**: Candid editorial lifestyle, warm creamy skin, fine grain.
  - **Kodak Vision3 500T**: Hollywood narrative feature, deep blacks, warm amber halation.
  - **Kodak Vision3 250D**: Daylight crispness, true primaries, clean architectural texture.
  - **Fuji Eterna 500**: Arthouse desaturation, soft pastel shadow roll-off.
- Specify tactile micro-textures: real skin pores, wool weave, worn timber, optical halation, fine 35mm grain.

### Step 6: Synchronized Multi-Track Sound Design
- **Acoustics & Ambience**: Dry domestic room tone, echoing concrete hall, rainy city street.
- **Timeline Foley**: Match physical actions to contact sounds with timestamp precision (e.g., metallic compass slide on linen at 00:01.8).
- **Dialogue / Voiceover**: Dialogue lines in quotation marks `\"...\"` with delivery instructions (whisper, natural conversation).
- **Musical Underscore**: Entry timestamp, instrumentation (felt piano, cello, analog synth pad), low-pass background bed.

### Step 7: Synthesize Master Flowing Narrative Paragraph
Synthesize the entire scene into the `ltx_2_3_prompt` field:
- Must be a **single, cohesive, flowing paragraph** (120 to 220 words).
- Follow the sequence: **Setting & Subject -> Main Action -> Prop Interaction -> Camera Movement -> Lighting & Color Science -> Audio & Dialogue**.
- Do not use bullet points or newline breaks inside this string.

### Step 8: Negative Prompt Formulation & Schema Validation
- Group negative tokens into clean categories: `anti_cgi`, `anatomy_and_physics`, `camera_and_artifacts`, `lighting`, `prohibited_elements`.
- Assemble the complete JSON object matching [ltx_scene_prompt_schema.json](./resources/ltx_scene_prompt_schema.json).
- Run the validator script to verify compliance:
  ```bash
  python3 .agents/skills/ltx-video-director/scripts/validate_ltx_prompt.py path/to/scene_prompt.json --extract-prompt
  ```

---

## 3. Output Format Standard

When producing prompts for the user or saving them for ComfyUI Node `267:266`, generate the complete structured JSON:

```json
{
  "scene": {
    "scene_number": 1,
    "title": "...",
    "timecode": "00:00-00:06",
    "duration_seconds": 6,
    "generation_target": "LTX-2.3 via ComfyUI",
    "generation_mode": "T2V",
    "aspect_ratio": "16:9",
    "purpose": "...",
    "emotional_destination": "...",
    "dominant_visual_idea": "...",
    "brand_landing": "..."
  },
  "important_generation_architecture": {
    "reason": "...",
    "generative_boundaries": "...",
    "recommended_method": "Native LTX-2.3 T2V Two-Stage Workflow"
  },
  "continuity": {
    "character": { ... },
    "environment": { ... }
  },
  "spatial_blocking": {
    "foreground": "...",
    "midground": "...",
    "background": "...",
    "camera_relation": "..."
  },
  "action_timeline": [
    { "time": "00:00.0-00:02.0", "action": "..." }
  ],
  "performance": {
    "primary_subject": "...",
    "micro_actions": "...",
    "emotional_tone": "...",
    "forbidden": [ ... ]
  },
  "camera": {
    "camera_type": "...",
    "lens": "...",
    "starting_position": "...",
    "starting_height": "...",
    "ending_height": "...",
    "depth_of_field": "...",
    "focus_priority": "...",
    "movement": { ... },
    "camera_path": { ... },
    "constraints": [ ... ]
  },
  "lighting": {
    "source": "...",
    "quality": "...",
    "temperature": "...",
    "direction": "...",
    "subject_lighting": "...",
    "forbidden": [ ... ]
  },
  "color_and_finish": {
    "style": "...",
    "film_character": "Kodak Vision3 500T",
    "grade": "...",
    "palette": [ ... ],
    "contrast": "...",
    "saturation": "...",
    "grain": "...",
    "halation": "...",
    "texture": "...",
    "avoid": [ ... ]
  },
  "audio": {
    "acoustics_and_ambience": "...",
    "timeline_foley": { ... },
    "dialogue": [ ... ],
    "music": { ... }
  },
  "negative_prompt": {
    "anti_cgi": [ ... ],
    "anatomy_and_physics": [ ... ],
    "camera_and_artifacts": [ ... ],
    "lighting": [ ... ],
    "prohibited_elements": [ ... ]
  },
  "ltx_2_3_prompt": "A single continuous cinematic paragraph combining all elements...",
  "comfyui_direction": {
    "workflow": "...",
    "why_mode": "...",
    "camera_strategy": "...",
    "audio": "...",
    "prompting": "...",
    "render_strategy": { ... }
  },
  "generation_priority": [ ... ],
  "quality_control": {
    "critical_story_test": "...",
    "critical_continuity_test": "...",
    "critical_performance_test": "...",
    "critical_camera_test": "...",
    "failure_conditions": [ ... ]
  }
}
```

---

## 4. Working with Reference Images (Image-to-Video / I2V)

When the user provides a reference image or frames:
1. **Analyze Fixed Geometries**: Extract exact room dimensions, window placement, furniture anchors, character wardrobe colors/fabrics, and lighting direction.
2. **Preserve Anchors**: Set `generation_mode` to `"I2V"`. Direct LTX-2.3 to preserve character facial identity and room geometry while introducing natural movement.
3. **Motion Differential**: Specify only the new delta motion (e.g., character's hand moving, head turning, camera tracking) so the DiT does not regenerate a completely new person or setting.
