/**
 * Stable filesystem locations for the Flux.2 image agent.
 *
 * `mastra dev` runs the server with cwd = src/mastra/public (and `mastra
 * start` from .mastra/output), while `npm run inbox` runs from the project
 * root. Resolving paths from process.cwd() therefore sends the Studio intake,
 * the tools and the paste page to DIFFERENT folders. Everything here resolves
 * from the project root instead, so they all share one inbox.
 */

import fs from "node:fs";
import path from "node:path";

/** Walks up from cwd to the directory that has package.json AND src/mastra. */
export function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src", "mastra"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function fluxRoot(): string {
  return path.join(projectRoot(), "workspace", "flux");
}

/** Where pasted / attached reference images wait before upload to ComfyUI. Override with FLUX_INBOX_DIR. */
export function fluxInboxDir(): string {
  return process.env.FLUX_INBOX_DIR ? path.resolve(projectRoot(), process.env.FLUX_INBOX_DIR) : path.join(fluxRoot(), "inbox");
}

export function fluxReferenceDir(): string {
  return path.join(fluxRoot(), "references");
}

export function fluxOutputDir(): string {
  return path.join(fluxRoot(), "output");
}
