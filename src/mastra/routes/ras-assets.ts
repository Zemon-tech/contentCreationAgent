/**
 * Serves rendered RAS graphic PNGs produced by the Satori render tools.
 *
 * URLs look like /ras-assets/<slug>/<file>.png and resolve against
 * <workspaceOutput>/ras/<slug>/<file>. Scoped narrowly (slug + png filename
 * only) so it cannot read arbitrary workspace files.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { registerApiRoute } from "@mastra/core/server";
import { getWorkspaceOutputRoot, sanitizeSlug } from "../renderer/output.js";

const PNG_FILENAME_PATTERN = /^[0-9a-z._-]+\.png$/i;

export const rasAssetRoute = registerApiRoute("/ras-assets/:slug/:filename", {
  method: "GET",
  handler: async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const filename = c.req.param("filename");

    if (!PNG_FILENAME_PATTERN.test(filename)) {
      return c.text("RAS asset not found", 404);
    }

    const rasRoot = path.join(getWorkspaceOutputRoot(), "ras");
    const slugDir = path.resolve(rasRoot, slug);
    const assetPath = path.resolve(slugDir, filename);

    // Defense in depth: keep params inside the slug folder.
    if (!assetPath.startsWith(`${slugDir}${path.sep}`)) {
      return c.text("RAS asset not found", 404);
    }

    try {
      const asset = await readFile(assetPath);
      const download = c.req.query("download") === "1";
      return c.body(asset, 200, {
        "Content-Type": "image/png",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
      });
    } catch {
      return c.text("RAS asset not found", 404);
    }
  },
});
