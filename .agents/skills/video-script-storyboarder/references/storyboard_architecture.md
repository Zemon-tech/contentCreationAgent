# Storyboard Architecture & Scene-by-Scene Scripting Reference

## Overview
In high-end commercial film and AI video production, a script is not just a block of text—it is a synchronized **Audio-Visual (AV) Blueprint**. Every beat must be time-budgeted down to the exact second, with visual blocking on one axis and acoustic design on the other.

---

## 1. The Industry Standard Two-Column AV Script Format

The standard production script aligns every visual frame with its exact auditory accompaniment:

| Timecode & Scene | Visual (Video Column) | Audio (Acoustic Column) |
| :--- | :--- | :--- |
| **Scene 1 (00:00 - 00:04)**<br>*(4.0s / 121 frames)*<br>**Beat: The Hook** | **EXT. RAIN-SLICKED CITY STREET - DUSK**<br>Tight 50mm tracking shot at knee-height. A commuter's leather oxfords splash through a puddle reflecting flickering fluorescent bus signs. Rapid forward movement.<br>*Camera*: Low 0.3m tracking backwards at 1.4 m/s. | **SFX**: Heavy rubber-on-wet-pavement splash, distant siren howl, muffled traffic wash.<br>**VO (Intimate, unhurried)**: *"We spend our entire day racing to catch up..."*<br>**MUSIC**: Faint, tense analog synth pulse enters at 00:02.0. |
| **Scene 2 (00:04 - 00:09)**<br>*(5.0s / 151 frames)*<br>**Beat: The Friction** | **INT. COFFEE SHOP INTERIOR - CONTINUOUS**<br>Protagonist sits hunched over a laptop, 14 browser tabs visible on screen, phone screen vibrating beside the keyboard. He rubs his temples with thumb and forefinger.<br>*Camera*: 35mm prime, slow 0.3m dolly push-in. | **SFX**: Hissing espresso steam machine, sharp ceramic cup clink, continuous phone vibration buzz on wooden table.<br>**VO**: *"...drowning in tabs, notifications, and noise."* |

---

## 2. Anatomy of a Production Storyboard Card

Each scene in the storyboard represents an autonomous shot designed for seamless execution in video diffusion models like LTX-2.3:

```
┌────────────────────────────────────────────────────────┐
│ 1. HEADER: Scene Number, Title, Timecode, Duration    │
├────────────────────────────────────────────────────────┤
│ 2. DRAMATIC BEAT: Hook / Agitation / Pivot / Flow / End│
├────────────────────────────────────────────────────────┤
│ 3. SPATIAL BLOCKING: FG / MG / BG Physical Anchors     │
├────────────────────────────────────────────────────────┤
│ 4. CAMERA CHOREOGRAPHY: Lens, Starting Height, Move    │
├────────────────────────────────────────────────────────┤
│ 5. LIGHTING & COLOR: Kelvin, Motivated Source, LUT     │
├────────────────────────────────────────────────────────┤
│ 6. PERFORMANCE PHYSICS: Concrete micro-gestures        │
├────────────────────────────────────────────────────────┤
│ 7. MULTI-TRACK AUDIO: Acoustics, Foley, VO, Music      │
├────────────────────────────────────────────────────────┤
│ 8. POST COMPOSITING: Vector overlays, UI, Brand Cards  │
└────────────────────────────────────────────────────────┘
```

### Key Fields Defined:
- **Spatial Blocking**: Exact positions of subjects and room geometry. Ensures spatial consistency across scenes.
- **Camera Choreography**: Explicit focal lengths (e.g. 35mm, 50mm, 85mm), starting heights (e.g. 1.1m, 1.4m), and physical speeds (e.g. 0.15 m/s).
- **Lighting & Color**: Authentic motivated source (e.g. north window, tungsten lamp), Kelvin balance, and film stock (e.g. Kodak Portra 400, Vision3 500T).
- **Post Compositing Separation**: Strictly separates live-action footage from 2D motion graphics, brand logos, and UI dashboards.

---

## 3. Commercial Timing & Scene Count Budgeting

| Target Runtime | Ideal Scene Count | Typical Scene Durations | Target Platforms |
| :--- | :--- | :--- | :--- |
| **15-Second Bumper** | 3 Scenes | Scene 1: 3.0s (Hook)<br>Scene 2: 7.0s (Product Core)<br>Scene 3: 5.0s (Payoff & CTA) | TikTok, Instagram Reels, YouTube Non-Skip Bumpers |
| **30-Second Commercial** | 5–6 Scenes | Scene 1: 3.5s (Hook)<br>Scene 2: 5.5s (Friction)<br>Scene 3: 6.0s (The Catalyst)<br>Scene 4: 7.0s (Flow State)<br>Scene 5: 5.0s (Resolution)<br>Scene 6: 3.0s (Brand Card) | Broadcast TV, YouTube Pre-Roll, Meta Feeds, LinkedIn Hero |
| **60-Second Brand Anthem** | 7–9 Scenes | Scenes 1–2: 12.0s (The Human Tension)<br>Scenes 3–4: 16.0s (The Turning Point)<br>Scenes 5–6: 18.0s (The Transformation)<br>Scenes 7–8: 10.0s (The Human Life Payoff)<br>Scene 9: 4.0s (Clean Brand Manifesto) | Website Hero, Product Launch Keynotes, Super Bowl, Cinema Ads |

---

## 4. The "Golden Rule of Continuity" Across Scenes

When writing a multi-scene ad campaign:
1. **The Hero Identity Must Stay Fixed**: State the exact age, ethnicity, facial features, hair styling, and wardrobe materials across every scene description.
2. **Prop Persistence**: If a character holds a brass mechanical pencil or wears a titanium watch in Scene 1, it must be explicitly carried through subsequent scenes.
3. **Lighting Direction Logic**: If morning daylight enters from the left in Scene 1, it must not randomly switch to evening tungsten from the right in Scene 2 unless an explicit time jump is narrated.
