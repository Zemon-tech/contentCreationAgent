/**
 * Serves the JPEG copies of rendered RAS posts at
 *   /ras-publish/<slug>/<file>.jpg
 * Instagram requires JPEG, while RAS's own route (routes/ras-assets.ts) serves
 * PNG only. This is a separate, additive route so RAS's route is not modified.
 * Scoped narrowly (slug + .jpg filename only, inside workspace/output/ras) so it
 * cannot read arbitrary files. Expose ONLY /ras-publish/* (and nothing else of
 * this server) to the internet.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { registerApiRoute } from "@mastra/core/server";
import { getWorkspaceOutputRoot, sanitizeSlug } from "../renderer/output.js";

const JPEG_FILENAME_PATTERN = /^[0-9a-z._-]+\.jpe?g$/i;

export const rasPublishRoute = registerApiRoute("/ras-publish/:slug/:filename", {
  method: "GET",
  handler: async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const filename = c.req.param("filename");
    if (!JPEG_FILENAME_PATTERN.test(filename)) return c.text("Not found", 404);

    const slugDir = path.resolve(getWorkspaceOutputRoot(), "ras", slug);
    const assetPath = path.resolve(slugDir, filename);
    if (!assetPath.startsWith(`${slugDir}${path.sep}`)) return c.text("Not found", 404);

    try {
      const asset = await readFile(assetPath);
      return c.body(asset, 200, {
        "Content-Type": "image/jpeg",
        "Content-Disposition": `inline; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=300",
      });
    } catch {
      return c.text("Not found", 404);
    }
  },
});
