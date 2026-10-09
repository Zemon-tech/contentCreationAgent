/**
 * Asset path resolution for the Satori RAS renderer.
 *
 * Fonts and logos live under `src/mastra/assets/`. At dev/build time Mastra
 * bundles the server into `.mastra/output` and runs it from a different cwd
 * (Studio uses `src/mastra/public`), so a cwd-relative path like
 * `./assets/...` is unreliable. We instead resolve relative to THIS module's
 * own location and walk upward until we find the `src/mastra/assets` folder.
 * This works both when running the TS source directly (tsx) and from the
 * bundled output.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedAssetsDir: string | null = null;

/**
 * Resolves the absolute path to `src/mastra/assets`. Searches a set of
 * candidate roots derived from this module's directory and the cwd, picking
 * the first that actually exists.
 */
export function getAssetsDir(): string {
  if (cachedAssetsDir) return cachedAssetsDir;

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  const candidates: string[] = [
    // Running from TS source: .../src/mastra/renderer -> .../src/mastra/assets
    path.resolve(moduleDir, "..", "assets"),
    // Walk upward from the module looking for src/mastra/assets.
    ...ancestorsOf(moduleDir).map((dir) => path.join(dir, "src", "mastra", "assets")),
    // cwd-based fallbacks (project root, or Studio's src/mastra/public cwd).
    path.resolve(process.cwd(), "src", "mastra", "assets"),
    path.resolve(process.cwd(), "..", "assets"),
    path.resolve(process.cwd(), "assets"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedAssetsDir = candidate;
      return candidate;
    }
  }

  throw new Error(
    `Could not locate the RAS assets directory (src/mastra/assets). Looked in:\n` +
      candidates.map((c) => `  - ${c}`).join("\n") +
      `\nEnsure the fonts and logos are present under src/mastra/assets.`,
  );
}

export function getFontsDir(): string {
  return path.join(getAssetsDir(), "fonts");
}

export function getLogosDir(): string {
  return path.join(getAssetsDir(), "RAS-by-keilhq");
}

/** Absolute path to a named logo file in the RAS-by-keilhq folder. */
export function logoPath(filename: string): string {
  return path.join(getLogosDir(), filename);
}

/** Lists ancestor directories of `start`, closest first. */
function ancestorsOf(start: string): string[] {
  const result: string[] = [];
  let dir = start;
  while (true) {
    result.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return result;
}
