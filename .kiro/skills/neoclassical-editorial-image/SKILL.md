---
name: neoclassical-editorial-image
description: >-
  Art-direct Contemporary Neoclassical Editorial Collage images from any article,
  topic, idea, headline, metaphor, or brief. Behaves like an editorial art director:
  finds the visual thesis, builds a historical x contemporary metaphor, applies the
  fixed house style (engraving/print, saturated color, black-cream hero, print texture),
  varies composition, adapts syntax per model (general, midjourney, openai, flux, google),
  and emits validated canonical JSON.
---

# Neoclassical Editorial Image — House Art Director

This skill is a **reusable art-direction system**, not a prompt expander.
Style is FIXED. Subject varies. Grammar stays coherent; objects do not repeat.

Use when user: provides article/topic/idea/headline/brief and wants an editorial
image, says "same style", asks for concepts, typography poster, photorealistic
adaptation, concise/detailed prompt, or reference-guided generation.

## 1. Core Resources (load as needed)

- **House style (normative):** [house_style.md](./references/house_style.md) — fixed DNA, non-negotiables, color/texture/material rules.
- **Metaphor engine:** [metaphor_engine.md](./references/metaphor_engine.md) — thesis → concept → metaphor → hero/support/environment.
- **Composition patterns A–G:** [composition_patterns.md](./references/composition_patterns.md)
- **Model adaptation:** [model_adaptation.md](./references/model_adaptation.md) — general/midjourney/openai/flux/google syntax.
- **Research log:** [research.md](./references/research.md)
- **Schema:** [neoclassical_editorial_schema.json](./resources/neoclassical_editorial_schema.json)
- **Vocabulary:** [house_vocabulary.json](./resources/house_vocabulary.json) — prefer these terms.
- **Validator:** [validate_neoeditorial.py](./scripts/validate_neoeditorial.py)
- **Examples:** [examples/](./examples/)

## 2. Workflow (art director, 8 steps)

```
USER IDEA → THESIS → METAPHOR → SUBJECTS → HOUSE STYLE → COMPOSITION → MODEL ADAPT → CANONICAL JSON
```

### Step 1 — Understand the idea
Extract: `source` (what user gave), `topic`, `thesis` (one sentence: "The image is really about ___"),
`abstract_concept`, `image_goal`. If article: identify 3–5 candidate concepts internally,
pick strongest by: conceptual clarity, originality, house-style fit, composition potential,
editorial impact, text-independence.

### Step 2 — Visual metaphor (mandatory)
Complete: "The best visual metaphor for that is ___."
Fill `creative_brief.visual_metaphor`, plus `hero_subject`, supporting objects,
environment, and explicit `historical_language` vs `contemporary_language`.
Rule: never illustrate literal words when a stronger metaphor exists.
Weak: "person programming with AI." Strong: "marble figure + computer collaborating
over illuminated blueprint." Avoid clichés: robot-with-laptop, person-working-faster.

### Step 3 — Apply house style (FIXED, do not reinvent)
From [house_style.md](./references/house_style.md):
- Style: Contemporary Neoclassical Editorial Collage (`neoclassical-pop-editorial`)
- DNA: classical language + contemporary subject + surreal juxtaposition +
  engraving/etching + saturated color + black/cream hero + print texture + editorial composition
- Non-negotiables (must all hold or justify exception in `validation.warnings`):
  1. old × new tension 2. strong visual metaphor 3. engraved/illustrated tactile rendering
  4. saturated contemporary color 5. black/cream visual anchor 6. editorial composition
  7. physical print texture
- Color: 1 dominant bg + 1–2 support + 1 high-sat accent + black/cream engraving.
  House HEX: `#087FEA` electric blue, `#0B0C0C` deep ink, `#F3EFE5` warm paper,
  `#F4E900` acid yellow, `#18A8C7` cyan; optional `#FF8A00` `#6A39D7` `#C4CF36` `#D96532` `#253F25`.
  Never use all colors. Hero usually black/cream/gray; environment carries saturation.
- Texture (non-negotiable): cross-hatching, stipple, halftone, paper grain/tooth,
  ink breakup, screen-print misregistration, risograph/xerox distress. Avoid clean digital/CGI.
- Medium: antique engraving, copperplate etching, woodcut, scientific illustration,
  halftone, screen print, risograph, paper collage. NOT glossy CGI / stock / generic cinematic.
- Lighting: directional graphic light, ink shadow masses, paper-white highlights,
  symbolic glow. Deep apparent focus (no auto bokeh/85mm f/1.4 unless perspective needs it).
- Finish: "antique print reproduced through modern editorial screen printing".
- Mood: curious, surreal, playful, sophisticated, provocative, strange, delightful,
  slightly absurd, editorial, culturally literate. Never generic corporate/inspirational/epic/sci-fi.

### Step 4 — Compose (vary, don't repeat)
Pick ONE pattern from [composition_patterns.md](./references/composition_patterns.md):
A. Hero + symbolic object / B. Classical figure + modern tech / C. Object collision /
D. Central subject + small symbols / E. Classical landscape + modern intrusion /
F. Diagrammatic collage / G. Surreal scale shift.
Define foreground/midground/background, asymmetry, negative space, scale surprise.
Hero typically 50–80% but adapt to concept. Grammar consistent; objects never copy-pasted
(statue/blue-bg/laptop/yellow-accent are examples, not defaults).

### Step 5 — Detail calibration (maximum control per word)
- Simple idea → concise art-directed prompt. Complex article → detailed spatial relations.
- Multi-subject → explicit spatial relationships. Reference-match → style+composition spec.
- Midjourney → concise concept seed + style cues (concept first, constraints second, discovery third).
- General → clear natural-language spec. Never bloat.

### Step 6 — Model adaptation (style fixed, syntax varies)
See [model_adaptation.md](./references/model_adaptation.md). Default `target_model="general"`.
- `general`: medium+hero+metaphor+composition+contrast+color+texture+light+mood. No vendor syntax.
- `midjourney`: CONCEPT + STYLE + DETAILS + COMPOSITION + params (`--ar --s --c --no --sref --sw --style raw --v`).
  Short prompts win (official docs). Concept seed, room for discovery/remix.
- `openai` (gpt-image): natural paragraph or labeled scene/subject/details/constraints;
  assign reference roles; state exclusions; no `--` params; `size/quality` in generation_parameters.
- `flux`: Subject+Action+Style+Context, front-loaded, 30–80 words sweet spot, ≤512 tokens,
  HEX as `object is #HEX`, NO negative prompts (put avoid-list in prose if needed).
- `google` (Imagen/Gemini): Subject+Composition+Action+Location+Style; descriptive adjectives;
  quote exact text `"..."`; iterative-friendly.
Record choice in `prompt_strategy.model_specific_strategy`.

### Step 7 — Special modes
- **3 concepts:** 3 DISTINCT metaphors (not recolors), same grammar, separate JSON objects.
- **Typography:** only if requested; exact wording in quotes, hierarchy/location/font/readability in `visual_spec.typography`. Default `typography: "no text, wordless editorial illustration"`.
- **Photorealistic request:** keep conceptual old×new + metaphor + palette; shift `medium`/`rendering_language`
  to photographic source material (e.g. "archival photograph composited with engraved elements, screen-printed finish").
- **Reference image:** extract only useful dimensions (composition/subject/material/light/texture);
  house style stays primary unless user explicitly replaces it. Fill `reference_strategy`.
- **"Same style":** apply house grammar, new subject/composition; don't copy subject/text/objects.

### Step 8 — Emit + validate
Assemble canonical JSON per schema (section 3). Then run:
```bash
python3 .agents/skills/neoclassical-editorial-image/scripts/validate_neoeditorial.py path/to/output.json
```
Fix errors. Deliver: 1-line thesis + metaphor summary, full JSON, copy-paste `prompts.primary`.

## 3. Canonical JSON (ONLY schema — never invent fields)

Required top keys: `meta, creative_brief, art_direction, visual_spec, style_constraints,
reference_strategy, prompt_strategy, prompts, negative_prompt, generation_parameters, validation`.
Full normative types: [neoclassical_editorial_schema.json](./resources/neoclassical_editorial_schema.json).

Minimal skeleton:
```json
{
  "meta": {"schema_version": "1.0", "skill": "neoclassical-editorial-image",
    "style_system": "contemporary-neoclassical-editorial-collage",
    "target_model": "general|midjourney|openai|flux|google",
    "task_type": "text_to_image", "prompt_complexity": "concise|standard|detailed"},
  "creative_brief": {"source": "", "topic": "", "thesis": "", "abstract_concept": "", "visual_metaphor": "", "image_goal": ""},
  "art_direction": {"style_name": "Contemporary Neoclassical Editorial Collage",
    "style_archetype": "neoclassical-pop-editorial", "historical_language": "", "contemporary_language": "",
    "medium": "", "rendering_language": "", "composition_language": "",
    "color_strategy": "", "texture_strategy": "", "mood": ""},
  "visual_spec": {"hero_subject": "", "supporting_elements": [], "environment": "",
    "composition": "", "spatial_relationships": "", "perspective": "", "lighting": "",
    "color_palette": [], "color_hierarchy": "", "materials": [], "textures": [],
    "atmosphere": "", "negative_space": "", "typography": "no text, wordless editorial illustration"},
  "style_constraints": {"non_negotiables": [], "preferred": [], "avoid": []},
  "reference_strategy": {"references_present": false, "reference_roles": [],
    "style_reference": "", "composition_reference": "", "content_reference": "", "reference_strength": null},
  "prompt_strategy": {"complexity": "", "reason": "", "prompt_structure": [], "model_specific_strategy": ""},
  "prompts": {"primary": "", "compact": "", "model_specific": ""},
  "negative_prompt": {"enabled": false, "content": ""},
  "generation_parameters": {"aspect_ratio": "16:9", "width": null, "height": null,
    "resolution": null, "quality": null, "stylization": null, "seed": null, "model_parameters": {}},
  "validation": {"valid": true, "checks": [], "warnings": [], "missing_information": []}
}
```

## 4. Guardrails
- Metaphor, hero, composition, color strategy, texture must be non-empty — else validation fails.
- `color_palette`: 2–5 HEX (at least one house color unless justified).
- No vendor syntax in `general` mode (`--ar`, `--sref`, `::`, `{params}` forbidden).
- FLUX: `negative_prompt.enabled` must be false (FLUX has no negative prompts).
- Typography default wordless; never inject article titles unasked.
- Keep `SKILL.md` lean; details in `references/`. Prefer `house_vocabulary.json` terms.
