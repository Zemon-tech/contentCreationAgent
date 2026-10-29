/**
 * tunnel:keep — a self-healing Cloudflare quick-tunnel supervisor for the
 * Instagram publish proxy.
 *
 * WHY THIS EXISTS
 * ----------------
 * Instagram fetches slide images from PUBLIC_BASE_URL over the public
 * internet. In local dev that URL is a Cloudflare *quick* tunnel
 * (trycloudflare.com), which has two annoying properties:
 *   1. It has no uptime guarantee — Cloudflare expires it on its own schedule,
 *      and it dies when your machine sleeps or the network blips.
 *   2. Every restart mints a BRAND-NEW random hostname.
 * So every drop broke publishing until someone manually restarted the tunnel
 * and hand-edited PUBLIC_BASE_URL in .env.
 *
 * This supervisor removes all of that manual work:
 *   - starts (and owns) the publish:serve proxy on PUBLISH_PROXY_PORT (4112)
 *   - starts `cloudflared tunnel --url http://localhost:<port>`
 *   - parses the fresh hostname from cloudflared's output
 *   - rewrites PUBLIC_BASE_URL in .env automatically (preserving everything
 *     else in the file, byte-for-byte except that one line)
 *   - health-checks the public URL; if the tunnel dies or stops serving,
 *     it kills cloudflared, starts a new one, and rewrites .env again
 *
 * It does NOT give you a STABLE hostname (quick tunnels can't). It gives you
 * zero-touch recovery: you never edit .env or restart the tunnel by hand.
 *
 * IMPORTANT: the Mastra dev server (`npm run dev`) reads PUBLIC_BASE_URL once
 * at startup. When this supervisor rotates the URL, it prints a loud notice;
 * restart `npm run dev` to pick up the new value. (The published image URLs
 * are built at publish time from process.env, so a dev server that was started
 * AFTER the latest rotation is always correct.)
 *
 * USAGE
 *   npm run tunnel:keep
 * Leave it running in its own terminal alongside `npm run dev`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// --- config ---------------------------------------------------------------

const PROXY_PORT = Number(process.env.PUBLISH_PROXY_PORT) || 4112;
const ENV_PATH = path.resolve(process.cwd(), ".env");
const ENV_KEY = "PUBLIC_BASE_URL";
/** The exact asset path shape the publish proxy serves — used for health checks. */
const HEALTH_PATH_HINT = "/ras-publish/";
/** How often to health-check the public URL once it is up. */
const HEALTH_INTERVAL_MS = 20_000;
/** Consecutive failed health checks before we rotate the tunnel. */
const MAX_HEALTH_FAILURES = 2;
/** Matches the trycloudflare hostname cloudflared prints on startup. */
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

// --- small helpers ---------------------------------------------------------

function log(msg: string): void {
  console.log(`[tunnel-keeper] ${new Date().toISOString()} ${msg}`);
}

function banner(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = "=".repeat(width);
  console.log(`\n${bar}`);
  for (const l of lines) console.log(`  ${l}`);
  console.log(`${bar}\n`);
}

/**
 * Rewrites (or inserts) the PUBLIC_BASE_URL line in .env, leaving every other
 * line untouched. Returns the previous value so the caller can detect change.
 */
function setPublicBaseUrl(url: string): string | null {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`.env not found at ${ENV_PATH}`);
  }
  const raw = readFileSync(ENV_PATH, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const line = `${ENV_KEY}=${url}`;
  let previous: string | null = null;
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    // Match an uncommented assignment of the key (allow leading whitespace).
    const m = lines[i].match(/^\s*PUBLIC_BASE_URL\s*=(.*)$/);
    if (m) {
      previous = m[1].trim();
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(line);

  writeFileSync(ENV_PATH, lines.join(eol), "utf8");
  return previous;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** HEAD/GET the public base URL root; any HTTP response means the tunnel routes. */
async function tunnelResponds(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 12_000);
    // The root 404s (the proxy only serves /ras-publish/...), but a 404 is a
    // valid HTTP response proving the tunnel reaches the proxy. A network
    // failure (dead tunnel) throws instead.
    const res = await fetch(baseUrl, { method: "GET", signal: controller.signal });
    clearTimeout(t);
    return res.status > 0;
  } catch {
    return false;
  }
}

// --- process management -----------------------------------------------------

let proxyProc: ChildProcess | null = null;
let tunnelProc: ChildProcess | null = null;
let shuttingDown = false;

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function startProxy(): void {
  log(`starting publish proxy on port ${PROXY_PORT} …`);
  proxyProc = spawn(npmCmd, ["run", "publish:serve"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  proxyProc.stdout?.on("data", (d) => process.stdout.write(`[proxy] ${d}`));
  proxyProc.stderr?.on("data", (d) => process.stderr.write(`[proxy] ${d}`));
  proxyProc.on("exit", (code) => {
    if (shuttingDown) return;
    log(`publish proxy exited (code ${code}); restarting in 3s …`);
    proxyProc = null;
    setTimeout(startProxy, 3_000);
  });
}

/**
 * Starts cloudflared, resolves once the hostname has been parsed and written
 * to .env. Rejects if cloudflared exits before printing a hostname.
 */
function startTunnel(): Promise<string> {
  return new Promise((resolve, reject) => {
    log(`starting cloudflared quick tunnel -> http://localhost:${PROXY_PORT} …`);
    const proc = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${PROXY_PORT}`],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" },
    );
    tunnelProc = proc;

    let resolved = false;
    const onLine = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(`[cloudflared] ${text}`);
      const match = text.match(TUNNEL_URL_RE);
      if (match && !resolved) {
        resolved = true;
        const url = match[0];
        const previous = setPublicBaseUrl(url);
        if (previous !== url) {
          banner([
            "PUBLIC_BASE_URL was updated in .env:",
            `  old: ${previous ?? "(none)"}`,
            `  new: ${url}`,
            "",
            "RESTART `npm run dev` so the Mastra server picks up the new URL.",
          ]);
        } else {
          log(`tunnel hostname unchanged (${url}).`);
        }
        resolve(url);
      }
    };

    proc.stdout?.on("data", onLine);
    proc.stderr?.on("data", onLine);
    proc.on("exit", (code) => {
      if (!resolved) reject(new Error(`cloudflared exited (code ${code}) before printing a hostname`));
      if (shuttingDown) return;
      if (tunnelProc === proc) tunnelProc = null;
    });
  });
}

function stopTunnel(): void {
  if (tunnelProc) {
    log("stopping current cloudflared …");
    tunnelProc.kill();
    tunnelProc = null;
  }
}

async function rotateTunnel(): Promise<string> {
  stopTunnel();
  await sleep(1_500);
  return startTunnel();
}

// --- supervisor loop --------------------------------------------------------

async function main(): Promise<void> {
  banner([
    "tunnel-keeper: self-healing Cloudflare quick tunnel",
    `proxy port:   ${PROXY_PORT}`,
    `.env:         ${ENV_PATH}`,
    "",
    "Keep this running alongside `npm run dev`.",
    "It auto-rewrites PUBLIC_BASE_URL whenever the tunnel hostname changes.",
  ]);

  startProxy();
  await sleep(3_000); // give the proxy a moment to bind

  let baseUrl = await startTunnel();

  // Health-check loop: rotate the tunnel if it stops routing.
  let failures = 0;
  // eslint-disable-next-line no-constant-condition
  while (!shuttingDown) {
    await sleep(HEALTH_INTERVAL_MS);
    if (shuttingDown) break;

    const ok = await tunnelResponds(baseUrl);
    if (ok) {
      if (failures > 0) log(`tunnel healthy again (${baseUrl}).`);
      failures = 0;
      continue;
    }

    failures += 1;
    log(`health check failed (${failures}/${MAX_HEALTH_FAILURES}) for ${baseUrl}`);
    if (failures >= MAX_HEALTH_FAILURES) {
      log("tunnel appears dead — rotating …");
      try {
        baseUrl = await rotateTunnel();
        failures = 0;
      } catch (err) {
        log(`rotation failed: ${err instanceof Error ? err.message : String(err)}; retrying in 5s`);
        await sleep(5_000);
      }
    }
  }
}

// --- graceful shutdown ------------------------------------------------------

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down — stopping tunnel and proxy …");
  stopTunnel();
  if (proxyProc) proxyProc.kill();
  setTimeout(() => process.exit(0), 1_000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  shutdown();
});
