# Requirements — X Topic-Driven Discovery, Scraper Enrichment, Quality-First Ranking, and Payload Extensions

## Summary

The project is a Mastra (TypeScript) content pipeline that ingests RSS feeds and a live X/Twitter signal, ranks candidate stories, builds a verified fact pack, sources an image, and hands a typed payload to a downstream RAS render/publish step. X scraping runs through an existing Python CDP browser automation (`tweetytweets/scripts/`), not an API. Today the X path scrapes a **static** handle list on every main-workflow cycle, the ranker weighs recency heavily via an exponential half-life, and the ranker/payload carry no X-specific judgments.

This work makes five coordinated changes:

- **A. Scraper enrichment** — extract outbound (t.co-resolved) links, expanded "Show more" text, quoted posts, and self-thread continuations from each post, threaded through `ScrapedXPost` and the `RawContent` mapping.
- **B. Topic-driven discovery + its own schedule + budgets** — replace the guessed handle list with LLM-generated search queries over configured topics, learn accounts from real scrape results (never invent handles), persist discovered accounts / scrape-health / daily-budget state, and run X scraping on a **separate 6-hour schedule** whose results the main workflow only *reads*.
- **C. Quality-first ranking rework** — compute a `qualityScore` first (LLM meaning judgments + relative engagement + corroboration), then apply a bounded recency tiebreaker (max ~5 points) to produce `finalScore`; add X-specific hard filters and LLM judgments; cap max age at 24h.
- **D. Payload extensions** — add `derivedHeadline`, `hookPotential`, `facts[]`, `verified`, `claimRisk`, `outboundUrls`, `quoted`, `attributionLine`; backward-compatible for RSS.
- **E. Tests + offline dry-run + report** — parameterized recency-vs-quality tests, X-filter tests, link-expansion unit test, fail-soft block test, and a 3-topic offline dry run; final report of what is mocked vs real plus assumptions.

The hard, non-negotiable constraints: post **nothing**; keep `INSTAGRAM_DRY_RUN` and `REQUIRE_APPROVAL` defaulting true; no git commit/push/config changes; the RSS pipeline must keep working when X is unavailable; never bypass a captcha or login wall; every tunable number lives in config and starts conservative.

## Scope note on process

Per AGENTS.md, implementers must load the `mastra` skill and verify Mastra APIs against `node_modules/@mastra/*` before any Mastra work; register all agents/tools/workflows/scorers/crons in `src/mastra/index.ts`; and use the `dev`/`build` npm scripts rather than `mastra dev`/`mastra build` directly. These are process constraints the design and implementation steps must honor; they are restated here so later steps carry them forward.

---

## Functional Requirements

### A. Scraper enrichment (`scrape.py` HARVEST_JS, `ScrapedXPost` in `x-publisher.ts`, `RawContent` mapping in `collect-x-posts.ts`)

- **FR-A1 Outbound links.** For each post, capture every outbound link's expanded destination URL, returned as `outbound_urls: string[]`. t.co links must be resolved to their real destination (by reading the anchor's real `href`/expanded URL in the rendered DOM, or by following the redirect). Links whose resolved host is `x.com`/`twitter.com` are dropped. Empty array when none.
- **FR-A2 Truncated text.** When a post shows a "Show more" control, expand it and capture the full text. When the full text cannot be obtained, set `text_truncated: true`; otherwise `false`.
- **FR-A3 Quoted posts.** Capture a quoted post as `quoted: { text, author_handle, url, at } | null`.
- **FR-A4 Self-threads.** When a post is the first in a thread authored by the **same** account, capture up to 5 following posts' text as `thread_texts: string[]` (hard cap 5). Threads by other authors are not captured.
- **FR-A5 Explicitly skipped.** Do not capture media URLs or author display names.
- **FR-A6 Preserve existing flags.** Keep `is_reply` and `is_repost`. The ranker drops both by default (see FR-C3).
- **FR-A7 Thread fields through TS types.** Extend `ScrapedXPost` (`x-publisher.ts`) with `outbound_urls`, `text_truncated`, `quoted`, `thread_texts`, and map them onto `RawContent` (in `collect-x-posts.ts`) — outbound links and quoted/thread context stored where the ranker and payload can read them (e.g. `metadata` plus any first-class fields the design defines). New fields are additive and backward-compatible: posts scraped before enrichment (or by the old path) must still map cleanly with sensible empty defaults.

### B. Topic-driven discovery, scheduling, budget, health

- **FR-B1 Topic list in config.** A configurable topic list (AI, startups, deeptech, plus India variants) drives discovery. Each topic produces X search queries.
- **FR-B2 LLM-generated queries.** For each topic, the LLM generates **2** X search queries that include engagement filters, e.g. `(topic terms) min_faves:300 filter:links -filter:replies lang:en`. The LLM produces **query strings only** — it must never invent account handles.
- **FR-B3 Top tab primary, Latest secondary.** Scrape the **Top** tab. Use the **Latest** tab only as a secondary pass when Top returns fewer than a configurable minimum number of posts.
- **FR-B4 Same extraction.** Search-result posts are extracted with the same enrichment as section A (FR-A1–A6).
- **FR-B5 Learn accounts, never guess.** Persist a `discovered_accounts` store with at least: `handle`, `first_seen`, `times_seen`, `median_likes`, `median_reposts`, `credibility_score`, `status`. A handle enters the store **only** if it came from a real scrape. Accounts that recur with strong engagement are promoted; engagement-bait/giveaway/spam accounts are demoted. The exact promotion/demotion thresholds are config-driven numbers.
- **FR-B6 Scrape promoted profiles.** For **promoted** accounts, also scrape the profile via the existing per-handle scraper, so strong sources are covered when search misses them. Visit each promoted profile **at most once per day** (persisted).
- **FR-B7 Optional block/pin lists.** Support optional config `blocklist_handles` (never scraped/learned) and `pinned_handles` (always treated as sources). Both are optional; the system must work with both empty.
- **FR-B8 Separate schedule.** X scraping runs on its **own** schedule, separate from the 30–60 min main workflow. Default interval **every 6 hours**, configurable. Results are saved to storage. Add a runner under `src/mastra/cron/` following the existing cron runner pattern (e.g. `runAutoNewsRadar.ts`), and register anything needed in `src/mastra/index.ts`.
- **FR-B9 Main workflow reads only.** The main workflow (`collectRankSelect` → `collectXPosts`) must read **saved** X posts from storage and must **never** trigger a live X scrape. The live-scrape code path in the current `collectXPosts` must be replaced by (or gated behind) a read-from-storage path for the main workflow.
- **FR-B10 Dedicated account + consistent fingerprint.** Reuse the existing dedicated Chrome CDP profile in `browser.py` (the "secondary account", never a personal one). Do **not** re-login each run. Keep user agent and viewport **consistent** across runs.
- **FR-B11 Per-session ceilings.** Per discovery session: ≤3 topics × ≤2 queries × ≤2 scrolls; Top tab only (Latest only under the FR-B3 minimum); hard cap **40 posts per session**. All four numbers are config.
- **FR-B12 Daily budget, persisted.** Max **30** search page loads and max **20** profile visits **per day** (both config). When either budget is exhausted, skip the corresponding X activity for the rest of the day and log it. Budget counters reset on day boundary and survive process restarts (persisted).
- **FR-B13 Human-like pacing.** Random delay **4–12 s** between actions, **30–90 s** between queries, **±20%** jitter on session start time. One tab at a time, **never** parallel. All ranges are config.
- **FR-B14 Query cooldown + dedupe.** Do not re-run the same query within a cooldown (default **4 h**, config). Dedupe collected posts by post URL.
- **FR-B15 Stop conditions + escalating cooldown.** On any of: login wall, captcha, "unusual activity" notice, HTTP 429, or empty results **twice in a row** — abort the X branch immediately, continue with RSS, and start an escalating cooldown: **12 h → 24 h → 48 h** on repeats. Never retry in the same session; never attempt to solve or bypass a captcha/block. Health/cooldown state is persisted.
- **FR-B16 Health/budget stores.** Persist discovered-accounts, scrape-health (last run, stop reason, cooldown-until, consecutive-empty count), and daily-budget state. Each store is accessed through an injectable gateway interface with a libSQL-backed implementation and an in-memory stub, mirroring `RankStorageGateway`/`createStubGateway` so tests run with no DB.
- **FR-B17 Conservative defaults.** Every number above starts conservative; looser values can be set later via config/env.

### C. Quality-first ranking (applies globally to RSS **and** X)

- **FR-C1 Max age 24h.** Freshness window is max age **24 h** (configurable, up to 36 h). Items older than max age are dropped in the hard filter. This replaces the current `maxAgeHours` default of 6.
- **FR-C2 Recency is tiebreaker only.** Recency must not be a main scoring factor. It is applied **last** as a bounded tiebreaker — either a multiplier in **[0.95, 1.0]** across the window or a near-zero additive weight — such that no freshness term moves a story by more than **~5 points**. The existing exponential half-life recency term is removed from the main weighted sum (or its weight driven to ~0) and replaced by this bounded tiebreaker.
- **FR-C3 qualityScore then finalScore.** Compute `qualityScore` first from: LLM meaning judgments (FR-C6), relative engagement (FR-C4), and corroboration (FR-C5). Then apply the bounded recency tiebreaker to produce `finalScore`. Both scores and the full component breakdown are kept per story in the output (extend `ScoreComponents` and `RankedStory` in `schemas/ranking.ts`).
- **FR-C4 Relative engagement.** Score each X post's `likes + reposts + replies` **relative to that account's own median** over its recent scraped posts (a capped ratio). Use `views` only when present. Never use raw likes alone. The account medians come from the `discovered_accounts` store / recent scrape history.
- **FR-C5 Corroboration.** Add a bonus when an X post's `outbound_urls` or text match an RSS cluster, and when several distinct credible accounts discuss the same story. The cluster key must be **stable across runs** (reuse the existing `canonicalKey` approach so a cluster id is reproducible).
- **FR-C6 LLM scoring additions.** Extend the Stage-B structured output (Zod-validated in `schemas/ranking.ts`, same batching / retry-once / fail-soft behavior as now) with: `isNewInformation` (bool), `isPrimarySource` (bool), `specificity` (0–10), `hookPotential` (0–10), `claimRisk` (`low|medium|high`), `flags` (`engagementBait`, `selfPromotion`, `giveaway`, `hotTakeThread` booleans), `derivedHeadline` (a factual plain headline written from the text) and `headlineDerived: true`.
- **FR-C7 X-specific hard filters.** For X items only: skip the short-summary filter; drop replies and reposts; drop posts under a configurable minimum engagement floor; require **either** `outbound_urls` present **or** text above a configurable minimum length (a bare one-liner with no source is insufficient). Existing RSS hard filters stay intact and unchanged for RSS items.
- **FR-C8 verified flag.** `verified = true` only if the account is official, **or** the post links to a primary source, **or** an RSS item in the same cluster corroborates it. Unverified single-account stories with `claimRisk: high` are penalized and **cannot** be selected unless a config flag (default **off**) enables it.
- **FR-C9 Few-shot X examples.** Update `src/mastra/lib/ranking/fewshot.ts` with good / medium / bad X examples. Examples are **synthetic**: clearly fictional company/person names, no real facts, each example object tagged `synthetic: true`.
- **FR-C10 Everything tunable in config.** All new numbers (engagement floor, min text length, recency bound, corroboration bonuses, penalty sizes, the verified-override flag, max age) live in `ranking.config.ts`.
- **FR-C11 Output full breakdown.** The ranked output exposes the full per-story score breakdown including the new components (qualityScore, engagement ratio, corroboration, recency tiebreaker, applied penalties).

### D. Payload to the design/RAS step (`schemas/handoff.ts`, `lib/ras/payload.ts`, `prepareForHandoff`)

- **FR-D1 New fields.** Extend `RasPayload` (and `buildRasPayload` + the `prepareForHandoff` caller) with: `derivedHeadline`, `hookPotential`, `facts` (array of `{ claim, sourceUrl, sourceType }`), `verified`, `claimRisk`, `outboundUrls`, `quoted`, and `attributionLine` (e.g. `"per @handle on X"` when the story is X-only).
- **FR-D2 Facts are the only claims.** The design step must use **only** claims listed in `facts`. The payload's `facts` array is the authoritative claim set.
- **FR-D3 Backward compatibility.** All new fields are optional or empty where not applicable so existing RSS payloads remain valid. RSS items without X context get empty/absent X-specific fields (e.g. empty `outboundUrls`, null `quoted`, no `attributionLine`).

### E. Tests, offline dry-run, and report (node:test + node:assert/strict)

- **FR-E1 Parameterized recency-vs-quality test (replaces the single 18h-vs-2h example).** Across several age/quality combinations (ages **1h, 6h, 12h, 18h, 23h**): (a) within the 24h window the higher `qualityScore` wins regardless of age **when the quality gap exceeds the recency bound**; (b) when quality is equal within a small epsilon, the **fresher** item wins; (c) items older than max age are **dropped**.
- **FR-E2 X filter test.** X items survive the X-specific filters and replies/reposts are dropped.
- **FR-E3 Link-expansion unit test.** t.co links come back expanded — a **pure function** over sample link data (mapping/extraction logic), with **no network** and no X access.
- **FR-E4 Fail-soft block test.** A simulated scraper block (login wall / captcha / 429 / empty-twice) does **not** fail the run and RSS still proceeds — achieved by injecting a failing scraper into the discovery/collect layer.
- **FR-E5 Register tests.** New test files are added to the explicit `test` file list in `package.json`.
- **FR-E6 Offline dry-run.** Extend or add a demo under `src/mastra/demo/` (following `autoNewsDryRun.ts`) that runs over **3 topics** with an injected heuristic/mock LLM and an injected mock scraper so it runs fully offline and hits **no network**. It shows: queries generated, posts scraped, accounts discovered, top-5 ranked **with full breakdown**, and any item truncated or blocked.
- **FR-E7 Verification sequence.** After implementation, run `npm run typecheck`, then `npm run test`, then the dry-run. `npm run auto:dry` must still work feed-only (X disabled via `X_WATCH_ENABLED=false` or equivalent) **and** with the mock X path.
- **FR-E8 Final report.** Report what is mocked vs real and list all assumptions.

---

## Non-Functional Requirements

- **NFR-1 Fail-soft boundary.** Every point where X touches the main pipeline must fail soft — an X error (scrape failure, markup change, block, empty store) must never throw into the news run. The RSS-only run must remain unchanged when X is off or unavailable.
- **NFR-2 LLM/code boundary.** The strict boundary holds: the LLM judges **meaning** (and generates search query strings and derived headlines); **code** decides every number that affects ranking, promotion/demotion, budgets, and selection. The LLM never invents handles and never emits the final ranking number.
- **NFR-3 Additive/backward-compatible.** Changes to RSS-path behavior are additive. Existing RSS hard filters, existing payload consumers, and existing tests must continue to pass unchanged except where a requirement explicitly changes them (e.g. max age, recency term).
- **NFR-4 Testability without a DB or network.** New persistence (discovered accounts, scrape health, daily budget) is reached through injectable gateways with in-memory stubs; scraping, LLM, and session checks are injectable. Tests and the dry-run run offline with no DB and no network.
- **NFR-5 Config-first & conservative.** Every tunable number lives in config (`ranking.config.ts`, the X-discovery config, `xAccounts.ts` as appropriate) and starts conservative.
- **NFR-6 Safety.** Post nothing. `INSTAGRAM_DRY_RUN` and `REQUIRE_APPROVAL` default true. No git commit/push/config changes. Never bypass a captcha/login wall. Read-only X scraping (nothing is posted/liked/followed).
- **NFR-7 Platform.** Windows + PowerShell (`;` as separator, not `&&`). Python interpreter is plain `python` (pythoncore-3.14-64); `websockets` is already installed. The scraper is CDP-over-`websockets`, not Playwright/Selenium.
- **NFR-8 Determinism of cluster keys.** Cluster keys used for corroboration and dedupe must be reproducible across runs so persisted state (budgets, cooldowns, discovered accounts, corroboration) stays coherent between the separate X schedule and the main workflow.

---

## Acceptance Criteria (testable, numbered)

1. `scrape.py` returns, per post, `outbound_urls: string[]` with t.co links resolved to their destination and `x.com`/`twitter.com` links removed; posts with no external links return `[]`.
2. A post with a "Show more" control yields full expanded text; when expansion fails, the post carries `text_truncated: true`, otherwise `false`.
3. A post with a quoted tweet yields `quoted` with `{ text, author_handle, url, at }`; a post without one yields `quoted: null`.
4. A first post of a same-author thread yields up to 5 `thread_texts`; never more than 5; threads by other authors yield none.
5. `ScrapedXPost` and the `RawContent` mapping carry all four new fields with safe empty defaults; a post from the pre-enrichment shape still maps without error.
6. Given a topic list, the discovery layer produces exactly 2 LLM-generated query strings per topic, each containing engagement filters; no handle is ever produced by the LLM.
7. Discovery uses the Top tab first and only issues a Latest pass when Top returns fewer than the configured minimum.
8. A handle appears in `discovered_accounts` only after it is seen in a real scrape result; promotion and demotion follow the configured engagement/credibility thresholds; status transitions are persisted.
9. Promoted accounts are profile-scraped at most once per calendar day (persisted); a second attempt the same day is skipped and logged.
10. With `blocklist_handles` and `pinned_handles` both empty, discovery runs normally; blocklisted handles are never scraped/learned; pinned handles are always treated as sources.
11. A separate cron runner under `src/mastra/cron/` runs X scraping on a default 6h interval, writes results to storage, and is registered as needed in `src/mastra/index.ts`; the interval is configurable.
12. The main workflow reads saved X posts from storage and performs **no** live X scrape — verified by the fail-soft/injection test and by `auto:dry` producing X items purely from saved/mock data.
13. Per session, discovery never exceeds 3 topics × 2 queries × 2 scrolls and never returns more than 40 posts; all four limits are read from config.
14. Daily budgets of 30 search page loads and 20 profile visits are enforced and persisted; exhausting either budget skips the matching activity for the rest of the day and logs it; counters reset at the day boundary and survive a restart.
15. Observed action/query delays fall within 4–12 s and 30–90 s respectively, session start carries ±20% jitter, and only one tab is ever open at a time (verified via the injected timing hooks, not by wall-clock in tests).
16. The same query is not re-run within the 4h cooldown; posts are deduped by URL.
17. Each stop condition (login wall, captcha, "unusual activity", HTTP 429, empty-twice) aborts the X branch, lets RSS proceed, and sets an escalating 12h→24h→48h cooldown persisted across runs; no captcha is ever solved or bypassed.
18. Hard filter drops items older than 24h (default) and the max age is configurable up to 36h.
19. For two items inside the 24h window whose `qualityScore` gap exceeds the recency bound, the higher-quality item outranks the fresher one; when quality is equal within epsilon the fresher item wins; this holds across ages 1h/6h/12h/18h/23h (parameterized test passes).
20. No freshness adjustment changes a story's score by more than ~5 points (recency multiplier stays within [0.95, 1.0] of the quality score, or the additive recency term is bounded accordingly).
21. X items pass filters only when they are not replies/reposts, clear the configured engagement floor, and have either `outbound_urls` or text above the minimum length; replies and reposts are always dropped; RSS filters are unchanged for RSS items.
22. Engagement is scored relative to the account's own median (capped ratio), views used only when present, and raw likes alone are never the sole signal.
23. Corroboration bonuses apply when X `outbound_urls`/text match an RSS cluster and when multiple distinct credible accounts cover the same (stable-keyed) cluster.
24. Stage-B LLM output validates against the extended Zod schema with `isNewInformation`, `isPrimarySource`, `specificity`, `hookPotential`, `claimRisk`, `flags{...}`, `derivedHeadline`, `headlineDerived`; a malformed response still triggers retry-once then fail-soft (unscored), exactly as today.
25. `verified` is true only via official account / primary-source link / RSS cluster corroboration; an unverified single-account `claimRisk: high` story is penalized and is not selectable while the override flag is off (default), and becomes selectable only when the flag is on.
26. `fewshot.ts` includes good/medium/bad X examples, all with fictional names and `synthetic: true`.
27. Every new ranking number is present in `ranking.config.ts`; the ranked output includes the full per-story breakdown (qualityScore, finalScore, engagement ratio, corroboration, recency tiebreaker, penalties).
28. `RasPayload` includes `derivedHeadline`, `hookPotential`, `facts[]` (`{claim, sourceUrl, sourceType}`), `verified`, `claimRisk`, `outboundUrls`, `quoted`, `attributionLine`; an X-only story sets `attributionLine` to `"per @handle on X"`; an RSS story leaves X-specific fields empty/absent and still validates.
29. The `facts` array is the only claim source available to the design step (claims not in `facts` are not surfaced).
30. `npm run typecheck` passes; `npm run test` passes with the new tests registered in `package.json`; `npm run auto:dry` works both feed-only (X disabled) and with the mock X path.
31. The 3-topic offline dry-run runs with injected mock LLM + mock scraper, touches no network, and prints: queries generated, posts scraped, accounts discovered, top-5 ranked with full breakdown, and any truncated/blocked items.
32. The final report states what is mocked vs real and lists all assumptions.
33. No post is ever published; `INSTAGRAM_DRY_RUN` and `REQUIRE_APPROVAL` remain defaulting true; no git commit/push/config change is made.

---

## Out of Scope

- Posting, publishing, or any write action to X or Instagram (read-only scraping and dry-run only).
- Any X API / paid tier integration — scraping stays on the existing CDP `websockets` browser.
- Media URL and author display-name extraction (explicitly excluded by FR-A5).
- Solving or bypassing captchas, login walls, or blocks.
- Swapping the few-shot synthetic examples for real posts (owner will do this later).
- Replacing the light rank-item mapping with full cross-source clustering (the `industryAggregationWorkflow` path) — noted as a pre-existing flagged limitation, not part of this work beyond keeping the corroboration cluster key stable.
- Changing the Mastra workflow/agent framework versions or the `dev`/`build`/`start` scripts themselves.
- Loosening any conservative default (owner will loosen after a warning-free week).

---

## Assumptions (noted for the design review to confirm)

- **A1 — Merge conflict in `autoNewsToRas.ts`.** `prepareForHandoff` currently contains an unresolved Git merge conflict (`<<<<<<< HEAD` … `>>>>>>>`). The two sides differ on whether `signalOnly` counts toward `limited` and whether a `log` is injected. This file must compile, so resolving this conflict is in scope for the implementation; the design step should choose the resolution. Assumption: keep `signalOnly` contributing to `limited` (the HEAD side) since X posts are signal-only, and retain the injectable `log`. The design review should confirm.
- **A2 — "official account" signal.** "Account is official" (FR-C8) is assumed to be derived from the `discovered_accounts` store's `status`/credibility plus optional `pinned_handles`, since no verified-badge field is scraped. Design should define the concrete rule.
- **A3 — `sourceType` in facts.** `facts[].sourceType` is assumed to be an enum over at least `rss | x | primary` (or similar), to be finalized in design.
- **A4 — Account medians source.** FR-C4 relative engagement needs per-account medians; assumed to come from `discovered_accounts.median_likes/median_reposts` updated by the discovery runs, with a neutral fallback ratio when an account has too few samples.
- **A5 — "Separate schedule" storage contract.** The X runner writes a saved-posts store that the main workflow reads via `collectXPosts`. Assumed shape: a persisted list of enriched posts (already mapped toward `RawContent`) with a freshness window so the main workflow ignores stale entries older than max age. Design to define the exact store/table and its gateway + stub.
- **A6 — Topic→query LLM lives behind an injectable generate fn** (like `RankGenerate`) so the dry-run and tests can supply a deterministic heuristic. The real query generator uses an existing agent/model; design picks which.
- **A7 — "secondary X account."** The existing dedicated CDP Chrome profile in `browser.py` is treated as the secondary account; no new profile is provisioned by this work. The owner is responsible for having signed that profile into the dedicated (non-personal) account.
- **A8 — Recency bound realization.** The bounded tiebreaker is assumed implemented as a multiplier in [0.95, 1.0] applied to `qualityScore` to produce `finalScore` (equivalently ≤5% of a ≤100 score ≈ ~5 points). If a design prefers an additive bounded term, it must still guarantee the ≤~5-point ceiling.
- **A9 — `maxScrolls` semantics.** The existing per-handle scraper takes `maxScrolls`; the ≤2-scrolls session ceiling (FR-B11) is assumed to map onto that parameter for search scraping. Design to confirm the search-scrape entrypoint (new `search` subcommand in `scrape.py` vs a new script).
- **A10 — Day boundary.** Daily budgets reset on a configurable timezone boundary (assumed local/server midnight unless design specifies IST given the India focus).
