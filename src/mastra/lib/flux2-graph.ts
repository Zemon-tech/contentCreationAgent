/**
 * Flux.2 Dev API-graph builder.
 *
 * The file the user exported (`image_flux2 (1).json`) is a ComfyUI *UI*
 * workflow built around a subgraph ("Image Edit (Flux.2 Dev)"). The
 * ComfyUI HTTP API (`POST /prompt`) does NOT accept that UI format — it
 * needs the flattened "API format" graph: a flat map of nodeId ->
 * { class_type, inputs }. This module reconstructs that graph from the
 * nodes/links found in the exported workflow, parameterized so an agent
 * can drive it.
 *
 * Models (from the exported workflow's model links note):
 *   diffusion_models/flux2_dev_fp8mixed.safetensors        (UNETLoader)
 *   text_encoders/mistral_3_small_flux2_bf16.safetensors   (CLIPLoader, type "flux2")
 *   vae/flux2-vae.safetensors                              (VAELoader)
 *   loras/Flux_2-Turbo-LoRA_comfyui.safetensors            (LoraLoaderModelOnly, optional 8-step turbo)
 *
 * Pipeline reproduced:
 *   UNETLoader ─┬─(turbo? LoraLoaderModelOnly)─ BasicGuider ─┐
 *   CLIPLoader ─ CLIPTextEncode ─ FluxGuidance ─ ReferenceLatent* ─┘   SamplerCustomAdvanced ─ VAEDecode ─ SaveImage
 *   VAELoader ── (per reference) ImageScaleToTotalPixels ─ VAEEncode ─ ReferenceLatent (chained)
 *   RandomNoise, KSamplerSelect(euler), Flux2Scheduler(steps,w,h), EmptyFlux2LatentImage(w,h)
 *
 * Multiple references: Flux.2's native mechanism is to VAE-encode each
 * reference image and chain a ReferenceLatent node per image, threading
 * the conditioning through. That is exactly what we build below when
 * `referenceImageNames` has more than one entry.
 */

export const FLUX2_MODELS = {
  unet: "flux2_dev_fp8mixed.safetensors",
  clip: "mistral_3_small_flux2_bf16.safetensors",
  vae: "flux2-vae.safetensors",
  turboLora: "Flux_2-Turbo-LoRA_comfyui.safetensors",
} as const;

import type { ComfyPromptGraph } from "./comfyui-client";

export interface BuildFlux2GraphParams {
  /** Positive prompt describing the image to generate. */
  prompt: string;
  /**
   * ComfyUI input-dir file names of reference images (as returned by
   * uploadImage). Empty → pure text-to-image. One or more → each is
   * VAE-encoded and chained as a ReferenceLatent (Flux.2 multi-reference).
   */
  referenceImageNames?: string[];
  /** Output width in px. Default 1248 (from the workflow). */
  width?: number;
  /** Output height in px. Default 832 (from the workflow). */
  height?: number;
  /** Sampling steps. Default 20 (full) / 8 when turbo. */
  steps?: number;
  /** FluxGuidance value. Default 4 (from the workflow). */
  guidance?: number;
  /** Noise seed. Random when omitted. */
  seed?: number;
  /** Enable the 8-step Turbo LoRA for faster (lower-fidelity) drafts. */
  turbo?: boolean;
  /** SaveImage filename prefix. Default "Flux2". */
  filenamePrefix?: string;
  /** Override the model file names (rarely needed). */
  models?: Partial<typeof FLUX2_MODELS>;
}

// Stable node ids for the API graph.
const N = {
  UNET: "10",
  CLIP: "11",
  VAE: "12",
  POS: "20", // CLIPTextEncode
  FLUX_GUIDANCE: "21",
  TURBO_LORA: "30",
  BASIC_GUIDER: "40",
  RANDOM_NOISE: "41",
  SAMPLER_SELECT: "42",
  SCHEDULER: "43",
  EMPTY_LATENT: "44",
  SAMPLER: "50",
  VAE_DECODE: "51",
  SAVE: "60",
} as const;

/** Prefix for the per-reference node ids (scale/encode/reference-latent). */
function refIds(i: number) {
  return {
    load: `100${i}`, // LoadImage
    scale: `200${i}`, // ImageScaleToTotalPixels
    encode: `300${i}`, // VAEEncode
    ref: `400${i}`, // ReferenceLatent
  };
}

export function buildFlux2Graph(params: BuildFlux2GraphParams): {
  graph: ComfyPromptGraph;
  meta: { width: number; height: number; steps: number; seed: number; turbo: boolean; referenceCount: number };
} {
  const models = { ...FLUX2_MODELS, ...(params.models ?? {}) };
  const refs = (params.referenceImageNames ?? []).filter(Boolean);
  const turbo = !!params.turbo;
  const width = clampEven(params.width ?? 1248);
  const height = clampEven(params.height ?? 832);
  const steps = params.steps ?? (turbo ? 8 : 20);
  const guidance = params.guidance ?? 4;
  const seed = params.seed ?? Math.floor(Math.random() * 1_000_000_000_000_000);
  const filenamePrefix = params.filenamePrefix ?? "Flux2";

  const graph: ComfyPromptGraph = {};

  // --- Loaders ---
  graph[N.UNET] = {
    class_type: "UNETLoader",
    inputs: { unet_name: models.unet, weight_dtype: "default" },
    _meta: { title: "Load Flux.2 Diffusion Model" },
  };
  graph[N.CLIP] = {
    class_type: "CLIPLoader",
    inputs: { clip_name: models.clip, type: "flux2", device: "default" },
    _meta: { title: "Load Mistral Text Encoder" },
  };
  graph[N.VAE] = {
    class_type: "VAELoader",
    inputs: { vae_name: models.vae },
    _meta: { title: "Load Flux.2 VAE" },
  };

  // --- Model path (optional Turbo LoRA) ---
  let modelSource: [string, number] = [N.UNET, 0];
  if (turbo) {
    graph[N.TURBO_LORA] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: [N.UNET, 0], lora_name: models.turboLora, strength_model: 1 },
      _meta: { title: "Flux.2 Turbo LoRA (8 steps)" },
    };
    modelSource = [N.TURBO_LORA, 0];
  }

  // --- Positive conditioning ---
  graph[N.POS] = {
    class_type: "CLIPTextEncode",
    inputs: { clip: [N.CLIP, 0], text: params.prompt },
    _meta: { title: "CLIP Text Encode (Positive Prompt)" },
  };
  graph[N.FLUX_GUIDANCE] = {
    class_type: "FluxGuidance",
    inputs: { conditioning: [N.POS, 0], guidance },
    _meta: { title: "Flux Guidance" },
  };

  // --- Reference chain: VAE-encode each reference and chain ReferenceLatent ---
  let conditioningSource: [string, number] = [N.FLUX_GUIDANCE, 0];
  refs.forEach((name, i) => {
    const id = refIds(i);
    graph[id.load] = {
      class_type: "LoadImage",
      inputs: { image: name, upload: "image" },
      _meta: { title: `Reference ${i + 1}` },
    };
    graph[id.scale] = {
      class_type: "ImageScaleToTotalPixels",
      // Matches the exported workflow widgets ["lanczos", 1, 1]:
      // upscale_method, megapixels, resolution_steps (required by current ComfyUI).
      inputs: { image: [id.load, 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 1 },
      _meta: { title: `Scale Reference ${i + 1}` },
    };
    graph[id.encode] = {
      class_type: "VAEEncode",
      inputs: { pixels: [id.scale, 0], vae: [N.VAE, 0] },
      _meta: { title: `Encode Reference ${i + 1}` },
    };
    graph[id.ref] = {
      class_type: "ReferenceLatent",
      inputs: { conditioning: conditioningSource, latent: [id.encode, 0] },
      _meta: { title: `Reference Latent ${i + 1}` },
    };
    conditioningSource = [id.ref, 0];
  });

  // --- Guider ---
  graph[N.BASIC_GUIDER] = {
    class_type: "BasicGuider",
    inputs: { model: modelSource, conditioning: conditioningSource },
    _meta: { title: "Basic Guider" },
  };

  // --- Sampler stack ---
  graph[N.RANDOM_NOISE] = {
    class_type: "RandomNoise",
    inputs: { noise_seed: seed },
    _meta: { title: "Random Noise" },
  };
  graph[N.SAMPLER_SELECT] = {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "euler" },
    _meta: { title: "Sampler Select" },
  };
  graph[N.SCHEDULER] = {
    class_type: "Flux2Scheduler",
    inputs: { steps, width, height },
    _meta: { title: "Flux.2 Scheduler" },
  };
  graph[N.EMPTY_LATENT] = {
    class_type: "EmptyFlux2LatentImage",
    inputs: { width, height, batch_size: 1 },
    _meta: { title: "Empty Flux.2 Latent" },
  };
  graph[N.SAMPLER] = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: [N.RANDOM_NOISE, 0],
      guider: [N.BASIC_GUIDER, 0],
      sampler: [N.SAMPLER_SELECT, 0],
      sigmas: [N.SCHEDULER, 0],
      latent_image: [N.EMPTY_LATENT, 0],
    },
    _meta: { title: "Sampler Custom Advanced" },
  };

  // --- Decode + save ---
  graph[N.VAE_DECODE] = {
    class_type: "VAEDecode",
    inputs: { samples: [N.SAMPLER, 0], vae: [N.VAE, 0] },
    _meta: { title: "VAE Decode" },
  };
  graph[N.SAVE] = {
    class_type: "SaveImage",
    inputs: { images: [N.VAE_DECODE, 0], filename_prefix: filenamePrefix },
    _meta: { title: "Save Image" },
  };

  return {
    graph,
    meta: { width, height, steps, seed, turbo, referenceCount: refs.length },
  };
}

/** ComfyUI latent dims must be divisible by 8 (Flux uses 16); round to a safe even value. */
function clampEven(v: number): number {
  const n = Math.max(256, Math.min(2048, Math.round(v)));
  return n - (n % 16);
}
