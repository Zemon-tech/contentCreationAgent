# Technical Design — X Topic-Driven Discovery, Scraper Enrichment, Quality-First Ranking, and Payload Extensions

## Overview

This design implements the five coordinated changes in `01-requirements.md` against the existing Mastra (TypeScript) + Python CDP pipeline. The spine is unchanged: `scrape.py` (Python CDP-over-`websockets`) harvests X posts, `x-publisher.ts` shells out to it, `collect-x-posts.ts` maps posts to `RawContent`, `rankStories.ts` ranks, and `autoNewsToRas.ts` builds the `RasPayload`. The work is additive to the RSS path and introduces a **separate X discovery subsystem** that runs on its own 6-hour cron, persists its results, and is the only thing that ever drives a live scrape. The main workflow becomes a pure reader of saved posts.

The locked technology stack: **TypeScript (ES2022, NodeNext)** for all Mastra code; **Python 3.14 + `websockets`** for scraping (no Playwright/Selenium — the existing CDP driver is the "Playwright-style persistent profile" the request refers to); **Zod 4** for schemas; **libSQL** via the existing `createLibSqlRepository<T>` generic repository for persistence, each store wrapped in an injectable gateway with an in-memory stub mirroring `RankStorageGateway`/`createStubGateway`; **node:test + node:assert/strict** for tests run through the explicit file list in `package.json`'s `test` script; **tsx** for crons and demos. No new npm dependencies are added. Nothing is locked beyond what the requirements already fix.

The strict boundary from NFR-2 is preserved everywhere: **the LLM judges meaning and writes query strings + derived headlines; code decides every number** (ranking, promotion/demotion, budgets, selection, pacing). The LLM never emits a handle and never emits a final score.

Cross-subsystem interactions resolved here: (1) the X schedule writes a `saved_x_posts` store that the main workflow reads via a rewritten `collectXPosts`; (2) per-account engagement medians flow from `discovered_accounts` into Stage C relative-engagement scoring; (3) corroboration reuses the existing `canonicalKey` so cluster ids are stable between the X schedule and the main run; (4) all X persistence is reached through injectable gateways so tests and the dry-run stay offline.

---

## Part A — Scraper enrichment (`scrape.py`, `x-publisher.ts`, `collect-x-posts.ts`)

### A.1 `scrape.py` — `HARVEST_JS` additions

`HARVEST_JS` is the single DOM-extraction function. It gains four fields per `article[data-testid="tweet"]`, extracted with the same resilience pattern already used (optional chaining, empty defaults, never throw). The existing fields (`text`, `url`, `author_handle`, `at`, `is_reply`, `is_repost`, `replies`, `reposts`, `likes`, `views`) are unchanged.

**outbound_urls (FR-A1).** Inside each article, iterate `a[href]` anchors within the tweet text/card region. For each anchor resolve the real destination in the DOM without a network call: X renders the expanded URL as the anchor's visible text (e.g. `techcrunch.com/...`) while `href` is a `t.co` shortlink. The extraction prefers, in order: (a) the anchor's `title` attribute if it is an absolute URL; (b) a `https://` URL reconstructed from the anchor's visible `innerText` (X shows `display` + `…` — strip the ellipsis and trailing `…`); (c) the raw `href`. Because X truncates long display URLs with `…`, any candidate still containing `…` or lacking a TLD is treated as unresolved and kept as the raw `t.co` href (so the TS layer/test can still see it). Links whose resolved host matches `x.com`/`twitter.com`/`t.co`-that-stayed-unresolved-to-x are dropped. Dedupe, return `string[]`, empty array when none. **No redirect-following in the browser** (following redirects risks a navigation that kills the harvest tab per the `open_page` comment); resolution is DOM-only. The "or by following the redirect" clause in FR-A1 is satisfied at the TS mapping layer as a pure, testable fallback (see A.3) — not in the harvester — which also keeps FR-E3 a pure no-network function.

**text_truncated + Show more (FR-A2).** Detect a `[data-testid="tweet-text-show-more-link"]` / a `button`/`div` whose text matches `/show more/i` inside the tweet text block. The harvester cannot reliably click-and-wait inside the batched eval, so expansion is attempted once per scroll pass with a dedicated step: before harvesting, a small JS pass clicks every visible "Show more" control (`el.click()`), then waits ~800ms (a config-driven `showMoreWaitMs`) for the DOM to re-render the full text, then harvests. If after that pass the control is still present on an article, that article's `text_truncated` is `true`; otherwise `false`. This keeps the "try to expand, record truncated when it cannot" contract (AC-2) without any per-article async in the harvest loop.

**quoted (FR-A3).** A quoted tweet renders as a nested `div[role="link"]` containing its own `[data-testid="tweetText"]`, a `time`, and an author span. Extract `{ text, author_handle, url, at }` from that nested node; `url` is reconstructed from the nested `a[href*="/status/"]`; `author_handle` from the `@…` in the nested header. Return `quoted: {…} | null`. Guard against counting the quoted node's own metrics as the outer tweet's (scope the metric/anchor queries to the outer article but exclude the nested quote subtree via `:not()` / an explicit skip when walking).

**thread_texts (FR-A4).** Self-thread detection happens in `scrape_user` (Python, not JS), because it spans multiple articles. After harvesting the collected posts for a profile/search, when a post is the first of a run of consecutive same-`author_handle` posts that X renders as a connected thread (the `[data-testid="tweet"]` articles joined by the thread connector line — detectable via the presence of a following article by the same author with no intervening `socialContext`), collect up to `threadCap` (config, default 5) following posts' `text` into `thread_texts: string[]`. Non-first posts in the thread are still returned as their own posts (dedup by URL handles overlap); only the first carries `thread_texts`. Threads by other authors yield `[]`. This is best-effort: if the connector cannot be determined, `thread_texts` is `[]` (never an error).

**Explicitly skipped (FR-A5).** No media URLs, no display names. (FR-A6) `is_reply`/`is_repost` stay.

The new search entrypoint and session discipline (budgets, pacing, stop conditions) live in Part B; A.1 is purely the per-post field extraction shared by both the profile scraper and the search scraper.

### A.2 `ScrapedXPost` type (`x-publisher.ts`)

Extend the interface additively:

```ts
export interface QuotedXPost { text: string; author_handle: string | null; url: string; at: string; }
export interface ScrapedXPost {
  // …existing fields unchanged…
  outbound_urls: string[];       // default []
  text_truncated: boolean;       // default false
  quoted: QuotedXPost | null;    // default null
  thread_texts: string[];        // default []
}
```

`scrapeXPosts()` already passes `parsed.posts` through untouched, so the only change is normalizing legacy/old-shape posts: a small `normalizeScrapedPost(raw): ScrapedXPost` applies the defaults above (`outbound_urls ?? []`, `text_truncated ?? false`, `quoted ?? null`, `thread_texts ?? []`) so a pre-enrichment payload still maps cleanly (AC-5). This normalizer is exported for the Part E unit test.

### A.3 `RawContent` mapping (`collect-x-posts.ts`)

`postToRaw` is extended to thread the new fields through. First-class additions and `metadata`:

- `metadata.outboundUrls: string[]` — resolved outbound URLs (see below).
- `metadata.quoted: QuotedXPost | null`.
- `metadata.threadTexts: string[]`.
- `metadata.textTruncated: boolean`.
- `metadata.isRepost` / `metadata.isReply` — kept as today.
- `metadata.engagementRaw: { likes, reposts, replies, views }` — the raw counts preserved for Stage C relative-engagement scoring (the existing `engagement` block stays for back-compat with the image/UI path).

**t.co fallback resolution (pure, testable — FR-A1 "or by following the redirect").** A pure function `resolveOutboundUrls(urls: string[], opts?): string[]` normalizes/expands the harvester's `outbound_urls`: strips tracking params, lowercases host, drops `x.com`/`twitter.com`/`t.co` hosts, dedupes. It accepts an optional injected `expand(tco) => string | null` map so a test can simulate "t.co → real destination" with **no network** (FR-E3). The real collector passes the identity/empty expander (the harvester already resolved via DOM); the function exists so link expansion is unit-testable as a pure mapping over sample data. This is the function Part E's FR-E3 test targets.

The content-length / signalOnly behavior is unchanged except that the new X-specific hard filter in Part C (not the mapping) now owns the "bare one-liner with no source" rejection; the mapping keeps a minimal non-empty guard so that an outbound-only post with short text still survives to the ranker (which applies the real rule). `signalOnly: true` stays on every X item.

**Edge cases:** a post with `quoted` but empty outer text still maps (the quote gives context); a post with only `thread_texts` beyond the first is deduped by URL; unparseable `at` → omit `publishedAt` (as today).

---

## Part B — Topic-driven discovery, schedule, budget, health

This is the largest new subsystem. It is a **separate module tree** under `src/mastra/lib/x-discovery/` plus one config file, three gateways, one Python search entrypoint, and one cron runner. The main workflow never calls into it live.

### B.1 Config — `src/mastra/config/xDiscovery.ts`

A single config object, every number env-overridable and **conservative by default** (NFR-5, FR-B17). Shape (defaults shown; all via `envNum`/`envFlag` helpers mirroring `xAccounts.ts`):

```ts
export interface XDiscoveryConfig {
  enabled: boolean;                 // X_DISCOVERY_ENABLED, default true
  topics: string[];                 // AI, startups, deeptech + India variants
  queriesPerTopic: number;          // 2  (FR-B2)
  // per-session ceilings (FR-B11)
  maxTopicsPerSession: number;      // 3
  maxQueriesPerTopic: number;       // 2
  maxScrollsPerQuery: number;       // 2
  hardPostCapPerSession: number;    // 40
  topMinPosts: number;              // Latest-pass trigger threshold (FR-B3), default 8
  // daily budget (FR-B12)
  maxSearchLoadsPerDay: number;     // 30
  maxProfileVisitsPerDay: number;   // 20
  dayBoundaryTz: string;            // "Asia/Kolkata" (A10: India focus) — configurable
  // pacing (FR-B13)
  actionDelayMsRange: [number, number];   // [4000, 12000]
  queryDelayMsRange: [number, number];    // [30000, 90000]
  startJitterPct: number;                 // 0.20
  // cooldowns (FR-B14, FR-B15)
  queryCooldownHours: number;       // 4
  stopCooldownHoursLadder: number[];// [12, 24, 48]
  consecutiveEmptyLimit: number;    // 2
  // learning thresholds (FR-B5)
  promoteMinTimesSeen: number;      // 3
  promoteMinMedianLikes: number;    // 200
  demoteSpamCredibilityBelow: number; // e.g. 2
  // profile re-scrape (FR-B6)
  profileVisitPerDay: number;       // 1 per promoted handle
  profilePerVisitLimit: number;     // posts per profile scrape, e.g. 20
  // lists (FR-B7)
  blocklistHandles: string[];       // optional, default []
  pinnedHandles: string[];          // optional, default []
  // schedule (FR-B8)
  intervalHours: number;            // 6
  // freshness contract for saved posts (A5)
  savedPostMaxAgeHours: number;     // 24, matches ranking maxAgeHours
}
```

`getXDiscoveryConfig()` returns the merged object. Topics default to: `"AI"`, `"startups"`, `"deeptech"`, `"AI India"`, `"Indian startups"`, `"India deeptech"`. The old `xAccounts.ts` static list is retained for back-compat but the discovery path does not use it for guessing; `pinned_handles` supersedes it as the explicit-source mechanism (A7).

### B.2 Query generation — LLM behind an injectable fn (FR-B2, A6, NFR-2)

`src/mastra/lib/x-discovery/queryGen.ts` exports:

```ts
export type QueryGenerate = (prompt: string) => Promise<{ text: string }>;
export async function generateQueries(topics: string[], opts: { generate?: QueryGenerate; config?: XDiscoveryConfig; log?: Logger }): Promise<Map<string, string[]>>;
```

Mirrors `RankGenerate`: the default generator uses an agent (**reuse `rankScoringAgent`'s model resolution** via a new tiny agent `xQueryAgent` with its own instruction, registered in `index.ts` — the model is the project small model, no new provider). The LLM returns **query strings only**, validated by a Zod schema `z.object({ queries: z.array(z.string()).length(config.queriesPerTopic) })` per topic, parsed with `extractJson` + `safeParse` + retry-once, exactly like `scoreItems`. **Guard (NFR-2):** each returned string is post-processed in code to strip any `@handle` / `from:` tokens so the LLM can never inject a handle; if a topic fails validation after retry, code falls back to a deterministic template query (`(topic) min_faves:300 filter:links -filter:replies lang:en`) so discovery never blocks. Each query is forced to contain the engagement filters in code (appended if missing) to satisfy AC-6 deterministically regardless of model wording. The dry-run/tests inject a heuristic `generate` returning fixed strings.

### B.3 Python search entrypoint (FR-B3, FR-B4, A9)

Add a `search` subcommand to `scrape.py` (not a new script — keeps the `_wait_login`, `ensure_chrome`, `_open`, `HARVEST_JS`, stop-condition detectors in one place). Signature:

```
python scrape.py search --query "<q>" --tab top|latest --max-scrolls 2 --limit 40 --json-only
```

It opens `https://x.com/search?q=<url-encoded q>&src=typed_query&f=top` (or `&f=live` for Latest), reuses `settle_page` + `_wait_login`, then runs the **same scroll+HARVEST_JS loop** as `scrape_user` (so FR-B4/A.1 enrichment applies identically), capped by `--max-scrolls` (the ≤2-scroll ceiling, A9) and `--limit`. The Top-vs-Latest decision (FR-B3) is made in **TypeScript**, not Python: the orchestrator first calls `--tab top`; if `count < topMinPosts`, it issues a second `--tab latest` call. `scrape.py search` returns `{ query, tab, count, posts: [...] }` or `{ error, stop_reason }`.

**Stop-condition detection (FR-B15)** is added to `scrape.py` as a `detect_block(page)` JS probe run after `settle_page`, returning `{ login_wall, captcha, unusual_activity, http_429 }` by testing: the existing login-form selector (`_wait_login`), presence of an iframe/div matching arkose/captcha testids or text `/verify you.?re human|are you a robot/i`, body text `/unusual activity|suspicious/i`, and (for 429) a page whose body is empty + title/text matching `/rate limit|too many requests/i`. When any is true, `scrape.py` returns `{ error: "blocked", stop_reason: "<which>" }` and **does not scroll further** (never retries in the same session, never attempts to solve — the login/captcha is simply reported). HTTP 429 at the CDP level is also surfaced if `Network` events are available, but the text probe is the reliable floor.

### B.4 `x-publisher.ts` — `searchXPosts()`

A new exported function parallel to `scrapeXPosts`:

```ts
export interface XSearchResult { success: boolean; query: string; tab: "top"|"latest"; count: number; posts: ScrapedXPost[]; stopReason?: XStopReason; error?: string; }
export async function searchXPosts(opts: { query: string; tab: "top"|"latest"; maxScrolls: number; limit: number }): Promise<XSearchResult>;
```

Same `execFile` + JSON-parse + fail-soft pattern as `scrapeXPosts`. `stopReason` is a typed enum `"login_wall" | "captcha" | "unusual_activity" | "http_429" | "empty"`. Posts run through `normalizeScrapedPost` (A.2).

### B.5 Gateways + stores (FR-B16, NFR-4)

Three new gateways under `src/mastra/lib/x-discovery/stores/`, each an interface + a libSQL impl (via `createLibSqlRepository<T>("<table>")`) + an in-memory stub, **mirroring `RankStorageGateway`/`createStubGateway` exactly**.

1. **`DiscoveredAccountsGateway`** (table `discovered_accounts`, row keyed by lowercased `handle`):
   ```ts
   interface DiscoveredAccount {
     id: string;            // = handle.toLowerCase()
     handle: string; firstSeen: string; timesSeen: number;
     medianLikes: number; medianReposts: number;
     credibilityScore: number;      // 0..10, code-derived
     status: "candidate" | "promoted" | "demoted";
     recentLikes: number[];         // rolling sample (cap ~20) for median/relative-engagement (A4)
     lastProfileVisitDay?: string;  // YYYY-MM-DD in dayBoundaryTz (FR-B6)
   }
   interface DiscoveredAccountsGateway {
     get(handle): Promise<DiscoveredAccount | undefined>;
     upsertFromScrape(handle, samples: {likes:number;reposts:number}[], now): Promise<DiscoveredAccount>;
     list(): Promise<DiscoveredAccount[]>;
     markProfileVisited(handle, day): Promise<void>;
   }
   ```
   `upsertFromScrape` is where **learning** happens (code, not LLM): increment `timesSeen`, append samples (cap the array), recompute medians, recompute `credibilityScore` and `status` via pure functions (B.6). A handle is only ever written here, from a real scrape result (AC-8) — nothing else creates rows.

2. **`XScrapeHealthGateway`** (table `x_scrape_health`, single row id `"health"`):
   ```ts
   interface XScrapeHealth {
     id: "health"; lastRunAt?: string; lastStopReason?: XStopReason | null;
     cooldownUntil?: string | null; cooldownLadderIndex: number; consecutiveEmpty: number;
     lastQueryRunAt: Record<string, string>; // queryString -> ISO, for the 4h cooldown (FR-B14)
   }
   interface XScrapeHealthGateway { load(): Promise<XScrapeHealth>; save(h): Promise<void>; }
   ```
   Escalating cooldown (FR-B15): on a stop condition, set `cooldownUntil = now + ladder[min(cooldownLadderIndex, len-1)]`, increment `cooldownLadderIndex`. A fully clean run with posts resets `cooldownLadderIndex = 0` and `consecutiveEmpty = 0`. `consecutiveEmpty` increments on empty results and triggers a stop at `consecutiveEmptyLimit`.

3. **`XBudgetGateway`** (table `x_daily_budget`, row keyed by day string):
   ```ts
   interface XDailyBudget { id: string /* YYYY-MM-DD */; searchLoads: number; profileVisits: number; }
   interface XBudgetGateway {
     today(day): Promise<XDailyBudget>;
     incSearch(day, n?): Promise<void>; incProfile(day, n?): Promise<void>;
   }
   ```
   Counters key on the day string in `dayBoundaryTz`, so they "reset" naturally at the boundary and survive restarts because they are persisted rows (FR-B12, AC-14).

4. **`SavedXPostsGateway`** (table `saved_x_posts`, row keyed by post URL hash — the A5 storage contract): stores already-mapped `RawContent` enriched X items written by the cron and read by the main workflow.
   ```ts
   interface SavedXPostsGateway {
     saveMany(items: RawContent[]): Promise<void>;
     recentWithin(maxAgeHours: number, now): Promise<RawContent[]>; // freshness-filtered read
   }
   ```
   Dedupe by URL is enforced here (row id = `hashString(url)`), reinforcing FR-B14's URL dedupe across runs.

Each gateway exports `create<Name>StubGateway(seed?)` for tests/dry-run.

### B.6 Learning math (pure code, FR-B5, NFR-2)

`src/mastra/lib/x-discovery/learning.ts`, all pure and unit-testable:

- `median(nums): number`.
- `credibilityOf(account, config): number` — blends `timesSeen` (saturating), median engagement (relative to a config baseline), and spam signals. Spam/giveaway/engagement-bait is detected from the account's recent post **text** (regex over `/giveaway|airdrop|follow.{0,10}retweet|RT to win|link in bio/i`) — a code heuristic, independent of the per-post LLM `flags` which are a separate signal in ranking.
- `statusFor(account, config): "candidate"|"promoted"|"demoted"` — promoted when `timesSeen >= promoteMinTimesSeen && medianLikes >= promoteMinMedianLikes && credibilityScore >= threshold`; demoted when `credibilityScore < demoteSpamCredibilityBelow`. Pure function of the row + config.
- `isOfficialAccount(account, config): boolean` (A2) — true when `status === "promoted"` AND `credibilityScore >= officialMinCredibility` (config), OR the handle is in `pinned_handles`. No verified-badge is scraped; this is the concrete rule for FR-C8's "official account".

### B.7 Discovery orchestrator (`runDiscovery`)

`src/mastra/lib/x-discovery/runDiscovery.ts` — the heart, fully injectable so it runs offline in tests/dry-run:

```ts
export async function runDiscovery(deps: {
  config?: XDiscoveryConfig;
  generateQueries?: QueryGenerate;      // LLM or heuristic
  search?: typeof searchXPosts;         // real or mock
  scrapeProfile?: typeof scrapeXPosts;  // real or mock
  accounts: DiscoveredAccountsGateway;
  health: XScrapeHealthGateway;
  budget: XBudgetGateway;
  savedPosts: SavedXPostsGateway;
  now?: Date;
  sleep?: (ms: number) => Promise<void>; // injectable pacing (tests pass a no-op; AC-15)
  rng?: () => number;                     // injectable jitter
  log?: Logger;
}): Promise<DiscoveryReport>;
```

Control flow (every step fail-soft; any throw is caught and turns into an aborted-but-clean report):

1. **Gate:** if `!enabled`, return empty. Load `health`; if `cooldownUntil > now`, skip and log (`x.discovery.cooldown`). Check `budget.today`; if both budgets exhausted, skip and log.
2. **Jitter start** (FR-B13): the cron computes start time with ±20% jitter; within `runDiscovery`, pacing between actions/queries uses `sleep` with random delays in the configured ranges (via injected `rng`/`sleep` so tests are instant).
3. **Query gen:** `generateQueries(topics.slice(0, maxTopicsPerSession))` → map. Code enforces ≤`queriesPerTopic` and strips handles.
4. **Per query (sequential, one tab — FR-B13):**
   - Skip if run within `queryCooldownHours` (health.lastQueryRunAt) — FR-B14.
   - Skip if `searchLoads` budget exhausted — FR-B12.
   - `search({ query, tab: "top", maxScrolls, limit })`; `budget.incSearch`.
   - If `stopReason` is a block → **abort the whole X branch** (set escalating cooldown, break out), return report with `aborted: true, stopReason`. RSS is unaffected because this is a separate process (FR-B15, NFR-1).
   - If `count < topMinPosts` → secondary `--tab latest` pass (FR-B3), another `incSearch`.
   - Empty-twice tracking: increment/reset `consecutiveEmpty`; at the limit → abort + cooldown.
   - Accumulate posts, dedupe by URL, stop at `hardPostCapPerSession` (FR-B11).
   - `sleep` a query-delay; record `lastQueryRunAt[query]`.
5. **Learn (FR-B5):** group accumulated posts by `author_handle`, skip `blocklistHandles`, call `accounts.upsertFromScrape` per handle. Recompute status.
6. **Profile pass (FR-B6):** for each `promoted` account (plus `pinnedHandles`) not visited today and within `maxProfileVisitsPerDay`: `scrapeProfile({ handle, limit: profilePerVisitLimit, maxScrolls })`, `budget.incProfile`, `accounts.markProfileVisited`, merge posts. Blocklist excluded.
7. **Map + save:** convert all collected posts to `RawContent` via `postToRaw` (reusing `collect-x-posts.ts`'s mapper, exported), stamp `collectedAt = now`, `savedPosts.saveMany` (URL-dedupe).
8. **Health:** clean run → reset ladder/empty; persist `lastRunAt`.
9. Return `DiscoveryReport { queries, postsScraped, accountsTouched, promoted, aborted, stopReason, budgetUsed, truncatedCount, blocked }` for the dry-run display (FR-E6).

### B.8 Cron runner (FR-B8, FR-B10, AC-11) — `src/mastra/cron/runXDiscovery.ts`

Mirrors `runAutoNewsRadar.ts` structure (daemon + `--once` + `--demo`): loads `.env`, builds the **real** gateways (libSQL) + real `searchXPosts`/`scrapeXPosts` + real `generateQueries`, computes the next fire time as `intervalHours` ± `startJitterPct`, and calls `runDiscovery`. One instance, in-process overlap guard (`running` flag) exactly like the existing runner. `--demo` injects stubs + mock search for an offline smoke run. Scripts added to `package.json`: `"x:discover"`, `"x:discover:once"`, `"x:discover:demo"`.

**Registration (`index.ts`, AGENTS.md rule 2):** register the new `xQueryAgent` under `agents`. Crons are run as standalone tsx processes (the existing `runAutoNewsRadar.ts` is not registered as a Mastra object — it's a script), so no workflow registration is needed for the cron itself; the requirement "register anything needed" is satisfied by registering the agent and keeping the runner discoverable via the npm scripts, matching the existing pattern. FR-B10: the cron always uses the single dedicated Chrome CDP profile from `browser.py` (unchanged), never re-logs in, and `UA`/viewport are already constant in `browser.py` — no change needed beyond documenting it.

### B.9 Main workflow reads saved posts only (FR-B9, AC-12)

`collect-x-posts.ts` gains a **read mode**. `collectXPosts` is rewritten so its default path for the main workflow reads from `SavedXPostsGateway.recentWithin(savedPostMaxAgeHours, now)` instead of calling `scrapeXPosts`. The live-scrape code is **removed from `collectXPosts`** (it now lives only in `runDiscovery`). Signature becomes:

```ts
export async function collectXPosts(opts?: {
  savedPosts?: SavedXPostsGateway;   // injectable; defaults to libSQL impl
  now?: Date;
  maxAgeHours?: number;
  log?: Logger;
}): Promise<CollectXResult>;
```

It is fail-soft: a gateway error returns `{ items: [], perAccount: [] }`. `autoNewsToRas.ts`'s call site is simplified to `collectXPosts({ log })` and still wrapped in try/catch (NFR-1). This is the resolution that guarantees the main workflow **never triggers a live scrape**: there is no scraper reference left in its import graph for the X signal. The fail-soft/injection test (FR-E4) injects a `SavedXPostsGateway` whose read throws, and asserts the run proceeds with RSS only.

---

## Part C — Quality-first ranking (RSS + X, global)

### C.1 Config additions (`ranking.config.ts`, FR-C10)

- `maxAgeHours` default changes **6 → 24**, clamped to a configurable ceiling `maxAgeCeilingHours = 36` (FR-C1, AC-18). `envNum("RANK_MAX_AGE_HOURS", 24)` then `Math.min(value, 36)`.
- **Recency becomes a bounded tiebreaker**, not a weighted term (FR-C2). Remove `recency` from the weighted sum: set `weights.recency = 0` and redistribute its 1.0 across the quality weights (new sums still 10.0 — proposed: `significance 2.5→3.0`, `topicFit 2.0→2.0`, `audienceInterest 2.0→2.0`, `visualPotential 1.0→1.0`, `coverage 0.75→1.0`, `sourceCredibility 0.75→1.0`; = 10.0). Add `recencyTiebreaker: { minMultiplier: 0.95, maxMultiplier: 1.0 }` (A8). The `recencyHalfLifeHours` field stays in config (unused by main sum) to avoid breaking the existing `recencyScore` unit test, but its weight is 0.
- New X block:
  ```ts
  x: {
    minEngagementFloor: number;        // likes+reposts+replies floor, default 20
    minTextLength: number;             // when no outbound_urls, default 60
    engagementRatioCap: number;        // relative-engagement cap, default 3
    neutralEngagementRatio: number;    // fallback when too few samples, default 1
    minSamplesForMedian: number;       // default 3
    corroborationRssBonus: number;     // points, default 4
    corroborationMultiAccountBonus: number; // points, default 3
    corroborationMaxBonus: number;     // cap total corroboration, default 8
    claimRiskHighPenalty: number;      // default 15
    allowUnverifiedHighRisk: boolean;  // RANK_ALLOW_UNVERIFIED_HIGH_RISK, default false (FR-C8)
    engagementWeight: number;          // weight of relative-engagement in qualityScore, default 1.0 (0-10 component)
  }
  ```
  All env-overridable, conservative.

### C.2 Schema additions (`schemas/ranking.ts`, FR-C6, FR-C3, FR-C11)

Extend `LlmScoreSchema` (Stage B, Zod-validated, same batching/retry/fail-soft):

```ts
isNewInformation: z.boolean(),
isPrimarySource: z.boolean(),
specificity: z.number().min(0).max(10),
hookPotential: z.number().min(0).max(10),
claimRisk: z.enum(["low","medium","high"]),
flags: z.object({ engagementBait: z.boolean(), selfPromotion: z.boolean(), giveaway: z.boolean(), hotTakeThread: z.boolean() }),
derivedHeadline: z.string().max(200),
headlineDerived: z.literal(true),
```

**Backward-compat for RSS:** these are required in the schema the model returns, but the prompt instructs the model to fill them for all items (RSS included — `derivedHeadline` for RSS is just the cleaned title, `isPrimarySource` reflects the source). Unscored items (model failed) fall through the existing `unscored` path with components zeroed. To avoid breaking existing few-shot example objects (which lack the new fields), `FewShotExample.score` uses the extended type and the RSS examples are updated with sensible defaults (C.6).

Extend `ScoreComponentsSchema`:

```ts
qualityScore: z.number(),            // the pre-recency quality sum (0-100)
engagementRatio: z.number(),         // relative engagement (X only; 0 for RSS)
engagementComponent: z.number(),     // 0-10 mapped engagement
corroborationBonus: z.number(),      // points
recencyMultiplier: z.number(),       // [0.95,1.0]
recencyAdjustment: z.number(),       // finalScore - qualityScore (<= ~0; informational)
```

Extend `RankedStorySchema` with `qualityScore: z.number().min(0).max(100)` alongside `finalScore`, plus optional X-derived fields surfaced for the payload: `derivedHeadline`, `hookPotential`, `claimRisk`, `verified`, `outboundUrls`, `quoted`, `attributionLine` (all optional/nullable so RSS stories omit them). `RankInputItem` gains optional X fields read from `RawContent.metadata`: `isX?: boolean`, `isReply?: boolean`, `isRepost?: boolean`, `outboundUrls?: string[]`, `quoted?: QuotedXPost | null`, `authorHandle?: string`, `engagementRaw?: {likes;reposts;replies;views}`, `accountMedianLikes?: number`, `accountStatus?: string`. These are populated by `rawToRankItem` in `autoNewsToRas.ts` from metadata (default empty for RSS).

### C.3 Hard filter — X branch (`hardFilter.ts`, FR-C7, AC-21)

Add new drop reasons `X_IS_REPLY_OR_REPOST`, `X_BELOW_ENGAGEMENT_FLOOR`, `X_NO_SOURCE_SHORT`. In the loop, branch on `item.isX`:

- **X items:** skip the `SUMMARY_TOO_SHORT` check entirely. Drop if `isReply || isRepost`. Drop if `(likes+reposts+replies) < x.minEngagementFloor`. Drop if `outboundUrls.length === 0 && text.length < x.minTextLength`. The `too_old` (24h) and blocklist checks still apply to X.
- **RSS items:** unchanged — existing filters including `minSummaryLength` run exactly as today (NFR-3). 

Verified by FR-E2 (X items survive; replies/reposts dropped) and the existing RSS filter tests staying green.

### C.4 Scoring — qualityScore then finalScore (`score.ts`, FR-C3/C4/C5/C8)

`computeRankedStory` is restructured so the weighted sum is now **qualityScore**, and the recency tiebreaker is applied last:

1. **Quality components:** LLM components (`topicFit`, `significance`, `audienceInterest`, `visualPotential`) as today, **plus** an `engagementComponent` (0-10) for X items and `coverage`/`sourceCredibility` as today. `significance`/`specificity`/`hookPotential` feed the LLM-side; `specificity` and `isNewInformation`/`isPrimarySource` adjust significance via small code-side nudges (bounded) — kept simple: `significance` stays the main term; `specificity` adds to `audienceInterest`-style readability only if desired (documented default: not wired into the sum to keep weights summing to 10; these extra judgments primarily drive flags/penalties and the payload). 
2. **Relative engagement (FR-C4):** pure function `relativeEngagement(engagementRaw, accountMedianLikes, config): { ratio, component }`. `ratio = clamp((likes+reposts+replies) / max(accountMedianLikes, 1), 0, engagementRatioCap)` when samples ≥ `minSamplesForMedian`, else `neutralEngagementRatio`. `component = clamp(ratio / engagementRatioCap * 10, 0, 10)`. Views used only when present (adds a small bounded bump). Raw likes are never used alone (AC-22). For RSS, `engagementComponent = 0` and its weight contributes nothing.
3. **Corroboration (FR-C5):** pure function `corroborationBonus(item, context, config)`. Context carries the set of RSS cluster keys and a count of distinct credible X accounts per cluster for this run. Bonus = `corroborationRssBonus` if the X item's `clusterId` (stable `canonicalKey`, A5/NFR-8) matches an RSS item's cluster OR an `outboundUrl` host matches an RSS item's URL host; plus `corroborationMultiAccountBonus` if ≥2 distinct credible accounts share the cluster; capped at `corroborationMaxBonus`. Cluster key stability is guaranteed by reusing `canonicalKey` (already content-hash based, A5).
4. **qualityScore** = `clamp(weightedSum + engagementContribution + corroborationBonus + regionBalanceAdjustment − penalties, 0, 100)`.
5. **verified (FR-C8):** `verified = isOfficialAccount(account) || item.isPrimarySource (llm) || outboundUrls-points-to-primary || corroboratedByRss`. Computed in code from LLM judgments + account status + cluster context.
6. **claimRisk penalty + selection gate (FR-C8, AC-25):** if `!verified && claimRisk === "high"`, add `claimRiskHighPenalty` AND set a flag `blockedUnlessOverride = true`. Selection (`select.ts`) excludes any story with `blockedUnlessOverride` unless `config.x.allowUnverifiedHighRisk` is true.
7. **Recency tiebreaker LAST (FR-C2, AC-20):** `recencyMultiplier = minMultiplier + (1 - minMultiplier) * freshnessFraction`, where `freshnessFraction = clamp(1 - age/maxAgeHours, 0, 1)` → multiplier in `[0.95, 1.0]`. `finalScore = round2(qualityScore * recencyMultiplier)`. Because the multiplier floor is 0.95, the maximum downward move is 5% of qualityScore ≤ ~5 points on a ≤100 scale (AC-20). `recencyAdjustment = finalScore - qualityScore` stored for the breakdown.

All new fields populated in `components`, `weightedContributions`, and the top-level `RankedStory` (qualityScore, finalScore, engagementRatio, corroborationBonus, recencyMultiplier, appliedPenalties). FR-C11 satisfied.

### C.5 Selection (`select.ts`, FR-C8)

`selectTop` additionally skips any `RankedStory` flagged `blockedUnlessOverride` unless `config.x.allowUnverifiedHighRisk`. Still one-per-cluster, top-N, `minScore`. Sorts by `finalScore` (which, after the bounded tiebreaker, orders quality-first then recency — exactly FR-E1).

### C.6 Prompt + few-shot (`prompt.ts`, `fewshot.ts`, FR-C6/C9, AC-26)

`buildSystemPrompt` gains the new field definitions and an **X-mode note**: when scoring X items, derive a factual `derivedHeadline` from the post text, judge `isPrimarySource`/`isNewInformation`, set `flags` for engagement-bait/giveaway/self-promo/hot-take. `buildBatchPrompt` includes an `isX`/`hasOutboundLink` hint per item so the model knows the medium (meaning-only; no numbers).

`fewshot.ts`: existing RSS examples get the new fields filled with safe defaults (`derivedHeadline` = title, `headlineDerived: true`, `isPrimarySource` per source, `flags` all false, `specificity`/`hookPotential` reasonable, `claimRisk` low). Add **three synthetic X examples** (AC-26) — good (a named fictional company shipping with an outbound link, verified-leaning), medium (a credible-sounding but single-account claim), bad (giveaway/engagement-bait). All use clearly fictional names (e.g. "Nimbus Robotics", "@fakefounder"), no real facts, each tagged `synthetic: true` on the example object. `FewShotExample` gets `synthetic?: boolean`.

---

## Part D — Payload extensions (`schemas/handoff.ts`, `lib/ras/payload.ts`, `prepareForHandoff`)

### D.1 Schema (`handoff.ts`, FR-D1/D3, AC-28)

Extend `RasPayloadSchema` additively (all optional/defaulted so RSS payloads stay valid):

```ts
derivedHeadline: z.string().optional(),
hookPotential: z.number().min(0).max(10).optional(),
facts: z.array(z.object({ claim: z.string(), sourceUrl: z.string(), sourceType: z.enum(["rss","x","primary"]) })).default([]),
verified: z.boolean().default(false),
claimRisk: z.enum(["low","medium","high"]).default("low"),
outboundUrls: z.array(z.string()).default([]),
quoted: z.object({ text: z.string(), author_handle: z.string().nullable(), url: z.string(), at: z.string() }).nullable().default(null),
attributionLine: z.string().nullable().default(null),
```

`sourceType` enum is `rss | x | primary` (A3). Existing RSS payloads validate unchanged because every new field has a default.

### D.2 `buildRasPayload` (`payload.ts`, FR-D2, AC-29)

`buildRasPayload` accepts the extra inputs (passed from `prepareForHandoff`): `rankedStory` (for `derivedHeadline`, `hookPotential`, `claimRisk`, `verified`, `outboundUrls`, `quoted`) and the X `authorHandle`/`isXOnly` flag. It builds `facts[]` as the **authoritative claim set (FR-D2)**: each `keyFact`/figure from the fact pack becomes a `{ claim, sourceUrl, sourceType }` where `sourceUrl` is the primary/source URL and `sourceType` is `primary` when a primary source exists, else `rss`, else `x`. For X-only stories, facts draw from the post text + resolved outbound URLs with `sourceType: "x"` (or `primary` when an outbound link is a primary source). `attributionLine` is set to `"per @<handle> on X"` **only when the story is X-only** (no corroborating RSS cluster); null otherwise. `derivedHeadline` prefers the LLM-derived headline over the raw title for X items.

The design step contract (FR-D2/AC-29): downstream must read claims **only** from `payload.facts`. This is a documentation + shape guarantee — `facts` is the single array of claims; `keyFacts` remain in the embedded `factPack` for back-compat but the design-step guidance (and the dry-run output) surface `facts` as the claim source.

### D.3 `prepareForHandoff` + merge-conflict resolution (`autoNewsToRas.ts`, A1)

`prepareForHandoff` passes the selected `RankedStory` (and its raw) into `buildRasPayload` so the new fields flow through. **Resolve the merge conflict (A1):** the file as read is clean (no conflict markers present in the current source), so no conflict resolution is needed in the live file — but per assumption A1 the implementer must confirm at edit time; if markers exist, keep the HEAD side (`signalOnly` contributes to `limited`, retain the injectable `log`) as the requirements assume. `limited` already derives from `raw.paywalled || raw.factPackLimited || raw.viaFallback`; add `|| raw.signalOnly` so X-only (signal-only) stories are treated as limited, keeping fact-pack invention off for X-only posts (consistent with A1).

---

## Part E — Tests, offline dry-run, report

### E.1 New test files (node:test + node:assert/strict), registered in `package.json` (FR-E5)

1. **`tests/ranking/recencyQuality.test.ts` (FR-E1, AC-19/20)** — parameterized. A matrix of ages `[1,6,12,18,23]`h × quality levels. Asserts: (a) for two items inside 24h where the qualityScore gap exceeds the recency bound (≥ ~5 pts), the higher-quality item has the higher `finalScore` regardless of age; (b) when qualityScore is equal within epsilon, the fresher item wins (its recency multiplier is higher); (c) an item at 25h is dropped by `hardFilter` (`too_old`). Uses `computeRankedStory` + `hardFilter` with injected `now`, no LLM.
2. **`tests/x/xHardFilter.test.ts` (FR-E2, AC-21)** — X items with outbound/long text + engagement survive; replies and reposts are always dropped; a bare one-liner with no source is dropped; RSS items with short summaries still dropped by the RSS rule (proving the branch).
3. **`tests/x/linkExpand.test.ts` (FR-E3, AC-1)** — pure test of `resolveOutboundUrls` + `normalizeScrapedPost`: sample link data with a `t.co` + a fake expander map returns the expanded destination; `x.com`/`twitter.com` links dropped; no network, no X. 
4. **`tests/x/failSoft.test.ts` (FR-E4, AC-12)** — two cases: (i) inject a `search` that returns `{ stopReason: "login_wall" }` (and captcha/429/empty-twice variants) into `runDiscovery` with stub gateways; assert `runDiscovery` resolves with `aborted:true`, sets an escalating cooldown, and never throws; (ii) inject a `SavedXPostsGateway` whose read throws into `collectXPosts`; assert it returns `{ items: [] }` and that `collectRankSelect` still ranks the RSS items (RSS proceeds). Also assert `collectXPosts` performs no live scrape (no scraper injected/available).
5. **`tests/x/budgetCooldown.test.ts` (AC-14/16/17)** — stub gateways: exhausting `maxSearchLoadsPerDay` skips further search and logs; the same query within `queryCooldownHours` is skipped; day-boundary key change resets counters; escalating cooldown ladder 12→24→48 advances on repeats.
6. **`tests/x/learning.test.ts` (AC-8)** — `upsertFromScrape` only creates rows from scrape samples; promotion/demotion follow thresholds; `isOfficialAccount` rule.
7. **`tests/ras/payloadX.test.ts` (AC-28/29)** — X-only story sets `attributionLine = "per @handle on X"`, populates `facts[]` with `sourceType:"x"`, `verified`/`claimRisk`; an RSS story leaves X fields empty/default and the payload still validates against `RasPayloadSchema`.

Existing tests (`score.test.ts`, `hardFilter.test.ts`, etc.) stay green: `recencyScore` function is untouched (still exported), and the RSS filter path is unchanged. `score.test.ts`'s "perfect item > 90" assertion holds because removing recency from the sum and redistributing keeps a maxed item near 100 (×0.95 floor only when old; a NOW item gets ×1.0). Any assertion tied to the old weight numbers is updated minimally if needed and noted in the report.

### E.2 Offline dry-run (FR-E6, AC-31) — `src/mastra/demo/xDiscoveryDryRun.ts` + extend `autoNewsDryRun.ts`

New demo `x:discover:demo` path runs `runDiscovery` over **3 topics** with: injected heuristic `generateQueries` (fixed strings), injected **mock `search`/`scrapeProfile`** returning synthetic enriched posts (including a truncated one and one that triggers a simulated block for display), and **stub gateways** — zero network. It prints: queries generated, posts scraped, accounts discovered (with status), and writes to a stub `SavedXPostsGateway`. Then it runs `collectRankSelect` with the heuristic ranker reading from that same stub (so top-5 ranked **with full breakdown** — qualityScore, engagement ratio, corroboration, recency multiplier, penalties — are shown), plus any truncated/blocked items. `auto:dry` is extended to accept an injected `savedPosts` stub so it exercises the mock-X path, and continues to work feed-only when `X_DISCOVERY_ENABLED=false`/empty store (FR-E7).

### E.3 Verification sequence (FR-E7) and report (FR-E8)

Implementer runs, in PowerShell (`;` separator): `npm run typecheck` → `npm run test` → `npm run auto:dry` (feed-only, `X_WATCH_ENABLED=false`) → `npm run auto:dry` with the mock-X stub → `npm run x:discover:demo`. The final report states what is mocked (LLM query-gen, LLM ranking judgments, the Python scraper/search, all four gateways) vs real (the scoring/filter/learning/corroboration **math**, the schemas, the payload builder, the fact pack, the cron wiring), and lists all assumptions A1–A10 with their resolutions.

---

## Error handling (per fallible operation)

- **`scrape.py` search/harvest JS eval failure** — caught (existing `CDPError, OSError, TimeoutError` pattern), that scroll yields `[]`, loop continues; recoverable. Logged to stderr. A total failure returns `{ error, stop_reason }` (fatal for that query only).
- **Block detected (login/captcha/unusual/429)** — fatal for the X branch this session: `searchXPosts` returns `stopReason`; `runDiscovery` aborts the branch, sets escalating cooldown, returns `aborted:true`. **Not** recoverable in-session (never retry, never solve). RSS unaffected (separate process). Logged `x.discovery.blocked`.
- **Empty results twice in a row** — treated as a soft block: abort + cooldown, same as above. Recoverable next schedule after cooldown.
- **LLM query-gen invalid/failed** — retry once; on repeat, code falls back to the deterministic template query per topic. Never fatal. Logged `x.query.fallback`.
- **LLM ranking (Stage B) invalid/failed** — unchanged: retry-once then `unscored` + penalty, fail-soft. Caller gets a ranked list with unscored items.
- **Gateway read/write error (any of the four)** — caught at the call site; reads return empty, writes are best-effort. `collectXPosts` read failure → `{ items: [] }`, RSS proceeds (NFR-1). Logged `x.*.storage_warn`.
- **Budget exhausted** — not an error: skip the activity, log `x.budget.exhausted`, continue with whatever remains (profiles vs search independently gated).
- **`buildRasPayload` with missing X fields** — defaults fill (`facts: []`, `verified: false`, `attributionLine: null`); always produces a schema-valid payload. RSS unaffected.
- **Main-workflow X throw** — `collectRankSelect` keeps its existing try/catch around the X call; any X error is logged and the run continues feed-only (NFR-1).

## Input validation (per external input)

- **Topic list** — strings; empty list → no discovery (valid). Each topic trimmed; blank dropped.
- **LLM query strings** — Zod `z.array(z.string()).length(queriesPerTopic)`; handle/`from:` tokens stripped in code; engagement filters enforced/appended in code (required). Failure → template fallback.
- **Scraped post fields** — `normalizeScrapedPost` coerces to the typed shape with safe defaults; `outbound_urls` filtered to non-x hosts; `thread_texts` capped at 5; unparseable `at` → omit `publishedAt`.
- **Engagement numbers** — nullable from the scraper; treated as 0 when null for the floor/ratio; `accountMedianLikes` < `minSamplesForMedian` → neutral ratio.
- **`maxAgeHours`** — parsed from env, clamped to `[1, 36]` (ceiling). Items with unparseable `publishedAt` dropped (`too_old`, as today).
- **Config ranges** (`[min,max]` delays) — used only through injected `rng`/`sleep`; tests pass no-op so wall-clock is never asserted (AC-15).
- **Blocklist/pinned handles** — optional, default `[]`; lowercased for comparison; both-empty is the normal case (AC-10).

## Invariant ownership

- **"LLM never decides a number / never invents a handle" (NFR-2)** — owned by the **code layer**: query-gen strips handles post-LLM; `score.ts` computes every number; `learning.ts` owns promotion/credibility. The LLM output is confined to meaning fields + query strings + derived headlines, all Zod-validated.
- **"Main workflow never live-scrapes" (FR-B9)** — owned by **module boundaries**: `collectXPosts` imports only `SavedXPostsGateway`, not the scraper. Enforced structurally, not by a runtime flag.
- **Budget/cooldown correctness (FR-B12/B15)** — owned by the **gateways + `runDiscovery`** (the only writer). Day-key and ladder logic are pure functions, unit-tested.
- **Cluster-key stability (NFR-8)** — owned by `canonicalKey` (unchanged, content-hash based); both the X schedule and the main run derive the same key for the same post.
- **"Post nothing / DRY_RUN defaults" (NFR-6)** — unchanged; this work adds no publish path. The cron is read-only scraping.

## Testability notes

- **Unit-testable (pure, no DB/network):** `resolveOutboundUrls`, `normalizeScrapedPost`, `relativeEngagement`, `corroborationBonus`, the recency-multiplier math, `computeRankedStory`, `hardFilter` (X branch), `median`/`credibilityOf`/`statusFor`/`isOfficialAccount`, `buildRasPayload`, budget/cooldown date logic.
- **Integration-testable with stubs (no DB/network):** `runDiscovery` (all deps injected), `collectXPosts` (stub gateway), `collectRankSelect` (heuristic ranker + stub saved-posts).
- **Not unit-testable (requires a real browser/X):** `scrape.py` DOM extraction and block detection — covered only by the live cron + the pure `resolveOutboundUrls`/`normalizeScrapedPost` tests over sample DOM-shaped data. This is called out in the report as a real-vs-mocked boundary.
- The design keeps every network/LLM/DB boundary behind an injectable function or gateway, so the full suite and the dry-run run offline (NFR-4).

---

## Technology stack (locked on approval)

TypeScript (ES2022/NodeNext) · Zod 4 · `@mastra/core` 1.67 (Agent for query-gen, reusing the project small-model resolver; no new provider) · libSQL via `createLibSqlRepository` · Python 3.14 + `websockets` CDP (existing `browser.py`; no Playwright/Selenium) · node:test + node:assert/strict · tsx for crons/demos. No new npm or Python dependencies. Windows/PowerShell (`;` separator). AGENTS.md honored: `mastra` skill loaded before this design; new agent registered in `src/mastra/index.ts`; `dev`/`build`/`test` npm scripts used, never `mastra dev`/`mastra build` directly.

## File change map

- **Modify:** `tweetytweets/scripts/scrape.py` (HARVEST_JS fields, `search` subcommand, `detect_block`, self-thread capture); `src/mastra/lib/x-publisher.ts` (`ScrapedXPost` fields, `QuotedXPost`, `normalizeScrapedPost`, `searchXPosts`); `src/mastra/lib/collect-x-posts.ts` (read-from-storage mode, `resolveOutboundUrls`, export `postToRaw`); `src/mastra/config/ranking.config.ts` (maxAge 24/36, recency→tiebreaker, X block); `src/mastra/schemas/ranking.ts` (LlmScore/ScoreComponents/RankedStory/RankInputItem additions); `src/mastra/lib/ranking/hardFilter.ts` (X branch); `src/mastra/lib/ranking/score.ts` (qualityScore→finalScore, engagement, corroboration, verified, recency tiebreaker); `src/mastra/lib/ranking/select.ts` (high-risk gate); `src/mastra/lib/ranking/prompt.ts` + `fewshot.ts` (X judgments + synthetic examples); `src/mastra/schemas/handoff.ts` + `src/mastra/lib/ras/payload.ts` (payload fields); `src/mastra/lib/workflow/autoNewsToRas.ts` (`rawToRankItem` X fields, `collectXPosts` call, `prepareForHandoff` payload wiring, `limited` includes signalOnly); `src/mastra/index.ts` (register `xQueryAgent`); `package.json` (new test files + `x:discover*` scripts); `src/mastra/demo/autoNewsDryRun.ts` (mock-X path).
- **Add:** `src/mastra/config/xDiscovery.ts`; `src/mastra/lib/x-discovery/{queryGen,runDiscovery,learning}.ts`; `src/mastra/lib/x-discovery/stores/{discoveredAccounts,xScrapeHealth,xBudget,savedXPosts}.ts`; `src/mastra/agents/xQueryAgent.ts`; `src/mastra/cron/runXDiscovery.ts`; `src/mastra/demo/xDiscoveryDryRun.ts`; `tests/ranking/recencyQuality.test.ts`; `tests/x/{xHardFilter,linkExpand,failSoft,budgetCooldown,learning}.test.ts`; `tests/ras/payloadX.test.ts`.

---

## Responses to design-review findings

No `design-review.json` exists in the run directory (`.agents/pipeline/2026-10-26_13-46-06/`), confirmed by search. This is the **initial design**, not a revision — there are no findings to address. When a review is produced, a follow-up revision will respond to each finding here.
