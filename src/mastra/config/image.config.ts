/**
 * image.config.ts — image sourcing + local storage knobs (Step 5).
 *
 * Images are downloaded to a LOCAL folder on the server (IMAGE_DIR). RAS reads
 * the local file path and composites the image INTO its rendered PNG, so
 * IMAGE_DIR does NOT need to be publicly served — only RAS's rendered output is
 * fetched by Instagram (via PUBLIC_BASE_URL + /ras-assets). We never generate
 * images for news posts (no Flux) and never mark an image as rights-cleared.
 */

import path from "node:path";

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface ImageConfig {
  /** Local folder for downloaded images. NOT publicly served. */
  imageDir: string;
  /** Delete downloaded images older than this (days). */
  retentionDays: number;
  /** Max bytes to download for one candidate. */
  maxDownloadBytes: number;
  downloadTimeoutMs: number;
  /** Instagram-friendly: short side should be >= this (flag if under). */
  minShortSidePx: number;
  /** Reject logos/tiny images below this on any side. */
  minAnySidePx: number;
  /** Crops "cleanly" to 4:5 / 1:1 only if aspect ratio is within these bounds. */
  minAspect: number;
  maxAspect: number;
  /** Exa image-search candidates to consider. */
  exaCandidates: number;
}

export const imageConfig: ImageConfig = {
  imageDir: process.env["IMAGE_DIR"]?.trim() || path.resolve(process.cwd(), "data", "images"),
  retentionDays: envNum("IMAGE_RETENTION_DAYS", 7),
  maxDownloadBytes: envNum("IMAGE_MAX_BYTES", 10 * 1024 * 1024),
  downloadTimeoutMs: envNum("IMAGE_DOWNLOAD_TIMEOUT_MS", 15000),
  minShortSidePx: envNum("IMAGE_MIN_SHORT_SIDE", 1080),
  minAnySidePx: envNum("IMAGE_MIN_ANY_SIDE", 400),
  minAspect: 0.5,
  maxAspect: 2.0,
  exaCandidates: envNum("IMAGE_EXA_CANDIDATES", 5),
};
