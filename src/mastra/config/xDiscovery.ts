/**
 * X discovery subsystem configuration (Part B). The discovery run is a
 * SEPARATE schedule from the 30-60min news workflow: it scrapes X search +
 * promoted profiles on its own cadence, learns which accounts are high-signal,
 * and SAVES the resulting posts to storage. The main news workflow only ever
 * READS those saved posts (collectXPosts) and never triggers a live scrape.
 *
 * Everything tunable lives here with conservative defaults. Start tight and
 * loosen later: the whole subsystem is governed by a single feed-only switch
 *   X_DISCOVERY_ENABLED=false     # main workflow reads nothing; no scraper ref
 * plus per-session ceilings, a persisted daily budget, randomized pacing, query
 * cooldowns, and an escalating stop-cooldown ladder.
 *
 * Mirrors the env-helper + getXxxConfig() pattern in config/xAccounts.ts.
 */

export interface XDiscoveryConfig {
  /** Master switch. When false the main workflow reads nothing and no scrape runs. */
  enabled: boolean;
  /** Topics the query generator seeds from (order matters: sliced per session). */
  topics: string[];
  /** Target queries the generator should produce per topic. */
  queriesPerTopic: number;

  // --- per-session ceilings (conservative) ---
  maxTopicsPerSession: number;
  maxQueriesPerTopic: number;
  maxScrollsPerQuery: number;
  hardPostCapPerSession: number;
  /** If the Top tab returns fewer than this, do ONE secondary Latest pass. */
  topMinPosts: number;

  // --- persisted daily budget ---
  maxSearchLoadsPerDay: number;
  maxProfileVisitsPerDay: number;
  /** IANA tz the day boundary (budget reset) is computed in. */
  dayBoundaryTz: string;

  // --- randomized pacing (ms ranges / fractions) ---
  actionDelayMsRange: [number, number];
  queryDelayMsRange: [number, number];
  /** +/- fraction applied to the session start fire time. */
  startJitterPct: number;

  // --- cooldowns ---
  /** Don't re-run the same query within this many hours. */
  queryCooldownHours: number;
  /** Escalating cooldown (hours) on repeated stop conditions. */
  stopCooldownHoursLadder: number[];
  /** Abort the X branch after this many consecutive empty results. */
  consecutiveEmptyLimit: number;

  // --- learning / promotion thresholds ---
  promoteMinTimesSeen: number;
  promoteMinMedianLikes: number;
  promoteMinCredibility: number;
  demoteSpamCredibilityBelow: number;
  /** FIX #13: credibility floor for an account to count as "official". */
  officialMinCredibility: number;

  // --- profile pass ---
  profilePerVisitLimit: number;

  // --- lists ---
  blocklistHandles: string[];
  pinnedHandles: string[];

  // --- schedule / storage window ---
  intervalHours: number;
  /** Store-window filter for recentWithin reads (NOT the ranker's 24h drop). */
  savedPostMaxAgeHours: number;

  // --- scraper tunables passed through ---
  showMoreWaitMs: number;
  threadCap: number;
}

const DEFAULT_TOPICS: string[] = [
  "AI",
  "startups",
  "deeptech",
  "AI India",
  "Indian startups",
  "India deeptech",
];

function envFlag(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function envNum(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined) return dflt;
  const n = Number(v.trim());
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function envStr(name: string, dflt: string): string {
  const v = process.env[name];
  if (v === undefined) return dflt;
  const t = v.trim();
  return t ? t : dflt;
}

/** Parse "a, b c,@d" -> ["a","b","c","d"] (strip @, drop blanks, de-dupe). */
function parseList(raw: string | undefined, stripAt = true): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    let h = part.trim();
    if (stripAt) h = h.replace(/^@/, "");
    if (!h) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** Topics may contain spaces, so split on commas / newlines only. */
function parseTopics(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]+/)) {
    const t = part.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function envRange(name: string, dflt: [number, number]): [number, number] {
  const v = process.env[name];
  if (v === undefined) return dflt;
  const parts = v.split(/[\s,]+/).map((p) => Number(p.trim())).filter((n) => Number.isFinite(n));
  if (parts.length < 2) return dflt;
  const lo = Math.max(0, Math.min(parts[0]!, parts[1]!));
  const hi = Math.max(parts[0]!, parts[1]!);
  return [lo, hi];
}

function envLadder(name: string, dflt: number[]): number[] {
  const v = process.env[name];
  if (v === undefined) return dflt;
  const parts = v.split(/[\s,]+/).map((p) => Number(p.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return parts.length ? parts : dflt;
}

export function getXDiscoveryConfig(): XDiscoveryConfig {
  const topicsEnv = parseTopics(process.env.X_DISCOVERY_TOPICS);
  const topics = topicsEnv.length ? topicsEnv : DEFAULT_TOPICS;
  return {
    enabled: envFlag("X_DISCOVERY_ENABLED", true),
    topics,
    queriesPerTopic: envNum("X_DISCOVERY_QUERIES_PER_TOPIC", 2),

    maxTopicsPerSession: envNum("X_DISCOVERY_MAX_TOPICS_PER_SESSION", 3),
    maxQueriesPerTopic: envNum("X_DISCOVERY_MAX_QUERIES_PER_TOPIC", 2),
    maxScrollsPerQuery: envNum("X_DISCOVERY_MAX_SCROLLS_PER_QUERY", 2),
    hardPostCapPerSession: envNum("X_DISCOVERY_HARD_POST_CAP_PER_SESSION", 40),
    topMinPosts: envNum("X_DISCOVERY_TOP_MIN_POSTS", 8),

    maxSearchLoadsPerDay: envNum("X_DISCOVERY_MAX_SEARCH_LOADS_PER_DAY", 30),
    maxProfileVisitsPerDay: envNum("X_DISCOVERY_MAX_PROFILE_VISITS_PER_DAY", 20),
    dayBoundaryTz: envStr("X_DISCOVERY_DAY_BOUNDARY_TZ", "Asia/Kolkata"),

    actionDelayMsRange: envRange("X_DISCOVERY_ACTION_DELAY_MS_RANGE", [4000, 12000]),
    queryDelayMsRange: envRange("X_DISCOVERY_QUERY_DELAY_MS_RANGE", [30000, 90000]),
    startJitterPct: envNum("X_DISCOVERY_START_JITTER_PCT", 0.2),

    queryCooldownHours: envNum("X_DISCOVERY_QUERY_COOLDOWN_HOURS", 4),
    stopCooldownHoursLadder: envLadder("X_DISCOVERY_STOP_COOLDOWN_HOURS_LADDER", [12, 24, 48]),
    consecutiveEmptyLimit: envNum("X_DISCOVERY_CONSECUTIVE_EMPTY_LIMIT", 2),

    promoteMinTimesSeen: envNum("X_DISCOVERY_PROMOTE_MIN_TIMES_SEEN", 3),
    promoteMinMedianLikes: envNum("X_DISCOVERY_PROMOTE_MIN_MEDIAN_LIKES", 200),
    promoteMinCredibility: envNum("X_DISCOVERY_PROMOTE_MIN_CREDIBILITY", 6),
    demoteSpamCredibilityBelow: envNum("X_DISCOVERY_DEMOTE_SPAM_CREDIBILITY_BELOW", 2),
    officialMinCredibility: envNum("X_DISCOVERY_OFFICIAL_MIN_CREDIBILITY", 8),

    profilePerVisitLimit: envNum("X_DISCOVERY_PROFILE_PER_VISIT_LIMIT", 20),

    blocklistHandles: parseList(process.env.X_DISCOVERY_BLOCKLIST_HANDLES),
    pinnedHandles: parseList(process.env.X_DISCOVERY_PINNED_HANDLES),

    intervalHours: envNum("X_DISCOVERY_INTERVAL_HOURS", 6),
    savedPostMaxAgeHours: envNum("X_DISCOVERY_SAVED_POST_MAX_AGE_HOURS", 24),

    showMoreWaitMs: envNum("X_SCRAPE_SHOW_MORE_WAIT_MS", 800),
    threadCap: envNum("X_SCRAPE_THREAD_TEXTS_CAP", 5),
  };
}
