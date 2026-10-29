/**
 * Image helpers for the Satori renderer.
 *
 * Satori embeds <img> content from data URLs. These helpers turn local files
 * or remote URLs into base64 data URIs and probe PNG dimensions (needed
 * because Satori requires explicit width/height and we want to preserve the
 * real aspect ratio of the brand logos).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/**
 * Re-encode a raster image buffer to a clean baseline PNG via sharp. sharp
 * fully DECODES then re-encodes, which repairs progressive / non-standard /
 * slightly-truncated JPEGs that Satori's own decoder rejects at render time
 * with "Offset is outside the bounds of the DataView". `failOn: "none"` makes
 * sharp tolerate recoverable corruption instead of throwing on the first
 * warning. Throws only when the bytes are not a decodable image at all.
 */
async function sanitizeToPngDataUrl(buffer: Buffer): Promise<string> {
  const png = await sharp(buffer, { failOn: "none" })
    .flatten({ background: "#13110E" }) // drop any alpha onto the hero backdrop
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** Hero dimensions on the RAS story canvas (3/5 of 1080x1350). */
const HERO_W = 1080;
const HERO_H = 810;

/**
 * A neutral solid-color hero used when the real image cannot be decoded, so a
 * bad/corrupt source image degrades to a plain branded panel instead of
 * failing the whole post. Rendered once and cached.
 */
let placeholderHeroCache: string | null = null;
export async function placeholderHeroDataUrl(): Promise<string> {
  if (placeholderHeroCache) return placeholderHeroCache;
  const png = await sharp({
    create: { width: HERO_W, height: HERO_H, channels: 3, background: "#13110E" },
  })
    .png()
    .toBuffer();
  placeholderHeroCache = `data:image/png;base64,${png.toString("base64")}`;
  return placeholderHeroCache;
}

/** Converts a local image file into a base64 data URL. */
export function getLocalImageDataUrl(filePath: string): string {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Image not found: ${abs}`);
  }
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "image/png";
  return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
}

/** Reads intrinsic width/height of a PNG from its IHDR chunk. */
export function getPngDimensions(filePath: string): { width: number; height: number } {
  const abs = resolve(filePath);
  const buf = readFileSync(abs);
  const isPng =
    buf.length > 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;
  if (!isPng) {
    throw new Error(`Not a PNG (cannot read dimensions): ${abs}`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

/**
 * Loads a local PNG and returns its data URL plus intrinsic dimensions.
 * Useful for logos where we must preserve the real aspect ratio.
 */
export function loadLocalPng(filePath: string): {
  dataUrl: string;
  width: number;
  height: number;
} {
  const { width, height } = getPngDimensions(filePath);
  return { dataUrl: getLocalImageDataUrl(filePath), width, height };
}

/** Reads intrinsic width/height of an SVG from its root width/height or viewBox. */
export function getSvgDimensions(svgText: string): { width: number; height: number } {
  const widthMatch = svgText.match(/<svg[^>]*\bwidth="([\d.]+)/i);
  const heightMatch = svgText.match(/<svg[^>]*\bheight="([\d.]+)/i);
  if (widthMatch && heightMatch) {
    return { width: Number(widthMatch[1]), height: Number(heightMatch[1]) };
  }
  const viewBox = svgText.match(/viewBox="([\d.\s-]+)"/i);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/\s+/).map(Number);
    if (parts.length === 4) return { width: parts[2], height: parts[3] };
  }
  return { width: 500, height: 250 };
}

/**
 * Loads a local brand logo (PNG or SVG) and returns its data URL plus
 * intrinsic dimensions. Satori rasterizes SVG via resvg, so an svg+xml data
 * URL embeds cleanly in an <img>.
 */
export function loadLocalLogo(filePath: string): {
  dataUrl: string;
  width: number;
  height: number;
} {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Logo not found: ${abs}`);
  }
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  if (ext === ".svg") {
    const svgText = readFileSync(abs, "utf8");
    const { width, height } = getSvgDimensions(svgText);
    const base64 = Buffer.from(svgText, "utf8").toString("base64");
    return { dataUrl: `data:image/svg+xml;base64,${base64}`, width, height };
  }
  return loadLocalPng(filePath);
}

/**
 * Fetches a remote image (http/https) and returns it as a base64 data URL.
 * Validates the response is actually an image. Used when the hero image is a
 * web URL the agent found rather than a local file.
 */
export async function fetchImageAsDataUrl(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid image URL: "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Image URL must be http(s): "${url}"`);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch image (HTTP ${res.status}): ${url}`);
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!contentType.startsWith("image/")) {
    throw new Error(
      `URL did not return an image (content-type "${contentType}"): ${url}. ` +
        `Pass a direct link to a .png/.jpg/.webp file.`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  // SVG stays as-is (Satori rasterizes it via resvg). Every RASTER image —
  // including JPEG/PNG — is re-encoded through sharp. This both transcodes
  // formats Satori can't read (WebP/AVIF) AND repairs progressive/odd/truncated
  // JPEGs that Satori's decoder rejects at render time. The previous code
  // embedded "safe" JPEG/PNG bytes verbatim, which is exactly what let a bad
  // yourstory.com JPEG blow up the render with a DataView offset error.
  if (contentType === "image/svg+xml") {
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  }
  return sanitizeToPngDataUrl(buffer);
}

/**
 * Resolves a hero image reference (local path OR http(s) URL) into a base64
 * data URL that Satori can embed. Every raster image is re-encoded through
 * sharp so a progressive / non-standard / slightly-corrupt source cannot blow
 * up the render. If the bytes are not a decodable image at all, it FALLS BACK
 * to a neutral placeholder hero rather than throwing — a bad source image
 * degrades the post, it does not kill it.
 */
export async function resolveHeroImage(ref: string): Promise<string> {
  try {
    if (/^https?:\/\//i.test(ref)) {
      return await fetchImageAsDataUrl(ref);
    }
    if (ref.startsWith("data:")) {
      return ref;
    }

    const abs = resolve(ref);
    if (!existsSync(abs)) {
      throw new Error(`Image not found: ${abs}`);
    }
    const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "image/png";
    // SVG embeds directly; every raster is sanitized through sharp (see
    // fetchImageAsDataUrl for why JPEG/PNG are no longer embedded verbatim).
    if (mime === "image/svg+xml") {
      return getLocalImageDataUrl(ref);
    }
    return await sanitizeToPngDataUrl(readFileSync(abs));
  } catch (err) {
    console.warn(
      `[resolveHeroImage] could not decode hero image (${ref}): ${
        err instanceof Error ? err.message : String(err)
      } — falling back to a placeholder hero.`,
    );
    return placeholderHeroDataUrl();
  }
}
