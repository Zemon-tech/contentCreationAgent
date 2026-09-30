# MiniMax H3 Native Stereo Audio & Sound Design Guide

MiniMax H3 generates **native stereo audio simultaneously with video latents** using its dedicated `H3-AudioVAE` (`minimax_h3_audio_vae_fp32.safetensors`). This document provides comprehensive direction for generating synchronized speech, Foley, room tone, and score.

---

## 1. The Four Sound Layers in MiniMax H3

```
┌────────────────────────────────────────────────────────────────────────┐
│                        MiniMax H3 Audio Output                         │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 1: Diegetic Spoken Dialogue & Singing (<d> inside timeline)       │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Synchronized Timeline Foley (footsteps, impacts, rustle)      │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 3: overall_soundscape (room tone, acoustics, environmental bed)  │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 4: non_diegetic_music (audience-only background score)           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Spoken Dialogue & Vocal Directing

MiniMax H3 uses strict token syntax to bind spoken dialogue to physical characters:

### 2.1 Speaker IDs
- Assign sequential speaker IDs based on order of speech: `(S1)`, `(S2)`.
- When multiple characters speak or chant together, use compound IDs: `(S1,S2)`.
- **Character Consistency**: Once a character is labeled `(S1)`, maintain `(S1)` across all subsequent shots.
- Characters who never speak must **not** receive a speaker ID.

### 2.2 Dialogue Syntax `<d>[Language] ...</d>`
- Spoken lines must appear inside `<d>` tags with an explicit language prefix:
  ```text
  The architect with a quiet, authoritative voice (S1) points to the blueprint and says: <d>[English] This is where the structural load transfers.</d>
  ```
- **Verbatim Rule**: Never paraphrase or summarize dialogue inside `<d>`. Preserve exact words and punctuation marks (`.`, `?`, `!`).
- **Descriptive Attribution**: Place all vocal performance notes (timbre, tone, cadence, whisper, projection) **outside** the `<d>` block.

### 2.3 Off-Screen Voiceover (VO)
When narration or thoughts occur without on-screen mouth movement, you **must explicitly direct lip closure**:
```text
The founder (S1) says in an off-screen voiceover: <d>[English] We had to tear down the old architecture first.</d> while his lips remain completely closed.
```

### 2.4 Dialogue Crossing Cuts (`<scenetrans>`)
If an unbroken line of dialogue continues while the camera cuts to another angle:
```text
[Shot 1] The engineer (S1) turns toward the terminal and says: <d>[English] Once the command is executed, <scenetrans></d>
[Shot 2] At 00:03.200, the camera cuts to a tight macro of the server indicator lights while the engineer's voice continues seamlessly across the cut: <d>[English] <scenetrans> the entire cluster switches to primary backup.</d>
```

### 2.5 Truncated Dialogue (`<cutoff>`)
If a sentence is deliberately cut off by an explosion, sudden cut, or scene ending:
```text
The pilot (S1) shouts urgently: <d>[English] Pull up, we're losing altit—<cutoff></d>
```

---

## 3. Directing `overall_soundscape`

The `overall_soundscape` block defines the physical acoustic world:
- **Length**: 1 to 4 English sentences in a single paragraph.
- **Content**:
  - Room acoustics (dry studio, echoing concrete warehouse, intimate domestic space).
  - Ambient environmental sounds (subtle air ventilation hum, distant traffic rumble, rain tapping on glass).
  - Contact Foley (creaking leather chair, ceramic mug landing on oak, key clink).
  - Non-verbal human respiration (quiet exhalation, steady breath, soft intake of air).
- **Exclusion Rule**: **Do not repeat spoken dialogue lines or non-diegetic music here.**
- **Example**:
  ```text
  overall_soundscape: Quiet domestic room tone with a faint ventilation hum underneath. Rain taps rhythmically against double-glazed window glass while a ceramic cup makes a dull clink against the oiled walnut desk.
  ```

---

## 4. Directing `non_diegetic_music`

The `non_diegetic_music` block controls the background score audible only to the audience:
- **Length**: 1 to 3 English sentences.
- **Rule of Concrete Musicology**: Describe **instrumentation, tempo, rhythm, and dynamic volume progression**. Never rely on vague emotion words like "epic", "uplifting", or "sad".
- **Dynamic Level Direction**: Specify volume decay so music does not compete with dialogue:
  - *Good*: *"Sparse felt-piano chords at a slow tempo, accompanied by low sustained cello notes holding a steady, subdued presence at -14dB before fading out cleanly."*
  - *Bad*: *"Dramatic inspiring music that makes you feel excited."*
- **Silence**: When no background music is desired, write:
  ```text
  non_diegetic_music: N/A
  ```

---

## 5. Audio-Visual Mixing Checklist

Before generating an H3 prompt, audit these four checkpoints:
1. Are all spoken lines wrapped in `<d>[Language] ...</d>`?
2. Does every speaking subject have a matching ID like `(S1)`?
3. If voiceover is used, is lip closure explicitly enforced?
4. Are `overall_soundscape` and `non_diegetic_music` formatted as clean standalone paragraphs separated by blank lines?
