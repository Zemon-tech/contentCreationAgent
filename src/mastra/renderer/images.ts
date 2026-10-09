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
 * Formats Satori can embed directly in an <img>. Anything else (WebP, AVIF,
 * TIFF, BMP, ...) must be transcoded to PNG first — Satori silently renders
 * nothing for formats it cannot decode, which shows up as a blank image.
 */
const SATORI_SAFE_MIME = new Set(["image/png", "image/jpeg", "image/svg+xml"]);

/**
 * Transcodes a raster image buffer to a PNG data URL via sharp. Used for any
 * format Satori cannot decode natively (notably WebP, which is what news
 * sites commonly serve for hero images).
 */
async function transcodeToPngDataUrl(buffer: Buffer): Promise<string> {
  const png = await sharp(buffer).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
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

  // Satori cannot decode WebP/AVIF/etc. — transcode anything that isn't a
  // directly-embeddable format to PNG so the hero image actually renders.
  if (!SATORI_SAFE_MIME.has(contentType)) {
    return transcodeToPngDataUrl(buffer);
  }
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

/**
 * Resolves a hero image reference (local path OR http(s) URL) into a base64
 * data URL that Satori can embed.
 */
export async function resolveHeroImage(ref: string): Promise<string> {
  if (/^https?:\/\//i.test(ref)) {
    return fetchImageAsDataUrl(ref);
  }
  if (ref.startsWith("data:")) {
    return ref;
  }

  // Local file: transcode to PNG if it isn't a format Satori can embed.
  const abs = resolve(ref);
  if (!existsSync(abs)) {
    throw new Error(`Image not found: ${abs}`);
  }
  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "image/png";
  if (!SATORI_SAFE_MIME.has(mime)) {
    return transcodeToPngDataUrl(readFileSync(abs));
  }
  return getLocalImageDataUrl(ref);
}
