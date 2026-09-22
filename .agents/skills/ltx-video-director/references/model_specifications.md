# LTX-2.3 Model Specifications & Architecture Reference

## Overview
**LTX-2.3** (developed by Lightricks) is a state-of-the-art open-weights foundation model for synchronized audio-visual video generation. It is built as a **22-Billion Parameter Diffusion Transformer (DiT)** operating on a unified audio-visual latent representation.

---

## 1. Core Model Specifications

| Parameter | Specification |
| :--- | :--- |
| **Architecture** | Spatio-Temporal Diffusion Transformer (DiT) with Cross-Attention |
| **Model Size** | 22 Billion Parameters (`ltx-2.3-22b-dev-fp8.safetensors` / bf16) |
| **Text Encoder** | Google Gemma 3 12B IT (`gemma_3_12B_it_fp4_mixed.safetensors`) |
| **Modality** | Joint Audio-Visual Latent Diffusion (Video + Synchronized Multi-Track Audio) |
| **Base Latent Space** | 3D Causal Spatio-Temporal VAE (16x spatial compression, 8x temporal compression) |
| **Audio Latent Space** | Continuous Audio Latent VAE (`LTXVAudioVAELoader` / `LTXVAudioVAEDecode`) |
| **Native Frame Rates** | 24, 25, 30, 50 FPS (pacing of motion blur and audio envelopes depends directly on FPS) |
| **Native Resolutions** | 1280x720 (16:9), 720x1280 (9:16), 1920x1080 (Full HD), up to 4K via two-stage upscaler |
| **Distilled Sampling** | 8 to 9 steps via distilled LoRA and custom `ManualSigmas` schedules |
| **CFG Guidance** | Standard CFG = 1.0 (CFG Guider mode for distilled LoRA workflows) |

---

## 2. Multimodal Text Encoder: Gemma 3 12B IT

Unlike earlier diffusion models that relied on T5-XXL or CLIP-L, LTX-2.3 utilizes **Gemma 3 12B IT**:
- **Instruction Tuned Reasoning**: Gemma 3 understands complex compositional syntax, chronological timelines, camera jargon, physical lighting terminology, and multi-character spatial relationships.
- **Cross-Modal Attention**: Gated cross-attention layers in the 22B DiT inject Gemma 3 embeddings across both spatial frames and temporal motion slices.
- **Multimodal Prompt Enhancer (`TextGenerateLTX2Prompt`)**:
  - In ComfyUI workflows, the Gemma 3 model can function both as the text encoder and as an on-the-fly prompt expansion engine.
  - Takes structured scene JSON or high-level director notes and synthesizes rich, cohesive cinematographic descriptions.

---

## 3. Joint Audio-Visual Latent Pipeline

LTX-2.3 generates synchronized video and audio **simultaneously in a single diffusion pass**:
1. **Empty Audio Latent Initialization**: `LTXVEmptyLatentAudio` calculates required audio frames based on `(duration_seconds * fps + 1)`.
2. **AV Latent Concatenation**: `LTXVConcatAVLatent` concatenates the video latent tensor with the audio latent tensor.
3. **Joint Denoising**: The 22B DiT denoises visual frames and audio waveform representations in locked temporal alignment.
4. **AV Separation**: `LTXVSeparateAVLatent` splits the denoised latent back into video samples and audio samples.
5. **Dual Decoding**:
   - Video latent -> `VAEDecodeTiled` (spatial tile size 768, temporal size 4096).
   - Audio latent -> `LTXVAudioVAEDecode` -> 48kHz audio stream.
6. **Muxing**: `CreateVideo` multiplexes the image sequence and audio stream into MP4/WebM.

---

## 4. Two-Stage Generation & Distilled LoRA Pipeline

In production ComfyUI workflows (such as `video_ltx2_3_t2v.json`):

### Pass 1: Base Resolution Latent Generation
- **LoRA**: `ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors` (strength 0.5 to 1.0).
- **Resolution**: Half-resolution of target output (e.g. 640x360 for a 1280x720 target).
- **Sampler**: `euler` with `ManualSigmas`:
  ```text
  1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0
  ```
  *(8-step denoising trajectory tailored for the distilled DiT).*

### Latent Upscaling
- **Upscaler Model**: `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` via `LTXVLatentUpsampler`.
- Upscales latent dimensions 2x (e.g., from 640x360 to 1280x720) in latent space without decoding to pixel space first.

### Pass 2: High-Resolution Refinement
- **Sampler**: `euler` with second-pass `ManualSigmas`:
  ```text
  0.85, 0.7250, 0.4219, 0.0
  ```
  *(3-step high-frequency detail injection and micro-texture refinement).*
- **Decode**: `VAEDecodeTiled` prevents VRAM exhaustion when decoding full 720p/1080p frame batches.

---

## 5. Mathematical Frame Count Formulation

To ensure perfect temporal loop, audio sync, and batch alignment:
$$\text{Total Frames} = (\text{Duration in Seconds} \times \text{Frame Rate (FPS)}) + 1$$

Examples:
- **5 seconds @ 30 FPS**: $5 \times 30 + 1 = 151$ frames.
- **7 seconds @ 30 FPS**: $7 \times 30 + 1 = 211$ frames.
- **6 seconds @ 50 FPS**: $6 \times 50 + 1 = 301$ frames.
