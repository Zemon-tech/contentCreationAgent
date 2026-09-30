---
name: video-script-storyboarder
description: >-
  Create high-converting commercial video scripts and scene-by-scene storyboards inspired by top campaigns
  from Apple, Perplexity, OpenAI, Uber, and KeilHQ. Specializes in product discovery, audience psychology,
  narrative pacing (Hook-Hold-Payoff), and seamless 1-to-1 handoff to the LTX-2.3 prompt generation skill.
---

# Commercial Video Script & Storyboard Creator (LTX-2.3 Pipeline)

This skill teaches the agent how to act as a **Creative Director and Commercial Storyboard Artist**, creating world-class video ad campaigns that translate any product, audience, and use case into an unforgettable scene-by-scene narrative script optimized for generative video models like **LTX-2.3**.

---

## 1. Quick Reference & Core Documentation

Review the dedicated guides when planning or writing campaigns:
- **Campaign Archetypes & Psychology**: [ad_creative_frameworks.md](./references/ad_creative_frameworks.md) (Apple, Perplexity, OpenAI, Uber, KeilHQ models)
- **Storyboard Architecture & AV Scripts**: [storyboard_architecture.md](./references/storyboard_architecture.md) (Two-Column AV scripts, timing budgets, scene anatomy)
- **LTX-2.3 Pipeline Integration**: [ltx_integration_handoff.md](./references/ltx_integration_handoff.md) (Field-by-field mapping to `ltx-video-director`)
- **JSON Schema**: [storyboard_template_schema.json](./resources/storyboard_template_schema.json)
- **Archetype Library**: [ad_archetypes_library.json](./resources/ad_archetypes_library.json)
- **Production Examples**:
  - [storyboard_perplexity_style_contrast.json](./examples/storyboard_perplexity_style_contrast.json) (30s Perplexity-style cognitive contrast ad)
  - [storyboard_apple_style_productivity.json](./examples/storyboard_apple_style_productivity.json) (30s Apple 'Underdogs' style team commercial)

---

## 2. The 6-Step Commercial Directing Procedure

When tasked with creating a commercial script and storyboard, execute this 6-step sequence:

```
┌────────────────────────────────────────────────────────┐
│ 1. Product & Audience Discovery (The 4 Strategic Roots)│
├────────────────────────────────────────────────────────┤
│ 2. Campaign Archetype Selection (Apple/Perplexity/etc) │
├────────────────────────────────────────────────────────┤
│ 3. Pacing & Timecode Budgeting (15s / 30s / 60s)       │
├────────────────────────────────────────────────────────┤
│ 4. Two-Column AV Script Writing (Video vs. Audio)      │
├────────────────────────────────────────────────────────┤
│ 5. Scene-by-Scene Storyboard Generation                │
├────────────────────────────────────────────────────────┤
│ 6. Automated LTX-2.3 Handoff & Validation              │
└────────────────────────────────────────────────────────┘
```

### Step 1: Product & Audience Discovery
Answer the four strategic foundation questions:
1. **The True Villain**: What is the unseen emotional enemy? (e.g. Not "slow spreadsheets", but *"dread of missing Friday evening with family"*).
2. **The Hero Character**: Age, profession, physical wardrobe textures, natural human habits.
3. **The Magic Moment ("Aha!")**: The physical, visual demonstration of the product's genius (the laptop closing, the single command typed, the sudden relief).
4. **The Emotional Destination**: How the audience must feel as the screen fades to black (empowered, peaceful, awed, hungry for clarity).

### Step 2: Campaign Archetype Selection
Choose the creative model that best fits the product's unique advantage:
- **Apple "The Underdogs"**: Collaborative friction turning into kinetic teamwork. Fast, witty dialogue, naturalistic sound, product as the calm catalyst.
- **Perplexity "Radical Contrast"**: High sensory overload (20 open tabs, flashing popups, exhaustion) abruptly cutting to clean, serene cognitive clarity.
- **OpenAI "Poetic Manifesto"**: Awe, human imagination, philosophical voiceover, expansive cinematography, visual metaphors of thought becoming reality.
- **Uber Eats "Relatable Absurdity"**: Deadpan humor, literal misdirection, self-deprecating truth, grounded everyday relief.
- **KeilHQ "Work Ends. Life Continues."**: Anti-grind B2B realism. Work handles itself quietly in the background while the character physically leaves the desk behind.

### Step 3: Pacing & Timecode Budgeting
Structure the script into the **Hook-Hold-Payoff** timing engine:
- **15s Bumper**: Scene 1 (0-3s: Hook) -> Scene 2 (3-10s: Product Pivot) -> Scene 3 (10-15s: Payoff & CTA).
- **30s Hero Commercial**:
  - Scene 1 (00:00–00:04): **The Hook** (Stop the scroll, in media res).
  - Scene 2 (00:04–00:09): **The Friction / Agitation** (The relatable villain).
  - Scene 3 (00:09–00:16): **The Pivot / Magic Moment** (Product enters as a natural tool).
  - Scene 4 (00:16–00:24): **The Flow State** (Life and work harmonized).
  - Scene 5 (00:24–00:30): **The Resolution & Brand Card** (Emotional landing, quiet confidence).

### Step 4: Two-Column AV Script Writing
Map visual blocking strictly against acoustic design:
- **Visual Column**: Setting, character blocking (FG, MG, BG), camera lens (e.g. 35mm, 50mm), camera trajectory, lighting Kelvin temperature.
- **Audio Column**: Room tone acoustics, timestamped foley cues (typing, mug clinks, chair rolling), dialogue/VO in quotes, musical progression.

### Step 5: Scene-by-Scene Storyboard Generation
Package the commercial into a structured JSON conforming to [storyboard_template_schema.json](./resources/storyboard_template_schema.json).
Ensure every scene contains:
- `spatial_blocking` (Foreground, Midground, Background)
- `action_timeline` with sub-second chronological progression
- `performance` (observable physical cues, breath, posture, no stock grins)
- `camera` (lens, starting height, speed, constraints)
- `lighting` (motivated source, Kelvin temperature, mood)
- `audio` (acoustics, foley, VO, music cue)
- `ltx_prompt_preview` (a single continuous flowing paragraph ready for LTX-2.3)

### Step 6: Automated LTX-2.3 Handoff & Validation
1. To preview the two-column AV script:
   ```bash
   python3 .agents/skills/video-script-storyboarder/scripts/export_storyboard_to_ltx.py path/to/storyboard.json --script
   ```
2. To export any scene (e.g. Scene 2) into a production LTX-2.3 scene JSON file:
   ```bash
   python3 .agents/skills/video-script-storyboarder/scripts/export_storyboard_to_ltx.py path/to/storyboard.json --scene 2 --output scene_2_ltx.json
   ```
3. Validate the exported scene using `ltx-video-director`:
   ```bash
   python3 .agents/skills/ltx-video-director/scripts/validate_ltx_prompt.py scene_2_ltx.json --extract-prompt
   ```
4. Drop the extracted prompt straight into ComfyUI Node `267:266` and queue render!

---

## 3. Working with Client Briefs

When a user provides a brief such as:
> *"I have an AI customer support automation tool for e-commerce brands, make a 30s ad script..."*

1. **Conduct Product Breakdown**:
   - Hero: Stressed e-commerce support lead at midnight on Black Friday.
   - Villain: Endless unresolved support tickets, ringing alarms, frantic caffeine buzz.
   - Magic Moment: Turning on the automated resolution engine; thousands of tickets clear gracefully in real time.
   - Emotional Destination: Deep breath of relief, stepping away from the desk to sleep peacefully.
2. **Select Archetype**: Perplexity-style contrast or Apple-style team momentum.
3. **Draft the Storyboard**: 5 distinct scenes with exact timecodes.
4. **Generate the LTX Prompts**: Deliver the scenes ready for ComfyUI video generation.
