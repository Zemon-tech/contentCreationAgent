# MiniMax H3 Prompt Syntax & Multimodal Modes

MiniMax H3 understands five distinct operational generation modes:
1. **T2VA**: Text-to-Video with Audio
2. **I2VA**: Image-to-Video with Audio (First Frame)
3. **FL2VA**: First-and-Last-Frame Video with Audio (Interpolation)
4. **L2VA**: Last-Frame Video with Audio (Reverse Convergence)
5. **Ref2VA**: Full-Reference Multimodal Video Generation (Cross-Asset Re-Targeting)

---

## 1. The Five Generation Modes

### 1.1 T2VA (Text-to-Video with Audio)
- **Concept**: Builds a complete audiovisual timeline directly from text description.
- **Instruction Header**: None. Begins immediately with the three core blocks.
- **Syntax**:
  ```text
  integrated_multimodal_description: [Shot 1] ...

  overall_soundscape: ...

  non_diegetic_music: ...
  ```

### 1.2 I2VA (Image-to-Video with Audio)
- **Concept**: `<Picture 1>` serves as the actual first frame of the video at 0.00 seconds.
- **Instruction Header**: **Must appear on line 1 verbatim**:
  ```text
  For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
  ```
- **Timeline Structure**: **First-frame anchor → Action onset → Continuous development → Result or reaction**.
- **Syntax**:
  ```text
  For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

  integrated_multimodal_description: [Shot 1] Live-action, cinematic, the scene begins from <Picture 1>...

  overall_soundscape: ...

  non_diegetic_music: ...
  ```

### 1.3 FL2VA (First-and-Last-Frame Video with Audio)
- **Concept**: `Picture 1` is the opening frame (0.00s) and `Picture 2` is the final frame ($S.SS$s).
- **Instruction Header**: **Must appear on line 1 verbatim**:
  ```text
  How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
  ```
  *(where $N$ is the final shot number and $S.SS$ is the video duration formatted to exactly two decimal places).*
- **Timeline Structure**: **First-frame state → Observable intermediate changes → Progressively narrowing differences → Last-frame landing**.
- **Rule**: FL2VA favors a single continuous shot to allow the diffusion transformer to interpolate smoothly.

### 1.4 L2VA (Last-Frame Video with Audio)
- **Concept**: `<Picture 1>` anchors only the final moment at $S.SS$ seconds.
- **Instruction Header**: **Must appear on line 1 verbatim**:
  ```text
  How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
  ```
- **Timeline Structure**: **Plausible preceding state → Explicit action path → Gradual convergence in final shot → Last-frame landing**.

### 1.5 Ref2VA (Full-Reference Multimodal Generation)
- **Concept**: The most advanced mode. Re-targets content across images, video clips, and audio tracks.
- **Reference Labels**:
  - `<Subject N>`: Reusable visible content (character, environment, object, costume, style).
  - `<Picture N>`: Concrete target frame or storyboard anchor.
  - `<Video N>`: Whole-video structural or temporal source (e.g. source of an edit or camera move).
  - `<Audio N>`: Standalone audio asset or enabled reference video audio track.
- **Six-Section Schema Order**:
  1. `subject_definitions`: Defines referenced content and labels.
  2. `summary`: `[task_type] ...` (e.g. `[reference generation + audio reference]`).
  3. `retention_analysis`: Records `fully_preserved`, `partially_preserved`, `attribute_transfer`, or `weak_reference`. For audio: `fully_copy`, `partially_copy`, `reference`, `weak_reference`.
  4. `detailed_description`: Shot-by-shot playback description with labels embedded.
  5. `overall_soundscape`: Ambient sound and Foley summary.
  6. `non_diegetic_music`: Audience-only background music score.

---

## 2. Shared Core Field Grammar

### 2.1 `integrated_multimodal_description`
- **Shot Indexing**:
  - `[Shot 1]` starts the opening shot and **never has a timestamp**.
  - Subsequent shots **must include an explicit cut timestamp**:
    `[Shot 2] At 00:03.500, the camera cuts to...`
- **Style Announcement**: First sentence after `[Shot 1]` announces visual style:
  `[Shot 1] Live-action, cinematic, captured in 35mm format, a medium shot frames...`
- **Camera Movement Vocabulary**:
  Always express camera motion as **Motion Type + Amplitude + Speed** embedded naturally in the sentence:
  - Motion Types: `Zoom In/Out`, `Push In/Pull Out`, `Pan Left/Right`, `Truck Left/Right`, `Tilt Up/Down`, `Pedestal Up/Down`, `Arc Shot`, `Tracking Shot`, `Static Shot`, `Shake Slightly/Strongly`, `POV`, `Roll Clockwise/Counterclockwise`.
  - Amplitudes: `with small amplitude`, `with large amplitude`.
  - Speeds: `at slow speed`, `at fast speed`.
  - Example: *"The camera pushes in with small amplitude at slow speed toward the architect's hand."*

### 2.2 Speakers, Dialogue, and Singing
- **Speaker IDs**:
  - Spoken sources use stable IDs: `(S1)`, `(S2)`.
  - Multiple speakers talking simultaneously: `(S1,S2)`.
  - Keep the same ID across cuts. Characters who do not speak receive no ID.
- **Dialogue Tags `<d>`**:
  - Enclose only spoken words and language tag inside `<d>[Language] ...</d>`.
  - Example:
    `The founder with a measured, calm voice (S1) says: <d>[English] Run your business as a system.</d>`
  - Preserve original punctuation and capitalization verbatim.
- **Off-Screen Voiceover**:
  - Use exact phrasing: `says in an off-screen voiceover: <d>[Language] ...</d> while his lips remain completely closed.`
- **Dialogue Crossing Cuts**:
  - Use `<scenetrans>` at the junction point in both shots and state: *"continues seamlessly across the cut"*.
- **Truncated Speech**:
  - Use `<cutoff>` when dialogue is intentionally interrupted by the video end.

### 2.3 `overall_soundscape`
- 1–4 English sentences in one continuous paragraph.
- Covers room acoustics, room tone, environmental weather, physical impact Foley, and non-verbal human breath.
- **Do not repeat dialogue or singing here** (they belong in `<d>` in the timeline).
- If total silence is required, write `N/A`.

### 2.4 `non_diegetic_music`
- 1–3 English sentences.
- Describes score audible only to the audience (not heard by in-world characters).
- Dictate instrumentation, tempo, rhythm, and volume decay (e.g. *"Sparse felt piano at a slow tempo, joined by warm sustained cello notes that slowly diminish into silence"*).
- **Never use abstract emotional adjectives** like "hopeful", "mysterious", or "dramatic". Use concrete musical descriptors.
- If no background music is needed, write `N/A`.
