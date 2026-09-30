import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import {
  downloadImage,
  pingComfyUi,
  queuePrompt,
  uploadImage,
  waitForImages,
} from "../lib/comfyui-client";
import { buildFlux2Graph } from "../lib/flux2-graph";
import { acquireReference, listInboxImages } from "../lib/reference-images";
import { fluxInboxDir, fluxOutputDir, fluxReferenceDir } from "../lib/flux-paths";
import { fluxOutputUrl } from "../lib/flux-output-route";

/**
 * Tools for the Flux.2 image agent.
 *
 * fetchReferenceImage — pulls a fresh reference (logo/face/product/theme)
 *   from a URL/data-URI/base64, validates it is an image, uploads it into
 *   ComfyUI's input dir, and returns the input file name to pass to
 *   generateFluxImage as a reference.
 *
 * generateFluxImage — builds the Flux.2 Dev API graph (text-to-image OR
 *   reference-conditioned with 1..N references), queues it on the local
 *   ComfyUI server, waits for completion, and copies the rendered PNGs into
 *   the agent workspace.
 */

// Resolved from the project root (not cwd) so Studio, tools and the paste page
// all share <project>/workspace/flux/*. See lib/flux-paths.ts.
const REF_DIR = fluxReferenceDir();
const OUT_DIR = fluxOutputDir();
/** Where pasted / attached reference images wait before upload to the ComfyUI VM. */
const INBOX_DIR = fluxInboxDir();

export const fetchReferenceImageTool = createTool({
  id: "fetchReferenceImage",
  description:
    "Fetches ONE reference image (logo, person's face, product shot, brand asset, style/theme reference) from a direct image URL, data URI, or base64 string, validates it, and uploads it into the local ComfyUI input directory. Returns comfyInputName — pass that in generateFluxImage.referenceImageNames to condition the generation on this reference. Use exa_search/web_fetch first to find fresh, direct image URLs.",
  inputSchema: z.object({
    source: z
      .string()
      .min(1)
      .describe("A DIRECT image URL (ends in .png/.jpg/.webp), a data: URI, or raw base64. Not an HTML page URL."),
    label: z
      .string()
      .default("reference")
      .describe("Short label for what this reference is, e.g. 'openai-logo' or 'ceo-face'. Used in the saved filename."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    comfyInputName: z.string().optional().describe("File name inside ComfyUI's input dir — use in generateFluxImage.referenceImageNames."),
    savedPath: z.string().optional().describe("Local copy in the workspace for inspection."),
    mime: z.string().optional(),
    sizeBytes: z.number().optional(),
    source: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ source, label }) => {
    try {
      const ref = await acquireReference(source, { saveDir: REF_DIR, label });
      const uploaded = await uploadImage(ref.bytes, `${label}.${ref.ext}`, { overwrite: false });
      return {
        ok: true,
        comfyInputName: uploaded.name,
        savedPath: ref.savedPath,
        mime: ref.mime,
        sizeBytes: ref.size,
        source: ref.source,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const savePastedImageTool = createTool({
  id: "savePastedImage",
  description:
    "Saves an image the user pasted/attached in chat into the local inbox folder so it can be shipped to the ComfyUI VM. Accepts a data: URI or raw base64 (the form pasted images usually arrive in). After saving, call useInboxReferences (or fetchReferenceImage with the returned path) to upload it to ComfyUI. Use this when you have the image DATA; if you only have a URL, use fetchReferenceImage directly.",
  inputSchema: z.object({
    data: z.string().min(16).describe("The pasted image as a data: URI or raw base64 string."),
    label: z.string().default("pasted").describe("Short label, e.g. 'logo' or 'face'. Used in the saved filename."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    savedPath: z.string().optional(),
    inboxDir: z.string(),
    mime: z.string().optional(),
    sizeBytes: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ data, label }) => {
    try {
      // acquireReference validates it is a real image and writes it into the inbox.
      const ref = await acquireReference(data, { saveDir: INBOX_DIR, label });
      return {
        ok: true,
        savedPath: ref.savedPath,
        inboxDir: INBOX_DIR,
        mime: ref.mime,
        sizeBytes: ref.size,
      };
    } catch (err) {
      return { ok: false, inboxDir: INBOX_DIR, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const useInboxReferencesTool = createTool({
  id: "useInboxReferences",
  description:
    "Uploads reference image(s) the user attached in chat (or dropped into the inbox folder) to the ComfyUI VM. When the user's message contains a note like 'Attached image(s) saved to the Flux inbox: chat_xxx.jpg', pass those exact names in fileNames. Without fileNames it takes the newest inbox images. Returns a comfyInputName per image — pass them to generateFluxImage.referenceImageNames.",
  inputSchema: z.object({
    fileNames: z
      .array(z.string())
      .optional()
      .describe("Exact inbox file names from the attachment note (e.g. ['chat_c654087bd58ce3e6.jpg']). Preferred."),
    max: z.number().int().min(1).max(8).default(4).describe("When fileNames is omitted: max number of newest inbox images to take."),
    consume: z
      .boolean()
      .default(false)
      .describe("Delete the inbox files after upload. Leave false; files are content-named so reuse is safe."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    inboxDir: z.string(),
    references: z
      .array(
        z.object({
          comfyInputName: z.string(),
          originalName: z.string(),
          savedPath: z.string().optional(),
          sizeBytes: z.number(),
        }),
      )
      .default([]),
    skipped: z.array(z.object({ name: z.string(), error: z.string() })).default([]),
    message: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ fileNames, max, consume }) => {
    const ping = await pingComfyUi();
    if (!ping.ok) {
      return { ok: false, inboxDir: INBOX_DIR, references: [], skipped: [], error: ping.detail };
    }

    fs.mkdirSync(INBOX_DIR, { recursive: true });
    const missing: { name: string; error: string }[] = [];
    let found: { path: string; name: string }[];
    if (fileNames && fileNames.length > 0) {
      found = [];
      for (const raw of fileNames) {
        const name = path.basename(raw); // never allow paths outside the inbox
        const full = path.join(INBOX_DIR, name);
        if (fs.existsSync(full)) found.push({ path: full, name });
        else missing.push({ name, error: "Not found in inbox. Ask the user to re-attach this image." });
      }
    } else {
      found = listInboxImages(INBOX_DIR).slice(0, max);
    }
    if (found.length === 0) {
      return {
        ok: false,
        inboxDir: INBOX_DIR,
        references: [],
        skipped: missing,
        message:
          `No images found in the inbox. Save the pasted/attached image into: ${INBOX_DIR} ` +
          `(png/jpg/webp/gif), then call this tool again.`,
      };
    }

    const references: {
      comfyInputName: string;
      originalName: string;
      savedPath?: string;
      sizeBytes: number;
    }[] = [];
    const skipped: { name: string; error: string }[] = [...missing];

    for (const item of found) {
      try {
        const ref = await acquireReference(item.path, { saveDir: REF_DIR, label: path.parse(item.name).name });
        const uploaded = await uploadImage(ref.bytes, `${path.parse(item.name).name}.${ref.ext}`, {
          overwrite: false,
        });
        references.push({
          comfyInputName: uploaded.name,
          originalName: item.name,
          savedPath: ref.savedPath,
          sizeBytes: ref.size,
        });
        if (consume) {
          try {
            fs.unlinkSync(item.path);
          } catch {
            /* best-effort */
          }
        }
      } catch (err) {
        skipped.push({ name: item.name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      ok: references.length > 0,
      inboxDir: INBOX_DIR,
      references,
      skipped,
      message:
        references.length > 0
          ? `Uploaded ${references.length} reference(s) to ComfyUI. Pass their comfyInputName values to generateFluxImage.`
          : "No inbox images could be used as references.",
    };
  },
});

export const generateFluxImageTool = createTool({
  id: "generateFluxImage",
  description:
    "Generates an image with the locally deployed Flux.2 Dev model in ComfyUI. Works as pure text-to-image (no references) OR as reference-conditioned generation when referenceImageNames are supplied (each produced by fetchReferenceImage). Chains a ReferenceLatent per reference — Flux.2's native multi-reference mechanism — so you can combine e.g. a logo + a face + a theme reference in one image. Waits for the render and saves the PNG(s) into the workspace.",
  inputSchema: z.object({
    prompt: z
      .string()
      .min(3)
      .describe("Detailed positive prompt. When using references, describe how each should appear and what to keep (e.g. 'keep the face', 'place the logo on the mug')."),
    referenceImageNames: z
      .array(z.string())
      .default([])
      .describe("ComfyUI input file names from fetchReferenceImage. Empty = text-to-image. Order matters; keep it small (1-4)."),
    width: z.number().int().min(256).max(2048).default(1248),
    height: z.number().int().min(256).max(2048).default(832),
    steps: z.number().int().min(1).max(50).optional().describe("Sampling steps. Defaults to 20 (or 8 when turbo)."),
    guidance: z.number().min(0).max(10).default(4).describe("FluxGuidance strength."),
    seed: z.number().int().optional().describe("Fixed seed for reproducibility. Random when omitted."),
    turbo: z.boolean().default(false).describe("Use the 8-step Turbo LoRA for a faster, lower-fidelity draft."),
    filenamePrefix: z.string().default("Flux2"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    promptId: z.string().optional(),
    images: z
      .array(z.object({ file: z.string(), workspacePath: z.string(), url: z.string() }))
      .default([]),
    markdown: z
      .string()
      .optional()
      .describe("Ready-to-paste Markdown that displays the image(s) in chat. Include it verbatim in the reply."),
    settings: z
      .object({
        width: z.number(),
        height: z.number(),
        steps: z.number(),
        seed: z.number(),
        turbo: z.boolean(),
        referenceCount: z.number(),
      })
      .optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    // Fail fast with an actionable message if ComfyUI is unreachable.
    const ping = await pingComfyUi();
    if (!ping.ok) {
      return { ok: false, images: [], error: ping.detail };
    }

    try {
      const { graph, meta } = buildFlux2Graph({
        prompt: input.prompt,
        referenceImageNames: input.referenceImageNames,
        width: input.width,
        height: input.height,
        steps: input.steps,
        guidance: input.guidance,
        seed: input.seed,
        turbo: input.turbo,
        filenamePrefix: input.filenamePrefix,
      });

      const { prompt_id } = await queuePrompt(graph);
      const rendered = await waitForImages(prompt_id, {
        onProgress: (s) => console.log(`[flux2] prompt ${prompt_id}: ${s}`),
      });

      fs.mkdirSync(OUT_DIR, { recursive: true });
      const images: { file: string; workspacePath: string; url: string }[] = [];
      for (const img of rendered) {
        const bytes = await downloadImage(img);
        const dest = path.join(OUT_DIR, img.filename);
        fs.writeFileSync(dest, bytes);
        images.push({ file: img.filename, workspacePath: dest, url: fluxOutputUrl(img.filename) });
      }

      if (images.length === 0) {
        return {
          ok: false,
          promptId: prompt_id,
          images: [],
          error: "ComfyUI finished but produced no output images. Check that the SaveImage node ran.",
          settings: meta,
        };
      }

      const markdown = images.map((i) => `![Generated image](${i.url})`).join("\n\n");
      return { ok: true, promptId: prompt_id, images, markdown, settings: meta };
    } catch (err) {
      return { ok: false, images: [], error: err instanceof Error ? err.message : String(err) };
    }
  },
});
