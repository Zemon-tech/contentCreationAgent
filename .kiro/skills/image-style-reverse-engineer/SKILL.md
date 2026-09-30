---
name: image-style-reverse-engineer
description: >-
  Reverse-engineer any uploaded/reference image into reusable style DNA (aesthetics, lighting, optics, color science, textures, themes, composition) stripped of source subject/identity, then emit validated JSON image prompts for Higgsfield Soul, Flux, SDXL, and Midjourney recreation.
---

# Image Style Reverse-Engineer & JSON Prompt Generator

This skill teaches the agent how to act as a **Visual Forensics Director + Prompt Engineer**: inspect any provided image, decode *how it was made* (not *what it shows*), save a transferable `style_profile`, then generate new images in the same style with a different subject via a validated JSON prompt.

Use this skill when the user: uploads an image and asks to copy/match/extract its style, says "same style as this", "reverse engineer", "image to prompt", "style reference", "recreate this aesthetic", or wants a JSON image prompt built from a reference.

Higgsfield-equivalent mental model: **Soul preset + image-reference + Soul ID separation**. Higgsfield Soul / Soul 2.0 works as: pick a curated preset (lighting + color + grain + lens feel), optionally pass an image as style/composition reference, lock identity separately via Soul ID. This skill replicates that logic in prompt form: `style_profile` = preset, `subject` = Soul ID slot, `composition_geometry` = reference-image lock.

---

## 1. Quick Reference & Core Resources

Before analyzing, load as needed:

- **18-Dimension Forensics Framework**: [reverse_engineering_method.md](./references/reverse_engineering_method.md) — the full inspection checklist (subject strip, optics, lighting, color, texture, era, psychology).
- **Higgsfield Soul Mapping**: [higgsfield_soul_mapping.md](./references/higgsfield_soul_mapping.md) — how Soul presets, image-reference mode, Soul ID, and Midjourney `--sref/--cref/describe` + CLIP-Interrogator map to this skill's JSON.
- **Lighting & Texture Taxonomy**: [lighting_texture_taxonomy.md](./references/lighting_texture_taxonomy.md) — Kelvin table, contrast ratios, film stocks, grain/halation, fabric/material micro-texture vocabulary.
- **JSON Schema**: [image_prompt_schema.json](./resources/image_prompt_schema.json)
- **Style Vocabulary**: [style_vocabulary.json](./resources/style_vocabulary.json) — controlled terms for medium, lens, light, film, palette, texture, era, mood. Always prefer these terms.
- **Validator**: [validate_image_prompt.py](./scripts/validate_image_prompt.py)
- **Example**: [example_editorial_flash.json](./examples/example_editorial_flash.json)

---

## 2. The 6-Step Workflow

```
┌──────────────────────────────────────────────────────┐
│ 1. Intake & Separation (style vs subject)            │
├──────────────────────────────────────────────────────┤
│ 2. 18-Dimension Visual Forensics (see reference)     │
├──────────────────────────────────────────────────────┤
│ 3. Thought-Process Reconstruction (why it works)     │
├──────────────────────────────────────────────────────┤
│ 4. Style Profile Synthesis (transferable DNA)        │
├──────────────────────────────────────────────────────┤
│ 5. JSON Prompt Generation (new subject + same style) │
├──────────────────────────────────────────────────────┤
│ 6. Negative Prompt + Validation                      │
└──────────────────────────────────────────────────────┘
```

### Step 1 — Intake & Separation

1. Confirm at least one reference image is visible (in-context upload) or a local path was given. If none, ask for it. Support 1–3 references; with multiple, extract the *shared* DNA, note divergences.
2. Immediately split:
   - **STRIP (never carry over):** named person/celebrity identity, exact garments logos/text, brand marks, plot event, unique props that are story not style, watermark.
   - **KEEP (style DNA):** medium, composition geometry, lens/DOF, lighting design, color science, texture/finish, atmosphere, era/cultural codes, rendering traits, information density.
3. Ask the single most load-bearing question if ambiguous: *"What new subject should I place in this style?"* Default if unanswered: `[SUBJECT]` placeholder.

### Step 2 — 18-Dimension Visual Forensics

Work through [reverse_engineering_method.md](./references/reverse_engineering_method.md) internally. Minimum viable extraction per image:

1. medium_realism 2. composition_geometry 3. shot_scale 4. optics_lens_dof 5. lighting_source 6. lighting_quality_Kelvin_ratio 7. exposure_dynamic_range 8. palette_hex_5 9. grade_LUT 10. texture_materiality 11. grain_halation_post 12. atmosphere_air 13. background_logic 14. styling_era 15. theme_concept 16. mood_psychology 17. density_negative_space 18. instantaneity_motion

Rules from CLIP-Interrogator / Midjourney `/describe` practice:
- Name concrete optics: `85mm f/1.4`, `35mm f/2.0`, `24mm wide`, aperture + DOF behavior, never just "blurry background".
- Name motivated source + Kelvin + ratio: e.g. `direct on-camera flash ~5500K, hard falloff, 4:1 ratio` (Higgsfield "Subtle Flash" cue) vs `diffuse overcast 5600K wrap, 1.5:1`.
- Name film/imperfection: Kodak Portra 400 / Vision3 500T / 250D / Tri-X / iPhone flash / old-smartphone compression — Higgsfield Soul's realism comes from dust, flash hotspot, grain. Always specify one.
- Palette = 5 HEX + plain names + where saturation lives (skin? single hero accent vs global?).

### Step 3 — Thought-Process Reconstruction

Write 3–5 sentences of *director intent* (stored in `style_profile.director_intent`): why these choices work together. Template:

> "Attention lands [1st/2nd/3rd] because [contrast/focus/color isolation]. [Light choice] + [lens choice] creates [psychology]. [Texture/grade] signals [era/taste class: editorial candid, Y2K digicam, 90s grunge, luxury minimal]. To reuse, keep [3 non-negotiables], vary everything else."

Also output `style_archetype` (e.g. `editorial-flash-candid`, `soft-ecommerce-studio`, `y2k-digicam-night`, `90s-grunge-editorial`, `warm-domestic-documentary`, `high-fashion-overcast`) and closest Higgsfield Soul preset mapping (see reference).

### Step 4 — Style Profile Synthesis

Condense forensics into a reusable `style_profile` object matching the schema. This is the "preset" — subject-free, 120–200 words total across fields. Must include: medium, lens, framing rule (not exact pose), light rig with Kelvin, palette HEX, film stock + grain, 3+ tactile textures, atmosphere, era, density rule.

### Step 5 — JSON Prompt Generation

Assemble full JSON per [image_prompt_schema.json](./resources/image_prompt_schema.json):

- `subject`: the NEW content (from user or `[SUBJECT]` placeholder). Never copy the reference's identity/scene verbatim.
- `master_prompt`: single fluent paragraph 100–180 words, order: **Medium + Subject → Composition/Framing → Optics/DOF → Lighting/Kelvin → Color/Grade → Texture/Grain → Atmosphere/Era/Mood**. Concrete visual language, no bullet points inside the string.
- `higgsfield_soul_block`: `preset_hint` + `style_strength 0.7–0.85` + `reference_mode: style|composition` + short Soul-ready prompt (simple idea + preset, per Soul 2.0 convention).
- `model_variants`: one-line adaptations for `flux/sdxl` (dense descriptive) and `midjourney` (token-dense + `--sref` note + `--style raw` when photoreal).
- `negative_prompt`: grouped `anti_cgi`, `anatomy`, `artifacts`, `lighting`, `prohibited` (identity/logo/text of source).

### Step 6 — Negative Prompt + Validation

1. Always forbid carrying the source identity/text/logo: `same face as reference, exact outfit logo, readable text, watermark`.
2. Run validator:
   ```bash
   python3 .agents/skills/image-style-reverse-engineer/scripts/validate_image_prompt.py path/to/image_prompt.json --extract-prompt
   ```
3. Fix errors, then deliver: (a) 1-paragraph forensics summary + director intent, (b) full JSON, (c) extracted `master_prompt` as copy-paste code block.

---

## 3. Output Format Standard

```json
{
  "meta": { "skill": "image-style-reverse-engineer", "version": "1.0.0", "style_archetype": "editorial-flash-candid" },
  "source_analysis": {
    "medium_realism": "...",
    "composition_geometry": "...",
    "shot_scale": "...",
    "optics": { "lens": "35mm f/2.0", "dof": "...", "focus_priority": "..." },
    "lighting": { "source": "...", "quality": "...", "temperature_kelvin": "5500K", "contrast_ratio": "4:1", "shadow_behavior": "..." },
    "exposure": { "dynamic_range": "...", "highlight_rolloff": "...", "black_point": "..." },
    "palette": ["#...", "#...", "#...", "#...", "#..."],
    "palette_names": ["...", "...", "...", "...", "..."],
    "grade": "...",
    "textures": ["...", "...", "..."],
    "finish": { "film_stock": "Kodak Portra 400", "grain": "...", "halation": "...", "post_traces": ["..."] },
    "atmosphere": "...",
    "background_logic": "...",
    "styling_era": "...",
    "theme_concept": "...",
    "mood_psychology": "...",
    "density_negative_space": "...",
    "instantaneity": "..."
  },
  "style_profile": {
    "name": "...",
    "director_intent": "...",
    "transferable_dna": "...",
    "non_negotiables": ["...", "...", "..."],
    "higgsfield_preset_hint": "Subtle flash",
    "midjourney_cues": ["...", "..."]
  },
  "subject": { "description": "[SUBJECT] or user brief", "preserve_source_identity": false },
  "master_prompt": "Single 100-180 word paragraph ...",
  "higgsfield_soul_block": { "preset_hint": "...", "reference_mode": "style", "style_strength": 0.8, "soul_prompt": "..." },
  "model_variants": { "flux_sdxl": "...", "midjourney": "... --style raw" },
  "negative_prompt": { "anti_cgi": [], "anatomy": [], "artifacts": [], "lighting": [], "prohibited": [] },
  "generation_params": { "aspect_ratio": "4:5", "recommended_models": ["Higgsfield Soul 2.0", "Flux 1.1", "SDXL"] }
}
```

Full normative schema: [image_prompt_schema.json](./resources/image_prompt_schema.json). Validate every output.

---

## 4. Rules & Guardrails

- **Never** reproduce a real person's face, logo, or readable text from the reference. New subject only.
- **Never** output just adjectives ("cinematic, beautiful, 8k"). Every style claim needs a physical anchor (lens, Kelvin, stock, fabric, HEX).
- **Always** separate STYLE (reusable) from SUBJECT (replaceable). If user later says "same style, new subject: X", only swap `subject` + `master_prompt` subject clause.
- **Always** include 5 palette HEX values, one film stock/imperfection, one Kelvin value, one lens spec, 3+ textures — else validation fails.
- Keep `SKILL.md` body lean; details live in `references/`. Prefer controlled vocabulary from `style_vocabulary.json`.
