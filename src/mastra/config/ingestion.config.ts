/**
 * ingestion.config.ts — the ONE place to tune feed ingestion hygiene.
 *
 * Covers conditional GET, per-domain rate limiting, robots.txt policy,
 * feed-health auto-disable/re-probe, staleness, and the Google News fallback.
 * Change values here (or via the INGEST_* / FEED_* env vars); never hardcode.
 */

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export interface GoogleNewsLocale {
  hl: string;
  gl: string;
  ceid: string;
}

export interface IngestionConfig {
  /** Honest bot UA sent on every request. */
  userAgent: string;
  feedTimeoutMs: number;

  /** Conditional GET (ETag / If-Modified-Since). 304 counts as success. */
  conditionalGet: boolean;

  /** Per-domain minimum interval between requests (ms). */
  perDomainMinIntervalMs: number;

  robots: {
    enabled: boolean;
    /** Feeds: allow when robots.txt is unreachable / 5xx (fail-open). */
    feedFailOpen: boolean;
    /** Scraper: refuse when robots.txt is unreachable / 5xx (fail-closed); 404 = allowed. */
    scraperFailClosed: boolean;
    cacheTtlMs: number;
  };

  health: {
    /** Consecutive failures before auto-disabling a source. */
    autoDisableAfter: number;
    /** Hours to wait before re-probing an auto-disabled source. */
    reprobeHours: number;
    /** Newest item older than this many days => stale WARNING (not a failure). */
    staleDays: number;
  };

  googleNews: {
    enabled: boolean;
    /** Max items pulled from a fallback query per run. */
    maxItemsPerRun: number;
    /** Recency window token, e.g. "1d". */
    when: string;
    localeByRegion: Record<"US" | "IN" | "GLOBAL", GoogleNewsLocale>;
  };
}

export const ingestionConfig: IngestionConfig = {
  userAgent:
    process.env["INGEST_USER_AGENT"] ??
    "RAS-NewsRadar/1.0 (+https://example.com/bot; contact: admin@example.com; respects robots.txt)",
  feedTimeoutMs: envNum("FEED_FETCH_TIMEOUT_MS", 15000),

  conditionalGet: envBool("FEED_CONDITIONAL_GET", true),

  perDomainMinIntervalMs: envNum("FEED_PER_DOMAIN_MIN_INTERVAL_MS", 2000),

  robots: {
    enabled: envBool("FEED_ROBOTS_ENABLED", true),
    feedFailOpen: envBool("FEED_ROBOTS_FEED_FAIL_OPEN", true),
    scraperFailClosed: envBool("FEED_ROBOTS_SCRAPER_FAIL_CLOSED", true),
    cacheTtlMs: envNum("FEED_ROBOTS_CACHE_TTL_MS", 6 * 3_600_000),
  },

  health: {
    autoDisableAfter: envNum("FEED_AUTO_DISABLE_AFTER", 5),
    reprobeHours: envNum("FEED_REPROBE_HOURS", 24),
    staleDays: envNum("FEED_STALE_DAYS", 7),
  },

  googleNews: {
    enabled: envBool("GOOGLE_NEWS_FALLBACK_ENABLED", true),
    maxItemsPerRun: envNum("GOOGLE_NEWS_MAX_ITEMS", 10),
    when: process.env["GOOGLE_NEWS_WHEN"] ?? "1d",
    localeByRegion: {
      US: { hl: "en-US", gl: "US", ceid: "US:en" },
      IN: { hl: "en-IN", gl: "IN", ceid: "IN:en" },
      GLOBAL: { hl: "en-US", gl: "US", ceid: "US:en" },
    },
  },
};
