/**
 * X/Twitter accounts the auto-news-to-RAS pipeline watches as a LIVE news
 * signal, scraped for free through the logged-in automation browser (see
 * tools/x-tools.ts -> scrapeXPosts, lib/collect-x-posts.ts).
 *
 * These are treated as SIGNAL-ONLY sources, exactly like Hacker News / Reddit
 * in config/newsFeeds.ts: they may inform ranking (what's breaking, velocity)
 * but a post must never be cited as a story's primary source without
 * corroboration. The ranker and fact-pack already enforce that via the
 * signalOnly flag carried on each RawContent item.
 *
 * Edit the default list below, or override at runtime without touching code:
 *   X_WATCH_ACCOUNTS="OpenAI,sama,AnthropicAI"   # comma/space separated
 *   X_WATCH_ENABLED=false                          # turn the whole signal off
 *   X_WATCH_LIMIT=25                               # posts fetched per account
 */

export interface XWatchConfig {
  enabled: boolean;
  handles: string[];
  /** Posts fetched per account per run. */
  perAccountLimit: number;
  /** Scroll iterations ceiling passed to the scraper. */
  maxScrolls: number;
}

/** Default watch list: high-signal AI / startup accounts. Edit freely. */
const DEFAULT_HANDLES: string[] = [
  "OpenAI",
  "AnthropicAI",
  "GoogleDeepMind",
  "sama",
  "ycombinator",
];

function envFlag(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined) return dflt;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Parse "a, b c,@d" -> ["a","b","c","d"] (strip @, drop blanks, de-dupe). */
export function parseHandles(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const h = part.trim().replace(/^@/, "");
    if (!h) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function getXWatchConfig(): XWatchConfig {
  const fromEnv = parseHandles(process.env.X_WATCH_ACCOUNTS);
  const handles = fromEnv.length ? fromEnv : DEFAULT_HANDLES;
  return {
    // Default ON when a watch list exists, but easy to kill with X_WATCH_ENABLED=false.
    enabled: envFlag("X_WATCH_ENABLED", true) && handles.length > 0,
    handles,
    perAccountLimit: envInt("X_WATCH_LIMIT", 25),
    maxScrolls: envInt("X_WATCH_MAX_SCROLLS", 20),
  };
}
