import { ingestionConfig, type IngestionConfig } from "../config/ingestion.config";

/**
 * politeFetch — conditional GET + per-domain rate limiting + robots.txt.
 *
 * - Per-domain minimum interval (serialized per host so concurrent workers
 *   don't burst a single site).
 * - robots.txt honored: fail-OPEN for feed fetches, fail-CLOSED for the article
 *   scraper (a robots 404 means "allowed"; unreachable/5xx means "refuse" for
 *   the scraper, "allow" for feeds). All policy comes from ingestion.config.ts.
 * - Conditional GET: pass the stored ETag / Last-Modified; a 304 is a SUCCESS
 *   with no new body (callers must not treat it as a failure).
 */

export type FetchMode = "feed" | "scraper";

export interface PoliteFetchArgs {
  mode: FetchMode;
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  config?: IngestionConfig;
}

export interface PoliteFetchResult {
  status: number | null;
  ok: boolean;
  body: string | null;
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  blockedByRobots: boolean;
  error?: string;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- per-domain throttle (serialized chain per host) ----------

const hostChains = new Map<string, Promise<number>>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function throttle(host: string, minMs: number): Promise<void> {
  const prev = hostChains.get(host) ?? Promise.resolve(0);
  const next = prev.then(async (lastAt) => {
    const wait = Math.max(0, lastAt + minMs - Date.now());
    if (wait > 0) await delay(wait);
    return Date.now();
  });
  hostChains.set(host, next);
  await next;
}

// ---------- robots.txt (cached per host) ----------

interface RobotsEntry {
  fetchedAt: number;
  /** null = unknown/unreachable; [] = allow all; list = Disallow prefixes. */
  disallow: string[] | null;
  status: number | null;
}
const robotsCache = new Map<string, RobotsEntry>();

/** True if `path` is disallowed by a set of Disallow prefixes. */
export function isPathDisallowed(disallow: string[], path: string): boolean {
  return disallow.some((d) => d === "/" || path.startsWith(d));
}

/** Minimal robots parser: Disallow prefixes for the `*` user-agent group. */
export function parseRobots(txt: string): string[] {
  const lines = txt.split(/\r?\n/);
  let inStar = false;
  const disallow: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") inStar = value === "*";
    else if (field === "disallow" && inStar && value) disallow.push(value);
  }
  return disallow;
}

async function getRobots(url: string, cfg: IngestionConfig): Promise<RobotsEntry> {
  const host = hostOf(url);
  const cached = robotsCache.get(host);
  if (cached && Date.now() - cached.fetchedAt < cfg.robots.cacheTtlMs) return cached;
  let entry: RobotsEntry;
  try {
    const origin = new URL(url).origin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${origin}/robots.txt`, {
      signal: controller.signal,
      headers: { "User-Agent": cfg.userAgent },
    }).finally(() => clearTimeout(timer));
    if (res.status === 404) entry = { fetchedAt: Date.now(), disallow: [], status: 404 };
    else if (res.ok) entry = { fetchedAt: Date.now(), disallow: parseRobots(await res.text()), status: res.status };
    else entry = { fetchedAt: Date.now(), disallow: null, status: res.status }; // 5xx/403 => unknown
  } catch {
    entry = { fetchedAt: Date.now(), disallow: null, status: null }; // unreachable
  }
  robotsCache.set(host, entry);
  return entry;
}

/** Decide if `url` may be fetched under `mode`, per robots policy. */
export async function robotsAllows(url: string, mode: FetchMode, cfg: IngestionConfig): Promise<boolean> {
  if (!cfg.robots.enabled) return true;
  const entry = await getRobots(url, cfg);
  if (entry.disallow === null) {
    // Unknown (unreachable / 5xx): mode-specific policy.
    return mode === "feed" ? cfg.robots.feedFailOpen : !cfg.robots.scraperFailClosed;
  }
  let path = "/";
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep "/" */
  }
  return !isPathDisallowed(entry.disallow, path);
}

// ---------- politeFetch ----------

export async function politeFetch(url: string, args: PoliteFetchArgs): Promise<PoliteFetchResult> {
  const cfg = args.config ?? ingestionConfig;
  const base: PoliteFetchResult = { status: null, ok: false, body: null, notModified: false, blockedByRobots: false };

  const allowed = await robotsAllows(url, args.mode, cfg).catch(() => args.mode === "feed" && cfg.robots.feedFailOpen);
  if (!allowed) return { ...base, blockedByRobots: true, error: "blocked by robots.txt" };

  await throttle(hostOf(url), cfg.perDomainMinIntervalMs);

  const headers: Record<string, string> = { "User-Agent": cfg.userAgent };
  if (cfg.conditionalGet) {
    if (args.etag) headers["If-None-Match"] = args.etag;
    if (args.lastModified) headers["If-Modified-Since"] = args.lastModified;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? cfg.feedTimeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    if (res.status === 304) {
      return { ...base, status: 304, ok: true, notModified: true, etag, lastModified };
    }
    if (!res.ok) return { ...base, status: res.status, error: `HTTP ${res.status}` };
    const body = await res.text();
    return { status: res.status, ok: true, body, notModified: false, etag, lastModified, blockedByRobots: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, error: /abort/i.test(msg) ? "timeout" : msg };
  } finally {
    clearTimeout(timer);
  }
}
