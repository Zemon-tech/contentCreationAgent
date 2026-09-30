# The 16-Dimension Reverse-Engineering Framework for AI Video

## Overview
To translate any reference photograph, commercial still, or brand campaign image into an LTX-2.3 generative prompt, you must decode all 16 dimensions of visual craft.

---

## 1. The 16 Dimensions Decoded

| # | Dimension | Reverse-Engineering Questions | LTX-2.3 Translation Target |
| :--- | :--- | :--- | :--- |
| **1** | **Subject & Composition** | What is the focal anchor? How are planes (FG, MG, BG) layered? Where is the eye-line? | `spatial_blocking` & `scene.dominant_visual_idea` |
| **2** | **Camera & Optics** | What lens was used? (Wide 24mm, Normal 35mm, Telephoto 85mm). What is the focal plane and DOF? | `camera.lens`, `camera.depth_of_field`, `camera.starting_height` |
| **3** | **Lighting Direction & Quality** | Where is the motivated source? Is it hard sun, soft overcast, or window slats? What Kelvin temp? | `lighting.source`, `lighting.temperature`, `lighting.direction` |
| **4** | **Exposure & Dynamic Range** | Are blacks lifted (filmic) or deep? How do highlights roll off? Any clipping? | `color_and_finish.contrast`, `lighting.subject_lighting` |
| **5** | **Color Palette** | What are the dominant, secondary, and accent colors? Where is saturation concentrated? | `color_and_finish.palette` (HEX & descriptive names) |
| **6** | **Color Grading & LUT** | Is there a warm/cool split? Teal/cyan shadows? Warm amber highlights? | `color_and_finish.grade` (Kodak 2383, Portra 400 curve) |
| **7** | **Tonal Hierarchy** | What does the eye see 1st, 2nd, and 3rd? How is attention steered? | Visual sequence in `ltx_2_3_prompt` |
| **8** | **Focus & Sharpness** | Is micro-contrast punchy or soft? Is grain organic 35mm or digital noise? | `color_and_finish.grain`, `camera.focus_priority` |
| **9** | **Texture & Materiality** | How do skin pores, fabric weaves (wool, cotton), and surfaces reflect light? | `color_and_finish.texture` |
| **10**| **Atmosphere & Air Density** | Is there visible steam, sunbeam dust motes, haze, or rain reflections? | Environmental physical descriptors in `action_timeline` |
| **11**| **Background Design** | Does the background tell a story? Is it geometric blinds, crowd, or brick? | `spatial_blocking.background`, `continuity.environment` |
| **12**| **Geometry & Shapes** | Horizontal slats, vertical window frames, or symmetrical framing? | Compositional lines in `camera.camera_path` |
| **13**| **Styling & Art Direction** | What era or cultural world? (Vintage tennis, French domestic, urban transit). | `continuity.character.wardrobe`, `performance` |
| **14**| **Aesthetic / Visual Spectrum**| Is it raw vs polished, natural vs artificial, soft vs punchy? | Master tone definition in `scene.purpose` |
| **15**| **Conceptual Intent** | Why were these decisions made? (Obsession over decorum, domestic sanctuary). | `scene.emotional_destination` |
| **16**| **Visual Psychology** | What emotion does the viewer feel? (Intimacy, vulnerability, playful indulgence). | `performance.emotional_tone`, `audio.music` |

---

## 2. Synthesis Order for LTX-2.3

When constructing a prompt from an image analysis, synthesize in this exact order:

```
[1. Intent & Mood] ➔ [2. Subject & Gesture] ➔ [3. Optics & Lens] ➔ [4. Motivated Light & Kelvin] ➔ [5. Film Stock & Palette] ➔ [6. Tactile Textures] ➔ [7. Movement Physics & Audio]
```

This ensures the Gemma 3 text encoder understands the causal physical reality of the frame before the DiT generates temporal motion.
