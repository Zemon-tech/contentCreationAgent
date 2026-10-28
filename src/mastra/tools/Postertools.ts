/**
 * RAS poster story tools — everything the agent needs between "scraper found a
 * story" and "render the template".
 *
 *  1. makeHeroCutout()      rectangular image -> transparent 1080x700 cutout
 *  2. loadLogoAsset()       load the black RAS logo once
 *  3. preparePosterStory()  cutout + copy checks -> props for RasPosterStoryTemplate
 *
 * Install:  npm i @imgly/background-removal-node sharp
 * Pair with: ../templates/RasPosterStoryTemplate.tsx and ras-logo-black.png.
 */

import fs from "node:fs/promises";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";
import { checkPosterCopy, type RasPosterStoryProps } from "../templates/RasPosterStoryTemplate.js";

// ==========================================================================
// 1. Hero cutout tool
// ==========================================================================
/**
 * Hero cutout tool for the RAS poster story template.
 *
 * Takes any rectangular image (scraped article photo, URL, file, buffer, data
 * URI) and produces what RasPosterStoryTemplate expects as `heroCutoutBase64`:
 *
 *   a 1080x700 transparent PNG, subject isolated, trimmed, scaled to fit and
 *   bottom-aligned, so the accent circle and smear behind it line up.
 *
 * Pipeline:
 *   load -> normalise (EXIF, size cap) -> background removal (local model,
 *   no API key, no per-image cost) -> drop stray specks -> trim to subject ->
 *   fit + bottom-align on a transparent canvas -> sanity checks.
 *
 * Install:  npm i @imgly/background-removal-node sharp
 * (The segmentation models ship inside the npm package, ~140 MB, no download
 * at runtime.)
 *
 * The tool never throws on a "bad" image; it returns `ok: false` plus warnings
 * so the agent can pick another image instead of publishing a broken post.
 * It does throw when the source cannot be loaded or decoded at all.
 */


export interface HeroCutoutOptions {
  /** Output canvas width. Must match the template's hero slot. Default 1080. */
  width?: number;
  /** Output canvas height. Must match the template's hero slot. Default 700. */
  height?: number;
  /** Empty space kept under the subject (the smear sits here). Default 24. */
  bottomPad?: number;
  /** Empty space kept left/right of the subject. Default 24. */
  sidePad?: number;
  /** Empty space kept above the subject. Default 0. */
  topPad?: number;
  /** "medium" = better edges, slower. "small" = faster. Default "medium". */
  model?: "small" | "medium";
  /** Long edge cap (px) before segmentation, for speed. Default 1600. */
  maxInput?: number;
  /** Below this fraction of the canvas, the subject counts as too small. Default 0.04. */
  minCoverage?: number;
  /** Drop disconnected blobs smaller than this fraction of the foreground. Default 0.01. */
  speckFraction?: number;
  /** Beyond this upscale factor the source is rejected as too low-res (ok=false). Default 4. */
  maxUpscale?: number;
}

export interface HeroCutoutResult {
  /** True when the cutout is usable. False = pick a different image. */
  ok: boolean;
  /** `data:image/png;base64,...` ready for `heroCutoutBase64`. */
  dataUri: string;
  png: Buffer;
  width: number;
  height: number;
  /** Fraction of the canvas covered by subject pixels. */
  coverage: number;
  /** Where the subject landed on the output canvas. */
  subjectBox: { left: number; top: number; width: number; height: number };
  /** Human-readable problems / things worth a look. */
  warnings: string[];
  /** True if the input already had a transparent background (model skipped). */
  alreadyCutout: boolean;
}

const DEFAULTS: Required<HeroCutoutOptions> = {
  width: 1080,
  height: 700,
  bottomPad: 24,
  sidePad: 24,
  topPad: 0,
  model: "medium",
  maxInput: 1600,
  minCoverage: 0.04,
  speckFraction: 0.01,
  maxUpscale: 4,
};

const MAX_BYTES = 25 * 1024 * 1024;
const ALPHA_VISIBLE = 24; // alpha above this counts as "subject"

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export async function makeHeroCutout(
  source: string | Buffer,
  opts: HeroCutoutOptions = {},
): Promise<HeroCutoutResult> {
  const o = { ...DEFAULTS, ...opts };
  const warnings: string[] = [];

  const raw = await loadSource(source);

  // 1. Normalise: honour EXIF rotation, cap size, force RGBA PNG.
  const base = await sharp(raw, { failOn: "none" })
    .rotate()
    .resize({ width: o.maxInput, height: o.maxInput, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .png()
    .toBuffer();

  // 2. Background removal (skipped when the input is already a cutout).
  const alreadyCutout = await hasRealTransparency(base);
  let cut: Buffer = base;
  if (!alreadyCutout) {
    const blob = await removeBackground(new Blob([new Uint8Array(base)], { type: "image/png" }), {
      model: o.model,
      output: { format: "image/png" },
    });
    cut = Buffer.from(await blob.arrayBuffer());
  }

  // 3. Raw pixels -> clean alpha -> bounding box.
  const { data, info } = await sharp(cut).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const fgCount = dropSpecks(data, w, h, o.speckFraction);
  const box = alphaBBox(data, w, h);

  if (!box || fgCount === 0) {
    warnings.push("no subject found in the image");
    return emptyResult(o, warnings, alreadyCutout);
  }

  // 4. Diagnostics on the source segmentation.
  const fgFraction = fgCount / (w * h);
  if (!alreadyCutout && fgFraction > 0.9) {
    warnings.push(
      "background removal kept almost the whole image (likely a graphic, screenshot or very busy photo)",
    );
  }
  const sides = touchedSides(box, w, h);
  if (sides >= 3) warnings.push("subject looks cropped by the image frame on several sides");
  const aspect = box.width / box.height;
  if (aspect > 3.5 || aspect < 0.35) {
    warnings.push(
      `subject has an unusual shape (aspect ${aspect.toFixed(2)}); circle and smear may not line up`,
    );
  }

  // 5. Trim, scale to fit, bottom-align on a transparent canvas.
  const trimmed = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .png()
    .toBuffer();

  const maxW = o.width - o.sidePad * 2;
  const maxH = o.height - o.topPad - o.bottomPad;
  const scale = Math.min(maxW / box.width, maxH / box.height);
  let ok = true;
  if (scale > o.maxUpscale) {
    ok = false;
    warnings.push(
      `source is too low-resolution: subject would need ${scale.toFixed(1)}x upscaling (max ${o.maxUpscale}x)`,
    );
  } else if (scale > 2) {
    warnings.push(`low-resolution source: subject upscaled ${scale.toFixed(1)}x, will look soft`);
  }
  const tw = Math.max(1, Math.round(box.width * scale));
  const th = Math.max(1, Math.round(box.height * scale));
  const resized = await sharp(trimmed).resize(tw, th, { kernel: "lanczos3" }).png().toBuffer();

  const left = Math.round((o.width - tw) / 2);
  const top = o.height - o.bottomPad - th;
  const png = await sharp({
    create: {
      width: o.width,
      height: o.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, left, top }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  // 6. Coverage check.
  const coverage = Math.min(1, (fgCount * scale * scale) / (o.width * o.height));
  if (coverage < o.minCoverage) {
    ok = false;
    warnings.push(
      `subject is too small on the canvas (${(coverage * 100).toFixed(1)}% < ${(o.minCoverage * 100).toFixed(0)}%)`,
    );
  }

  return {
    ok,
    dataUri: "data:image/png;base64," + png.toString("base64"),
    png,
    width: o.width,
    height: o.height,
    coverage,
    subjectBox: { left, top, width: tw, height: th },
    warnings,
    alreadyCutout,
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Accepts a Buffer, data URI (base64), http(s) URL, or local file path. */
async function loadSource(source: string | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(source)) return source;

  if (source.startsWith("data:")) {
    const comma = source.indexOf(",");
    if (comma < 0 || !source.slice(0, comma).includes(";base64")) {
      throw new Error("Only base64 data URIs are supported");
    }
    return Buffer.from(source.slice(comma + 1), "base64");
  }

  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; RAS-image-fetcher)" },
    });
    if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status} for ${source}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error(`Image too large (${declared} bytes)`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`Image too large (${buf.length} bytes)`);
    return buf;
  }

  return fs.readFile(source);
}

/** True when a meaningful share of pixels is already transparent. */
async function hasRealTransparency(png: Buffer): Promise<boolean> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let transparent = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 10) transparent++;
  return transparent / n > 0.05;
}

/**
 * Zeroes alpha on faint pixels and on disconnected blobs smaller than
 * `minFrac` of the total foreground. Mutates `data` (RGBA). Returns the number
 * of foreground pixels left.
 */
function dropSpecks(data: Buffer, w: number, h: number, minFrac: number): number {
  const n = w * h;
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const sizes: number[] = [0];
  let next = 0;
  let total = 0;

  for (let i = 0; i < n; i++) {
    if (label[i] || data[i * 4 + 3] <= ALPHA_VISIBLE) continue;
    next++;
    let sp = 0;
    stack[sp++] = i;
    label[i] = next;
    let size = 0;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      if (x > 0) {
        const q = p - 1;
        if (!label[q] && data[q * 4 + 3] > ALPHA_VISIBLE) {
          label[q] = next;
          stack[sp++] = q;
        }
      }
      if (x < w - 1) {
        const q = p + 1;
        if (!label[q] && data[q * 4 + 3] > ALPHA_VISIBLE) {
          label[q] = next;
          stack[sp++] = q;
        }
      }
      if (p >= w) {
        const q = p - w;
        if (!label[q] && data[q * 4 + 3] > ALPHA_VISIBLE) {
          label[q] = next;
          stack[sp++] = q;
        }
      }
      if (p < n - w) {
        const q = p + w;
        if (!label[q] && data[q * 4 + 3] > ALPHA_VISIBLE) {
          label[q] = next;
          stack[sp++] = q;
        }
      }
    }
    sizes.push(size);
    total += size;
  }

  const minSize = Math.max(minFrac * total, 32);
  const keep = sizes.map((s) => s >= minSize);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const l = label[i];
    if (l && keep[l]) {
      kept++;
    } else {
      data[i * 4 + 3] = 0;
    }
  }
  return kept;
}

function alphaBBox(
  data: Buffer,
  w: number,
  h: number,
): { left: number; top: number; width: number; height: number } | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > ALPHA_VISIBLE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** How many of the 4 image edges the subject box touches (within 2px). */
function touchedSides(
  box: { left: number; top: number; width: number; height: number },
  w: number,
  h: number,
): number {
  let s = 0;
  if (box.left <= 2) s++;
  if (box.top <= 2) s++;
  if (box.left + box.width >= w - 2) s++;
  if (box.top + box.height >= h - 2) s++;
  return s;
}

async function emptyResult(
  o: Required<HeroCutoutOptions>,
  warnings: string[],
  alreadyCutout: boolean,
): Promise<HeroCutoutResult> {
  const png = await sharp({
    create: {
      width: o.width,
      height: o.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  return {
    ok: false,
    dataUri: "data:image/png;base64," + png.toString("base64"),
    png,
    width: o.width,
    height: o.height,
    coverage: 0,
    subjectBox: { left: 0, top: 0, width: 0, height: 0 },
    warnings,
    alreadyCutout,
  };
}


// ==========================================================================
// 2 + 3. Brand asset loader and template-props builder
// ==========================================================================
/**
 * Glue between the scraper/agent output and RasPosterStoryTemplate.
 *
 * Input:  whatever the agent produced for one story (a rectangular hero image
 *         plus three headline lines).
 * Output: ready-to-render template props, plus a list of problems so the agent
 *         can fix copy or choose another image BEFORE rendering.
 *
 * Usage:
 *   const brand = await loadLogoAsset("assets/ras-logo-black.png");   // once
 *   const { props, ready, problems } = await preparePosterStory(story, brand);
 *   if (!ready) { ...ask copywriter for shorter lines / pick another image... }
 *   const svg = await satori(<RasPosterStoryTemplate {...props} />, satoriOpts);
 */


export interface PosterStoryInput {
  /** Rectangular image: URL, local path, data URI or Buffer. Cutout is made automatically. */
  heroSource: string | Buffer;
  headlineTop: string;
  headlineMid: string;
  headlineHighlight: string;
  categoryTag?: string;
  accentColor?: string;
  /** Override cutout behaviour (padding, model, ...). Rarely needed. */
  cutout?: HeroCutoutOptions;
}

export interface BrandAssets {
  logoBase64: string;
  logoWidth: number;
  logoHeight: number;
}

export interface PreparedPoster {
  /** Pass straight to <RasPosterStoryTemplate {...props} />. Always populated. */
  props: RasPosterStoryProps;
  /** True when both the copy and the cutout passed their checks. */
  ready: boolean;
  /** Everything worth fixing, as plain sentences. Empty when ready. */
  problems: string[];
  /** Cutout diagnostics (without the heavy PNG buffers). */
  hero: Omit<HeroCutoutResult, "png" | "dataUri">;
}

/** Load the black transparent RAS logo once and keep it for every post. */
export async function loadLogoAsset(filePath: string): Promise<BrandAssets> {
  const buf = await fs.readFile(filePath);
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) throw new Error(`Cannot read logo dimensions: ${filePath}`);
  return {
    logoBase64: "data:image/png;base64," + buf.toString("base64"),
    logoWidth: meta.width,
    logoHeight: meta.height,
  };
}

export async function preparePosterStory(
  input: PosterStoryInput,
  brand: BrandAssets,
): Promise<PreparedPoster> {
  const copyIssues = checkPosterCopy(input);
  const hero = await makeHeroCutout(input.heroSource, input.cutout);

  const problems = [...copyIssues, ...hero.warnings.map((w) => `hero image: ${w}`)];

  const props: RasPosterStoryProps = {
    heroCutoutBase64: hero.dataUri,
    headlineTop: input.headlineTop,
    headlineMid: input.headlineMid,
    headlineHighlight: input.headlineHighlight,
    categoryTag: input.categoryTag,
    accentColor: input.accentColor,
    logoBase64: brand.logoBase64,
    logoWidth: brand.logoWidth,
    logoHeight: brand.logoHeight,
  };

  const { png: _png, dataUri: _uri, ...heroInfo } = hero;
  return {
    props,
    ready: copyIssues.length === 0 && hero.ok,
    problems,
    hero: heroInfo,
  };
}