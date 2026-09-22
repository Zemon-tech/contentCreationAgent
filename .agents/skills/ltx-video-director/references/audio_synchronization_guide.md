# Audio Synchronization & Sound Design Guide for LTX-2.3

## Introduction
One of the defining innovations of **LTX-2.3** is its native **joint audio-visual latent diffusion engine**. Unlike other video models that require secondary post-generation audio pipelines, LTX-2.3 generates synchronized video and multi-track audio latents in a single pass.

---

## 1. The Four Layers of LTX-2.3 Sound Design

To achieve production-grade sound, prompts should systematically define four audio layers:

```
┌────────────────────────────────────────────────────────┐
│ 1. Acoustic Space & Room Tone (Reverb, Ambience, Hiss) │
├────────────────────────────────────────────────────────┤
│ 2. Synchronized Foley & Contact Sound (Actions, Steps) │
├────────────────────────────────────────────────────────┤
│ 3. Dialogue & Vocal Delivery (Intelligible / Murmurs)  │
├────────────────────────────────────────────────────────┤
│ 4. Musical Bed & Underscore (Instrumentation, Emotion) │
└────────────────────────────────────────────────────────┘
```

---

## 2. Layer 1: Acoustic Space & Room Tone

Every space has an acoustic signature (impulse response). Explicitly define the environment acoustics:

| Environment | Acoustic Characteristics | Prompt Syntax Example |
| :--- | :--- | :--- |
| **Domestic Living Room** | Dry, warm, sound-absorbent (carpets, soft furniture), low reverberation. | *"Acoustics: dry, intimate domestic room tone with subtle refrigerator hum and distant outdoor breeze."* |
| **Cathedral / Concrete Hall** | Long 3.5s decayed reverberation, cavernous slapback echo. | *"Acoustics: vast wet stone cathedral reverb with lingering cavernous slapback."* |
| **Corporate Glass Office** | Bright, reflective, hard surface flutter echo, HVAC airflow. | *"Acoustics: clean modern office interior with subtle air-conditioning white noise and glass reflections."* |
| **Wet City Street** | Diffuse exterior street noise, distant traffic wash, tire spray on wet asphalt. | *"Acoustics: open rainy city street ambience with wet tire whooshes and distant rumbling traffic."* |

---

## 3. Layer 2: Synchronized Foley & Contact Sound

Tie physical interactions in your visual timeline directly to audio cues with timestamp precision:

### Timing Foley with Visual Beats
```json
"audio": {
  "00:00.0 - 00:02.0": ["soft fabric rustle as character shifts weight", "quiet shoe contact on hardwood"],
  "00:02.0 - 00:03.5": ["light ceramic clink of coffee mug placed on wooden desk", "subtle inhalation of breath"],
  "00:03.5 - 00:05.0": ["gentle child laugh", "creak of leather sofa springs"],
  "00:05.0 - 00:07.0": ["soft footsteps moving away across carpet", "door latch clicking quietly shut"]
}
```

### Foley Best Practices
- **Material Pairs**: State the two materials in contact (e.g. *"ceramic mug on bare oak wood"*, *"rubber sneaker soles on wet asphalt"*, *"wool coat sleeve brushing against cotton sofa"*).
- **Physical Weight**: Describe the impact force (*"gentle placement"*, *"heavy thud"*, *"delicate finger tap"*).

---

## 4. Layer 3: Dialogue, Voiceover & Vocal Performance

LTX-2.3's Gemma 3 encoder parses spoken lines enclosed in quotation marks and pairs them with facial lip motion latents:

### Dialogue Rules
1. **Enclose Spoken Lines in Quotes**: Always put the exact dialogue inside `\"...\"`.
2. **Specify Vocal Cadence & Delivery**:
   - *Delivery tone*: *"very soft, intimate conversational whisper, unhurried pacing"*
   - *Intelligibility*: *"clear, articulate spoken voice"* or *"soft natural child chatter, words indistinct and organic"*.
3. **Dialogue vs. Voiceover (VO)**:
   - **In-scene Dialogue**: Character's lips must move in sync.
   - **Voiceover**: Character's lips remain closed; audio plays over ambient scene sound.

---

## 5. Layer 4: Musical Underscore & Dynamic Progression

Music must not overpower scene foley. Use musical beds that complement narrative emotional beats:

- **Entry Point**: Always specify the timestamp when music enters (e.g., *"Subtle acoustic cello and felt piano chord enter softly at 00:04.5"*).
- **Instrumentation**: Organic instruments (felt piano, cello, acoustic guitar, warm analog synthesizer pads) yield cleaner AI audio latents than dense orchestral climaxes or distorted percussion.
- **Mix Balance**: Specify that music is an *"intimate, low-pass background bed sitting cleanly under room tone and voice"*.
