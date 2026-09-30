---
name: minimax-h3-director
description: >-
  Direct professional text-to-video-with-audio (T2VA), image-to-video (I2VA), first-and-last-frame (FL2VA),
  and full-reference (Ref2VA) generation for the MiniMax H3 omni-modal model.
  Synthesizes production-grade structured JSON and native MiniMax H3 prompt blocks implementing
  Higgsfield Cinema Studio optical rigor, sensor profiles, kinetic camera physics, motivated lighting,
  synchronized multi-track stereo sound (dialogue, foley, room tone, non-diegetic score), and ComfyUI workflow alignment.
---

# MiniMax H3 Video Director & Omni-Modal Scene Prompt Generator

This skill teaches the agent how to act as a **Director of Photography (DP), Director, and Sound Designer** for the **MiniMax H3 Omni-Modal Model** running in **ComfyUI** (with Qwen3-VL 32B text/vision encoder, H3-VisualVAE, H3-AudioVAE, H3-Omni-Transformer, optional 8-step Turbo LoRA, and native stereo sound generation as mapped in `video_minimax_h3_t2v.json`).

When the user asks to generate a video prompt for MiniMax H3, direct an H3 scene, build multi-modal reference prompts (I2VA, FL2VA, Ref2VA), or inject prompts into Node `140:131` in ComfyUI, use this skill.

---

## 1. Quick Reference & Core Resources

Before generating prompts, consult the dedicated references:
- **Model Architecture & Latent Math**: [model_specifications.md](./references/model_specifications.md)
- **ComfyUI Workflow Architecture (`video_minimax_h3_t2v.json`)**: [comfyui_workflow_architecture.md](./references/comfyui_workflow_architecture.md)
- **Prompt Syntax & Generation Modes (T2VA/I2VA/FL2VA/L2VA/Ref2VA)**: [prompt_syntax_and_modes.md](./references/prompt_syntax_and_modes.md)
- **Higgsfield Cinematography & Optics (Hero Frame First)**: [higgsfield_cinematography_and_optics.md](./references/higgsfield_cinematography_and_optics.md)
- **Native Stereo Audio & Dialogue Design**: [native_stereo_audio_guide.md](./references/native_stereo_audio_guide.md)
- **JSON Schema**: [minimax_h3_scene_prompt_schema.json](./resources/minimax_h3_scene_prompt_schema.json)
- **Preset Libraries**:
  - [camera_movement_presets.json](./resources/camera_movement_presets.json)
  - [audio_and_soundscape_presets.json](./resources/audio_and_soundscape_presets.json)

---

## 2. Core Pillars of MiniMax H3 Directing

MiniMax H3 represents a generational leap over legacy video generators:
1. **Omni-Modal Pretraining**: Understands unified contexts across Text, Image, Video, and Audio.
2. **Native Synchronized Stereo Audio**: Generates synchronized speech, Foley, room tone, and background music in a single joint pass without third-party audio post-processing.
3. **Structured Prompt Grammar**: Ingests strict sections:
   - `integrated_multimodal_description` (multi-shot visual and diegetic timeline)
   - `overall_soundscape` (ambient acoustics, non-verbal human sounds, Foley)
   - `non_diegetic_music` (tempo, instrumentation, rhythm of audience-only score)
   - Verbatim dialogue with speaker tags: `(S1)` and `<d>[Language] spoken text</d>`
4. **Higgsfield "Hero Frame First" Discipline**:
   - Lock composition, optics, sensor format (Full-frame, Super 35, ARRI LF), lens character (Cooke S4/i painterly roll-off, Zeiss Supreme architectural sharpness, Panavision C-Series anamorphic), and motivated lighting before generating motion.
   - Enforce tactile micro-textures (authentic skin pores, fine hair strands, linen weave) to eliminate airbrushed plastic AI artifacts.
5. **ComfyUI 17-Frame Latent Chunking**:
   - Framerate is locked at **24 FPS**.
   - Video duration in seconds $a$ maps through the workflow math formula:
     `max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17`
     guaranteeing exact latent chunk alignment for the H3 diffusion transformer.

---

## 3. The 8-Step Directing Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Mode Selection & Dramatic Purpose (T2VA/I2VA/FL2VA/Ref2VA)  │
├─────────────────────────────────────────────────────────────────┤
│ 2. Higgsfield Optical Rig & Hero Frame Anchors (Lens/Sensor/DoF)│
├─────────────────────────────────────────────────────────────────┤
│ 3. Spatial Blocking & Plane Separation (FG / MG / BG)          │
├─────────────────────────────────────────────────────────────────┤
│ 4. Multi-Shot Chronological Action Timeline ([Shot 1], cuts)   │
├─────────────────────────────────────────────────────────────────┤
│ 5. Motivated Lighting Design & Color Science (Kelvin/Stock)    │
├─────────────────────────────────────────────────────────────────┤
│ 6. Multi-Track Native Stereo Sound Design (Dialogue/Foley/BGM) │
├─────────────────────────────────────────────────────────────────┤
│ 7. Synthesize Master MiniMax H3 Native Prompt Blocks           │
├─────────────────────────────────────────────────────────────────┤
│ 8. Negative Prompt Hygiene & ComfyUI Schema Validation         │
└─────────────────────────────────────────────────────────────────┘
```

### Step 1: Mode Selection & Dramatic Purpose
- Determine generation mode:
  - **T2VA**: Pure text-to-video with synchronized native audio.
  - **I2VA**: Image-to-video starting from `<Picture 1>` at 0.00s.
  - **FL2VA**: Interpolation between opening Picture 1 and ending Picture 2.
  - **L2VA**: Converging from an inferred opening to landing on Picture 1.
  - **Ref2VA**: Multi-modal reference across `<Subject N>`, `<Picture N>`, `<Video N>`, `<Audio N>`.
- Set duration $a$ (seconds), calculate exact ComfyUI frame count, and establish aspect ratio (16:9, 9:16, 2.39:1).

### Step 2: Higgsfield Optical Rig & Hero Frame Anchors
- Specify camera body & sensor profile (e.g. *ARRI Alexa Mini LF large-format*, *RED V-Raptor 8K*).
- Define lens character:
  - *Cooke S4/i Prime*: Warm skin tones, silky bokeh, organic fall-off.
  - *Zeiss Supreme Prime*: Ultra-sharp modern contrast, pristine architectural geometry.
  - *Panavision C-Series 2x Anamorphic*: Subtle oval bokeh, horizontal blue streak, cinematic widescreen flares.
- Set focal length & aperture (e.g. *35mm f/2.0*, *50mm f/1.8*, *85mm f/1.4*).

### Step 3: Spatial Blocking & Plane Separation
- Anchor the frame in 3 distinct depth layers:
  - **Foreground (FG)**: Blurred framing elements, glass reflections, edge silhouettes.
  - **Midground (MG)**: Primary subject interaction and focal plane.
  - **Background (BG)**: Architectural perspective, motivated light sources, environmental depth.
- Lock character identity anchors: exact age, ethnicity, facial geometry, specific clothing fabric (e.g. *ribbed slub cotton*, *worn selvedge denim*), hair texture, and physical props.

### Step 4: Multi-Shot Chronological Action Timeline
- H3 supports **native multi-shot modeling in a single prompt pass**!
- `[Shot 1]` establishes opening composition and has **no timestamp**.
- Subsequent shots use strictly increasing cut timestamps within the duration:
  `[Shot 2] At 00:03.500, the camera cuts to...`
- Describe camera motion using MiniMax syntax:
  **Motion Type** (`Push In`, `Pull Out`, `Pan Left/Right`, `Truck Left/Right`, `Tilt Up/Down`, `Pedestal Up/Down`, `Arc Shot`, `Tracking Shot`, `Static Shot`, `Roll`) + **Amplitude** (`with small/large amplitude`) + **Speed** (`at slow/fast speed`).
- Express physical biomechanics rather than internal feelings (e.g. *"her fingers curl tightly around the handle, knuckles blanching"* instead of *"she feels stressed"*).

### Step 5: Motivated Lighting Design & Color Science
- Motivate every light source by visible in-world fixtures or natural sources (practical tungsten incandescent lamp, north-facing frosted window, neon storefront).
- Specify Kelvin color temperature (e.g. *2700K warm tungsten vs 5600K overcast daylight*).
- Define color palette, contrast ratio (e.g. *2:1 low-contrast commercial studio*), and film stock emulation (*Kodak Portra 400*, *Kodak Vision3 500T*, *Fuji Eterna*).
- Insist on tactile micro-textures: real skin pores, peach fuzz, fabric weave, worn wood grain, authentic dust motes.

### Step 6: Multi-Track Native Stereo Sound Design
- **Dialogue & Voice**:
  - Assign stable speaker IDs `(S1)`, `(S2)`.
  - Put spoken words inside `<d>[Language] ...</d>`.
  - For off-screen voiceover, specify: `says in an off-screen voiceover: <d>[English] ...</d> while his lips remain completely closed.`
  - For dialogue crossing cuts, use `<scenetrans>`.
- **overall_soundscape**: 1–4 sentences describing ambient room tone, acoustic environment, contact Foley, and non-verbal breath.
- **non_diegetic_music**: 1–3 sentences specifying tempo, instrumentation, and dynamic volume progression of audience-only background music.

### Step 7: Synthesize Master MiniMax H3 Prompt
Synthesize the complete, production-ready H3 prompt:
- For **I2VA**:
  ```text
  For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

  integrated_multimodal_description: [Shot 1] ...

  overall_soundscape: ...

  non_diegetic_music: ...
  ```
- For **T2VA**:
  ```text
  integrated_multimodal_description: [Shot 1] ...

  overall_soundscape: ...

  non_diegetic_music: ...
  ```
- For **FL2VA**:
  ```text
  How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.

  integrated_multimodal_description: [Shot 1] ...

  overall_soundscape: ...

  non_diegetic_music: ...
  ```

### Step 8: Negative Prompt Hygiene & Schema Validation
- Group negative prompt tokens into clean categories: `anti_cgi`, `anatomy_and_physics`, `camera_and_artifacts`, `lighting`, `prohibited_elements`.
- Save the structured JSON matching [minimax_h3_scene_prompt_schema.json](./resources/minimax_h3_scene_prompt_schema.json).
- Run the validator CLI:
  ```bash
  python3 .agents/skills/minimax-h3-director/scripts/validate_minimax_h3_prompt.py path/to/scene_prompt.json --extract-prompt
  ```

---

## 4. Output Format Standard (ComfyUI Node `140:131`)

When producing scene prompts for the user, output the complete structured JSON:

```json
{
  "scene": {
    "scene_number": 1,
    "title": "SCENE TITLE",
    "timecode": "00:00-00:07",
    "duration_seconds": 7.0,
    "generation_target": "MiniMax H3 via ComfyUI (video_minimax_h3_t2v.json)",
    "generation_mode": "T2VA",
    "aspect_ratio": "16:9",
    "fps": 24,
    "frame_count_comfyui": 175,
    "purpose": "...",
    "emotional_destination": "...",
    "dominant_visual_idea": "...",
    "brand_landing": "..."
  },
  "important_generation_architecture": {
    "reason": "MiniMax H3 omni-modal diffusion generates native synchronized stereo audio and multi-shot video.",
    "generative_boundaries": "All continuous live action, facial expressions, and native Foley/dialogue handled in diffusion. 2D vector logos and end cards in post.",
    "recommended_method": "Native MiniMax H3 T2VA / I2VA Workflow via ComfyUI Node 140:131."
  },
  "higgsfield_optical_rig": {
    "camera_body": "ARRI Alexa Mini LF Large Format Cinema Camera",
    "lens_profile": "Cooke S4/i Prime 50mm T2.0",
    "sensor_format": "Large Format 36x24mm",
    "focal_length": "50mm",
    "aperture": "f/2.0 shallow depth of field with creamy circular bokeh",
    "shutter_angle": "180° cinematic motion blur",
    "iso_emulation": "800 EI clean shadow latitude"
  },
  "continuity": {
    "character": {
      "identity": "...",
      "wardrobe": "...",
      "performance": "..."
    },
    "environment": {
      "location": "...",
      "props": "..."
    }
  },
  "spatial_blocking": {
    "foreground": "...",
    "midground": "...",
    "background": "...",
    "camera_relation": "..."
  },
  "action_timeline": [
    { "time": "00:00.0-00:03.5", "shot": 1, "action": "..." },
    { "time": "00:03.5-00:07.0", "shot": 2, "action": "..." }
  ],
  "performance": {
    "primary_subject": "...",
    "micro_actions": "...",
    "emotional_tone": "...",
    "forbidden": [
      "no plastic airbrushed skin",
      "no robotic stiff acting",
      "no looking into lens unless scripted"
    ]
  },
  "camera": {
    "movement_preset": "Slow Dolly Push-In with Subtle Parallax",
    "motion_type": "Push In",
    "amplitude": "with small amplitude",
    "speed": "at slow speed",
    "camera_path": "Smooth forward push traveling 0.5m along the central axis",
    "constraints": ["no erratic shake", "no digital zoom", "smooth kinetic deceleration"]
  },
  "lighting": {
    "source": "Motivated practical daylight through frosted industrial window",
    "quality": "Soft diffused wrap-around lighting",
    "temperature": "5600K clean natural daylight",
    "direction": "Side-key at 45 degrees",
    "subject_lighting": "Clean corneal catchlights, natural cheekbone roll-off",
    "forbidden": ["no harsh unmotivated neon", "no flat TV lighting"]
  },
  "color_and_finish": {
    "style": "Cinematic Commercial Realism",
    "film_character": "Kodak Portra 400 clean commercial emulation",
    "grade": "Balanced naturalistic highlights, rich neutral shadows",
    "palette": ["#1E293B", "#334155", "#F8FAFC"],
    "grain": "Ultra-fine organic 35mm grain texture",
    "texture": "Visible skin pores, authentic linen weave, matte wood grain",
    "avoid": ["plastic skin", "CGI look", "oversaturated digital colors"]
  },
  "audio": {
    "speakers": [
      {
        "id": "(S1)",
        "character": "Lead Founder",
        "voice_character": "Warm, measured, resonant baritone, natural conversational cadence"
      }
    ],
    "dialogue": [
      {
        "shot": 1,
        "speaker_id": "(S1)",
        "line": "We didn't need more tools. We needed a system.",
        "language": "English"
      }
    ],
    "timeline_foley": [
      "Soft linen rustle as shoulder turns",
      "Muted porcelain cup placement on oiled oak table at 00:02.1"
    ],
    "overall_soundscape": "Low domestic interior room tone with distant rain tapping lightly against windowpanes. Quiet ceramic contact and gentle fabric movement.",
    "non_diegetic_music": "Sparse felt-piano chords at a slow tempo, joined by sustained low cello notes that gently fade out at the conclusion."
  },
  "negative_prompt": {
    "anti_cgi": ["CGI", "3D render", "Unreal Engine", "video game", "plastic skin", "airbrushed face"],
    "anatomy_and_physics": ["deformed fingers", "mutated hands", "floating objects", "morphing"],
    "camera_and_artifacts": ["erratic camera shake", "whip pan", "sensor flicker", "digital compression artifacts"],
    "lighting": ["blown-out highlights", "crushed murky shadows", "unmotivated studio flare"],
    "prohibited_elements": ["watermarks", "subtitles unless scripted", "vector logos inside diffusion"]
  },
  "minimax_h3_prompt": "integrated_multimodal_description: [Shot 1] Live-action, cinematic, captured on an ARRI Alexa Mini LF with a 50mm Cooke S4/i prime at f/2.0... [Shot 2] At 00:03.500, the camera cuts to... The founder (S1) speaks with a warm, measured baritone: <d>[English] We didn't need more tools. We needed a system.</d>\\n\\noverall_soundscape: Low domestic interior room tone with distant rain tapping lightly against windowpanes. Quiet ceramic contact and gentle fabric movement.\\n\\nnon_diegetic_music: Sparse felt-piano chords at a slow tempo, joined by sustained low cello notes that gently fade out at the conclusion.",
  "comfyui_direction": {
    "workflow": "video_minimax_h3_t2v.json",
    "target_node": "140:131 (MiniMaxH3ImageToVideo)",
    "frame_rate": 24,
    "resolution": "16:9 (1280x720 or native 2K)",
    "sampling": "res_multistep with simple scheduler (20 steps base or 8 steps with turbo LoRA Node 140:134)"
  },
  "generation_priority": [
    "1. Grounded human acting and authentic facial micro-expressions.",
    "2. Strict adherence to MiniMax H3 multimodal prompt structure and dialogue tags.",
    "3. Higgsfield optical realism (Cooke bokeh, 180° shutter blur, tactile textures).",
    "4. Synchronized multi-track stereo audio and clear room acoustics."
  ],
  "quality_control": {
    "critical_story_test": "Does the shot communicate its dramatic purpose within the allotted seconds?",
    "critical_audio_test": "Are dialogue lines verbatim inside <d> and matched to speaker IDs?",
    "critical_camera_test": "Is camera motion defined with Motion Type, Amplitude, and Speed?",
    "failure_conditions": [
      "plastic airbrushed skin",
      "dialogue placed outside <d> tags",
      "erratic camera shake",
      "missing overall_soundscape or non_diegetic_music blocks"
    ]
  }
}
```
