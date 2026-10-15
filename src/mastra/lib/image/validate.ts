import sharp from "sharp";
import type { Metadata } from "sharp";
import { imageConfig, type ImageConfig } from "../../config/image.config";

/**
 * Deterministic image validation (Step 5). NO vision model is used — a vision
 * relevance check ("does this image match the story?") is intentionally
 * skipped for now. TODO(vision): add a vision-capable relevance check when a
 * vision model is configured.
 *
 * Checks, in order: HEAD 200 + image content-type -> capped, timed download ->
 * real-image byte sniff -> dimensions via sharp -> size/aspect guards.
 */

export type ImageExt = "jpg" | "png" | "webp" | "gif";

/** Magic-byte sniff — confirm the BYTES are a real image, not just the URL. */
export function sniffImage(buf: Buffer): ImageExt | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.toString("ascii", 0, 3) === "GIF") return "gif";
  return null;
}

export interface DimCheck {
  ok: boolean;
  under1080: boolean;
  reason?: string;
}

/** Pure size/aspect guard. */
export function checkDimensions(width: number, height: number, cfg: ImageConfig = imageConfig): DimCheck {
  const shortSide = Math.min(width, height);
  const ratio = width / height;
  if (shortSide < cfg.minAnySidePx) {
    return { ok: false, under1080: true, reason: `too small / likely a logo (${width}x${height})` };
  }
  if (ratio < cfg.minAspect || ratio > cfg.maxAspect) {
    return { ok: false, under1080: shortSide < cfg.minShortSidePx, reason: `aspect ${ratio.toFixed(2)} will not crop cleanly to 4:5/1:1` };
  }
  // Below 1080 short side is allowed but flagged (use best available).
  return { ok: true, under1080: shortSide < cfg.minShortSidePx };
}

export interface ValidatedImage {
  ok: boolean;
  reason?: string;
  buffer?: Buffer;
  ext?: ImageExt;
  width?: number;
  height?: number;
  under1080?: boolean;
  contentType?: string;
}

/** HEAD check: reachable, 200, image content type. */
export async function headCheck(url: string, cfg: ImageConfig = imageConfig): Promise<{ ok: boolean; reason?: string; contentType?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.downloadTimeoutMs);
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return { ok: false, reason: `HEAD ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!/^image\//i.test(ct)) return { ok: false, reason: `not an image content-type (${ct || "none"})` };
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len && len > cfg.maxDownloadBytes) return { ok: false, reason: `too large (${len} bytes)` };
    return { ok: true, contentType: ct };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? (/abort/i.test(err.message) ? "HEAD timeout" : err.message) : String(err) };
  }
}

/** Full validation: HEAD -> capped download -> sniff -> dimensions. */
export async function downloadAndValidate(url: string, cfg: ImageConfig = imageConfig): Promise<ValidatedImage> {
  const head = await headCheck(url, cfg);
  if (!head.ok) return { ok: false, reason: head.reason };

  let buffer: Buffer;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.downloadTimeoutMs);
    const res = await fetch(url, { redirect: "follow", signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return { ok: false, reason: `GET ${res.status}` };
    const ab = await res.arrayBuffer();
    buffer = Buffer.from(ab);
    if (buffer.length > cfg.maxDownloadBytes) return { ok: false, reason: `too large (${buffer.length} bytes)` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? (/abort/i.test(err.message) ? "download timeout" : err.message) : String(err) };
  }

  const ext = sniffImage(buffer);
  if (!ext) return { ok: false, reason: "bytes are not a valid image" };

  let meta: Metadata;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    return { ok: false, reason: "unreadable image" };
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return { ok: false, reason: "missing dimensions" };

  const dim = checkDimensions(width, height, cfg);
  if (!dim.ok) return { ok: false, reason: dim.reason, width, height };

  return { ok: true, buffer, ext, width, height, under1080: dim.under1080, contentType: head.contentType };
}
