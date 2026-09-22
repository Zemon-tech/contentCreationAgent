# Professional Cinematography & Directing Guide for LTX-2.3

## Introduction
Directing video generation in **LTX-2.3** requires the precision of a Director of Photography (DP) and a narrative film director. The 22B Diffusion Transformer responds strongly to **physical staging, spatial blocking, optical physics, and chronological action**, rather than vague emotional or abstract adjectives.

---

## 1. The Three Layers of Spatial Blocking

Every cinematic shot in LTX-2.3 must define three distinct planes of depth:

| Spatial Layer | Role in Composition | Prompting Technique |
| :--- | :--- | :--- |
| **Foreground (FG)** | Context, immersion, occlusion, depth cues | Specify soft, out-of-focus framing elements (e.g., door frame, tea cup edge, rain droplets on pane, edge of shoulder). |
| **Midground (MG)** | The primary dramatic action plane | Place the principal characters, key prop interactions, and primary eye-line. |
| **Background (BG)** | World-building, mood, perspective, scale | Environmental storytelling, motivated light sources (windows, streetlamps), atmospheric haze, soft bokeh roll-off. |

### Rule of Spatial Anchors
When moving characters through space, state their starting coordinates relative to fixed room geometry:
> *"The founder begins crouched on the carpet in the midground next to the low coffee table, with the closed laptop and dark oak desk anchored 2.5 meters behind in the background."*

---

## 2. Lens Selection & Optical Characteristics

Specify exact lens focal lengths to command perspective distortion and field of view:

| Lens / Focal Length | Angle of View | Visual Characteristics | Best Use Case |
| :--- | :--- | :--- | :--- |
| **18mm - 21mm Ultra-Wide** | 100° - 92° | Dramatic environmental immersion, barrel distortion, expansive scale, deep depth of field. | Epic vistas, claustrophobic interiors, architectural dominance. |
| **24mm - 28mm Wide** | 84° - 75° | Environmental context without extreme distortion, natural wide perspective. | Two-shots in domestic rooms, street walking, dynamic tracking. |
| **35mm Cinematic Normal** | 63° | The Hollywood and documentary standard. Natural human eye perspective, balanced proportions. | Conversational scenes, editorial lifestyle realism, grounded character drama. |
| **50mm Standard Prime** | 47° | Zero geometric distortion, true-to-life perspective, medium separation of subject from background. | Character-driven mid-shots, naturalistic portraits. |
| **85mm - 105mm Telephoto** | 28° - 23° | Flattens perspective, compresses background, creamy shallow depth of field (bokeh). | Intimate close-ups, emotional micro-expressions, isolating subject from chaos. |
| **Anamorphic 2.39:1 (35mm/50mm 2x squeeze)** | Widescreen | Oval bokeh, subtle horizontal flare streaks, slight edge barrel roll-off, cinematic letterbox framing. | High-budget cinematic drama, sci-fi, premium narrative films. |

---

## 3. Camera Movement Choreography & Physics

LTX-2.3 handles camera motion best when the movement is **physically grounded** and has an explicit **trajectory, velocity, and terminal destination**.

### The Core Motion Presets
1. **Dolly In / Push-In**:
   - *Prompt syntax*: `"The camera slowly dollys forward on smooth tracks from a medium shot to a tight medium close-up, moving 0.8 meters over 4 seconds, decelerating smoothly as it settles on the subject's face."`
2. **Dolly Out / Pull-Back**:
   - *Prompt syntax*: `"The camera gently pulls backward through an open doorway, gradually revealing the quiet, dimly lit room around the solitary character."`
3. **Lateral Tracking / Trucking**:
   - *Prompt syntax*: `"Camera tracks laterally from left to right at a matching human walking speed of 1.2 m/s, keeping the two characters centered in profile as they walk along the hallway."`
4. **Pedestal / Jib / Crane**:
   - *Prompt syntax*: `"The camera rises vertically on a jib from low knee-height (0.4m) to eye-level (1.6m), maintaining a level horizon as the character stands up."`
5. **Observational Static Hold**:
   - *Prompt syntax*: `"Locked-off tripod static shot with zero camera drift; all motion is internal within the subjects and the gentle breeze fluttering the linen curtains."`
6. **Handheld Organic Breathing**:
   - *Prompt syntax*: `"Subtle documentary handheld camera with natural human weight and organic breathing micro-movements, strictly avoiding rapid shake or artificial digital jitter."`

### Golden Rules for Camera Direction
- **Never stack conflicting movements**: Do not say `"dolly in while orbiting fast and zooming out"`. This causes DiT spatial collapse.
- **Specify Start, Transition, and End**:
  - `00:00 - 00:02`: Static observational hold.
  - `00:02 - 00:05`: Gentle push-in of 0.5m.
  - `00:05 - 00:07`: Settle and hold terminal framing.

---

## 4. Directing Performance, Postures, & Micro-Expressions

Models like LTX-2.3 fail when fed abstract emotional adjectives (*"he is sad"*, *"she feels joyful"*). They succeed when fed **actionable physical biomechanics**:

### The Emotion-to-Physics Translation Matrix

| Abstract Direction (AVOID) | Concrete Physical Performance (USE IN LTX-2.3) |
| :--- | :--- |
| *"He looks exhausted and burned out."* | *"He sits with slumped shoulders, elbows resting heavily on his knees; he rubs his temples with thumb and forefinger, closes his eyes for two seconds, then exhales slowly through parted lips."* |
| *"She is happy and having fun."* | *"A subtle relaxed smile crinkles the outer corners of her eyes; she gives an unhurried, natural nod and tilts her head slightly to the left while listening."* |
| *"They share a deep emotional bond."* | *"The father gently places an open palm on the child's shoulder, leaning his torso down to match the child's eye-line; the child leans their head against his arm in casual familiar trust."* |
| *"He is anxious and suspicious."* | *"His eyes dart quickly toward the closed door in the background; his jaw muscles tense and flex; his right hand unconsciously drums two fingers against the steering wheel."* |

### Forbidden Performance Trappings
Always include a negative constraint or strict negative prompt against:
- No stock footage smiling or plastic grins.
- No direct eye contact with the camera lens (unless breaking the 4th wall).
- No exaggerated pantomime melodrama or theatrical arm flailing.
- No freeze-frame mannequin poses.
