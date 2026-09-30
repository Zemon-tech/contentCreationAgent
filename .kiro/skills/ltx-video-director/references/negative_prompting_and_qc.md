# Negative Prompting Strategy & Quality Control Guide for LTX-2.3

## Introduction
Negative prompting in **LTX-2.3** operates differently from older models like SD 1.5. Overloading the negative prompt with hundreds of generic words dilutes the attention mechanism in the 22B DiT, causing degraded motion fidelity and prompt bleeding.

---

## 1. Golden Rules of LTX-2.3 Negative Prompting

1. **Keep It Focused & Categorized**: Use targeted, high-signal tokens grouped into distinct failure modes.
2. **Never Contradict Positive Direction**:
   - If your positive prompt asks for *"atmospheric rain and deep shadows"*, do **not** put `"rain, shadows, dark"` in the negative prompt.
3. **Avoid Token Stacking Bloat**: A 30-word categorized negative prompt outperforms a 200-word spam list every time.
4. **Separate Brand/UI Graphics from Diffusion**:
   - Never ask LTX-2.3 to render pixel-perfect vector typography, sharp UI buttons, or corporate logos inside the diffusion pass. Add `"no UI, no software interface, no dashboard, no logo overlay"` in the negative prompt, and composite clean 2D brand graphics in post-production.

---

## 2. Categorized Negative Prompt Bank

### Category 1: Anti-Synthetic / Anti-CGI
```text
video game, console game, 3D render, Unreal Engine, cartoon, anime, illustration, plastic skin, airbrushed, wax figure, oversaturated colors, harsh digital sharpness, CGI
```

### Category 2: Anatomical & Physical Coherence
```text
deformed hands, mutated fingers, extra limbs, fused fingers, warped facial features, unnatural joint bends, rubbery limbs, sliding feet, floating props, object morphing, disappearing objects
```

### Category 3: Camera & Temporal Artifacts
```text
erratic camera shake, wild whip pan, abrupt camera cuts, rapid zoom, floating ungrounded camera, jitter, temporal flicker, motion smear, duplicate ghosting, frame stutter
```

### Category 4: Lighting & Color Defects
```text
blown-out clipped highlights, crushed muddy shadows, artificial HDR glow, harsh unmotivated rim lights, extreme neon wash, muddy color cast, digital sensor noise
```

### Category 5: Stock Footage & Commercial Clichés
```text
stock footage aesthetic, staged commercial smile, corporate video cliché, looking directly at camera, exaggerated pantomime acting, artificial melodramatic posing
```

---

## 3. The 10-Point Pre-Render Quality Control Checklist

Before sending a scene prompt to ComfyUI, audit it against these 10 criteria:

| # | Test | Verification Question | Pass Criteria |
| :--- | :--- | :--- | :--- |
| **1** | **Chronological Flow** | Is the prompt structured in sequential time order from start to finish? | Action progresses forward logically without jumping back and forth. |
| **2** | **Spatial Blocking** | Are subjects, key props, and room anchors fixed in foreground, midground, and background? | Explicit distances and coordinates relative to room features are stated. |
| **3** | **Performance Physics** | Are character emotions described through observable physical actions instead of abstract feelings? | Uses visible cues (pupil dilations, finger grips, posture shifts) instead of "sad/happy". |
| **4** | **Camera Trajectory** | Does the camera have an explicit start height, lens focal length, movement vector, and settled end? | Explicit start/end coordinates (e.g. 1.1m height, 0.5m dolly, 35mm prime). |
| **5** | **Camera Restraint** | Does the camera movement avoid excessive cinematic acrobatics? | Movement is humanly motivated, smooth, and grounded. |
| **6** | **Lighting Motivation** | Is every light source anchored to an in-world source with Kelvin temperature specified? | Identifiable practicals/windows with clear light direction and quality. |
| **7** | **Color & Film Stock** | Is a specific film stock (e.g., Kodak Portra 400, Vision3 500T) or LUT specified? | Defined color palette, contrast curve, and subtle 35mm grain. |
| **8** | **Audio Layering** | Are acoustics, synchronized foley, spoken lines (in quotes), and music entry defined? | Distinct audio timestamps matched to physical contact in the visual timeline. |
| **9** | **Graphic Separation** | Are exact logos, titles, and UI mockups segregated from diffusion into post-compositing? | No expectation of perfect text rendering inside the AI video model. |
| **10** | **Frame Formula** | Does the frame count match `Duration * FPS + 1`? | Math matches ComfyUI latent settings. |
