# Lighting, Film Stocks, LUTs & Color Grading Guide for LTX-2.3

## Introduction
Achieving a true cinematic look in **LTX-2.3** requires moving beyond generic terms like *"cinematic lighting"*. You must specify **motivated light sources, color temperatures in Kelvin, contrast ratios, film stock chemistry, and LUT (Look-Up Table) color responses**.

---

## 1. Motivated Lighting Architecture

In cinema, all lighting is **motivated**—it originates from an identifiable physical source in the scene.

### Key Components of Cinematic Lighting
1. **Key Light (Primary Illuminator)**:
   - *Soft diffused*: Large north-facing window, 8x8 diffusion silk, diffused china ball.
   - *Hard directional*: Direct midday sun, bare tungsten filament bulb, harsh spotlight.
2. **Fill Light (Contrast Controller)**:
   - *Negative Fill*: Black flags absorbing ambient bounce to deepen shadow side (creates dramatic chiaroscuro / 4:1 to 8:1 contrast ratio).
   - *Soft Ambient Fill*: Subtle unbleached muslin bounce providing clean shadow detail without washing out blacks (2:1 commercial contrast ratio).
3. **Backlight / Hairlight / Rim**:
   - Separates the subject from the background.
   - *Warm edge hairlight*: 2800K kicker grazing hair and shoulders.
   - *Cool atmospheric backlight*: 5600K rim from an exterior window.
4. **Practicals (In-World Light Fixtures)**:
   - Desk lamps, candles, fluorescent ceiling tubes, laptop screen spill, vehicle headlights, street sodium-vapor lamps.

### Color Temperature Cheat Sheet (Kelvin)

| Kelvin (K) | Source Description | Visual Mood / Atmosphere |
| :--- | :--- | :--- |
| **1800K - 2200K** | Candlelight, match flame, campfire | Intimate, primal, romantic, vulnerable |
| **2700K - 3000K** | Warm domestic incandescent tungsten bulb | Cozy, nostalgic, domestic comfort, safe |
| **3200K** | Standard film tungsten studio lighting | Warm baseline Hollywood studio interior |
| **4000K - 4500K** | Cool white fluorescent, moonlight bounce | Clinical, corporate, eerie, suspenseful |
| **5600K** | Pure midday sun, HMI daylight lights | Crisp, modern, energetic, neutral reality |
| **6500K - 7500K** | Overcast sky, open shade, blue hour dusk | Melancholy, moody, contemplative, cold |

---

## 2. Film Stock Emulation & Chemical Characteristics

LTX-2.3 has ingested vast archives of celluloid film and digital sensor footage. Specifying exact film stocks triggers specific color science, contrast curves, and grain structures:

### Legendary Film Stocks for LTX-2.3 Prompts

1. **Kodak Vision3 500T (5219)**:
   - *Aesthetic*: The gold standard of modern motion picture cinema.
   - *Characteristics*: Rich shadow latitude, clean warm skin tones, characteristic gentle amber-red halation around specular highlights, organic 35mm fine grain.
   - *Best for*: Night scenes, dramatic interiors, tungsten-lit dialogues.

2. **Kodak Portra 400**:
   - *Aesthetic*: High-fashion editorial and candid human lifestyle realism.
   - *Characteristics*: Flattering, creamy skin tones, pastel color rendition, smooth highlight roll-off, gentle S-curve contrast.
   - *Best for*: Human-centric scenes, emotional family drama, fashion/lifestyle commercials.

3. **Kodak Vision3 250D (5207)**:
   - *Aesthetic*: High-fidelity daylight cinema.
   - *Characteristics*: Vivid but natural greens and sky blues, neutral gray scale, medium contrast, crisp fine-grain texture.
   - *Best for*: Daytime exteriors, car chases, architectural walk-throughs.

4. **Fuji Eterna 500**:
   - *Aesthetic*: Indie cinema, European arthouse, subtle nostalgia.
   - *Characteristics*: Desaturated, muted color saturation, soft pastel green/cyan undertones, low contrast, gentle dreamy shadow roll-off.
   - *Best for*: Melancholic drama, period pieces, poetic atmospheric narratives.

5. **Kodak Tri-X 400 / Ilford HP5 Plus**:
   - *Aesthetic*: Noir black & white photography and cinema.
   - *Characteristics*: Deep velvety blacks, striking micro-contrast, prominent silver-halide grain structure, timeless texture.
   - *Best for*: Noir thrillers, historical retrospectives, high-art drama.

---

## 3. Cinematic LUTs & Color Grading Profiles

Specify the grading palette and LUT look directly in your prompt:

| LUT / Grade Profile | Color Characteristics | Contrast & Highlights | Recommended Palette |
| :--- | :--- | :--- | :--- |
| **Kodak 2383 Print Stock LUT** | Deep rich blacks, warm skin tones, cyan-leaning shadows, gentle highlight compression. | Medium-high contrast, organic roll-off | Amber, teal shadows, natural skin, charcoal |
| **Nordic Noir / Scandi Desaturation** | Cool slate gray, desaturated greens, muted earth tones, pale skin rendering. | Low saturation, neutral midtones | Slate blue, graphite, cool olive, bone white |
| **Warm Editorial Portra Grade** | Honey highlights, warm beige, soft terracotta, delicate skin highlights, restrained saturation. | Gentle S-curve, lifted blacks | Cream, caramel, warm taupe, charcoal, olive |
| **Bleach Bypass (Silver Retention)** | Hyper-textured grit, washed-out color saturation, deep intense shadows, extreme micro-contrast. | High contrast, stark highlights | Silver-gray, desaturated khaki, rust, deep black |
| **Cyberpunk / Neon Noir Bi-Color** | Split-tone color contrast (hot magenta/amber key vs deep cyan/cobalt rim light). | High contrast, glowing neon blooms | Cyber cyan (#00f0ff), electric magenta, wet asphalt black |

---

## 4. Layering, Graining, Halation & Micro-Textures

To destroy the "smooth plastic AI look", dictate tactile physical textures:

- **Film Grain Layering**:
  - *"Fine 35mm organic film grain with subtle gate weave and natural optical density fluctuations."*
  - Avoid digital noise or pixelated compression noise.
- **Optical Halation**:
  - *"Mild red-orange photonic halation blooming softly around the high-contrast window frame and specular light reflections."*
- **Surface Micro-Textures**:
  - *"Tactile realism: observable skin pores, natural dermal imperfections, fine loose cotton fibers on the rolled shirt sleeves, worn matte patina on the wooden desk, and microscopic dust particles floating in the sunbeam."*
- **Highlight Roll-Off**:
  - *"Soft optical highlight roll-off preventing digital sensor clipping, preserving detailed texture inside the bright window blinds."*
