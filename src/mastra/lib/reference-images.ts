/**
 * Reference-image acquisition helper for the Flux.2 image agent.
 *
 * The agent finds "fresh, latest" visual references (logos, faces, product
 * shots, themes) on the live web, then feeds them into Flux.2 as reference
 * images. This module turns a URL / data-URI / base64 string into raw image
 * bytes, validates that the payload really is a supported raster image, and
 * saves it into the agent workspace so the run is inspectable.
 *
 * It intentionally has NO network policy beyond fetching the exact URL it is
 * handed — the agent decides *which* URLs to fetch (via exa_search / web
 * search), this just retrieves them safely and reports failures instead of
 * throwing the whole run away.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AcquiredReference {
  /** Raw image bytes. */
  bytes: Buffer;
  /** Detected file extension (png/jpg/webp/gif). */
  ext: string;
  /** Detected mime type. */
  mime: string;
  /** Where it came from (URL or "inline"). */
  source: string;
  /** Absolute path where a local copy was written, if a workspace dir was given. */
  savedPath?: string;
  /** Byte size. */
  size: number;
}

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB guard

/** Sniffs common raster image formats by magic bytes. Returns null if not an image. */
function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { ext: "gif", mime: "image/gif" };
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

/** Parses a data: URI into bytes. */
function parseDataUri(input: string): Buffer | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(input.trim());
  if (!m) return null;
  const isBase64 = !!m[2];
  const data = m[3];
  try {
    return isBase64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data), "utf-8");
  } catch {
    return null;
  }
}

/** Heuristic: does a bare string look like base64 image data? */
function looksLikeBareBase64(input: string): boolean {
  const s = input.trim();
  return s.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(s);
}

/** True when the string points at an existing readable file on disk. */
function isReadableLocalFile(input: string): boolean {
  // Avoid treating long base64 blobs as paths (Windows MAX_PATH ~260).
  if (input.length > 400 || input.includes("\n")) return false;
  try {
    return fs.existsSync(input) && fs.statSync(input).isFile();
  } catch {
    return false;
  }
}

/**
 * Lists image files sitting in an "inbox" directory, newest first. This is how
 * pasted / dropped images reach the agent: the chat client (or the user) saves
 * them here, and the agent consumes them as references.
 */
export function listInboxImages(inboxDir: string): { path: string; name: string; mtimeMs: number; size: number }[] {
  if (!fs.existsSync(inboxDir)) return [];
  const out: { path: string; name: string; mtimeMs: number; size: number }[] = [];
  for (const name of fs.readdirSync(inboxDir)) {
    const full = path.join(inboxDir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) continue;
    out.push({ path: full, name, mtimeMs: st.mtimeMs, size: st.size });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Acquires a single reference image from a URL, data-URI, or raw base64.
 * Optionally writes a copy into `saveDir`. Throws with an actionable message
 * on failure so the tool layer can surface it per-reference.
 */
export async function acquireReference(
  input: string,
  options?: { saveDir?: string; label?: string; timeoutMs?: number },
): Promise<AcquiredReference> {
  const trimmed = input.trim();
  let bytes: Buffer;
  let source: string;

  if (trimmed.startsWith("data:")) {
    const parsed = parseDataUri(trimmed);
    if (!parsed) throw new Error("Malformed data: URI reference.");
    bytes = parsed;
    source = "inline";
  } else if (/^https?:\/\//i.test(trimmed)) {
    bytes = await fetchUrlBytes(trimmed, options?.timeoutMs ?? 30_000);
    source = trimmed;
  } else if (isReadableLocalFile(trimmed)) {
    bytes = fs.readFileSync(trimmed);
    source = trimmed;
  } else if (looksLikeBareBase64(trimmed)) {
    bytes = Buffer.from(trimmed.replace(/\s+/g, ""), "base64");
    source = "inline";
  } else {
    throw new Error(
      `Reference is not a URL, data URI, local file path, or base64: "${trimmed.slice(0, 60)}..."`,
    );
  }

  if (bytes.length === 0) throw new Error(`Empty reference from ${source}.`);
  if (bytes.length > MAX_BYTES) {
    throw new Error(`Reference from ${source} is ${(bytes.length / 1e6).toFixed(1)}MB, over the 20MB limit.`);
  }

  const kind = sniffImage(bytes);
  if (!kind) {
    throw new Error(
      `Content from ${source} is not a supported image (png/jpg/webp/gif). ` +
        `The URL may be an HTML page, not a direct image link.`,
    );
  }

  const result: AcquiredReference = {
    bytes,
    ext: kind.ext,
    mime: kind.mime,
    source,
    size: bytes.length,
  };

  if (options?.saveDir) {
    fs.mkdirSync(options.saveDir, { recursive: true });
    const base = (options.label || "reference").replace(/[^\w.\-]+/g, "_");
    const fileName = `${base}_${randomUUID().slice(0, 8)}.${kind.ext}`;
    const savedPath = path.join(options.saveDir, fileName);
    fs.writeFileSync(savedPath, bytes);
    result.savedPath = savedPath;
  }

  return result;
}

async function fetchUrlBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some CDNs 403 requests without a UA / accept header.
        "User-Agent": "Mozilla/5.0 (compatible; Flux2ImageAgent/1.0)",
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s fetching ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
