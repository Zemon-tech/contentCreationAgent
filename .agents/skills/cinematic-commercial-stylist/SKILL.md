---
name: cinematic-commercial-stylist
description: >-
  Direct and style LTX-2.3 text-to-video scenes using reverse-engineered aesthetics from world-class commercial campaigns
  (such as ChatGPT/OpenAI by Miles Jay, Heinz Wimbledon, and Uber Eats). Specializes in camera optics, motivated lighting ratios,
  Kelvin temperatures, Kodak film stocks, color isolation, and tactile micro-textures.
---

# Cinematic Commercial Stylist for LTX-2.3

This skill teaches the agent how to implement the exact visual language, lighting science, camera optics, and film textures found in top-tier cinematic commercials (such as **ChatGPT by Miles Jay on 35mm film**, **Heinz "It Has to Be Heinz" Wimbledon**, and **Uber Eats "When You've Busy'd Enough"**) into **LTX-2.3 scene prompts**.

---

## 1. Quick Reference & Core Resources

- **Style Profiles**: [commercial_style_profiles.md](./references/commercial_style_profiles.md) (Domestic Slat, Transit Intimacy, Athletic Sanctuary, Subdued Crowd, Urban Pastoral)
- **16-Dimension Reverse-Engineering Framework**: [image_reverse_engineering_framework.md](./references/image_reverse_engineering_framework.md)
- **Aesthetic Profiles Database**: [commercial_aesthetic_profiles.json](./resources/commercial_aesthetic_profiles.json)
- **Production Prompts**:
  - [prompt_chatgpt_kitchen_golden_slat.json](./examples/prompt_chatgpt_kitchen_golden_slat.json) (ChatGPT Kitchen 35mm Portra 400 look)
  - [prompt_heinz_wimbledon_focal_pop.json](./examples/prompt_heinz_wimbledon_focal_pop.json) (Heinz Wimbledon 85mm telephoto red pop)
- **Style Injector Tool**: [apply_commercial_style.py](./scripts/apply_commercial_style.py)

---

## 2. The 5 Reverse-Engineered Commercial Aesthetics

### 1. "Domestic Golden Slat" (ChatGPT Kitchen)
- **Keywords**: *35mm Cooke S4 prime, direct 3400K morning sunlight through wooden venetian blinds, 45-degree angle linear shadow slats, glazed terracotta tile, stainless steel stockpot, Kodak Portra 400 warmth, lifted sepia shadows, fine organic grain, delicate rising steam ribbons*.
- **When to use**: Domestic sanctuary, cooking, creative flow, morning calm, personal craftsmanship.

### 2. "Moody Transit Intimacy" (ChatGPT Public Bus)
- **Keywords**: *28mm wide cinema prime, eye-level two-shot framed symmetrically between bus headrests, 5000K afternoon window daylight grazing braided hair, cool transit moquette indigo fabric, warm honey skin highlights, Kodak Vision3 500T 35mm stock, subtle cyan shadow undertone, intimate shared laughter*.
- **When to use**: Friendship, travel, peer collaboration, urban transit, authentic vulnerability.

### 3. "Quiet Athletic Sanctuary" (ChatGPT High-Ceiling Workout)
- **Keywords**: *32mm wide prime lens, elevated 1.5m angle, deep focus f/5.6, diffuse 5000K daylight through white linen window drapes, cognac leather sofa, plush carpet, knurled chrome dumbbell glints, Kodak Tri-X/Portra hybrid aesthetic, isolated hyper-saturated gym orange accent*.
- **When to use**: Solitary discipline, mental endurance, fitness, interior focus, high-ceiling architectural living.

### 4. "Subdued English Crowd & Focal Pop" (Heinz Wimbledon)
- **Keywords**: *85mm telephoto prime lens, heavy optical background compression, flat facial proportions, locked-off tripod hold, diffuse 5400K high-altitude overcast daylight, gentle 1.8:1 contrast, lifted shadows under cap visors, Kodak Vision3 250D 35mm stock, muted sand and ecru crowd neutrals, isolated razor-sharp primary red Heinz bottle*.
- **When to use**: Sports events, outdoor crowds, comic food obsession, telephoto isolation, British summer aesthetics.

### 5. "Urban Pastoral Whimsy" (Uber Eats Rooftop Beekeeper)
- **Keywords**: *35mm cinema lens, symmetrical 1.4m eye-level wide environmental portrait, diffuse 5600K overcast London daylight, wrap-around soft ambient light, low 1.5:1 commercial contrast, weathered pine beehives, coarse white canvas beekeeper suit, terracotta pots, vivid brand Kelly green accent*.
- **When to use**: Quirky hobbies, rooftop gardens, food delivery rewards, open-air urban charm.

---

## 3. The 7-Step Style Application Workflow

When asked to give a scene the aesthetic of these commercials:

1. **Select the Matching Profile**: Choose one of the 5 archetypes based on environment and mood.
2. **Lock Lens & Focal Length**: Set exact optical focal length (28mm wide for intimate vehicles, 35mm for domestic flow, 85mm for compressed crowds).
3. **Establish Motivated Light & Kelvin**: Define in-world light source (e.g. 3400K direct window slats, 5400K overcast wrap).
4. **Enforce Color Separation**: Pick a neutral canvas (terracotta, slate, ecru) and introduce a single saturated hero color.
5. **Specify Celluloid Film Stock & Grain**: Name Kodak Portra 400, Vision3 500T, or Vision3 250D with fine 35mm organic grain and lifted shadows.
6. **Dictate Physical Micro-Textures**: Include real skin pores, steam, fabric weaves (wool knit, canvas, denim), and optical halation.
7. **Run the Validator**: Audit the generated scene prompt using:
   ```bash
   python3 .agents/skills/ltx-video-director/scripts/validate_ltx_prompt.py path/to/scene.json --extract-prompt
   ```

---

## 4. CLI Helper

To automatically inject any of these styles into an existing LTX-2.3 JSON scene prompt:
```bash
python3 .agents/skills/cinematic-commercial-stylist/scripts/apply_commercial_style.py scene.json --style domestic_golden_slat
```
