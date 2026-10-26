# Design Review — 02-design.md

Reviewed fresh against `01-requirements.md` and verified against the actual source in the repo. The design is thorough and mostly well-grounded, but several of its claims about existing code are wrong or unverified, and a few flows are described but not specified well enough to implement without ambiguity.

Verdict: **CHANGES_REQUESTED** (3 HIGH, 6 MEDIUM, 5 NIT).

---

## Findings

### 1. HIGH — Corroboration-by-cluster-match is infeasible as designed; `canonicalKey` never collides across X and RSS

Part C.4 step 3 and FR-C5 say corroboration fires when "the X item's `clusterId` (stable `canonicalKey`, A5/NFR-8) matches an RSS item's cluster." I read `src/mastra/lib/safety/ledger-key.ts`: `canonicalKey(url, title, summary)` = `normalizeUrl(url) + "::" + contentHash(title, summary)`. It is keyed on the **item's own URL plus a hash of its own title+summary**. An X post and an RSS article about the same story have different URLs and different text, so they produce **different** `clusterId`s. `rawToRankItem` in `autoNewsToRas.ts` confirms each raw becomes its own cluster (`clusterSourceCount: 1`), and the design itself notes clustering is out of scope. So "X item's `clusterId` matches an RSS item's cluster" can essentially never be true — the cluster-id branch of corroboration is dead code.

The design's own fallback ("OR an `outboundUrl` host matches an RSS item's URL host") is the only workable path, and "multiple distinct credible accounts share the cluster" has the same problem (each account's post is its own cluster).

Fix: Drop the clusterId-equality branch. Define corroboration purely over signals that actually collide: (a) an X `outboundUrl` host/normalized-URL matches an RSS item's `primaryUrl`/`url` host, and (b) "multiple distinct credible accounts" is detected by grouping X posts whose `outboundUrls` or normalized text overlap — not by `clusterId`. Specify the exact match function (host-only vs normalized-full-URL) and where the RSS URL set is assembled. Keep the NFR-8 "stable key" guarantee for dedupe/budgets (where it is real), but stop claiming `canonicalKey` unifies X and RSS stories.

### 2. HIGH — Merge-conflict assumption (A1) is false; `signalOnly` change to `limited` is an unrequested behavior change

Assumption A1 and Part D.3 state `prepareForHandoff` in `autoNewsToRas.ts` "currently contains an unresolved Git merge conflict (`<<<<<<< HEAD` … `>>>>>>>`)." I read the full file: there are **no conflict markers**, the code compiles, and `limited` is currently `!!(args.raw?.paywalled || args.raw?.factPackLimited || args.raw?.viaFallback)` — there is no `signalOnly` term and no injected `log` in the merge-conflict sense described. D.3 half-acknowledges this ("the file as read is clean") but then still instructs adding `|| raw.signalOnly` to `limited`.

Making `signalOnly` contribute to `limited` is a real behavior change: **every X item is `signalOnly: true`** (confirmed in `collect-x-posts.ts`), so this forces every X-only story into `factPackLimited` mode, suppressing fact-pack detail for all X stories. That may be desirable, but it is derived from a non-existent merge conflict, not from a requirement, and FR-D2 wants `facts[]` populated from X text + outbound URLs — which a hard `limited` flag could gut.

Fix: Remove the merge-conflict framing entirely (there is no conflict to resolve). State the actual change plainly: "add `|| raw.signalOnly` to `limited` so X-only stories never get invented fact-pack detail," and reconcile it explicitly with FR-D2's requirement that `facts[]` still be built from the X post text/outbound URLs. Confirm this is the intended tradeoff rather than inheriting it from A1.

### 3. HIGH — Corroboration/engagement cross-item context has no defined assembly point in `rankStories`

Part C.4 says `corroborationBonus(item, context, config)` and relative engagement need a `context` carrying "the set of RSS cluster keys," "a count of distinct credible X accounts per cluster," and per-account medians (`accountMedianLikes`). I read `rankStories.ts` and `score.ts`: `computeRankedStory(item, llm, ctx)` is called **per item** in a `.map()`, and `ScoreContext` only has `config`, `now`, `recentRegions`. There is no stage that builds a cross-item corroboration/engagement context, and `RankInputItem` carries none of the X fields. The design lists the new `RankInputItem` fields (C.2) and says medians come from `discovered_accounts` (A4), but never says **who reads the accounts gateway and populates `accountMedianLikes` onto each rank item**, nor where the "distinct credible accounts per cluster" map is computed before the per-item loop.

Fix: Specify the new pre-scoring stage in `rankStories` (or in `collectRankSelect`/`rawToRankItem`): e.g. "before the `kept.map(...)`, build a `CorroborationContext { rssUrlHosts: Set<string>, accountsPerCluster: Map<clusterId, number> }` and inject it into `ScoreContext`; `rawToRankItem` reads `SavedXPostsGateway`/`DiscoveredAccountsGateway` is NOT available at that layer, so medians must be stamped onto `RawContent.metadata` at save time in `runDiscovery`." Pick one concrete data path and name the function that assembles it.

### 4. MEDIUM — `browser.py` does not set UA or viewport on the CDP session; FR-B10 "consistent fingerprint" claim is wrong

Part B.8 states "`UA`/viewport are already constant in `browser.py` — no change needed beyond documenting it." I read `browser.py`: the `UA` constant is used **only** by `plain()` and `og_image()` (plain HTTP `urllib` requests). The CDP-driven pages (`open_page` → `Session`) never call `Network.setUserAgentOverride` or `Emulation.setDeviceMetricsOverride`, so the scraper's UA is whatever Chrome sends by default and the viewport is never pinned. The fingerprint is "consistent across runs" only incidentally (same Chrome binary + same persistent profile dir), not because the code sets it.

Fix: Correct the claim. Either (a) state that consistency comes from the persistent profile + fixed Chrome binary and that no UA/viewport override is applied (accurate), or (b) if FR-B10's "keep UA and viewport consistent" is to be enforced in code, add a small CDP step in the search/scrape path (`Emulation.setDeviceMetricsOverride` + `Network.setUserAgentOverride` to the existing `UA` constant) and say so. Do not assert the code already does something it doesn't.

### 5. MEDIUM — `collectXPosts` signature change drops `config`/`checkSession`/`scrape` params still referenced elsewhere; migration not specified

Part B.9 rewrites `collectXPosts` to `{ savedPosts?, now?, maxAgeHours?, log? }`, removing `config`, `scrape`, and `checkSession`. I verified `collect-x-posts.ts` currently exports those params and that `CollectXResult` includes `sessionNotReady`. The design says `autoNewsToRas.ts`'s call site becomes `collectXPosts({ log })` (already true today — it only passes `log`), but it does not address: (a) existing tests/demos that inject `scrape`/`checkSession` (the design's own FR-E4 test history and any current X tests), (b) whether `sessionNotReady` stays on `CollectXResult`, (c) the now-unused `getXWatchConfig`/`xAccounts.ts` enabled gating that currently makes `collectXPosts` a no-op when `X_WATCH_ENABLED=false` — FR-E7 requires feed-only `auto:dry` to work with "X disabled via `X_WATCH_ENABLED=false` or equivalent," but the new read-from-storage path is gated on `X_DISCOVERY_ENABLED`, not `X_WATCH_ENABLED`.

Fix: Specify the exact new `CollectXResult` shape; state how feed-only mode is selected in the new world (reconcile `X_WATCH_ENABLED` vs `X_DISCOVERY_ENABLED` vs simply an empty `saved_x_posts` store); and list which existing callers/tests of the old signature must change. FR-E7 explicitly names `X_WATCH_ENABLED=false` — either keep honoring it or update the requirement's acceptance path and say so.

### 6. MEDIUM — Thread capture (`thread_texts`) is specified in a layer that cannot see sibling articles reliably; detection heuristic is hand-wavy

Part A.1 `thread_texts` says self-thread detection "happens in `scrape_user` (Python)… when a post is the first of a run of consecutive same-`author_handle` posts… detectable via the presence of a following article by the same author with no intervening `socialContext`." I read `scrape_user`: it harvests via `HARVEST_JS` into a `collected` dict keyed by URL across scroll passes; order is dict-insertion order, and the DOM is re-queried every scroll with lazy loading, so "consecutive articles joined by the thread connector line" is not something the current harvest structure preserves (the connector element is never extracted, and `socialContext` presence is computed per-article but thread adjacency is not). The design calls it "best-effort… if the connector cannot be determined, `[]`," which is an acceptable fallback, but the detection rule as written ("following article by the same author with no intervening socialContext") is not implementable against the current harvest output without also capturing DOM order + the connector element.

Fix: Either (a) extend `HARVEST_JS` to emit a per-article `dom_index` and a `thread_connector: boolean` (whether the article has the vertical thread line to the next), then define `thread_texts` as "for the first article in a maximal same-author run where each has `thread_connector`, take up to 5 following texts in `dom_index` order" — concrete and testable; or (b) explicitly scope thread capture to a pure post-processing pass over an ordered `posts[]` array (keep insertion order, group consecutive same-author, cap 5) and accept it will miss threads broken by X's lazy reordering. Pick one and specify the field additions.

### 7. MEDIUM — `savedPostMaxAgeHours`/`collectedAt` vs `publishedAt` freshness semantics are ambiguous (recency double-counting risk)

A5/B.1/B.5 define `SavedXPostsGateway.recentWithin(maxAgeHours, now)` and stamp `collectedAt = now` at save time, with `savedPostMaxAgeHours: 24`. But the main-workflow ranker's `hardFilter` `too_old` check (and the C.7 24h X filter, and the recency tiebreaker) all operate on the item's **`publishedAt`** (via `ageInHours(item.publishedAt, now)` — verified in `hardFilter.ts`/`score.ts`). The design never says whether `recentWithin` filters on `collectedAt` or `publishedAt`. If it filters on `collectedAt`, a post scraped 1h ago but authored 30h ago passes the store read, then gets dropped by the ranker's `too_old` — fine, but wasteful and confusing. If it filters on `publishedAt`, the "freshness window so the main workflow ignores stale entries" (A5) and the 24h drop are the same check applied twice.

Fix: State explicitly which timestamp `recentWithin` uses (recommend `publishedAt`, falling back to `collectedAt` only when `publishedAt` is absent, mirroring `rawToRankItem`'s `publishedAt ?? collectedAt`), and confirm the ranker's `too_old` filter remains the single source of truth for the 24h drop so recency is not effectively filtered twice with different timestamps.

### 8. MEDIUM — Weight redistribution breaks the documented 0–100 scale invariant and the design's own math is off

Part C.1 removes `recency` (weight 1.0) and redistributes to keep weights summing to 10.0, proposing `significance 2.5→3.0, topicFit 2.0, audienceInterest 2.0, visualPotential 1.0, coverage 0.75→1.0, sourceCredibility 0.75→1.0`. Sum = 3.0+2.0+2.0+1.0+1.0+1.0 = **10.0** ✓. But the design then adds `engagementComponent` (0–10, `engagementWeight` default 1.0) and `corroborationBonus` (up to +8 points) **on top of** the weighted sum (C.4 step 4: `qualityScore = clamp(weightedSum + engagementContribution + corroborationBonus + regionBalance − penalties, 0, 100)`). With weights already summing to 10 (→ max 100 from the weighted sum alone), adding an engagement weight of 1.0×10 = +10 and corroboration +8 means the pre-clamp `qualityScore` maxes near 118 before clamping. That is fine arithmetically (it clamps to 100), but it silently compresses the top of the scale and contradicts the config file's stated invariant ("`weights w1..w7` sum to 10, so Σ ∈ [0,100]"). It also means `score.test.ts`'s "perfect item > 90" assertion behavior changes in ways the design asserts will "hold" without showing the math for an X item.

Fix: Either fold `engagementComponent` into the weight budget (make the weights, including engagement, sum to 10 for X items) or explicitly document that X `qualityScore` is intentionally over-provisioned pre-clamp and update the `ranking.config.ts` header comment. Show the worked max for a maxed X item (weighted 100 + engagement + corroboration → clamp 100) and for a maxed RSS item so the "perfect item > 90" test is demonstrably still green rather than asserted.

### 9. MEDIUM — FR-E7 verification uses `X_WATCH_ENABLED=false` but the design's feed-only gate is `X_DISCOVERY_ENABLED`

Part E.3 says the verification runs `npm run auto:dry` "(feed-only, `X_WATCH_ENABLED=false`)," while B.9/B.1 gate the new read path on `X_DISCOVERY_ENABLED` and an empty `saved_x_posts` store. These are two different env vars controlling two different subsystems (the old live-watch vs the new discovery schedule). After B.9 removes the live-scrape path, `X_WATCH_ENABLED=false` may no longer do anything in the main workflow, so the FR-E7 feed-only command could still read saved X posts.

Fix: Decide the single switch that makes `auto:dry` feed-only (recommend: empty/stubbed `SavedXPostsGateway` or `X_DISCOVERY_ENABLED=false`), and make E.3's command use it. If `X_WATCH_ENABLED` is retired, note that and update the acceptance step; if it is kept as the feed-only kill switch for the reader, wire it in B.9 explicitly.

### 10. NIT — `scrape.py` CLI `choices=["user"]` must be widened for the `search` subcommand

Part B.3 adds a `search` subcommand. I verified `scrape.py`'s argparse: `ap.add_argument("cmd", nargs="?", default="user", choices=["user"])`. The design doesn't mention updating `choices`. Minor, but an implementer following the design literally would get an argparse error.

Fix: Note that `choices` becomes `["user", "search"]` and that `--handle` (currently `required=True`) must become conditionally required (search uses `--query`, not `--handle`).

### 11. NIT — `normalizeScrapedPost` is described as handling "legacy/old-shape posts" but the current `ScrapedXPost` has no optional fields

Part A.2 introduces `normalizeScrapedPost` to default `outbound_urls ?? []` etc. for "a pre-enrichment payload." I verified the current `ScrapedXPost` and the Python harvester: old posts simply won't have the four new keys, so `??` defaulting is correct. The NIT: the design says `scrapeXPosts()` "already passes `parsed.posts` through untouched," which is accurate, but it should also note that `searchXPosts` and the new `recentWithin` read path must both run posts through `normalizeScrapedPost` (B.4 mentions it for search; the saved-posts read is already `RawContent`, so clarify the normalizer runs at scrape time, not read time).

Fix: One sentence clarifying the normalizer runs once, at the `x-publisher` boundary (both `scrapeXPosts` and `searchXPosts`), before `postToRaw`.

### 12. NIT — `views`-based engagement "small bounded bump" is unspecified

Part C.4 step 2 says "Views used only when present (adds a small bounded bump)" but gives no number, and C.1's `x` config block has no `viewsBump` field. FR-C4 only requires views be used "when present"; leaving the magnitude undefined is a latent ambiguity ("handle appropriately"-class).

Fix: Add a config number (e.g. `viewsBonusMax`) or state explicitly that views only break ties within the engagement ratio and contribute 0 points by default.

### 13. NIT — `isOfficialAccount` threshold `officialMinCredibility` referenced but not added to config

Part B.6 `isOfficialAccount` uses `credibilityScore >= officialMinCredibility (config)`, but the C.1/B.1 config blocks never list `officialMinCredibility`. A2 asks the design to "define the concrete rule" — the rule is defined but its constant is missing from the config shape.

Fix: Add `officialMinCredibility` to `XDiscoveryConfig` (or the ranking `x` block, whichever owns `isOfficialAccount`) with a conservative default.

### 14. NIT — Few-shot `FewShotExample.score` type widening will break existing 6 examples at compile time unless all are updated in the same change

Part C.2/C.6 extend `LlmScoreSchema` with 8 new **required** fields and say `FewShotExample.score = Omit<LlmScore,"id">`. I verified `fewshot.ts`: all 6 existing examples supply only the old fields. Making the new fields required means all 6 existing objects stop compiling until updated. The design says they "get the new fields filled," which covers it, but it is worth flagging as a must-do-in-the-same-commit so `npm run typecheck` doesn't break mid-change.

Fix: Explicitly list that all 6 existing few-shot objects must be updated in the same edit as the schema change (or make the new fields `.default(...)` in the Zod schema and optional in the TS type to decouple).

---

## Verified Assumptions (checked against source, design is correct)

- **`createLibSqlRepository<T>` generic repo exists** (`src/mastra/repositories/store.ts`) and is used widely — the design's "wrap each store in a gateway backed by `createLibSqlRepository`" is sound.
- **`RankStorageGateway` + `createStubGateway` pattern exists** (`src/mastra/lib/ranking/storage.ts`) with exactly the interface/libSQL-impl/in-memory-stub shape the design proposes to mirror. Accurate.
- **`canonicalKey` is content-hash based and reproducible across runs** (`ledger-key.ts`) — true for dedupe/budget/ledger stability (NFR-8). (Its cross-source unification claim is the HIGH-1 problem, but the stability-for-dedupe claim is correct.)
- **`signalOnly: true` is set on every X item** (`collect-x-posts.ts`) — confirms the design's premise that X posts are signal-only.
- **`hardFilter` is pure, `now`-injectable, keyed drop reasons** (`hardFilter.ts`) — the C.3 "branch on `item.isX`, add drop reasons, keep RSS path" plan fits cleanly; `too_old`/`summary_too_short`/`blocklist` behave as described.
- **`computeRankedStory` is pure with a `ScoreContext`** (`score.ts`), `recencyScore` is a standalone exported function — so the design's "keep `recencyScore` exported so its unit test stays green while weight→0" is viable.
- **`maxAgeHours` default is 6 via `envNum("RANK_MAX_AGE_HOURS", 6)`** and weights currently sum to 10.0 (`ranking.config.ts`) — confirms the 6→24 change and the weight-redistribution starting point.
- **`RawContent.metadata` is `z.record(z.string(), z.unknown())`** (`rawContent.ts`) — so threading `outboundUrls`/`quoted`/`threadTexts`/`engagementRaw` through `metadata` is schema-valid and additive, as A.3 claims.
- **`RasPayloadSchema` fields are additive-friendly** (`handoff.ts`) and `buildRasPayload` is a pure builder (`payload.ts`) taking `item`/`factPack`/`image` — the D.1/D.2 extensions (all optional/defaulted) will keep existing RSS payloads valid.
- **`runAutoNewsRadar.ts` cron pattern** (daemon + `--once`, in-process `running` guard, loads env, not registered as a Mastra object) matches B.8's description; the new `runXDiscovery.ts` can mirror it.
- **`agents` registration in `index.ts`** includes `rankScoringAgent`; adding `xQueryAgent` there is consistent with AGENTS.md rule 1.
- **`scrape.py` harvest resilience pattern** (optional chaining, empty defaults, `try/except (CDPError, OSError, asyncio.TimeoutError)` per scroll, dedupe by status URL) exists as A.1 describes, and the `open_page` comment about navigation dropping the websocket is real — so the "DOM-only resolution, no in-browser redirect following" decision is well-justified.
- **`_wait_login`, `settle_page`, `ensure_chrome`, `HARVEST_JS` all live in/around `scrape.py`/`browser.py`** as the design assumes for adding `search`/`detect_block` in-place.
- **`maxScrolls` parameter exists** on `scrapeXPosts`/`scrape_user` (A9) — the ≤2-scroll ceiling maps onto it.

## Unverified / Wrong Assumptions

- **WRONG — A1 merge conflict.** No conflict markers exist in `autoNewsToRas.ts`; the file is clean and compiles. See HIGH-2. The design partially caught this but still carries the conflict framing and the derived `signalOnly→limited` change.
- **WRONG — cross-source cluster unification via `canonicalKey` (FR-C5 / C.4 / A5 / NFR-8 as applied to corroboration).** `canonicalKey` is per-URL+own-text; it does not and cannot make an X post and an RSS article share a `clusterId`. See HIGH-1.
- **WRONG — B.8 "UA/viewport already constant in `browser.py`."** The `UA` constant is only used by `plain()`/`og_image()` HTTP calls; the CDP page session applies no UA or viewport override. See MEDIUM-4.
- **PARTIALLY WRONG / UNDERSPECIFIED — A4 account medians flow.** `discovered_accounts.median_likes` is defined, but the design never specifies the code path that stamps `accountMedianLikes` onto rank items before scoring (the gateway isn't reachable from `rawToRankItem`'s layer). See HIGH-3.
- **UNVERIFIED — `detect_block` selectors (arkose/captcha testids, "unusual activity" text, 429 text).** These DOM/text probes are plausible but could not be verified against live X markup (no network, no live browser). The design correctly flags `scrape.py` DOM extraction as not unit-testable; the specific block selectors remain an at-runtime risk, acceptable given the fail-soft contract.
- **UNVERIFIED — A10 day-boundary tz.** The design picks `Asia/Kolkata`; there is no existing tz handling in the repo to verify against (no conflict, just a new choice). Acceptable as a stated decision.
- **UNVERIFIED — existing X tests.** The design references mirroring test patterns but I did not find current X-specific tests in the `package.json` `test` list (the list is RSS/RAS/ingestion/image focused). The B.9 signature change (MEDIUM-5) therefore likely has no existing test to break, but the design should confirm no current demo (`autoNewsDryRun.ts`) injects the old `collectXPosts({ scrape, checkSession })` shape.
