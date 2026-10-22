/**
 * Output location for rendered RAS graphics.
 *
 * PNGs are written under the Mastra workspace output folder so the asset
 * route (routes/ras-assets.ts) can serve them for inline Studio preview and,
 * when PUBLIC_BASE_URL is set, for Instagram to fetch.
 *
 * Layout: <workspaceOutput>/ras/<slug>/<file>.png
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mastraPublicUrl } from "../lib/flux-output-route.js";

const RAS_SUBDIR = "ras";

/** Finds the workspace/output root the server actually serves from. */
export function getWorkspaceOutputRoot(): string {
  // Explicit override so every process (the Mastra dev server that renders and
  // the standalone publish:serve proxy) resolves the SAME root. Without this
  // they can disagree — the renderer writes under src/mastra/public/... while a
  // proxy started from the repo root picks ./workspace/output — and Instagram
  // then fetches a 404 ("Only photo or video can be accepted as media type").
  const override = process.env.RAS_OUTPUT_ROOT?.trim();
  if (override) return path.resolve(override);

  const cwdCandidate = path.resolve(process.cwd(), "workspace", "output");
  if (existsSync(cwdCandidate)) return cwdCandidate;

  // Walk upward from this module looking for an existing workspace/output.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = moduleDir;
  while (true) {
    const candidate = path.join(dir, "workspace", "output");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Default to the cwd candidate (will be created on demand).
  return cwdCandidate;
}

/** Returns (and creates) the output directory for a given deck/post slug. */
export function ensureRasOutputDir(slug: string): string {
  const safeSlug = sanitizeSlug(slug);
  const dir = path.join(getWorkspaceOutputRoot(), RAS_SUBDIR, safeSlug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Server-relative path for a rendered RAS asset (used for the Instagram
 * publish mapping against PUBLIC_BASE_URL).
 */
export function rasAssetPath(slug: string, filename: string): string {
  return `/ras-assets/${encodeURIComponent(sanitizeSlug(slug))}/${encodeURIComponent(filename)}`;
}

/**
 * Absolute, browser-loadable view URL for a rendered RAS asset
 * (e.g. http://localhost:4111/ras-assets/<slug>/<file>.png). Absolute so the
 * model/markdown renderer cannot mangle a leading-slash relative path into a
 * bogus hostname.
 */
export function rasViewUrl(slug: string, filename: string): string {
  return `${mastraPublicUrl()}${rasAssetPath(slug, filename)}`;
}

/** Restricts a slug to filesystem/URL-safe characters. */
export function sanitizeSlug(slug: string): string {
  const cleaned = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "ras-post";
}
