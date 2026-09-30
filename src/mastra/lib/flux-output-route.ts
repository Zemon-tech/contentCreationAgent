/**
 * Serves rendered Flux images from <project>/workspace/flux/output so the
 * agent can show them inline in Mastra Studio chat via Markdown:
 *   ![Generated image](http://localhost:4111/flux/output/Flux2_00001_.png)
 *
 * Read-only, image files only, and the file name is reduced to its basename
 * so nothing outside the output folder can be requested.
 */

import fs from "node:fs";
import path from "node:path";
import { registerApiRoute } from "@mastra/core/server";
import { fluxOutputDir } from "./flux-paths";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Public base URL of this Mastra server (what the browser uses). */
export function mastraPublicUrl(): string {
  return (process.env.MASTRA_PUBLIC_URL || "http://localhost:4111").replace(/\/+$/, "");
}

/** Browser-loadable URL for a file in the Flux output folder. */
export function fluxOutputUrl(fileName: string): string {
  return `${mastraPublicUrl()}/flux/output/${encodeURIComponent(path.basename(fileName))}`;
}

export const fluxOutputRoute = registerApiRoute("/flux/output/:file", {
  method: "GET",
  // Images are fetched by a plain <img> tag, which can't send auth headers.
  // The route is read-only and limited to image files in the output folder.
  requiresAuth: false,
  handler: async (c) => {
    const name = path.basename(c.req.param("file") ?? "");
    const mime = MIME[path.extname(name).toLowerCase()];
    const full = path.join(fluxOutputDir(), name);
    if (!name || !mime || !fs.existsSync(full)) {
      return c.json({ error: "Not found" }, 404);
    }
    return new Response(fs.readFileSync(full), {
      headers: { "Content-Type": mime, "Cache-Control": "public, max-age=3600" },
    });
  },
});
