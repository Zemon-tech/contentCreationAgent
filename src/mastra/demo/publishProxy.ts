/**
 * publish:serve — a tiny, read-only static server that serves ONLY the JPEG
 * copies of rendered posts, at /ras-publish/<slug>/<file>.jpg, straight from
 * disk. Point your tunnel / reverse proxy at THIS (default port 4112), never at
 * the Mastra server (4111): Mastra also serves agent and workflow endpoints, so
 * exposing it would let anyone who finds the URL run them (spending your model
 * credits) or trigger a publish.
 *
 *   npm run publish:serve
 *   cloudflared tunnel --url http://localhost:4112
 *   # then PUBLIC_BASE_URL=https://<tunnel-host>   (no trailing slash)
 *
 * Binds 127.0.0.1 only, GET/HEAD only, one URL shape, .jpg only, no listing.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getWorkspaceOutputRoot, sanitizeSlug } from "../renderer/output";

const PORT = Number(process.env.PUBLISH_PROXY_PORT) || 4112;
const URL_SHAPE = /^\/ras-publish\/([0-9a-z._-]+)\/([0-9a-z._-]+\.jpe?g)$/i;

export function resolvePublishFile(urlPath: string, root: string): string | null {
  const m = URL_SHAPE.exec(urlPath);
  if (!m) return null;
  const slugDir = path.resolve(root, "ras", sanitizeSlug(m[1]!));
  const file = path.resolve(slugDir, m[2]!);
  return file.startsWith(`${slugDir}${path.sep}`) ? file : null;
}

export function createPublishServer(root: string = getWorkspaceOutputRoot()): http.Server {
  return http.createServer(async (req, res) => {
    const notFound = () => { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); };
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return; }
    const urlPath = decodeURIComponent((req.url ?? "").split("?")[0]!);
    const file = resolvePublishFile(urlPath, root);
    if (!file) return notFound();
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": data.length,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=300",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      notFound();
    }
  });
}

// Run directly (not when imported by tests).
if (process.argv[1] && /publishProxy\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  createPublishServer().listen(PORT, "127.0.0.1", () => {
    console.log(`publish:serve listening on http://127.0.0.1:${PORT}  (serving only /ras-publish/<slug>/<file>.jpg from ${getWorkspaceOutputRoot()})`);
    console.log(`Expose THIS port with your tunnel, not 4111.`);
  });
}
