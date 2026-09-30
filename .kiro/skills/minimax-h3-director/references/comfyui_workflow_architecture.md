# ComfyUI Workflow Architecture (`video_minimax_h3_t2v.json`)

This document maps the complete execution pipeline and node configuration of `video_minimax_h3_t2v.json`.

---

## 1. Node Map & Data Flow

```
[115: ResolutionSelector]
   │
   ├── (width)  ──────────────────────► [140:131: MiniMaxH3ImageToVideo]
   └── (height) ──────────────────────►           ▲
                                                  │
[140:133: PrimitiveFloat (duration)]              │ (prompt text / JSON)
   │                                              │ (length from 140:132)
   └──► [140:132: ComfyMathExpression] ───────────┤
                                                  │ (clip from 140:128)
[140:128: CLIPLoader (Qwen3-VL 32B)] ─────────────┤
                                                  │ (vae from 140:119)
[140:119: VAELoader (Visual VAE)] ────────────────┘
   │                                              │
   │                                              ▼
   │                                        (latent_image)
   │                                              │
   │                                              ▼
   │                             [140:125: SamplerCustomAdvanced]
   │                                  ▲     ▲     ▲     ▲
   │                                  │     │     │     │
   │         [140:129: RandomNoise] ──┘     │     │     │
   │                                        │     │     │
   │         [140:126: BasicGuider] ────────┘     │     │
   │            ▲                                 │     │
   │            │                                 │     │
   │    [140:135: If/Else Model Switch]           │     │
   │       ├── false: 140:127 (Base UNET)         │     │
   │       └── true:  140:134 (Turbo LoRA)        │     │
   │                                              │     │
   │         [140:123: KSamplerSelect (res_multistep)] ─┘     │
   │                                                    │
   │         [140:124: BasicScheduler (simple)] ────────┘
   │            ▲
   │            ├── steps from [140:136: If/Else Steps Switch]
   │            │      ├── false: 20 steps (140:137)
   │            │      └── true:   8 steps (140:138)
   │            └── model from [140:135]
   │
   ▼
[140:122: VAEDecode (Video)] ◄─── (samples) ── [140:125] ── (samples) ──► [140:121: VAEDecodeAudio]
   │                                                                             ▲
   │ (images)                                                                    │ (vae)
   │                                                         [140:120: VAELoader (Audio VAE)]
   ▼                                                                             │
[140:130: CreateVideo (24 FPS, sRGB, 8-bit)] ◄──────────────── (audio) ──────────┘
   │
   ▼
[92: SaveVideo ("video/MiniMax_H3")]
```

---

## 2. Key Workflow Nodes & Parameters

### Node `140:131`: `MiniMaxH3ImageToVideo`
- **Role**: Primary conditioning node for MiniMax H3.
- **Inputs**:
  - `prompt`: String containing either the structured JSON or the synthesized H3 prompt blocks (`integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`).
  - `width`: Ingested from `ResolutionSelector` (Node `115`).
  - `height`: Ingested from `ResolutionSelector` (Node `115`).
  - `length`: Ingested from `ComfyMathExpression` (Node `140:132`).
  - `clip`: Ingested from `CLIPLoader` (Node `140:128`).
  - `vae`: Ingested from Visual VAE (Node `140:119`).
- **Outputs**: Latent conditioning `[0]` and initial latent image `[1]`.

### Node `115`: `ResolutionSelector`
- **Default**: `16:9 (Widescreen)`
- **Megapixels**: 1 (or scaled up to 2K when running high-VRAM workflows).
- **Multiple**: 32 (ensures dimensions divide cleanly into VAE downsampling patches).

### Node `140:132`: `ComfyMathExpression`
- **Formula**:
  ```python
  max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17
  ```
- **Input `values.a`**: Connected to `PrimitiveFloat` (Node `140:133`), setting the duration in seconds (e.g. `7.0`).
- **Function**: Automatically computes the exact frame count that satisfies the H3 17-frame latent alignment.

### Node `140:139`: `Boolean (Enable Lightning LoRA)`
- **`false` (Default, High-Fidelity Base Mode)**:
  - Model: Node `140:127` (`minimax_h3_fl2va_pruned_int8_convrot.safetensors`).
  - Steps: Node `140:137` = **20 steps**.
  - Best for: Final production renders, subtle micro-expressions, complex lighting and multi-character interaction.
- **`true` (Turbo Acceleration Mode)**:
  - Model: Node `140:134` (`minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`).
  - Steps: Node `140:138` = **8 steps**.
  - Best for: Rapid pre-visualization, camera blocking tests, fast turnaround iterations.

### Node `140:123` & `140:124`: Sampler & Scheduler
- **Sampler**: `res_multistep` (`KSamplerSelect`).
- **Scheduler**: `simple` (`BasicScheduler`, `denoise: 1.0`).
- **Guider**: `BasicGuider` (Node `140:126`).

### Node `140:121` & `140:122`: Dual VAE Decoding
- **Video Decoding** (Node `140:122`): Decodes visual latents using `minimax_h3_video_vae_fp16.safetensors`.
- **Audio Decoding** (Node `140:121`): Decodes stereo audio latents using `minimax_h3_audio_vae_fp32.safetensors`.

### Node `140:130`: `CreateVideo`
- **Frame Rate**: `fps: 24`.
- **Bit Depth**: `bit_depth: 8`.
- **Color Space**: `sRGB`.
- **Inputs**: Joins decoded video images and decoded stereo audio into a single container.

### Node `92`: `SaveVideo`
- **Filename Prefix**: `video/MiniMax_H3`.
- **Codec**: `auto`.

---

## 3. Directorial Recommendations for ComfyUI Operators

1. **Duration Precision**: When writing scripts, always set durations that produce clean frame numbers (e.g., 5.0s, 7.0s, 8.0s).
2. **Audio Volume Normalization**: Because H3 generates audio natively in diffusion, background music description in `non_diegetic_music` must specify dynamics (e.g. *"subtle, low presence at -14dB, decaying to silence"*) to prevent music from drowning out diegetic speech in `<d>`.
3. **Multi-Shot Cuts in a Single Run**: H3 natively cuts between shots when `[Shot 2] At 00:03.500...` is used. Do not split scenes into multiple ComfyUI workflows unless you need completely disconnected locations.
