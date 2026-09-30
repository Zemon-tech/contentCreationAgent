# Higgsfield Soul Mapping (how Higgsfield does style reuse)

Source: Higgsfield Soul / Soul 2.0 docs, higgsfield-ai/skills repo (higgsfield-soul-id, higgsfield-generate), Soul preset gallery.

## 1. Soul's three levers — replicate in JSON

| Soul lever | What it does | Skill JSON equivalent |
|---|---|---|
| **Preset (50–80+ styles)** | Curated aesthetic: lighting + color + grain + lens feel. E.g. `Subtle flash`, `Old smartphone`, `Warm ambient`, `Editorial street style`, `Mystique city`, `REALISTIC`, `Y2K`, `EDITORIAL_90S`, `GRUNGE`, `ANIME`. User picks vibe, types simple idea, no prompt engineering. | `style_profile` + `higgsfield_soul_block.preset_hint`. Map extracted DNA to nearest preset (list below). |
| **Image reference** | Text-to-image OR image-as-style/composition reference. Soul interprets input with same realism + style control. | `higgsfield_soul_block.reference_mode`: `style` (keep palette/grain/light only) vs `composition` (also keep geometry/framing). Default `style` to avoid copying subject. |
| **Soul ID** | Trained character (20 photos, ~3 min) locking face/build/presence; reuse across styles. Referenced by slug in prompt. Never drifts. | `subject`: new content slot. Set `preserve_source_identity: false` always, unless user explicitly trains/provides their own identity. Never copy reference face. |

Realism trick: every Soul image bakes camera imperfections — dust, direct-flash hotspot + hard shadow falloff, grain, slight motion softness, lens halation. Always include one imperfection in `finish`.

## 2. Preset-hint mapping (extracted DNA → preset)

- Hard on-camera flash, flat BG, red-eye-ish sharpness, white wall falloff → `Subtle flash`
- Compressed highlights, noisy shadows, slight blur, phone-Flash look → `Old smartphone`
- Golden soft window, creamy skin, fine grain → `Warm ambient`
- 35–50mm, shallow DOF, city bokeh, candid motion → `Editorial street style`
- Teal-night + neon + haze → `Mystique city`
- Desaturated earth + one hyper-saturated accent → `Editorial street style` or `GRUNGE`
- Glossy 3D / surreal candy → `Frutiger Aero` / `GRUNGE` off; note as non-photo medium
- Photoreal neutral → `REALISTIC` / `General`

## 3. Other agents' equivalents (same idea, different names)

- **Midjourney**: `/describe` (image→4 prompt options, re-roll 3–4× for token variety) → keep style tokens, drop subject tokens; `--sref [url]` locks style, `--cref [url]` locks face/character, `--style raw` + real lens (`85mm f/1.4`) for photorealism; oversaturation + plastic skin are the top tells to forbid.
- **CLIP-Interrogator / Promptsera-style tools**: 4 layers — subject / medium (Octane, UE5, impasto, risograph) / lighting (volumetric, rim, god-rays) / camera (`24mm`, `f/1.8`, bokeh, 8k). Use as checklist, not gospel — interrogators hallucinate artists/lenses.
- **PromptPerfect-style optimizers**: reverse prompt ≠ original prompt (generated images contain unprompted details like gaze direction, stains). Same here: output a *reusable* prompt, not a caption claiming to be the original.

## 4. Style-strength discipline

Keep `style_strength 0.7–0.85` (Soul-ID community practice): below 0.7 the style drifts; above 0.85 the new subject can't breathe. When user wants near-copy composition, use `composition` mode + strength 0.85; for new scenes in same vibe, `style` + 0.75.
