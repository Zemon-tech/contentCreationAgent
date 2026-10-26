# FEAT-005 — Final Report: Tests, Offline Dry-Run & Verification (Part E)

This is the last feature of `task-x-discovery-ranking`. FEAT-001..FEAT-004 landed
the code (scraper enrichment, discovery subsystem, quality-first ranking, RAS
payload extensions). FEAT-005 adds the test coverage, the offline dry-run paths,
runs the full verification sequence, and confirms the hard constraints.

## What was delivered

### 8 new test files (all `node:test` + `node:assert/strict`, NO network)
Registered in `package.json`'s explicit `test` list:

1. `tests/ranking/recencyQuality.test.ts` — the parameterized recency-vs-quality
   matrix over ages `[1,6,12,18,23]h` x varied quality, using `computeRankedStory`
   + `hardFilter` with an injected `now`, no LLM. Proves: (a) a quality gap bigger
   than the recency bound always wins on `finalScore` regardless of age (checked
   across every age pair), (b) equal quality -> the fresher item wins via a higher
   `recencyMultiplier`, (c) a 25h item is dropped by `hardFilter` (`too_old`).
2. `tests/x/xHardFilter.test.ts` — X items with outbound/long text + engagement
   survive; replies and reposts always drop; a bare sub-`minTextLength` no-source
   one-liner drops (`X_NO_SOURCE_SHORT`); below-floor engagement drops
   (`X_BELOW_ENGAGEMENT_FLOOR`); and an identically-short RSS item is still dropped
   by the RSS `SUMMARY_TOO_SHORT` rule (branch proof).
3. `tests/x/linkExpand.test.ts` — pure `resolveOutboundUrls` with an injected
   `t.co -> destination` expander map (no network); x.com/twitter.com dropped;
   `normalizeScrapedPost` defaults; plus a TS mirror of `attach_thread_texts`
   ordering (consecutive same-author runs cap at 5 on the FIRST post; other-author
   runs and singletons yield `[]`; a repost breaks the run).
4. `tests/x/failSoft.test.ts` — `runDiscovery` aborts on each block variant
   (`login_wall` / `captcha` / `unusual_activity` / `http_429`) and on empty-twice,
   sets the escalating cooldown, and never throws; a throwing `recentWithin` makes
   `collectXPosts` return `{ items: [], perAccount: [] }`; the RSS ranker still
   ranks when X contributes nothing; and a source-level assertion that no scraper
   symbol remains in `collect-x-posts.ts`'s import graph.
5. `tests/x/budgetCooldown.test.ts` — exhausted daily search budget skips + logs;
   the same query within `queryCooldownHours` is skipped; a day-boundary key change
   resets counters; the ladder 12 -> 24 -> 48 advances on repeats and caps.
6. `tests/x/learning.test.ts` — `median`, `credibilityOf` (spam penalty),
   `statusFor` thresholds, `isOfficialAccount` gate + pinned override; and
   `upsertFromScrape` creating rows only from samples and promoting after enough
   credible sightings.
7. `tests/x/corroboration.test.ts` — `urlKey` / `groupTextKey` /
   `matchOutboundToRss` / `corroborationGroupKey` / `buildCorroborationContext`;
   RSS-match share, multi-account (>=2 promoted) share, a MIXED-CASE host assertion
   (`https://TechCrunch.com` vs `https://techcrunch.com` corroborate via `urlKey`),
   and the dropped clusterId-equality path (different clusterIds still corroborate
   via URL). Only promoted accounts count.
8. `tests/ras/payloadX.test.ts` — an X-only story sets `attributionLine`
   `per @handle on X`, a non-empty `facts[]` with `sourceType 'x'` (and `'primary'`
   when verified + outbound), and carries `verified`/`claimRisk`; an RSS story
   leaves the X fields empty/default and still validates; and `factPackLimited` is
   NOT forced true by `signalOnly`.

### Offline demo + mock-X path
- `src/mastra/demo/xDiscoveryDryRun.ts` (`npm run x:discover:demo`) — runs
  `runDiscovery` over 3 topics with injected heuristic `generateQueries`, a mock
  `search` returning synthetic enriched posts (including `text_truncated` ones) and
  a separate simulated-block pass, and in-memory stub gateways (zero network). It
  prints queries generated, posts scraped, accounts discovered (with status), the
  simulated block, then ranks the saved posts with an offline heuristic and prints
  the top-5 with the full breakdown (`qualityScore`, `engagementComponent`,
  `engagementRatio`, `corroborationComponent`, `recencyMultiplier`, `penalties`)
  plus truncated/blocked items.
- `src/mastra/demo/autoNewsDryRun.ts` — extended with a `--mock-x` flag
  (`npm run auto:dry:mockx`) that seeds a stub `SavedXPostsGateway` with synthetic
  X posts and threads it through a new optional `savedPosts` input on
  `collectRankSelect` -> `collectXPosts`. The X signal stays governed by the SINGLE
  switch `X_DISCOVERY_ENABLED`; with it `false` the run is feed-only. The heuristic
  Stage-B stub now emits the 8 new `LlmScore` fields so items validate under the
  updated schema.

### package.json
- Added all 8 new test files to the `test` script's explicit `tsx --test` list.
- Repointed `x:discover:demo` to the new `xDiscoveryDryRun.ts` demo (the one that
  prints the ranked top-5 breakdown required by FEAT-005). The previous cron-based
  offline smoke run is preserved as `x:discover:demo:cron`.
- Added `auto:dry:mockx` for the mock-X path.

## MOCKED vs REAL

MOCKED (injected / stubbed in the tests and demos; nothing hits the network):
- The LLM query generation (`xQueryAgent`) — demos/tests inject fixed query
  strings or force the deterministic fallback template.
- The LLM ranking judgements — a pure keyword heuristic `RankGenerate` stand-in.
- The Python scraper + search subprocess — injected `search` / `scrapeProfile`
  functions returning synthetic, clearly-fictional posts.
- All four gateways (`discovered_accounts`, `x_scrape_health`, `x_daily_budget`,
  `saved_x_posts`) — the in-memory stub factories.

REAL (exercised exactly as in production):
- Scoring, hard-filter, learning, and corroboration math (`score.ts`,
  `hardFilter.ts`, `learning.ts`, `rankStories.ts` corroboration helpers).
- All Zod schemas (`ranking.ts`, `handoff.ts`, `rawContent.ts`, `factpack.ts`).
- The payload builder (`buildRasPayload`) and fact-pack wiring.
- `runDiscovery`'s orchestration, budget/cooldown/ladder logic, and fail-soft
  behaviour; `collectXPosts`'s feed-only read; the cron wiring (unchanged).

## Assumptions & resolutions
- `collectRankSelect` had no way to inject saved X posts for an offline mock-X
  run. Resolution: added an OPTIONAL `savedPosts` input, threaded only into the
  existing `collectXPosts` call. The live workflow omits it (reads the real libSQL
  store); behaviour is unchanged and still gated by `X_DISCOVERY_ENABLED`. This is
  additive and within FEAT-005's stated "accept an injected savedPosts stub" scope.
- `x:discover:demo` previously ran the cron's `--demo --once` smoke path. FEAT-005
  explicitly owns `xDiscoveryDryRun.ts (x:discover:demo)` and its verification
  requires the ranked top-5 breakdown, so the script now points at the new demo;
  the cron smoke run is kept as `x:discover:demo:cron` so nothing is lost.
- The demo's discovered accounts show `status=candidate` / `promoted: 0`: a single
  scrape pass gives `timesSeen=1`, below `promoteMinTimesSeen=3`. This is correct
  conservative behaviour, not a defect.
- Synthetic few-shot / demo content uses clearly fictional names ("Nimbus
  Robotics", `@nimbus_labs`, `@orbit_founder`) with no real facts, per the user's
  instruction that synthetic examples are tagged/fictional.

## Verification results (PowerShell, `;` separator)
- `npm run test` -> **141/141 pass** (88 pre-existing suites + the 8 new FEAT-005
  files, each fully offline).
- `$env:X_DISCOVERY_ENABLED="false"; npm run auto:dry` -> feed-only run, 0 X items,
  ends at `status: dry_run` (nothing published).
- `npm run auto:dry:mockx` (mock-X path, `X_DISCOVERY_ENABLED=true`) -> "Mock-X
  path: 2 X item(s) merged into the ranking", X items ranked alongside RSS, ends at
  `status: dry_run`.
- `npm run x:discover:demo` -> prints queries generated, posts scraped (18),
  accounts discovered (+status), a simulated `login_wall` block (cooldown set),
  top-5 ranked with the full breakdown, and the truncated/blocked items — all
  offline.
- `npm run typecheck` -> FEAT-005's code is clean. The only `tsc` errors are in
  `src/mastra/templates/RasStoryTemplate-2.tsx`, an UNTRACKED, unreferenced
  work-in-progress scratch file the user is actively editing (open in the editor;
  missing `@imgly/background-removal-node` and `./ras-poster-story.js`). It is not
  imported anywhere in the project and is unrelated to this feature. No FEAT-005
  file produces a type error. This pre-existing-but-untracked failure is left
  untouched (it is the user's WIP, not FEAT-005 scope).

## Hard constraints — CONFIRMED
- **Posts nothing.** Every test and demo is offline; `auto:dry` and the mock-X path
  end at `status: dry_run`; nothing calls render/publish.
- **`INSTAGRAM_DRY_RUN` and `REQUIRE_APPROVAL` default true** — unchanged; the dry
  runs set `dryRun: true`/`approved: false` and never publish.
- **No git commit/push/config changes performed by the verification** — the only
  commit is this feature's single local commit on the current branch; no push, no
  config change.
- **The RSS pipeline keeps working if X is unavailable** — proven by the feed-only
  `auto:dry`, the fail-soft tests, and the "RSS ranker still ranks when X
  contributes nothing" test.
- **No captcha/login-wall bypass** — the demo and tests treat every block as an
  immediate abort + cooldown; nothing attempts to solve or retry a block.

## Cleanup
No temporary files were created during verification; nothing to remove.
