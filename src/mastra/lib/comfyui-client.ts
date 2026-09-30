/**
 * Minimal ComfyUI HTTP API client.
 *
 * Talks to a locally deployed ComfyUI instance (the one serving the
 * Flux.2 Dev workflow) via its built-in REST API on port 8188:
 *   POST /upload/image      — upload a reference image into ComfyUI's input dir
 *   POST /prompt            — queue an API-format workflow graph
 *   GET  /history/{id}      — poll for completion + output file names
 *   GET  /view              — download a rendered output image
 *
 * Everything is env-driven:
 *   COMFYUI_BASE_URL   default http://127.0.0.1:8188
 *   COMFYUI_API_KEY    optional; sent as Authorization: Bearer <key> when set
 *                      (for reverse-proxied / secured deployments)
 *
 * Docs: https://docs.comfy.org/development/comfyui-server/comms_routes
 */

import { randomUUID } from "node:crypto";

export interface ComfyPromptGraph {
  [nodeId: string]: {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title?: string };
  };
}

export interface QueuedPrompt {
  prompt_id: string;
  number?: number;
}

export interface UploadedImage {
  /** File name as ComfyUI stores it in its input directory (use this in LoadImage). */
  name: string;
  subfolder: string;
  type: string;
}

export interface OutputImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface RenderedImage extends OutputImageRef {
  /** URL that returns the raw image bytes from ComfyUI. */
  url: string;
  /** Node id that produced the image (a SaveImage node). */
  nodeId: string;
}

function baseUrl(): string {
  return (process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const key = process.env.COMFYUI_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** True when a ComfyUI base URL is configured (always true given the default). */
export function isComfyUiConfigured(): boolean {
  return !!(process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188");
}

/** Quick reachability check against /system_stats. */
export async function pingComfyUi(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${baseUrl()}/system_stats`, { headers: { ...authHeaders() } });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from /system_stats` };
    return { ok: true, detail: `ComfyUI reachable at ${baseUrl()}` };
  } catch (err) {
    return {
      ok: false,
      detail: `Cannot reach ComfyUI at ${baseUrl()}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Is ComfyUI running with --listen? Set COMFYUI_BASE_URL if it is on another host/port.`,
    };
  }
}

/**
 * Uploads image bytes into ComfyUI's input directory so a LoadImage node
 * can reference them by file name. Adds a UUID prefix to avoid collisions.
 */
export async function uploadImage(
  bytes: Uint8Array | Buffer,
  fileName: string,
  options?: { overwrite?: boolean; subfolder?: string },
): Promise<UploadedImage> {
  const safeName = `${randomUUID().slice(0, 8)}_${fileName.replace(/[^\w.\-]+/g, "_")}`;
  const form = new FormData();
  const blob = new Blob([Buffer.from(bytes)], { type: "application/octet-stream" });
  form.append("image", blob, safeName);
  form.append("overwrite", options?.overwrite ? "true" : "false");
  if (options?.subfolder) form.append("subfolder", options.subfolder);

  const res = await fetch(`${baseUrl()}/upload/image`, {
    method: "POST",
    headers: { ...authHeaders() },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ComfyUI /upload/image failed: HTTP ${res.status} ${body || res.statusText}`);
  }
  const data = (await res.json()) as { name: string; subfolder?: string; type?: string };
  return { name: data.name, subfolder: data.subfolder ?? "", type: data.type ?? "input" };
}

/** Queues an API-format prompt graph for execution. */
export async function queuePrompt(graph: ComfyPromptGraph, clientId?: string): Promise<QueuedPrompt> {
  const res = await fetch(`${baseUrl()}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ prompt: graph, ...(clientId ? { client_id: clientId } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `ComfyUI /prompt rejected the workflow: HTTP ${res.status} ${body || res.statusText}. ` +
        `This usually means a model file is missing or a node input is invalid.`,
    );
  }
  const data = (await res.json()) as { prompt_id: string; number?: number };
  return { prompt_id: data.prompt_id, number: data.number };
}

interface HistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, { images?: OutputImageRef[] }>;
}

async function getHistory(promptId: string): Promise<HistoryEntry | null> {
  const res = await fetch(`${baseUrl()}/history/${promptId}`, { headers: { ...authHeaders() } });
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, HistoryEntry>;
  return data[promptId] ?? null;
}

function viewUrl(ref: OutputImageRef): string {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "output",
  });
  return `${baseUrl()}/view?${params.toString()}`;
}

/**
 * Polls /history until the prompt finishes (or errors / times out), then
 * returns the produced output images.
 */
export async function waitForImages(
  promptId: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number; onProgress?: (status: string) => void },
): Promise<RenderedImage[]> {
  const timeoutMs = options?.timeoutMs ?? 300_000; // 5 min — Flux.2 is heavy
  const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
  const start = Date.now();
  let announced = false;

  while (Date.now() - start < timeoutMs) {
    const entry = await getHistory(promptId);
    if (entry) {
      const statusStr = entry.status?.status_str ?? "running";
      if (!announced) {
        options?.onProgress?.(statusStr);
        announced = true;
      }
      const done = entry.status?.completed === true || statusStr === "success";
      if (statusStr === "error") {
        throw new Error(
          `ComfyUI reported an execution error for prompt ${promptId}. ` +
            `Check the ComfyUI console for the failing node.`,
        );
      }
      if (done) {
        const images: RenderedImage[] = [];
        for (const [nodeId, out] of Object.entries(entry.outputs ?? {})) {
          for (const img of out.images ?? []) {
            if (img.type === "temp") continue; // skip previews
            images.push({ ...img, url: viewUrl(img), nodeId });
          }
        }
        return images;
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`ComfyUI prompt ${promptId} timed out after ${Math.round(timeoutMs / 1000)}s.`);
}

/** Downloads a rendered image's raw bytes from /view. */
export async function downloadImage(ref: OutputImageRef): Promise<Buffer> {
  const res = await fetch(viewUrl(ref), { headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(`ComfyUI /view failed for ${ref.filename}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
