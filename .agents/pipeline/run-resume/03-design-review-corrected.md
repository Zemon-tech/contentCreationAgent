# Design Review — `02-design-corrected.md` (X Discovery / Scraper Enrichment / Quality-First Ranking / Payload Extensions)

Reviewed fresh against the requirements, the prior design, the prior `design-review.json` (3 HIGH + MED/NIT), and the actual source tree. The job: confirm every prior decision resolves to ONE concrete, implementable data path with exact file/function names, and that no NEW ambiguity or unverified assumption was introduced.

Scope checked with special attention to the seven focus areas in the step prompt:
(1) corroboration redefinition over colliding signals; (2) engagement+corroboration folded into the 10-weight budget with worked maxima; (3) pre-scoring `CorroborationContext` + median stamping at save time; (4) ordered `posts[]` + `dom_index` thread post-pass; (5) single feed-only switch + `CollectXResult` shape + migration; (6) `recentWithin` vs `too_old` single 24h source; (7) fail-soft everywhere X touches the main pipeline.

---

## Verified Assumptions

These design claims were checked against the actual source and are TRUE:

1. **`canonicalKey` is per-item and never collides across X/RSS** — `src/mastra/lib/safety/ledger-key.ts`: `canonicalKey(url,title,summary) = normalizeUrl(url) + "::" + contentHash(title,summary).slice(0,16)`. The prior corroboration-by-cluster branch was indeed infeasible. The correction's decision to drop it is correct. ✓
2. **`ScoreContext` currently carries only `config/now/recentRegions`** — `src/mastra/lib/ranking/score.ts`. `computeRankedStory` is called per-item from `rankStories` with exactly `{ config, now, recentRegions }`. The design's new pre-scoring `CorroborationContext` injected into `ScoreContext` is a genuine, well-placed addition. ✓
3. **`rankStories` maps per item then sorts by `finalScore`** — `src/mastra/lib/ranking/rankStories.ts`, the `.map((item) => computeRankedStory(...))` line. The new pre-scoring stage slots in between Stage B and this map exactly as described. ✓
4. **Weights sum to 10 and the config header asserts `Σ wᵢ·componentᵢ ∈ [0,100]`** — `src/mastra/config/ranking.config.ts`. Current weights: significance 2.5, topicFit 2.0, audienceInterest 2.0, visualPotential 1.0, recency 1.0, coverage 0.75, sourceCredibility 0.75 = 10.0. The folded-budget redistribution preserves the invariant. ✓
5. **`autoNewsToRas.ts` has NO merge conflict and `limited` excludes `signalOnly`** — `limited = !!(args.raw?.paywalled || args.raw?.factPackLimited || args.raw?.viaFallback)`. Finding #2 premise confirmed; the correction's removal of the `|| raw.signalOnly` change is right. ✓
6. **`collectRankSelect` calls `collectXPosts({ log })` and reads `xResult.sessionNotReady` + `perAccount`** in the `x.collected` log — `autoNewsToRas.ts`. The migration (drop the `sessionNotReady` log field, keep the try/catch) matches the single live call site. ✓
7. **`collect-x-posts.ts` current shape** — signature takes `{ config, scrape, checkSession, log }`, returns `{ items, perAccount, sessionNotReady? }`, `postToRaw` is private, items are `signalOnly: true`, dedup id = `hashString(post.url)`. All B.9/A.4 migration claims are accurate. ✓
8. **`select.ts` `selectTop`** sorts by `finalScore`, enforces `topN`/`minScore`/one-per-cluster, no views tiebreak and no `blockedUnlessOverride` today. C.5's additions are genuinely new and compatible. ✓
9. **`normalizeUrl` exists in `src/mastra/lib/normalize.ts`**, strips tracking params (incl. `utm_*`), drops hash, strips AMP, trims trailing slash. The corroboration matcher correctly reuses it so both sides normalize identically. ✓ (See NIT finding re: host-casing below.)
10. **`fewshot.ts` has exactly 6 examples** using only the old fields (`topic`, `topicFit`, `significance`, `audienceInterest`, `visualPotential`, `isOpinionOrRumor`, `isClickbait`, `isDuplicateAngle`, `reason`). Finding #14 premise and the "update all 6 in the same edit" plan are correct. ✓
11. **`scrape.py HARVEST_JS` harvests into a URL-keyed dict and `scrape_user` accumulates with `collected.setdefault(url, r)` across scroll passes, losing DOM order** — finding #6 premise confirmed. The current `cmd` positional is `choices=["user"]` and `--handle` is `required=True` — finding #10 premise confirmed. ✓
12. **`settle_page`, `_wait_login`, the scroll+harvest loop exist** in `scrape.py` and are reusable by the `search` subcommand as the design describes. ✓

## Unverified / Wrong Assumptions

No assumption in the corrected design was found to be FALSE on re-verification. The prior review's wrong assumption (A1 merge conflict) has been explicitly dropped and the real file state restated correctly (verified). One assumption is stated but **cannot be fully verified from the design text alone** and is carried as a finding:

- **A5-adjacent (thread ordering across scroll passes):** the design asserts `dom_index` gives deterministic order for `attach_thread_texts`, but `dom_index` is defined as "0-based position in DOM order *within that harvest pass*" while `scrape_user` accumulates posts across multiple scroll passes. Whether a single stable global order exists is not specified. See HIGH finding #1.

---

## Findings

### 1. HIGH — `dom_index` is per-harvest-pass but threads are assembled over cross-pass accumulation; ordering is undefined
**Location:** Part A.1 (`HARVEST_JS` additions, ordered `posts[]`, `attach_thread_texts`), verified against `scrape.py` `scrape_user` (`collected: dict[str,dict]`, `collected.setdefault(url, r)` across up to `max_scrolls` iterations).

**Problem:** The design defines `dom_index` as "0-based position in DOM order **within that harvest pass**." But X virtualizes the timeline: each scroll pass re-runs `HARVEST_JS` over the *currently mounted* articles, and `scrape_user` accumulates across passes. A post first seen in pass 2 and a different post first seen in pass 5 can carry the same `dom_index`, and `dom_index` does not reflect global timeline order across passes. `attach_thread_texts` does `sorted(posts, key=lambda p: p["dom_index"])` over the **accumulated** list, so the sort key is not unique or globally monotonic. Consecutive-same-author detection will be computed over a mis-ordered list and can both miss real threads and fabricate false runs. This is the exact failure mode finding #6 was meant to fix, re-introduced one layer up.

**Fix (pick one, concrete):**
- (a) Assign `dom_index` **once at first-sighting across the whole scrape**: in `scrape_user`, maintain a monotonic counter and stamp `r["dom_index"] = next_index` only when a URL is first inserted into `collected` (i.e. inside the `collected.setdefault` branch when the key is new), NOT inside `HARVEST_JS`. Then `attach_thread_texts` sorts on that global first-sighting order, which is monotonic and unique. Document that threads are detected over first-sighting order (top-of-timeline first), and remove the per-pass `dom_index` from `HARVEST_JS`.
- (b) If per-pass `dom_index` must stay, state explicitly that `attach_thread_texts` runs **per harvest pass on that pass's rows only** (before dedup/accumulation), attaches `thread_texts` there, and the accumulation step preserves the first-seen `thread_texts`. Specify that cross-pass threads are intentionally not detected.

### 2. MEDIUM — `isOfficialAccount`/`accountLike` in `score.ts` needs `credibilityScore` and `pinnedHandles`, but only `accountStatus`/`accountMedianLikes` are stamped onto rank items
**Location:** Part C.4 step 5 (`verified`), Part B.6 (`isOfficialAccount(account, config)` = `status === "promoted" && credibilityScore >= officialMinCredibility` OR handle in `pinnedHandles`), Part C.2 (`RankInputItem` X fields: `accountStatus?`, `accountMedianLikes?`, `accountMedianReposts?` — NO `credibilityScore`, NO handle-in-pinned signal).

**Problem:** `isOfficialAccount` is defined over a full `DiscoveredAccount` (needs `credibilityScore` and a `pinnedHandles` lookup). But the scoring layer deliberately has no gateway access, and C.2 only stamps `accountStatus` and the two medians onto `RankInputItem` — not `credibilityScore`, and not a resolved "is this handle pinned" boolean. C.4 step 5 then calls `isOfficialAccount(accountLike)` where `accountLike` is "derived from `item.accountStatus`/`item.accountMedianLikes`," which cannot satisfy the `credibilityScore >= officialMinCredibility` branch nor the `pinnedHandles` branch. The `verified` computation (and thus FR-C8's high-risk selection gate) is therefore underspecified against its own helper.

**Fix:** Stamp the already-computed verification signal at save time rather than recomputing it in scoring. In `runDiscovery` step 7, add to `postToRaw` opts (and to `RankInputItem` / metadata): `accountCredibilityScore: number` and `isOfficialAccount: boolean` (computed once by `runDiscovery` via `learning.isOfficialAccount(acct, config)`, which already has `credibilityScore` and `pinnedHandles`). Then C.4 step 5 reads `item.isOfficialAccount` directly. State the field names in C.2 and the stamp in B.7 step 7.

### 3. MEDIUM — Multi-account corroboration requires cross-account visibility, but saved X items are read and scored without regrouping; the group key over `kept` can't see accounts not in this run
**Location:** Part C.4 (`credibleAccountsByGroup` built from the `kept` list in `rankStories`), Part B.7 (discovery saves per-post `RawContent`), Part B.9 (`collectXPosts` reads `recentWithin`).

**Problem:** The multi-account signal ("≥2 distinct promoted accounts share a group key") is computed over the `kept` list inside a single `rankStories` run. That list is whatever `collectXPosts` returned for *this* main-workflow run (saved posts within `maxAgeHours`). That is internally consistent IF the group key is derived per item from fields present on every saved item. But C.4 derives the multi-account group key from "any normalized outbound-URL host they share, else near-duplicate-text key (first 12 tokens)" and counts distinct `authorHandle` with `accountStatus === "promoted"`. Two requirements are not pinned down: (a) `accountStatus` must be stamped on EVERY saved X item (C.2 lists it as optional `accountStatus?`); an item whose status is absent silently fails the "credible" test and under-counts. (b) The near-duplicate-text key "first 12 tokens after lowercasing/stripping" is an ambiguous tokenizer (split on whitespace? drop punctuation? Unicode?), so two implementers could bucket differently.

**Fix:** (a) In B.7 step 7, make `accountStatus` a **required** stamped field for every saved X item (default `"candidate"` when unknown) so the credible-count is deterministic; update C.2 to show it non-optional for X items. (b) Specify the text-key function exactly, e.g. `groupTextKey(text) = text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu,"").split(/\s+/).filter(Boolean).slice(0,12).join(" ")`, and name it as a shared pure function used by BOTH the context builder and the per-item key derivation so they cannot diverge.

### 4. MEDIUM — `rssUrlSet` membership uses raw `normalizeUrl` output (host not lowercased), but the host-match path lowercases; direct `.has()` match can silently miss
**Location:** Part C.4 (`rssUrlSet = new Set(kept.filter(i=>!i.isX).map(i => normalizeUrl(i.url)))`; `matchOutboundToRss` = `rssUrlSet.has(normalizeUrl(u))` OR host comparison with `hostOf` lowercasing + `www.` strip), verified against `normalizeUrl` in `src/mastra/lib/normalize.ts`.

**Problem:** `normalizeUrl` strips tracking/hash/AMP/trailing-slash but does **NOT** lowercase the hostname (it returns `u.toString()` with the host casing as given). So `rssUrlSet` can contain `https://TechCrunch.com/x` while an X outbound normalizes to `https://techcrunch.com/x`; the exact `.has()` branch misses. The host-comparison fallback does lowercase, so it would still match on host — but then the "full normalized URL match" branch is dead for any mixed-case host, and worse, two URLs that differ only by path case won't match at all. This is a latent correctness gap in the primary corroboration signal (RSS-URL match, weight 0.6 of the component).

**Fix:** Define one canonical key for both sides, e.g. `urlKey(u) = normalizeUrl(u)` with host lowercased: build `rssUrlSet` from `urlKey(i.url)` and test `rssUrlSet.has(urlKey(u))`. Either add host-lowercasing to a small wrapper used on both sides, or state that the direct-match branch is redundant and matching is **host-only** via `hostOf`. Pick one and make the test in `corroboration.test.ts` assert the mixed-case case.

### 5. MEDIUM — "perfect item > 90" test change is a requirement-touching assertion rewrite that isn't justified by FR; confirm the fixture change is acceptable
**Location:** Part C.1 ("'perfect item > 90' test stays valid" → change fixture to a cross-corroborated maxed item and assert `>= 90`).

**Problem:** Under the folded budget, a maxed RSS item tops at 85 (engagement component 0), or up to 90 only if cross-corroborated. The design keeps the existing `score.test.ts` assertion green by **rewriting the fixture** into a cross-corroborated item and **relaxing `>90` to `>=90`**. That is a reasonable consequence of FR-C2 (recency as tiebreaker, not a weighted term), but it quietly changes what "a perfect item" means: a maxed RSS item that is NOT cross-corroborated now caps at 85 and can never clear a `>90`/`>=90` bar — i.e. a genuinely excellent single-source RSS story is structurally capped below 90. The requirements don't ask for RSS stories to be penalized for lacking X corroboration. This is a scope/behavior question the design resolves unilaterally.

**Fix:** State explicitly that a maxed single-source RSS item caps at 85 by design and confirm that is acceptable (it changes `minScore`-relative behavior: `minScore` default is 55, so 85 still passes comfortably — note this so it's clearly non-blocking for selection). If an uncorroborated maxed RSS item should still be able to reach the top band, give `coverage` or `sourceCredibility` enough weight to reach ~90 without X, or document the cap as intended. Update the test comment to say why `>=90` requires corroboration.

### 6. NIT — `postToRaw` export + new opts param changes the private function's call sites; spell out the back-compat default call
**Location:** Part A.4 (`postToRaw(handle, post, opts?)` exported; opts carries `accountMedianLikes/Reposts`), verified against current private `postToRaw(handle, post)` in `collect-x-posts.ts`.

**Problem:** The design says the live/legacy mapping path defaults medians to 0, but `collectXPosts` is being rewritten to NOT call `postToRaw` at all (it reads already-mapped `RawContent`). So the only live caller becomes `runDiscovery`. The design should confirm no other caller of the old private `postToRaw` exists (it was private, so none outside the module) and that the signature change is safe.

**Fix:** One sentence in A.4: "`postToRaw` had no callers outside `collect-x-posts.ts` (it was module-private); after export, its only caller is `runDiscovery`, so the added `opts?` third parameter is backward-compatible." (Verified: no external callers.)

### 7. NIT — `viewsBonusMax` tie-break lives in `select.ts` but needs `views` on the `RankedStory`; confirm the field path
**Location:** Part C.1 (views default 0 points, tiebreak in `select.ts`), C.5 (ties within epsilon break on views).

**Problem:** `selectTop` only sees `RankedStory`. To break ties on views it needs `views` reachable from the ranked story (currently only `engagementRaw` on the input item, threaded via `RankInputItem`). The design doesn't name where `select.ts` reads the view count.

**Fix:** State the path, e.g. `select.ts` reads `r.item.engagementRaw?.views ?? 0` for the epsilon tiebreak; RSS items (no `engagementRaw`) sort as 0 views, which is a stable no-op.

### 8. NIT — `facts[]` "concrete claim sentences" extraction for X is unspecified
**Location:** Part D.2 (X `facts[]` built from "the derived headline and any concrete claim sentences" + outbound URLs).

**Problem:** "Concrete claim sentences" has multiple valid interpretations (sentence split heuristic? all sentences? first N?). FR-D2 only requires a non-empty authoritative claim set for X, which the derived headline + outbound URLs already satisfy.

**Fix:** Pin it: `facts[]` for an X item = `[{ claim: derivedHeadline, sourceUrl: <post url or first outbound>, sourceType }]` plus one entry per resolved outbound URL (`sourceType: "primary"` if primary, else `"x"`). Drop the vague "claim sentences" clause unless a concrete splitter is specified.

---

## Verdict

Count of blocking findings: **1 HIGH + 4 MEDIUM = 5 blocking**. Per the mechanical rule (any HIGH or MEDIUM ⇒ CHANGES_REQUESTED), the verdict is **CHANGES_REQUESTED**.

The corrected design resolves all 14 prior findings correctly and introduces no false assumptions — the core architecture (separate discovery cron, median-stamping at save time, pre-scoring `CorroborationContext`, folded 10-weight budget, single `X_DISCOVERY_ENABLED` switch, `too_old` as the single 24h source, fail-soft at every X touchpoint) is sound and verified against source. The remaining findings are second-order gaps the correction opened while fixing the firsts: a re-introduced ordering hazard in the thread post-pass (#1), the `verified`/official-account data path not fully stamped (#2), two under-specified pure functions in corroboration (#3, #4), and a quietly requirement-touching test/behavior change (#5). All are concretely fixable without architectural change.
