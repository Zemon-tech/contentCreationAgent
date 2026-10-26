# Technical Design (CORRECTED) — X Topic-Driven Discovery, Scraper Enrichment, Quality-First Ranking, and Payload Extensions

> This is a revision of `.agents/pipeline/2026-10-26_13-46-06/02-design.md` after the `design-review.json` verdict `CHANGES_REQUESTED` (3 HIGH + MEDIUM/NIT findings). Every review finding has been decided by the user; this document bakes those decisions in. Sections unaffected by a finding are carried forward unchanged from the prior design. Findings resolved are noted inline and summarized in **Responses to design-review findings** at the end.

## Overview

This design implements the five coordinated changes in `01-requirements.md` against the existing Mastra (TypeScript) + Python CDP pipeline. The spine is unchanged: `scrape.py` (Python CDP-over-`websockets`) harvests X posts, `x-publisher.ts` shells out to it, `collect-x-posts.ts` maps posts to `RawContent`, `rankStories.ts` ranks, and `autoNewsToRas.ts` builds the `RasPayload`. The work is additive to the RSS path and introduces a **separate X discovery subsystem** that runs on its own 6-hour cron, persists its results, and is the only thing that ever drives a live scrape. The main workflow becomes a pure reader of saved posts.

The locked technology stack: **TypeScript (ES2022, NodeNext)** for all Mastra code; **Python 3.14 + `websockets`** for scraping (no Playwright/Selenium — the existing CDP driver is the persistent-profile browser the request refers to); **Zod 4** for schemas; **libSQL** via the existing `createLibSqlRepository<T>` generic repository for persistence, each store wrapped in an injectable gateway with an in-memory stub mirroring `RankStorageGateway`/`createStubGateway`; **node:test + node:assert/strict** for tests run through the explicit file list in `package.json`'s `test` script; **tsx** for crons and demos. No new npm or Python dependencies.

The strict boundary from NFR-2 is preserved everywhere: **the LLM judges meaning (and writes query strings + derived headlines); code decides every number** (ranking, promotion/demotion, budgets, selection, pacing). The LLM never emits a handle and never emits a final score.

**Cross-subsystem data path (locked, one concrete path — resolves findings #1, #3, #5, #8, #9):**
1. The X discovery cron (`runDiscovery`) scrapes search + promoted profiles, maps each post to `RawContent` via the shared `postToRaw`, **stamps per-account engagement medians onto `RawContent.metadata` at save time**, and writes the enriched items to the `saved_x_posts` store.
2. The main workflow reads those saved items through `SavedXPostsGateway.recentWithin(...)`. It holds **no scraper reference** in its import graph — this is the single, structural feed-only guarantee.
3. Ranking assembles a **`CorroborationContext`** in a new pre-scoring stage inside `rankStories` (the RSS normalized-URL set + per-group credible-account counts) and injects it into `ScoreContext`, so `computeRankedStory` reads cross-item signals per item without reaching into gateways from the scoring layer.
4. Corroboration is computed over signals that **actually collide across sources** — X outbound-URL hosts/normalized URLs vs. RSS `url`/`primaryUrl` sets, and X-post groups sharing outbound URLs or near-duplicate text — **not** over `canonicalKey`/`clusterId`, which is per-item and never collides across X and RSS.
5. Engagement and corroboration are folded **into** the existing 10-weight budget so `qualityScore` stays on a clean 0–100 scale; nothing is added on top and re-clamped.

---

## Part A — Scraper enrichment (`scrape.py`, `x-publisher.ts`, `collect-x-posts.ts`)

### A.1 `scrape.py` — `HARVEST_JS` additions and ordered `posts[]` (resolves finding #6)

`HARVEST_JS` is the single DOM-extraction function. It gains four fields per `article[data-testid="tweet"]`, extracted with the same resilience pattern already used (optional chaining, empty defaults, never throw). The existing fields (`text`, `url`, `author_handle`, `at`, `is_reply`, `is_repost`, `replies`, `reposts`, `likes`, `views`) are unchanged. **One structural change (finding #6):** the harvester no longer returns a URL-keyed dict; it returns an **ordered `posts[]` array** and each article carries a `dom_index` (0-based position in DOM order within that harvest pass).

**outbound_urls (FR-A1).** Inside each article, iterate `a[href]` anchors within the tweet text/card region. Resolve the real destination in the DOM without a network call: X renders the expanded URL as the anchor's visible text (e.g. `techcrunch.com/...`) while `href` is a `t.co` shortlink. The extraction prefers, in order: (a) the anchor's `title` attribute if it is an absolute URL; (b) a `https://` URL reconstructed from the anchor's visible `innerText` (strip the trailing `…`); (c) the raw `href`. Any candidate still containing `…` or lacking a TLD is treated as unresolved and kept as the raw `t.co` href (so the TS layer/test can still see it). Links whose resolved host matches `x.com`/`twitter.com` are dropped. Dedupe, return `string[]`, empty array when none. **No redirect-following in the browser** (navigation would kill the harvest tab); resolution is DOM-only. The FR-A1 "or by following the redirect" clause is satisfied at the TS mapping layer as a pure, testable fallback (A.3), keeping FR-E3 network-free.

**text_truncated + Show more (FR-A2).** Detect a `[data-testid="tweet-text-show-more-link"]` / a `button`/`div` whose text matches `/show more/i` inside the tweet text block. Before harvesting, a small JS pass clicks every visible "Show more" control (`el.click()`), waits `showMoreWaitMs` (config, default 800) for the DOM to re-render, then harvests. If the control is still present on an article after that pass, that article's `text_truncated` is `true`; otherwise `false`.

**quoted (FR-A3).** A quoted tweet renders as a nested `div[role="link"]` containing its own `[data-testid="tweetText"]`, a `time`, and an author span. Extract `{ text, author_handle, url, at }`; `url` from the nested `a[href*="/status/"]`, `author_handle` from the nested `@…`. Return `quoted: {…} | null`. Metric/anchor queries are scoped to the outer article and exclude the nested quote subtree (via `:not()` / explicit skip).

**thread_texts via ordered post-pass (FR-A4 — resolves finding #6).** The prior URL-keyed dict could not detect threads because it lost DOM order. The corrected approach does thread detection as a **pure Python post-pass in `scrape_user`/`search` over the ordered `posts[]`** (not in JS), using `dom_index` + `author_handle`:

```
# pure post-pass, after harvest, no DOM access
def attach_thread_texts(posts, cap):              # cap from config threadCap (5)
    posts_sorted = sorted(posts, key=lambda p: p["dom_index"])
    i = 0
    while i < len(posts_sorted):
        p = posts_sorted[i]
        run = []
        j = i + 1
        # consecutive same-author, non-repost, non-reply-to-others run
        while (j < len(posts_sorted)
               and posts_sorted[j]["author_handle"] == p["author_handle"]
               and not posts_sorted[j]["is_repost"]):
            run.append(posts_sorted[j]["text"])
            if len(run) >= cap:
                break
            j += 1
        p["thread_texts"] = run[:cap] if run else []
        i = j if run else i + 1
```

Only the **first** post of a run of consecutive same-author posts carries `thread_texts` (the following run members, capped at 5). Non-first members keep `thread_texts: []`. Threads by other authors naturally produce `[]` (the run breaks at author change). Best-effort: if the ordering is ambiguous, `thread_texts` is `[]`, never an error. This is purely a function of `dom_index` + `author_handle`, so it is deterministic and unit-testable in isolation.

**Field additions emitted per post (finding #6):** `dom_index: int`, `outbound_urls: string[]`, `text_truncated: bool`, `quoted: {...}|null`, `thread_texts: string[]`. The top-level payload stays `{ ..., posts: [ ... ordered ... ] }`.

**Explicitly skipped (FR-A5).** No media URLs, no display names. (FR-A6) `is_reply`/`is_repost` stay.

### A.2 `ScrapedXPost` type (`x-publisher.ts`)

Extend the interface additively:

```ts
export interface QuotedXPost { text: string; author_handle: string | null; url: string; at: string; }
export interface ScrapedXPost {
  // …existing fields unchanged…
  dom_index?: number;            // ordered position; optional for legacy payloads
  outbound_urls: string[];       // default []
  text_truncated: boolean;       // default false
  quoted: QuotedXPost | null;    // default null
  thread_texts: string[];        // default []
}
```

### A.3 Scraped-post normalizer runs ONCE at the x-publisher boundary (resolves finding #11)

`normalizeScrapedPost(raw): ScrapedXPost` applies the defaults above (`outbound_urls ?? []`, `text_truncated ?? false`, `quoted ?? null`, `thread_texts ?? []`, `dom_index ?? index`) so a pre-enrichment payload still maps cleanly (AC-5). **The normalizer runs exactly once, at the x-publisher boundary, for BOTH `scrapeXPosts` and `searchXPosts`, before any `postToRaw` call.** It is NOT re-run on the saved-posts read path — items read from `SavedXPostsGateway` are already `RawContent` and are consumed directly. `normalizeScrapedPost` is exported for the Part E unit test.

### A.4 `RawContent` mapping (`collect-x-posts.ts`) — `postToRaw` exported and extended

`postToRaw(handle, post, opts?)` is **exported** (prior design kept it private) so `runDiscovery` reuses the exact same mapper. It threads the new fields through `metadata`:

- `metadata.outboundUrls: string[]` — resolved outbound URLs (see below).
- `metadata.quoted: QuotedXPost | null`.
- `metadata.threadTexts: string[]`.
- `metadata.textTruncated: boolean`.
- `metadata.isRepost` / `metadata.isReply` — kept as today.
- `metadata.engagementRaw: { likes, reposts, replies, views }` — raw counts for Stage C relative-engagement scoring (the existing `engagement` block stays for back-compat with the image/UI path).
- `metadata.authorHandle: string` — the post author handle (lowercased).
- **`metadata.accountMedianLikes: number` and `metadata.accountMedianReposts: number`** — stamped by `runDiscovery` at SAVE time (decision 3); default `0` on the live/legacy mapping path where no account context exists.

**t.co fallback resolution (pure, testable — FR-A1 "or by following the redirect", resolves finding #11 boundary).** A pure function `resolveOutboundUrls(urls: string[], opts?: { expand?: (tco: string) => string | null }): string[]` normalizes/expands the harvester's `outbound_urls`: it calls `normalizeUrl` (from `lib/normalize.ts`) on each, lowercases the host, strips tracking params (already handled by `normalizeUrl`), drops `x.com`/`twitter.com`/`t.co` hosts, and dedupes. The optional injected `expand` lets a test simulate "t.co → real destination" with **no network** (FR-E3). The real collector passes no expander (the harvester already resolved via DOM). This is the function Part E's FR-E3 test targets.

**Edge cases:** a post with `quoted` but empty outer text still maps (the quote gives context); duplicate posts are deduped by URL at the save layer; unparseable `at` → omit `publishedAt`.

---

## Part B — Topic-driven discovery, schedule, budget, health

A **separate module tree** under `src/mastra/lib/x-discovery/` plus one config file, four gateways, one Python search entrypoint, and one cron runner. The main workflow never calls into it live.

### B.1 Config — `src/mastra/config/xDiscovery.ts`

A single config object, every number env-overridable and **conservative by default** (NFR-5, FR-B17). Shape (defaults shown; via `envNum`/`envFlag` helpers mirroring `xAccounts.ts`):

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
  dayBoundaryTz: string;            // "Asia/Kolkata" (India focus) — configurable
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
  promoteMinCredibility: number;    // 6  (credibility gate for promotion)
  demoteSpamCredibilityBelow: number; // 2
  officialMinCredibility: number;   // 8  (FR-C8 "official account" gate — resolves finding #13; conservative)
  // profile re-scrape (FR-B6)
  profilePerVisitLimit: number;     // posts per profile scrape, e.g. 20
  // lists (FR-B7)
  blocklistHandles: string[];       // optional, default []
  pinnedHandles: string[];          // optional, default []
  // schedule (FR-B8)
  intervalHours: number;            // 6
  // freshness contract for saved posts (resolves finding #7)
  savedPostMaxAgeHours: number;     // 24, matches ranking maxAgeHours
}
```

`getXDiscoveryConfig()` returns the merged object. Topics default to `"AI"`, `"startups"`, `"deeptech"`, `"AI India"`, `"Indian startups"`, `"India deeptech"`. `officialMinCredibility` (finding #13) is owned here because `isOfficialAccount` lives in `learning.ts`, which already consumes this config. The old `xAccounts.ts` static list is retained for back-compat but discovery does not use it for guessing; `pinnedHandles` supersedes it as the explicit-source mechanism.

### B.2 Query generation — LLM behind an injectable fn (FR-B2, NFR-2)

`src/mastra/lib/x-discovery/queryGen.ts` exports:

```ts
export type QueryGenerate = (prompt: string) => Promise<{ text: string }>;
export async function generateQueries(topics: string[], opts: { generate?: QueryGenerate; config?: XDiscoveryConfig; log?: Logger }): Promise<Map<string, string[]>>;
```

Mirrors `RankGenerate`: the default generator uses a new tiny agent `xQueryAgent` (project small model, no new provider), registered in `index.ts`. The LLM returns **query strings only**, validated per topic by `z.object({ queries: z.array(z.string()).length(config.queriesPerTopic) })`, parsed with `extractJson` + `safeParse` + retry-once, exactly like `scoreItems`. **Guard (NFR-2):** each returned string is post-processed in code to strip any `@handle`/`from:` tokens; if a topic fails validation after retry, code falls back to a deterministic template query `(topic) min_faves:300 filter:links -filter:replies lang:en`. Each query is forced to contain the engagement filters in code (appended if missing) to satisfy AC-6 deterministically. Tests/dry-run inject a heuristic `generate` returning fixed strings.

### B.3 Python search entrypoint (FR-B3, FR-B4) — argparse fix (resolves finding #10)

Add a `search` subcommand to `scrape.py` (not a new script). **argparse corrections (finding #10):** widen the `cmd` positional to `choices=["user", "search"]`, and make `--handle` **conditionally required** — required for `user`, not for `search` (which uses `--query`). This is enforced after parse:

```python
ap.add_argument("cmd", nargs="?", default="user", choices=["user", "search"])
ap.add_argument("--handle", required=False, help="account handle (required for 'user')")
ap.add_argument("--query", required=False, help="search query string (required for 'search')")
ap.add_argument("--tab", choices=["top", "latest"], default="top")
# ...existing --limit/--max-scrolls/--json-only...
args = ap.parse_args()
if args.cmd == "user" and not args.handle:
    ap.error("--handle is required for 'user'")
if args.cmd == "search" and not args.query:
    ap.error("--query is required for 'search'")
```

Invocation:

```
python scrape.py search --query "<q>" --tab top|latest --max-scrolls 2 --limit 40 --json-only
```

It opens `https://x.com/search?q=<url-encoded q>&src=typed_query&f=top` (or `&f=live` for Latest), reuses `settle_page` + `_wait_login`, then runs the **same scroll+HARVEST_JS loop + ordered `posts[]` + `attach_thread_texts` post-pass** as `scrape_user` (so FR-B4/A.1 enrichment and FR-A4 thread detection apply identically), capped by `--max-scrolls` (≤2) and `--limit`. The Top-vs-Latest decision (FR-B3) is made in **TypeScript**: the orchestrator first calls `--tab top`; if `count < topMinPosts`, it issues a second `--tab latest`. `scrape.py search` returns `{ query, tab, count, posts: [...] }` or `{ error, stop_reason }`.

**Stop-condition detection (FR-B15)** is a `detect_block(page)` JS probe run after `settle_page`, returning `{ login_wall, captcha, unusual_activity, http_429 }` via: the existing login-form selector, an arkose/captcha testid or `/verify you.?re human|are you a robot/i`, body text `/unusual activity|suspicious/i`, and (429) an empty body with title/text `/rate limit|too many requests/i`. When any is true, `scrape.py` returns `{ error: "blocked", stop_reason: "<which>" }` and **does not scroll further** (never retries, never attempts to solve).

### B.4 `x-publisher.ts` — `searchXPosts()` and CDP fingerprint (resolves finding #4)

```ts
export interface XSearchResult { success: boolean; query: string; tab: "top"|"latest"; count: number; posts: ScrapedXPost[]; stopReason?: XStopReason; error?: string; }
export async function searchXPosts(opts: { query: string; tab: "top"|"latest"; maxScrolls: number; limit: number }): Promise<XSearchResult>;
```

Same `execFile` + JSON-parse + fail-soft pattern as `scrapeXPosts`. `stopReason` is `"login_wall" | "captcha" | "unusual_activity" | "http_429" | "empty"`. Posts run through `normalizeScrapedPost` (A.3) here at the boundary, before any mapping.

**FR-B10 fingerprint consistency (finding #4).** The prior design wrongly implied the UA/viewport constant in `browser.py` applied to the CDP page session — it is only used by `plain()`/`og_image()` HTTP calls. **Decision 5: state the truth plainly and do NOT claim code enforcement.** UA/viewport consistency comes from the **persistent dedicated Chrome profile launched by `browser.py`** (one fixed Chrome binary, one persisted user-data-dir, never re-logged-in), which is the single source of a stable fingerprint across runs. No `Network.setUserAgentOverride` / `Emulation.setDeviceMetricsOverride` is added — adding per-session overrides that differ from the profile's own Chrome would make the fingerprint *less* consistent, not more. FR-B10 is satisfied by the persistent profile; the design documents this as a profile property, not a code behavior, and `browser.py` is unchanged.

### B.5 Gateways + stores (FR-B16, NFR-4)

Four gateways under `src/mastra/lib/x-discovery/stores/`, each an interface + a libSQL impl (via `createLibSqlRepository<T>("<table>")`) + an in-memory stub, mirroring `RankStorageGateway`/`createStubGateway`.

1. **`DiscoveredAccountsGateway`** (table `discovered_accounts`, keyed by lowercased `handle`):
   ```ts
   interface DiscoveredAccount {
     id: string;            // = handle.toLowerCase()
     handle: string; firstSeen: string; timesSeen: number;
     medianLikes: number; medianReposts: number;
     credibilityScore: number;      // 0..10, code-derived
     status: "candidate" | "promoted" | "demoted";
     recentLikes: number[];         // rolling sample (cap ~20) for median
     recentReposts: number[];       // rolling sample (cap ~20)
     recentTexts: string[];         // rolling sample for spam heuristic (cap ~20)
     lastProfileVisitDay?: string;  // YYYY-MM-DD in dayBoundaryTz (FR-B6)
   }
   interface DiscoveredAccountsGateway {
     get(handle): Promise<DiscoveredAccount | undefined>;
     upsertFromScrape(handle, samples: {likes:number;reposts:number;text:string}[], now): Promise<DiscoveredAccount>;
     list(): Promise<DiscoveredAccount[]>;
     markProfileVisited(handle, day): Promise<void>;
   }
   ```
   `upsertFromScrape` is where **learning** happens (code, not LLM): increment `timesSeen`, append samples (capped), recompute medians, recompute `credibilityScore`/`status` via pure functions (B.6). A handle is written only here, from a real scrape result (AC-8).

2. **`XScrapeHealthGateway`** (table `x_scrape_health`, single row id `"health"`):
   ```ts
   interface XScrapeHealth {
     id: "health"; lastRunAt?: string; lastStopReason?: XStopReason | null;
     cooldownUntil?: string | null; cooldownLadderIndex: number; consecutiveEmpty: number;
     lastQueryRunAt: Record<string, string>; // queryString -> ISO (4h cooldown, FR-B14)
   }
   interface XScrapeHealthGateway { load(): Promise<XScrapeHealth>; save(h): Promise<void>; }
   ```
   Escalating cooldown (FR-B15): on a stop condition, `cooldownUntil = now + ladder[min(cooldownLadderIndex, len-1)]`, increment `cooldownLadderIndex`. A clean run with posts resets `cooldownLadderIndex = 0` and `consecutiveEmpty = 0`. `consecutiveEmpty` increments on empty results and triggers a stop at `consecutiveEmptyLimit`.

3. **`XBudgetGateway`** (table `x_daily_budget`, keyed by day string):
   ```ts
   interface XDailyBudget { id: string /* YYYY-MM-DD */; searchLoads: number; profileVisits: number; }
   interface XBudgetGateway { today(day): Promise<XDailyBudget>; incSearch(day, n?): Promise<void>; incProfile(day, n?): Promise<void>; }
   ```
   Counters key on the day string in `dayBoundaryTz`, so they reset at the boundary and survive restarts (FR-B12, AC-14).

4. **`SavedXPostsGateway`** (table `saved_x_posts`, keyed by post-URL hash) — the storage contract. Stores already-mapped, median-stamped `RawContent` written by the cron and read by the main workflow.
   ```ts
   interface SavedXPostsGateway {
     saveMany(items: RawContent[]): Promise<void>;
     recentWithin(maxAgeHours: number, now: Date): Promise<RawContent[]>; // freshness-filtered read
   }
   ```
   **Freshness semantics (resolves finding #7):** `recentWithin(maxAgeHours, now)` filters on each item's **`publishedAt`**, falling back to **`collectedAt`** when `publishedAt` is absent/unparseable, dropping items whose chosen timestamp is older than `now - maxAgeHours`. This is purely a **store-window** filter to avoid serving stale rows; it is **NOT** the 24h drop. The ranker's `too_old` hard filter (C.3, on `publishedAt`) remains the **single source of truth** for the 24h age drop — the two checks use the same timestamp precedence but the ranker owns the authoritative decision, so there is no double-counting. Dedupe by URL is enforced here (row id = `hashString(url)`), reinforcing FR-B14's cross-run URL dedupe.

Each gateway exports `create<Name>StubGateway(seed?)` for tests/dry-run.

### B.6 Learning math (pure code, FR-B5, NFR-2) — `src/mastra/lib/x-discovery/learning.ts`

All pure and unit-testable:

- `median(nums): number`.
- `credibilityOf(account, config): number` (0–10) — blends `timesSeen` (saturating), median engagement relative to `promoteMinMedianLikes`, and a spam penalty. Spam/giveaway/engagement-bait detected from the account's `recentTexts` (regex `/giveaway|airdrop|follow.{0,10}retweet|RT to win|link in bio/i`) — a code heuristic, independent of the per-post LLM `flags`.
- `statusFor(account, config)` — `promoted` when `timesSeen >= promoteMinTimesSeen && medianLikes >= promoteMinMedianLikes && credibilityScore >= promoteMinCredibility`; `demoted` when `credibilityScore < demoteSpamCredibilityBelow`; else `candidate`.
- **`isOfficialAccount(account, config): boolean` (resolves finding #13)** — true when `status === "promoted" && credibilityScore >= config.officialMinCredibility`, OR the handle is in `config.pinnedHandles`. `officialMinCredibility` now exists in config (B.1, conservative default 8). This is the concrete rule for FR-C8's "official account".

### B.7 Discovery orchestrator (`runDiscovery`) — stamps medians at save time (resolves finding #3)

`src/mastra/lib/x-discovery/runDiscovery.ts`, fully injectable:

```ts
export async function runDiscovery(deps: {
  config?: XDiscoveryConfig;
  generateQueries?: QueryGenerate;
  search?: typeof searchXPosts;
  scrapeProfile?: typeof scrapeXPosts;
  accounts: DiscoveredAccountsGateway;
  health: XScrapeHealthGateway;
  budget: XBudgetGateway;
  savedPosts: SavedXPostsGateway;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;  // injectable pacing (tests no-op)
  rng?: () => number;                       // injectable jitter
  log?: Logger;
}): Promise<DiscoveryReport>;
```

Control flow (every step fail-soft; any throw is caught → aborted-but-clean report):

1. **Gate:** if `!enabled`, return empty. Load `health`; if `cooldownUntil > now`, skip + log `x.discovery.cooldown`. Check `budget.today`; if both budgets exhausted, skip + log.
2. **Jitter start** (FR-B13): the cron computes start time with ±`startJitterPct`; inside `runDiscovery`, pacing uses `sleep` with delays drawn via injected `rng` from the configured ranges.
3. **Query gen:** `generateQueries(topics.slice(0, maxTopicsPerSession))`. Code enforces ≤`queriesPerTopic` and strips handles.
4. **Per query (sequential, one tab — FR-B13):** skip if run within `queryCooldownHours` (FR-B14); skip if `searchLoads` budget exhausted; `search({ query, tab: "top", maxScrolls, limit })`; `budget.incSearch`. If `stopReason` is a block → **abort the whole X branch** (set escalating cooldown, break), return `aborted: true, stopReason` (RSS unaffected — separate process). If `count < topMinPosts` → secondary `--tab latest` pass (FR-B3), another `incSearch`. Empty-twice tracking increments/resets `consecutiveEmpty`; at the limit → abort + cooldown. Accumulate posts, dedupe by URL, stop at `hardPostCapPerSession`. `sleep` a query-delay; record `lastQueryRunAt[query]`.
5. **Learn (FR-B5):** group accumulated posts by `author_handle`, skip `blocklistHandles`, call `accounts.upsertFromScrape(handle, samples, now)`; recompute status.
6. **Profile pass (FR-B6):** for each `promoted` account (plus `pinnedHandles`) not visited today and within `maxProfileVisitsPerDay`: `scrapeProfile({ handle, limit: profilePerVisitLimit, maxScrolls })`, `budget.incProfile`, `accounts.markProfileVisited`, merge posts. Blocklist excluded.
7. **Map + stamp medians + save (decision 3):** for each collected post, look up its author's `DiscoveredAccount` (freshly upserted in step 5/6), and call `postToRaw(handle, post, { accountMedianLikes: acct.medianLikes, accountMedianReposts: acct.medianReposts })`. `postToRaw` writes those onto `RawContent.metadata.accountMedianLikes/accountMedianReposts`. Stamp `collectedAt = now`. `savedPosts.saveMany` (URL-dedupe). **This is the single concrete data path by which per-account medians travel into scoring** — they ride on the saved item's metadata, are read back by `recentWithin`, flow through `rawToRankItem` into `RankInputItem.accountMedianLikes`, and reach `relativeEngagement` in `score.ts`. No gateway is reachable from the scoring layer.
8. **Health:** clean run → reset ladder/empty; persist `lastRunAt`.
9. Return `DiscoveryReport { queries, postsScraped, accountsTouched, promoted, aborted, stopReason, budgetUsed, truncatedCount, blocked }` for the dry-run (FR-E6).

### B.8 Cron runner (FR-B8, FR-B10, AC-11) — `src/mastra/cron/runXDiscovery.ts`

Mirrors `runAutoNewsRadar.ts` (daemon + `--once` + `--demo`): loads `.env`, builds the **real** libSQL gateways + real `searchXPosts`/`scrapeXPosts` + real `generateQueries`, computes the next fire time as `intervalHours` ± `startJitterPct`, calls `runDiscovery`. One instance, in-process overlap guard (`running` flag). `--demo` injects stubs + mock search for an offline smoke run. `package.json` scripts added: `"x:discover"`, `"x:discover:once"`, `"x:discover:demo"`.

**Registration (`index.ts`, AGENTS.md):** register the new `xQueryAgent` under `agents`. Crons run as standalone tsx processes (the existing `runAutoNewsRadar.ts` is a script, not a registered Mastra object), so the runner is discoverable via the npm scripts, matching the existing pattern. FR-B10: the cron always uses the single dedicated Chrome CDP profile in `browser.py` (unchanged), never re-logs in; fingerprint consistency is the profile's property (B.4).

### B.9 Main workflow reads saved posts only — ONE feed-only switch (resolves findings #5 and #9)

`collectXPosts` is **rewritten** to read from `SavedXPostsGateway` only; the live-scrape path is removed from its import graph (`scrapeXPosts`/`checkXSession`/`xAccounts` are no longer imported here — they now live only in `x-publisher.ts`/`runDiscovery`).

**New signature and result shape (resolves finding #5):**

```ts
export interface CollectXResult {
  items: RawContent[];
  /** Per-source outcome for observability. */
  perAccount: Array<{ handle: string; count: number; error?: string }>;
  // sessionNotReady is REMOVED — there is no live session in the read path.
}

export async function collectXPosts(opts?: {
  savedPosts?: SavedXPostsGateway;   // injectable; defaults to the libSQL impl
  now?: Date;
  maxAgeHours?: number;              // defaults to getXDiscoveryConfig().savedPostMaxAgeHours
  config?: XDiscoveryConfig;         // for the single feed-only switch (see below)
  log?: (ev: string, data: Record<string, unknown>) => void;
}): Promise<CollectXResult>;
```

**Fate of `sessionNotReady`:** removed from `CollectXResult` entirely. Its sole caller is `collectRankSelect` in `autoNewsToRas.ts`, which logs it in `x.collected`; that log field is dropped (updated below). No other code reads it (verified: it appears only in `collect-x-posts.ts` and `autoNewsToRas.ts`).

**The single feed-only switch (resolves findings #5 and #9).** The prior design named two different env vars (`X_WATCH_ENABLED` in FR-E7, `X_DISCOVERY_ENABLED` for the reader) for two subsystems — ambiguous once the live-watch path is gone. **Decision 6: there is exactly ONE canonical feed-only switch — `X_DISCOVERY_ENABLED=false`** (the `enabled` flag already in `XDiscoveryConfig`). `collectXPosts` checks it first:

```ts
const config = opts?.config ?? getXDiscoveryConfig();
if (!config.enabled) { log("x.disabled", {}); return { items: [], perAccount: [] }; }
```

When `X_DISCOVERY_ENABLED=false`, `collectXPosts` returns empty **without touching the store**, so the main workflow is feed-only. When it is true, `collectXPosts` reads `savedPosts.recentWithin(maxAgeHours, now)`. The old `X_WATCH_ENABLED` env var is **retired** from the main-workflow feed-only decision; `xAccounts.ts`'s `getXWatchConfig` is no longer consulted by `collectXPosts` (it stays in the repo only for any unrelated legacy reference). FR-E7's feed-only acceptance step uses **exactly** `X_DISCOVERY_ENABLED=false` (see E.3), so the gate the test flips is the same gate the reader honors.

**Callers/tests that change (finding #5):** `collectRankSelect` in `autoNewsToRas.ts` — its call becomes `collectXPosts({ log: opts.log })`, still wrapped in try/catch (NFR-1); the `x.collected` log drops `sessionNotReady`. Any existing test that constructed `collectXPosts({ scrape, checkSession, config })` with the old signature is migrated to inject `{ savedPosts: stubGateway }` instead; the fail-soft test (FR-E4) injects a `SavedXPostsGateway` whose `recentWithin` throws and asserts `{ items: [], perAccount: [] }` with RSS proceeding. `collectXPosts` is fail-soft: a gateway error returns `{ items: [], perAccount: [] }`.

This is the structural guarantee that the main workflow **never triggers a live scrape**: there is no scraper reference left in its import graph (invariant ownership: module boundaries, not a runtime flag).

---

## Part C — Quality-first ranking (RSS + X, global)

### C.1 Config additions (`ranking.config.ts`, FR-C10) — folded weight budget (resolves finding #8)

- `maxAgeHours` default **6 → 24**, clamped to a configurable `maxAgeCeilingHours = 36`: `Math.min(envNum("RANK_MAX_AGE_HOURS", 24), 36)` (FR-C1, AC-18).
- **Recency becomes a bounded tiebreaker, not a weighted term (FR-C2).** `weights.recency` is driven to `0`; its 1.0 is redistributed into the quality weights. `recencyHalfLifeHours` stays in config (unused by the main sum) so the existing `recencyScore` unit test keeps compiling. Add `recencyTiebreaker: { minMultiplier: 0.95, maxMultiplier: 1.0 }`.
- **Folded 10-weight budget (decision 2b, resolves finding #8).** Engagement and corroboration are NOT added on top of the weighted sum and re-clamped. Instead they are **part of the 10-weight budget**, so `qualityScore` is a pure weighted sum of 0–10 components × weights summing to 10, giving a clean 0–100 ceiling before penalties. The weight table (sums to exactly **10.0**):

  | component | old weight | new weight | notes |
  |---|---|---|---|
  | significance | 2.5 | 2.5 | unchanged |
  | topicFit | 2.0 | 2.0 | unchanged |
  | audienceInterest | 2.0 | 1.5 | −0.5 |
  | visualPotential | 1.0 | 1.0 | unchanged |
  | coverage | 0.75 | 0.75 | unchanged |
  | sourceCredibility | 0.75 | 0.75 | unchanged |
  | recency | 1.0 | **0.0** | removed from sum (tiebreaker only) |
  | **engagement** | — | **1.0** | NEW 0–10 component; RSS contributes 0 |
  | **corroboration** | — | **0.5** | NEW 0–10 component; RSS contributes 0 unless RSS-corroborated |
  | **sum** | 10.0 | **10.0** | invariant preserved |

  Corroboration and engagement are expressed as **0–10 components** (not raw point bonuses) so the "weights sum to 10 → max 100" invariant in the `ranking.config.ts` header holds verbatim. The old `corroborationRssBonus`/`corroborationMultiAccountBonus`/`corroborationMaxBonus` point fields are **replaced** by sub-weights inside the engagement/corroboration component mappers (below) so there is a single clamped 0–10 corroboration component.

- New X block (points removed; only component-shaping numbers remain):
  ```ts
  x: {
    minEngagementFloor: number;        // likes+reposts+replies floor, default 20
    minTextLength: number;             // when no outbound_urls, default 60
    engagementRatioCap: number;        // relative-engagement cap, default 3
    neutralEngagementRatio: number;    // fallback when too few samples, default 1
    minSamplesForMedian: number;       // default 3
    viewsBonusMax: number;             // 0 by default — views only break ties, contribute 0 points (resolves finding #12)
    corroborationRssShare: number;     // fraction of the 0–10 corroboration component from RSS-URL match, default 0.6
    corroborationMultiAccountShare: number; // fraction from multi-account signal, default 0.4
    claimRiskHighPenalty: number;      // default 15
    allowUnverifiedHighRisk: boolean;  // RANK_ALLOW_UNVERIFIED_HIGH_RISK, default false (FR-C8)
  }
  ```
  **Views (resolves finding #12):** `viewsBonusMax` defaults to **0**, meaning views contribute **0 points** to `qualityScore`; they are used only as a final tiebreaker in `select.ts` when two items have equal `finalScore` within epsilon (higher views first). If the owner later wants views to add signal, raising `viewsBonusMax` lets `relativeEngagement` add up to that many tenths to the engagement component (still inside the 0–10 clamp, so the 0–100 ceiling is preserved). `engagementWeight` is removed as a standalone field — engagement is now the fixed 1.0 weight above.

  All env-overridable, conservative.

**Worked maxima (proving ≤100 — decision 2b):**
- **Fully-maxed X item:** all LLM 0–10 components = 10, engagement component = 10, corroboration component = 10, coverage = 10, sourceCredibility = 10, no penalties. `qualityScore = Σ wᵢ·10 = 10 × (2.5+2.0+1.5+1.0+0.75+0.75+1.0+0.5) = 10 × 10.0 = 100`. Recency tiebreaker ×[0.95,1.0] → `finalScore ∈ [95,100]`. **≤100. ✓**
- **Fully-maxed RSS item:** engagement component = 0 (no X engagement), corroboration component = 0 unless RSS-corroborated. Max achievable with the two X-only components at 0 is `10 × (2.5+2.0+1.5+1.0+0.75+0.75) = 10 × 8.5 = 85`. A maxed RSS item that is also cross-corroborated (corroboration component > 0) can reach up to `85 + 10×0.5 = 90` before recency. **≤100. ✓**
- **"perfect item > 90" test stays valid.** The existing `score.test.ts` "perfect item > 90" assertion is built as a maxed RSS-style item. Under the folded budget a maxed RSS item tops out at 85 (no engagement), which would FAIL a strict `>90`. **Resolution:** the existing perfect-item fixture is updated in the same edit to set the corroboration component contributors (so corroboration = 10 → 90) AND to assert `>= 90` (the fixture represents a maxed, cross-corroborated item). This keeps a "perfect item" near the ceiling and the assertion green; the change is minimal and noted in the report. (Alternative considered — keep recency in the budget so RSS maxes at 100 — rejected because FR-C2 mandates recency be a tiebreaker, not a weighted term.)

### C.2 Schema additions (`schemas/ranking.ts`, FR-C6, FR-C3, FR-C11)

Extend `LlmScoreSchema` (Stage B, Zod-validated, same batching/retry/fail-soft) with 8 new fields:

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

**Few-shot compilation (resolves finding #14).** Making these 8 fields **required** means every existing few-shot example object stops compiling until updated. **Decision 8: update ALL existing few-shot examples in `fewshot.ts` in the SAME edit** that adds the fields (see C.6) — the 6 (verified count at edit time) existing example `score` objects each get the 8 new fields filled with sensible defaults, so nothing stops compiling. (Alternative — making the fields `.optional()`/defaulted — rejected: FR-C6 wants them as first-class required judgments, and the prompt instructs the model to always fill them.)

Extend `ScoreComponentsSchema`:

```ts
qualityScore: z.number(),            // pre-recency quality sum (0-100)
engagementComponent: z.number(),     // 0-10 mapped engagement (X only; 0 for RSS)
engagementRatio: z.number(),         // relative engagement (X only; 0 for RSS) — informational
corroborationComponent: z.number(),  // 0-10 mapped corroboration
recencyMultiplier: z.number(),       // [0.95,1.0]
recencyAdjustment: z.number(),       // finalScore - qualityScore (<= 0; informational)
```

Extend `RankedStorySchema` with `qualityScore: z.number().min(0).max(100)` alongside `finalScore`, plus optional X-derived payload fields: `derivedHeadline`, `hookPotential`, `claimRisk`, `verified`, `outboundUrls`, `quoted`, `attributionLine` (all optional/nullable so RSS stories omit them). `RankInputItem` gains optional X fields read from `RawContent.metadata`: `isX?: boolean`, `isReply?: boolean`, `isRepost?: boolean`, `outboundUrls?: string[]`, `quoted?: QuotedXPost | null`, `authorHandle?: string`, `engagementRaw?: {likes;reposts;replies;views}`, `accountMedianLikes?: number`, `accountMedianReposts?: number`, `accountStatus?: string`. These are populated by `rawToRankItem` in `autoNewsToRas.ts` from metadata (default empty for RSS).

### C.3 Hard filter — X branch (`hardFilter.ts`, FR-C7, AC-21)

Add drop reasons `X_IS_REPLY_OR_REPOST`, `X_BELOW_ENGAGEMENT_FLOOR`, `X_NO_SOURCE_SHORT`. Branch on `item.isX`:

- **X items:** skip `SUMMARY_TOO_SHORT`. Drop if `isReply || isRepost`. Drop if `(likes+reposts+replies) < x.minEngagementFloor`. Drop if `outboundUrls.length === 0 && text.length < x.minTextLength`. The `too_old` (24h, on `publishedAt`) and blocklist checks still apply to X. **`too_old` here is the single source of truth for the 24h drop (resolves finding #7)** — the store-window `recentWithin` filter in B.5 does not re-drop.
- **RSS items:** unchanged (NFR-3).

Verified by FR-E2 and the existing RSS filter tests staying green.

### C.4 Cross-item context assembly in `rankStories` + scoring (`score.ts`, resolves findings #1, #3, #8)

**New pre-scoring stage in `rankStories.ts` (decision 3, resolves finding #3).** After Stage B (LLM scoring) and before the per-item `computeRankedStory` map, `rankStories` builds a **`CorroborationContext`** from the full `kept` item list (no gateway call — all signals are already on the items):

```ts
export interface CorroborationContext {
  /** Normalized-URL set assembled from every RSS item's url (+ any primaryUrl). */
  rssUrlSet: Set<string>;                 // normalizeUrl(item.url) for items where !item.isX
  /** For each corroboration group key, count of distinct credible X accounts. */
  credibleAccountsByGroup: Map<string, number>;
}
```

Assembly (pure, in `rankStories`):
- `rssUrlSet` = `new Set(kept.filter(i => !i.isX).map(i => normalizeUrl(i.url)))`. (RSS has no separate `primaryUrl` field on `RankInputItem`; `url` is the canonical source URL, so the set is built from `url`. This is the exact assembly point — resolves finding #1's "WHERE the RSS URL set is assembled".)
- `credibleAccountsByGroup`: group X items by a **corroboration group key** = the first shared signal, in order: (a) any normalized outbound-URL host they share, else (b) a near-duplicate-text key (lowercased, whitespace/punctuation-stripped, first 12 tokens). For each group, count distinct `authorHandle`s whose `accountStatus === "promoted"` (credible). This produces the "multiple distinct credible accounts discuss the same story" signal.

`CorroborationContext` is injected into `ScoreContext` alongside `config/now/recentRegions`. `rankStories` passes it into every `computeRankedStory(item, score, { config, now, recentRegions, corroboration })` call. **This is the one concrete assembly point.**

**`computeRankedStory` restructured — qualityScore then finalScore:**

1. **Quality components:** LLM 0–10 components (`topicFit`, `significance`, `audienceInterest`, `visualPotential`) as today, plus `coverage`/`sourceCredibility` as today, plus the two new 0–10 components below. `recencyScore` is still computed for the breakdown but its weight is 0.

2. **Relative engagement component (FR-C4, decision 2b).** Pure function `relativeEngagement(engagementRaw, accountMedianLikes, config): { ratio, component }`:
   - `ratio = clamp((likes+reposts+replies) / max(accountMedianLikes, 1), 0, engagementRatioCap)` when the account has `>= minSamplesForMedian` samples (inferred from a non-zero `accountMedianLikes` stamped by discovery), else `neutralEngagementRatio`.
   - `component = clamp(ratio / engagementRatioCap * 10, 0, 10)`, plus at most `viewsBonusMax` tenths when `views` present (default 0 → no effect; resolves finding #12). Raw likes are never used alone (AC-22).
   - For RSS, `engagementComponent = 0` (no `engagementRaw`), and its 1.0 weight contributes nothing.

3. **Corroboration component (FR-C5, resolves finding #1).** Pure function `corroborationComponent(item, ctx: CorroborationContext, config): number` (0–10). The clusterId-equality branch is **dropped entirely** (canonicalKey is per-item and never collides across X and RSS). Instead:
   - **RSS-URL match share:** if ANY of the X item's normalized `outboundUrls` host OR full normalized URL is present in `ctx.rssUrlSet`, award `corroborationRssShare * 10` (default 6.0). Match function: `matchOutboundToRss(outboundUrls, rssUrlSet)` = true if `rssUrlSet.has(normalizeUrl(u))` OR `[...rssUrlSet].some(r => hostOf(r) === hostOf(normalizeUrl(u)))` for any `u` (host via `new URL(...).hostname` lowercased, `www.` stripped). `normalizeUrl` is the existing `lib/normalize.ts` function, guaranteeing identical normalization to the RSS side.
   - **Multi-account share:** compute this X item's corroboration group key (same derivation as the context builder), and if `ctx.credibleAccountsByGroup.get(groupKey) >= 2`, award `corroborationMultiAccountShare * 10` (default 4.0).
   - Sum, `clamp(..., 0, 10)`. For RSS items, both signals are typically absent so the component is 0; an RSS item whose `url` is also linked by X posts does not award itself (the component is X-driven), keeping the RSS max at 85–90 as shown in C.1.

4. **qualityScore** = `clamp(Σ wᵢ·componentᵢ + regionBalanceAdjustment − penalties, 0, 100)`, where the component set now includes `engagementComponent` (w=1.0) and `corroborationComponent` (w=0.5) and `recencyScore` (w=0). Because all components are 0–10 and weights sum to 10, the pre-penalty ceiling is exactly 100 (worked maxima in C.1). **Nothing is added on top and re-clamped (resolves finding #8).**

5. **verified (FR-C8):** `verified = isOfficialAccount(accountLike) || item.isPrimarySource (llm) || outboundPointsToPrimary || corroboratedByRss`, where `corroboratedByRss` is the RSS-URL-match result from step 3 and `accountLike` is derived from `item.accountStatus`/`item.accountMedianLikes` plus `pinnedHandles` (the scoring layer gets account status via the stamped metadata, not a gateway). Computed in code from LLM judgments + account status + corroboration context.

6. **claimRisk penalty + selection gate (FR-C8, AC-25):** if `!verified && claimRisk === "high"`, add `claimRiskHighPenalty` AND set `blockedUnlessOverride = true`. `select.ts` excludes any story with `blockedUnlessOverride` unless `config.x.allowUnverifiedHighRisk`.

7. **Recency tiebreaker LAST (FR-C2, AC-20):** `recencyMultiplier = minMultiplier + (maxMultiplier - minMultiplier) * freshnessFraction`, `freshnessFraction = clamp(1 - age/maxAgeHours, 0, 1)` → multiplier in `[0.95, 1.0]`. `finalScore = round2(qualityScore * recencyMultiplier)`. Max downward move is 5% of qualityScore ≤ ~5 points (AC-20). `recencyAdjustment = finalScore - qualityScore` stored.

All new fields populated in `components`, `weightedContributions`, and `RankedStory` (qualityScore, finalScore, engagementComponent, engagementRatio, corroborationComponent, recencyMultiplier, appliedPenalties). FR-C11 satisfied.

### C.5 Selection (`select.ts`, FR-C8, finding #12 tiebreak)

`selectTop` skips any `RankedStory` flagged `blockedUnlessOverride` unless `config.x.allowUnverifiedHighRisk`. Still one-per-cluster, top-N, `minScore`. Sorts by `finalScore` (quality-first then recency — FR-E1); **ties within epsilon break on views** (higher first; resolves finding #12's "views only break ties").

### C.6 Prompt + few-shot (`prompt.ts`, `fewshot.ts`, FR-C6/C9, resolves finding #14)

`buildSystemPrompt` gains the new field definitions and an **X-mode note**: when scoring X items, derive a factual `derivedHeadline`, judge `isPrimarySource`/`isNewInformation`, set `flags`. `buildBatchPrompt` includes an `isX`/`hasOutboundLink` hint per item (meaning-only; no numbers).

`fewshot.ts` (single edit — finding #14): every existing example's `score` object gets the 8 new fields with safe defaults (`derivedHeadline` = title, `headlineDerived: true`, `isPrimarySource` per source, `flags` all false, reasonable `specificity`/`hookPotential`, `claimRisk: "low"`). Add **three synthetic X examples** (AC-26): good (fictional company shipping with an outbound link), medium (single-account claim), bad (giveaway/engagement-bait). Clearly fictional names (e.g. "Nimbus Robotics", "@fakefounder"), no real facts, each tagged `synthetic: true`. `FewShotExample` gets `synthetic?: boolean`.

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

`sourceType` enum is `rss | x | primary`. Existing RSS payloads validate unchanged.

### D.2 `buildRasPayload` (`payload.ts`, FR-D2, AC-29) — facts[] for X (resolves finding #2a)

`buildRasPayload` accepts the extra inputs from `prepareForHandoff`: `rankedStory` (for `derivedHeadline`, `hookPotential`, `claimRisk`, `verified`, `outboundUrls`, `quoted`) and the X `authorHandle`/`isXOnly` flag. It builds `facts[]` as the **authoritative claim set (FR-D2)**:
- For RSS/fact-pack items, each `keyFact`/figure becomes `{ claim, sourceUrl, sourceType }` with `sourceType = "primary"` when a primary source exists, else `"rss"`.
- **For X items (decision 2a — build facts[] from X text + outbound_urls, do NOT leave empty):** `facts[]` is populated from the X post text (the derived headline and any concrete claim sentences) and the resolved `outboundUrls`, with `sourceType: "x"` (or `"primary"` when an outbound link is a primary source). This reconciles with FR-D2/AC-29: an X story always has a non-empty `facts[]` so the design step has claims to work from.

`attributionLine = "per @<handle> on X"` **only when the story is X-only** (no corroborating RSS); null otherwise. `derivedHeadline` prefers the LLM-derived headline over the raw title for X items. Downstream reads claims **only** from `payload.facts`.

### D.3 `prepareForHandoff` — remove the signalOnly→limited change (resolves finding #2)

**Decision 2a (resolves finding #2, drops assumption A1).** The prior design assumed a git merge conflict in `autoNewsToRas.ts` and planned to add `|| raw.signalOnly` to the `limited` computation. **Verified: there is NO merge conflict in `autoNewsToRas.ts` — the file is clean and compiles, and `limited` currently does NOT include `signalOnly`.** The assumption A1 is dropped. The `|| raw.signalOnly` change is **REMOVED** and must NOT be made: forcing every X item (all `signalOnly: true`) into `factPackLimited` mode would gut FR-D2's requirement that `facts[]` be populated for X.

The actual, intended behavior: `limited` stays exactly as it is today — `!!(args.raw?.paywalled || args.raw?.factPackLimited || args.raw?.viaFallback)`. For X items, `facts[]` is built from the post text + `outboundUrls` (D.2), and the **trust signal is carried by `verified` and `claimRisk`** on the payload (from scoring, C.4), NOT by collapsing X into limited fact-pack mode. `prepareForHandoff` passes the selected `RankedStory` (and its raw) into `buildRasPayload` so `derivedHeadline`/`verified`/`claimRisk`/`outboundUrls`/`quoted`/`hookPotential` and the X `authorHandle`/`isXOnly` flow through. The injectable `log` is retained (it already exists in the clean file).

---

## Part E — Tests, offline dry-run, report

### E.1 New test files (node:test + node:assert/strict), registered in `package.json` (FR-E5)

1. **`tests/ranking/recencyQuality.test.ts` (FR-E1, AC-19/20)** — parameterized matrix of ages `[1,6,12,18,23]`h × quality levels. Asserts: (a) for two in-window items where the `qualityScore` gap exceeds the recency bound (≥ ~5 pts), the higher-quality item has the higher `finalScore` regardless of age; (b) when `qualityScore` is equal within epsilon, the fresher item wins (higher recency multiplier); (c) a 25h item is dropped by `hardFilter` (`too_old`). Uses `computeRankedStory` + `hardFilter` with injected `now`, no LLM.
2. **`tests/x/xHardFilter.test.ts` (FR-E2, AC-21)** — X items with outbound/long text + engagement survive; replies/reposts always dropped; a bare one-liner with no source dropped; RSS short-summary items still dropped by the RSS rule (proving the branch).
3. **`tests/x/linkExpand.test.ts` (FR-E3, AC-1)** — pure test of `resolveOutboundUrls` + `normalizeScrapedPost`: sample link data with a `t.co` + a fake expander map returns the expanded destination; `x.com`/`twitter.com` dropped; no network. Also covers the `attach_thread_texts` ordering logic via a TS mirror fixture (ordered `posts[]` with `dom_index`) — asserts consecutive same-author grouping caps at 5 and other-author runs yield `[]` (finding #6).
4. **`tests/x/failSoft.test.ts` (FR-E4, AC-12)** — (i) inject a `search` returning `{ stopReason: "login_wall" }` (and captcha/429/empty-twice variants) into `runDiscovery` with stub gateways; assert `aborted:true`, escalating cooldown set, never throws; (ii) inject a `SavedXPostsGateway` whose `recentWithin` throws into `collectXPosts`; assert `{ items: [], perAccount: [] }` and that `collectRankSelect` still ranks RSS items. Assert `collectXPosts` performs no live scrape (no scraper in its import graph).
5. **`tests/x/budgetCooldown.test.ts` (AC-14/16/17)** — stub gateways: exhausting `maxSearchLoadsPerDay` skips further search + logs; same query within `queryCooldownHours` skipped; day-boundary key change resets counters; escalating ladder 12→24→48 advances on repeats.
6. **`tests/x/learning.test.ts` (AC-8)** — `upsertFromScrape` only creates rows from scrape samples; promotion/demotion follow thresholds; `isOfficialAccount` rule (including `officialMinCredibility` gate, finding #13).
7. **`tests/x/corroboration.test.ts` (FR-C5, AC-23, resolves finding #1)** — pure test: build a `CorroborationContext` from mixed RSS+X items; assert an X post whose `outboundUrls` host matches an RSS `url` gets the RSS-match share; assert a group of ≥2 promoted accounts sharing an outbound URL gets the multi-account share; assert the clusterId-equality path is gone (two same-story X and RSS items with different `clusterId` still corroborate via URL, not cluster).
8. **`tests/ras/payloadX.test.ts` (AC-28/29, resolves finding #2)** — X-only story sets `attributionLine = "per @handle on X"`, populates **non-empty** `facts[]` with `sourceType:"x"` (proving the signalOnly→limited change is gone), `verified`/`claimRisk` carry trust; an RSS story leaves X fields empty/default and still validates. Assert `limited` is NOT forced true by `signalOnly`.

Existing tests stay green: `recencyScore` is untouched (still exported); the RSS filter path is unchanged; the `score.test.ts` "perfect item" fixture is updated to a maxed cross-corroborated item asserting `>= 90` (C.1). Any assertion tied to the old weight numbers is updated minimally and noted in the report.

### E.2 Offline dry-run (FR-E6, AC-31) — `src/mastra/demo/xDiscoveryDryRun.ts` + extend `autoNewsDryRun.ts`

New `x:discover:demo` runs `runDiscovery` over **3 topics** with injected heuristic `generateQueries` (fixed strings), injected **mock `search`/`scrapeProfile`** returning synthetic enriched posts (including a truncated one and one that triggers a simulated block), and **stub gateways** — zero network. It prints queries generated, posts scraped, accounts discovered (with status), and writes to a stub `SavedXPostsGateway`. Then it runs `collectRankSelect` with the heuristic ranker reading from that same stub (top-5 ranked **with full breakdown** — qualityScore, engagementComponent, engagementRatio, corroborationComponent, recencyMultiplier, penalties), plus truncated/blocked items. `autoNewsDryRun.ts` is extended to accept an injected `savedPosts` stub (mock-X path) and continues to work feed-only when `X_DISCOVERY_ENABLED=false` (the single switch, B.9).

### E.3 Verification sequence (FR-E7, resolves finding #9) and report (FR-E8)

Implementer runs, in PowerShell (`;` separator): `npm run typecheck` ; `npm run test` ; `npm run auto:dry` **feed-only with `X_DISCOVERY_ENABLED=false`** (the single canonical switch — finding #9, matching the reader gate in B.9) ; `npm run auto:dry` with the mock-X `savedPosts` stub ; `npm run x:discover:demo`. The report states what is **mocked** (LLM query-gen, LLM ranking judgments, the Python scraper/search, all four gateways) vs **real** (the scoring/filter/learning/corroboration **math**, the schemas, the payload builder, the fact pack, the cron wiring), and lists all assumptions with resolutions.

---

## Error handling (per fallible operation)

- **`scrape.py` search/harvest JS eval failure** — caught (existing `CDPError, OSError, TimeoutError`), that scroll yields `[]`, loop continues; recoverable; logged to stderr. Total failure returns `{ error, stop_reason }` (fatal for that query only).
- **Block detected (login/captcha/unusual/429)** — fatal for the X branch this session: `searchXPosts` returns `stopReason`; `runDiscovery` aborts the branch, sets escalating cooldown, returns `aborted:true`. Not recoverable in-session (never retry, never solve). RSS unaffected (separate process). Logged `x.discovery.blocked`.
- **Empty results twice in a row** — soft block: abort + cooldown; recoverable next schedule.
- **LLM query-gen invalid/failed** — retry once; then deterministic template query per topic. Never fatal. Logged `x.query.fallback`.
- **LLM ranking (Stage B) invalid/failed** — unchanged: retry-once then `unscored` + penalty, fail-soft.
- **Gateway read/write error (any of four)** — caught at the call site; reads return empty, writes best-effort. `collectXPosts` read failure → `{ items: [], perAccount: [] }`, RSS proceeds (NFR-1). Logged `x.*.storage_warn`.
- **Budget exhausted** — not an error: skip the activity, log `x.budget.exhausted`, continue (profiles vs search independently gated).
- **`buildRasPayload` with missing X fields** — defaults fill (`facts` from fact pack for RSS, `verified:false`, `attributionLine:null`); always schema-valid. RSS unaffected.
- **Main-workflow X throw** — `collectRankSelect` keeps its try/catch around `collectXPosts`; any X error is logged and the run continues feed-only (NFR-1).
- **Median stamp missing on a saved item** — `accountMedianLikes` defaults to 0 → `relativeEngagement` uses `neutralEngagementRatio`; never throws.

## Input validation (per external input)

- **Topic list** — strings; empty list → no discovery (valid). Each topic trimmed; blank dropped.
- **LLM query strings** — Zod `z.array(z.string()).length(queriesPerTopic)`; handle/`from:` tokens stripped in code; engagement filters enforced/appended. Failure → template fallback.
- **Scraped post fields** — `normalizeScrapedPost` (runs once at the x-publisher boundary, finding #11) coerces to the typed shape with safe defaults; `outbound_urls` filtered to non-x hosts; `thread_texts` capped at 5; unparseable `at` → omit `publishedAt`; `dom_index` defaults to array index.
- **Engagement numbers** — nullable from the scraper; treated as 0 for the floor/ratio; `accountMedianLikes < minSamplesForMedian` (0 stamp) → neutral ratio.
- **`maxAgeHours`** — parsed from env, clamped `[1, 36]`. Unparseable `publishedAt` dropped (`too_old`).
- **`recentWithin` timestamps** — `publishedAt` then `collectedAt` fallback (finding #7); unparseable → treated as stale and excluded from the store read (the ranker still owns the authoritative drop).
- **Config `[min,max]` delays** — used only via injected `rng`/`sleep`; tests no-op (AC-15).
- **Blocklist/pinned handles** — optional, default `[]`; lowercased; both-empty is normal (AC-10).
- **Corroboration URLs** — normalized via `normalizeUrl` before set membership/host comparison; malformed URLs skipped (no throw).

## Invariant ownership

- **"LLM never decides a number / never invents a handle" (NFR-2)** — owned by the **code layer**: query-gen strips handles post-LLM; `score.ts` computes every number including engagement/corroboration components; `learning.ts` owns promotion/credibility. LLM output is meaning fields + query strings + derived headlines, all Zod-validated.
- **"Main workflow never live-scrapes" (FR-B9)** — owned by **module boundaries**: `collectXPosts` imports only `SavedXPostsGateway`, not the scraper. The single feed-only switch is `X_DISCOVERY_ENABLED` (finding #9). Enforced structurally.
- **"qualityScore stays 0–100" (finding #8)** — owned by the **weight budget**: all components 0–10, weights sum to 10, engagement/corroboration are components (not top-of-sum bonuses). Worked maxima in C.1.
- **Corroboration collision correctness (finding #1)** — owned by `rankStories`' pre-scoring `CorroborationContext` + `score.ts`' `corroborationComponent`, over `normalizeUrl`-normalized outbound/RSS URLs and group keys — never over `canonicalKey` (which is per-item).
- **24h drop single source of truth (finding #7)** — owned by `hardFilter`'s `too_old` on `publishedAt`; `recentWithin` is only a store window.
- **Budget/cooldown correctness (FR-B12/B15)** — owned by the gateways + `runDiscovery` (the only writer); day-key and ladder logic are pure, unit-tested.
- **Cluster-key stability for DEDUP (NFR-8)** — `canonicalKey` (unchanged, content-hash based) remains the dedup/ledger key; it is explicitly NOT used for corroboration.
- **"Post nothing / DRY_RUN defaults" (NFR-6)** — unchanged; no publish path added; the cron is read-only scraping.

## Testability notes

- **Unit-testable (pure, no DB/network):** `resolveOutboundUrls`, `normalizeScrapedPost`, the `attach_thread_texts` ordering logic (TS mirror), `relativeEngagement`, `corroborationComponent` + `CorroborationContext` assembly, the recency-multiplier math, `computeRankedStory`, `hardFilter` (X branch), `median`/`credibilityOf`/`statusFor`/`isOfficialAccount`, `buildRasPayload`, budget/cooldown date logic.
- **Integration-testable with stubs (no DB/network):** `runDiscovery` (all deps injected), `collectXPosts` (stub gateway), `collectRankSelect` (heuristic ranker + stub saved-posts).
- **Not unit-testable (requires a real browser/X):** `scrape.py` DOM extraction and block detection — covered by the live cron + the pure `resolveOutboundUrls`/`normalizeScrapedPost`/thread-ordering tests over sample DOM-shaped data. Called out in the report.
- Every network/LLM/DB boundary sits behind an injectable function or gateway (NFR-4).

---

## Technology stack (locked on approval)

TypeScript (ES2022/NodeNext) · Zod 4 · `@mastra/core` (Agent for query-gen, reusing the project small-model resolver; no new provider) · libSQL via `createLibSqlRepository` · Python 3.14 + `websockets` CDP (existing `browser.py`; no Playwright/Selenium) · node:test + node:assert/strict · tsx for crons/demos. No new npm or Python dependencies. Windows/PowerShell (`;` separator). AGENTS.md honored: `mastra` skill loaded before this design; new `xQueryAgent` registered in `src/mastra/index.ts`; `dev`/`build`/`test` npm scripts used, never `mastra dev`/`mastra build` directly.

## File change map

- **Modify:** `tweetytweets/scripts/scrape.py` (HARVEST_JS fields + `dom_index` + ordered `posts[]`, `search` subcommand, argparse `choices=["user","search"]` + conditional `--handle`/`--query`, `detect_block`, pure `attach_thread_texts` post-pass); `src/mastra/lib/x-publisher.ts` (`ScrapedXPost` fields + `dom_index`, `QuotedXPost`, `normalizeScrapedPost` at the boundary, `searchXPosts`); `src/mastra/lib/collect-x-posts.ts` (read-from-storage mode, new `CollectXResult` without `sessionNotReady`, `X_DISCOVERY_ENABLED` feed-only gate, `resolveOutboundUrls`, **export** `postToRaw` with median-stamp opts); `src/mastra/config/ranking.config.ts` (maxAge 24/36, recency weight→0 + tiebreaker, folded engagement/corroboration weights summing to 10, X block incl. `viewsBonusMax`); `src/mastra/schemas/ranking.ts` (LlmScore 8 fields, ScoreComponents, RankedStory, RankInputItem X fields); `src/mastra/lib/ranking/hardFilter.ts` (X branch); `src/mastra/lib/ranking/rankStories.ts` (pre-scoring `CorroborationContext` assembly + inject into `ScoreContext`); `src/mastra/lib/ranking/score.ts` (qualityScore→finalScore, engagement + corroboration components, verified, recency tiebreaker); `src/mastra/lib/ranking/select.ts` (high-risk gate + views tiebreak); `src/mastra/lib/ranking/prompt.ts` + `fewshot.ts` (X judgments + synthetic examples + update all existing examples in the same edit); `src/mastra/schemas/handoff.ts` + `src/mastra/lib/ras/payload.ts` (payload fields + X `facts[]`); `src/mastra/lib/workflow/autoNewsToRas.ts` (`rawToRankItem` X fields, `collectXPosts({ log })` call + drop `sessionNotReady` log, `prepareForHandoff`→`buildRasPayload` wiring; **NO** `signalOnly`→`limited` change); `src/mastra/index.ts` (register `xQueryAgent`); `package.json` (new test files + `x:discover*` scripts); `src/mastra/demo/autoNewsDryRun.ts` (mock-X path via injected `savedPosts`).
- **Add:** `src/mastra/config/xDiscovery.ts`; `src/mastra/lib/x-discovery/{queryGen,runDiscovery,learning}.ts`; `src/mastra/lib/x-discovery/stores/{discoveredAccounts,xScrapeHealth,xBudget,savedXPosts}.ts`; `src/mastra/agents/xQueryAgent.ts`; `src/mastra/cron/runXDiscovery.ts`; `src/mastra/demo/xDiscoveryDryRun.ts`; `tests/ranking/recencyQuality.test.ts`; `tests/x/{xHardFilter,linkExpand,failSoft,budgetCooldown,learning,corroboration}.test.ts`; `tests/ras/payloadX.test.ts`.

---

## Responses to design-review findings

- **#1 (HIGH — corroboration by cluster is infeasible):** RESOLVED in C.4 + Overview item 4. Dropped the clusterId-equality branch entirely (verified `canonicalKey` in `ledger-key.ts` is per-item: own normalized URL + content hash of own title+summary, so X and RSS never share a clusterId). Corroboration is redefined over colliding signals: X `outboundUrls` host/normalized-URL vs. the RSS `url` set (`matchOutboundToRss` using the existing `normalizeUrl`), and X-post groups sharing outbound URLs or near-duplicate text for the multi-account signal. The RSS URL set is assembled in the new pre-scoring stage in `rankStories.ts`.
- **#2 (HIGH — A1 merge conflict is false; signalOnly→limited is unrequested):** RESOLVED in D.3 + D.2. Verified `autoNewsToRas.ts` has no conflict markers and `limited` does not include `signalOnly`; dropped assumption A1. Removed the `|| raw.signalOnly` change. X items now build a non-empty `facts[]` from text + outbound URLs (D.2) with trust carried by `verified`/`claimRisk`, reconciled with FR-D2.
- **#3 (HIGH — no assembly point for cross-item context):** RESOLVED in C.4 + B.7. Added the explicit pre-scoring stage in `rankStories.ts` that builds `CorroborationContext` and injects it into `ScoreContext`; `accountMedianLikes/Reposts` are stamped onto `RawContent.metadata` at save time in `runDiscovery` (step 7) and travel through `recentWithin` → `rawToRankItem` → `relativeEngagement`. One concrete path.
- **#4 (MED — CDP fingerprint claim wrong):** RESOLVED in B.4. Stated plainly that UA/viewport consistency comes from the persistent dedicated Chrome profile, not from code; no CDP overrides added; `browser.py` unchanged.
- **#5 (MED — collectXPosts signature/migration):** RESOLVED in B.9. New `CollectXResult` (no `sessionNotReady`), new signature taking `savedPosts`/`maxAgeHours`/`config`, `sessionNotReady` removed and its only log site updated, callers/tests migrated to inject a stub gateway.
- **#6 (MED — thread detection infeasible):** RESOLVED in A.1. Scraper emits ordered `posts[]` with per-post `dom_index`; a pure `attach_thread_texts` post-pass groups consecutive same-author posts (cap 5) into `thread_texts`.
- **#7 (MED — recency double-counting):** RESOLVED in B.5 + C.3. `recentWithin` filters on `publishedAt` (fallback `collectedAt`) as a store window only; `hardFilter`'s `too_old` remains the single source of truth for the 24h drop.
- **#8 (MED — 0–100 scale broken):** RESOLVED in C.1 + C.4. Engagement (w=1.0) and corroboration (w=0.5) folded into the 10-weight budget as 0–10 components; recency weight→0. Worked maxima show maxed X = 100 and maxed RSS = 85–90. "perfect item > 90" kept valid by updating the fixture to a cross-corroborated maxed item asserting `>= 90`.
- **#9 (MED — feed-only switch mismatch):** RESOLVED in B.9 + E.3. One canonical switch `X_DISCOVERY_ENABLED=false`; the reader gate and the FR-E7 acceptance command both use it.
- **#10 (NIT — argparse):** RESOLVED in B.3. `cmd choices=["user","search"]`, `--handle` conditionally required (user), `--query` required for search.
- **#11 (NIT — normalizer boundary):** RESOLVED in A.3. `normalizeScrapedPost` runs once at the x-publisher boundary for both `scrapeXPosts` and `searchXPosts` before `postToRaw`; the saved-posts read path is already `RawContent` and is not re-normalized.
- **#12 (NIT — views magnitude):** RESOLVED in C.1 + C.5. Added `viewsBonusMax` (default 0 → views contribute 0 points); views only break `finalScore` ties in `select.ts`.
- **#13 (NIT — officialMinCredibility missing):** RESOLVED in B.1 + B.6. Added `officialMinCredibility` (conservative default 8) to `XDiscoveryConfig`; `isOfficialAccount` uses it.
- **#14 (NIT — few-shot compile break):** RESOLVED in C.2 + C.6. All existing few-shot examples are updated with the 8 new fields in the same edit that makes them required.

### Hard constraints honored
Post nothing; `INSTAGRAM_DRY_RUN`/`REQUIRE_APPROVAL` default true; no git commit/push/config changes; RSS pipeline keeps working if X is unavailable (fail-soft at every X touchpoint — `collectXPosts` returns empty, main-workflow try/catch, `runDiscovery` catches all throws); never bypass captcha/login walls; every tunable number in config with conservative defaults; LLM judges meaning + writes query strings/headlines while code decides every ranking/promotion/budget/selection number. Windows/PowerShell `;` separator; scraper shells to plain `python` over CDP-websockets.
