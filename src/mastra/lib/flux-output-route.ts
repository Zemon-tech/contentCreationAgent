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

const LOCALHOST_FALLBACK = "http://localhost:4111";
let warnedLocalhostFallback = false;

/**
 * Public base URL of this Mastra server — the URL a BROWSER uses to reach it.
 *
 * Image URLs (RAS assets, Flux output) are baked with this prefix and pasted
 * into chat as <img> tags, so it MUST be the externally reachable origin, not
 * the server's own loopback. On a deployed host (e.g. behind a cloudflared
 * tunnel) the viewer's browser is a DIFFERENT machine, so a `localhost` prefix
 * resolves to the viewer's own box and every image 404s.
 *
 * Set MASTRA_PUBLIC_URL to the public origin (scheme + host, optional port),
 * e.g. https://ras.yourdomain.com. We fall back to localhost only for local
 * dev and warn once so a missing value is obvious in a deployment's logs
 * instead of silently serving unreachable image URLs.
 */
export function mastraPublicUrl(): string {
  const configured = process.env.MASTRA_PUBLIC_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  if (!warnedLocalhostFallback) {
    warnedLocalhostFallback = true;
    console.warn(
      "[mastraPublicUrl] MASTRA_PUBLIC_URL is not set — falling back to " +
        `${LOCALHOST_FALLBACK}. Inline image URLs will only load on the same ` +
        "machine as this server. On a deployed host set MASTRA_PUBLIC_URL to " +
        "the public origin the browser uses (e.g. your cloudflared domain).",
    );
  }
  return LOCALHOST_FALLBACK;
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
