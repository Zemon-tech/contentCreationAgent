# MiniMax H3 Model Specifications & Architecture

## 1. Executive Summary

**MiniMax H3** is a foundation-class omni-modal generative model developed by MiniMax AI. Unlike previous generations (Hailuo 01 and Hailuo 02) that isolated tasks into specialized silos, MiniMax H3 was designed from pretraining to eliminate task boundaries across text, images, video, and audio.

- **Primary Modalities**: Jointly understands and generates Text, Image, Video, and Native Stereo Audio.
- **Resolution**: Native 2K resolution (with default 768p base generation).
- **Temporal Output**: Up to 15 seconds of continuous generation at **24 frames per second**.
- **Audio Generation**: Joint audio-visual generation with native stereo sound (synchronized dialogue, Foley, room tone, and non-diegetic score).
- **Instruction Following**: Powered by Contextual Omni Representation trained with Qwen3-VL 32B vision-language intelligence.

---

## 2. Core Architecture Pipeline

```
┌────────────────────────────────────────────────────────────────────────┐
│                          User Input / Request                          │
│        (Text Prompt, Reference Pictures, Reference Video/Audio)         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 Text & Vision Encoder: Qwen3-VL 32B                    │
│           (qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors)               │
│      Encodes Multimodal Context & Alignment Instruction into Latents   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   H3-Omni Diffusion Transformer                        │
│             (minimax_h3_fl2va_pruned_int8_convrot.safetensors)         │
│                                                                        │
│   Joint Visual + Audio Latent Denoising (res_multistep / simple)       │
│   Optional: Turbo 8-Step LoRA (minimax_h3_fl2v_turbo_8step_v1.0)       │
└───────────────────────┬────────────────────────┬───────────────────────┘
                        │                        │
                        ▼                        ▼
        ┌──────────────────────────────┐  ┌──────────────────────────────┐
        │        H3-VisualVAE          │  │         H3-AudioVAE          │
        │ (minimax_h3_video_vae_fp16)  │  │ (minimax_h3_audio_vae_fp32)  │
        └───────────────┬──────────────┘  └──────────────┬───────────────┘
                        │                                │
                        ▼                                ▼
        ┌──────────────────────────────┐  ┌──────────────────────────────┐
        │       Decoded Frames         │  │     Decoded Stereo Audio     │
        │         (24.0 FPS)           │  │     (44.1kHz / 48kHz PCM)    │
        └───────────────┬──────────────┘  └──────────────┬───────────────┘
                        │                                │
                        └───────────────┬────────────────┘
                                        ▼
                        ┌──────────────────────────────┐
                        │      CreateVideo (Node 130)  │
                        │   Synchronized Video + Audio │
                        └──────────────────────────────┘
```

---

## 3. Sub-Component Breakdown

### 3.1 Text & Vision Encoder: Qwen3-VL 32B
- **Checkpoint**: `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- **Class**: `Qwen3VLForConditionalGeneration`
- **ComfyUI Loader**: `CLIPLoader` with `type: "minimax"`.
- **Role**: Ingests the complex H3 syntax (`integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`, dialogue `<d>` blocks, and alignment instructions) alongside image reference tokens.
- **Why it matters**: Standard CLIP or T5 models struggle with syntax tags and multi-modal reference binding. Qwen3-VL maintains high-dimensional multi-task reasoning.

### 3.2 Visual Tokenizer: H3-VisualVAE
- **Checkpoint**: `minimax_h3_video_vae_fp16.safetensors`
- **Compression**: High temporal and spatial compression ratio delivering a 4x effective sequence length boost.
- **Precision**: FP16 for rapid decoding without loss of skin micro-texture or edge sharpness.

### 3.3 Audio Tokenizer: H3-AudioVAE
- **Checkpoint**: `minimax_h3_audio_vae_fp32.safetensors`
- **Precision**: FP32 for maximum dynamic range, low noise floor, and pristine stereo phase separation.
- **Decoded via**: ComfyUI node `VAEDecodeAudio` (Node `140:121`).

### 3.4 Diffusion Transformer: H3-Omni-Transformer
- **Checkpoint**: `minimax_h3_fl2va_pruned_int8_convrot.safetensors`
- **Architecture**: Separates understanding and generation workloads while jointly balancing heterogeneous compute between video and audio tokens.
- **Base Steps**: 20–25 steps using `res_multistep` sampler and `simple` scheduler.
- **Turbo LoRA**: `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` reduces inference to **8 steps** with minimal quality degradation.

### 3.5 In-Context 2K Regeneration
- Unlike traditional models that use external ESRGAN / Real-ESRGAN super-resolution upscalers that hallucinate blurry textures, H3 utilizes **in-context regeneration**.
- The H3 base model regenerates its own lower-resolution latents directly within the original multi-modal context, restoring fine text, pupil reflections, and micro-textures.

---

## 4. Latent Chunking & Math Specification

MiniMax H3 organizes temporal video latents into **17-frame latent chunks** at 24 FPS.

### The ComfyUI Latent Math Formula
As implemented in `video_minimax_h3_t2v.json` (Node `140:132`):

$$\text{frame\_count} = \max(5, \text{round}(a \times 24)) + \Big(5 - \big(\max(5, \text{round}(a \times 24)) \pmod{17}\big)\Big) \pmod{17}$$

where $a$ is the duration in seconds (`Float (duration)` Node `140:133`).

### Frame Count Lookup Table
| Duration ($a$) | Raw Frames ($a \times 24$) | Quantized H3 Frames | Effective Duration |
|----------------|----------------------------|---------------------|--------------------|
| **2.0s**       | 48                         | **56 frames**       | 2.33s              |
| **3.0s**       | 72                         | **73 frames**       | 3.04s              |
| **4.0s**       | 96                         | **107 frames**      | 4.45s              |
| **5.0s**       | 120                        | **124 frames**      | 5.16s              |
| **6.0s**       | 144                        | **158 frames**      | 6.58s              |
| **7.0s**       | 168                        | **175 frames**      | 7.29s              |
| **8.0s**       | 192                        | **192 frames**      | 8.00s              |
| **10.0s**      | 240                        | **243 frames**      | 10.12s             |
| **12.0s**      | 288                        | **294 frames**      | 12.25s             |
| **15.0s**      | 360                        | **362 frames**      | 15.08s             |

> **Directorial Rule**: Always set the scene duration to match these exact quantizations when timing actions, cuts, and dialogue lines.
