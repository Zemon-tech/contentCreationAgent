# aggregrator

Welcome to your new [Mastra](https://mastra.ai) project! We're excited to see what you build.

This starter provides you with a general-purpose Mastra agent that can research current information, manage multi-step tasks, work with local files, run approved shell commands, and create recurring schedules.

## Features

- A project-level `workspace/` for files and command execution
- Approval gates for file changes, deletions, and shell commands
- Conversation memory, generated thread titles, and task tracking
- Built-in web search and direct web page fetching
- Recurring schedules that persist across restarts
- Local libSQL storage and DuckDB observability, with optional Turso storage
- A bundled Mastra skill that helps coding agents use current Mastra APIs

## Get started

Set your `OPENAI_API_KEY` in `.env` or in your environment, then run:

```shell
npm run dev
```

Open [http://localhost:4111](http://localhost:4111) in your browser to access [Mastra Studio](https://mastra.ai/docs/studio/overview).

Select **Agent** in Mastra Studio and try one of these prompts:

- `Get the weather forecast for Austin this weekend.`
- `Create a landing page for a Japanese sakura festival.`
- `Check the SPCX stock price now, then check it every minute.`

The agent asks for approval before it changes files or runs commands. When it creates a schedule, it returns an ID that you can use to pause the schedule.

## Workspace safety

The local filesystem tools stay inside the project-level `workspace/` directory. Shell commands start in that directory, but `LocalSandbox` does not provide operating-system isolation by default. Review command approvals carefully, and do not expose this template through an unauthenticated public server.

## Storage

The default `file:./mastra.db` database stores agent memory, tasks, and schedules locally. To use Turso, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`.

Recurring schedules continue to use model tokens until you pause them. Ask the agent to pause a schedule with the ID returned by `start_schedule`.

## Making it yours

- Edit `src/mastra/agents/aggregatorAgent.ts` to change the model, instructions, memory, or intelligence rules.
- Edit `src/mastra/tools/` to customize scheduling.
- Edit `src/mastra/index.ts` to change storage and observability.
- Add files or reusable skills under `workspace/` for the agent to use.

## News sources & feed health

The RAS news pipeline polls **RSS/Atom feeds first** (proper per-article items),
not homepage scrapes. The curated, region-tagged feed set lives in
[`src/mastra/config/newsFeeds.ts`](src/mastra/config/newsFeeds.ts); it is merged
into the registry in [`config/sources.ts`](src/mastra/config/sources.ts), which
also force-disables the old homepage entries these feeds replace
(`SUPERSEDED_SOURCE_IDS`).

Each source carries: `region` (`US | IN | GLOBAL`), `topics` (category hints),
`authorityScore` (credibility, 0–100), and optional `paywalled` / `signalOnly`.
The ranker reads these.

- **`paywalled: true`** (e.g. WSJ): ingest feed **title + summary only** — never
  fetch or reproduce article body text.
- **`signalOnly: true`** (Hacker News, Reddit, Product Hunt): may inform ranking
  (coverage/velocity) but is **never cited as a story's primary source**.
- **Inshorts** is intentionally kept `active: false` (no official feed/API; not scraped).

### Verify feeds are alive

```bash
npm run feeds:verify
```

Fetches every active RSS feed and prints a table: HTTP status, parsed?, item
count, newest-item age, and a LIVE / STALE / DEAD verdict. Run it after adding or
editing a source.

### Add or edit a source

Add a `feed(id, name, url, region, topics, authority, opts)` line to the right
array in `newsFeeds.ts` (`opts` takes `tier`, `role`, `paywalled`, `signalOnly`,
`active`, `note`), then run `npm run feeds:verify`. If a feed is dead or blocked,
set `active: false` with a `note` and rely on the Google News fallback rather than
spoofing a browser User-Agent.

### Ingestion hygiene

Feed fetching ([`lib/ingest-feeds.ts`](src/mastra/lib/ingest-feeds.ts)) is
health-aware and polite — all knobs live in
[`config/ingestion.config.ts`](src/mastra/config/ingestion.config.ts) (`FEED_*` /
`GOOGLE_NEWS_*` / `INGEST_*` env overrides):

- **Conditional GET** (ETag / If-Modified-Since); a `304` is a success, not a failure.
- **Per-domain rate limiting** (default 2s min interval) + an honest User-Agent.
- **robots.txt respected** — fail-**open** for feeds when robots is unreachable/5xx,
  fail-**closed** for the article scraper (a 404 means allowed). Note: some hosts
  (`reddit.com`, `news.google.com`) return `Disallow: /` for generic bots, so with
  robots respected those feeds/queries are blocked by design.
- **Feed health** ([`repositories/feedHealth.ts`](src/mastra/repositories/feedHealth.ts)):
  tracks consecutive failures, last success/item dates; auto-disables after
  `FEED_AUTO_DISABLE_AFTER` (5) failures, re-probes after `FEED_REPROBE_HOURS` (24),
  and re-enables on a successful probe. Manually-disabled sources are never
  auto-enabled. A **stale** feed (newest item older than `FEED_STALE_DAYS`) is a
  warning, not a failure. One bad feed never fails the run.
- **Paywall guard** ([`lib/article-body.ts`](src/mastra/lib/article-body.ts)):
  `fetchArticleBody` is the ONLY path that fetches article bodies and it refuses
  for `paywalled:true` sources and known paywalled domains (WSJ etc.), including
  items that resolve there via the fallback. Paywalled items carry
  `factPackLimited:true`. No paywall bypass is attempted.
- **Image candidates**: extracted from feed data only (`media:content` /
  `media:thumbnail` / `enclosure`) and stored `cleared:false` — never downloaded,
  re-hosted, or rights-checked here (that's the later image-sourcing step).
- **Google News fallback** ([`lib/google-news-fallback.ts`](src/mastra/lib/google-news-fallback.ts)):
  auto-activates for dropped/auto-disabled sources (headline-level, capped, items
  marked `viaFallback:true`).

Dry-run the whole thing (nothing persisted, nothing published):

```bash
npm run ingest:dry
```

prints a run-summary block (fetched / failed / newly-disabled / re-enabled / stale /
fallback) and a per-source health table.

## News ranker (`rankStories`)

Stage 3 of the news pipeline. Takes N deduplicated, clustered items and returns a
ranked, explainable shortlist for the RAS Instagram page. **The LLM judges meaning;
plain code does every number that decides ranking** — the model never produces the
final score.

Four stages (`src/mastra/lib/ranking/`):

1. **Hard filters** (`hardFilter.ts`, no LLM) — drops items that are too old, already
   posted/rejected, blocklisted, too short, or from a disabled source. Each drop is
   logged with one reason, grouped per reason.
2. **LLM scoring** (`llmScore.ts`) — batched (default 10/call), low-temperature, cheap
   model. Returns only judgements: `topicFit`, `significance`, `audienceInterest`,
   `visualPotential`, and the flags `isOpinionOrRumor` / `isClickbait` /
   `isDuplicateAngle`, plus a one-line reason. Output is Zod-validated; on failure it
   retries once, then marks the item `unscored` (never crashes the run).
3. **Final score** (`score.ts`, no LLM) — a deterministic 0–100 score:
   `Σ wᵢ·componentᵢ + recency + coverage + sourceCredibility + regionBalance − penalties`.
4. **Selection** (`select.ts`) — the top `N` clearing `MIN_SCORE`, never two from the
   same cluster. An empty result is the valid outcome "no story worthy this run", not
   an error.

Every run persists a full, inspectable log (items in, drops per filter, scored/unscored,
top 10 with component breakdown, the selection, and a token/cost estimate) to the
`rank_runs` table.

### Speed

Stage B is the slow part (Sarvam spends ~2k hidden reasoning tokens per item). Two
levers, both in `.env`: `RANK_CONCURRENCY` (default 4 parallel calls; measured 16 items
168s -> 46s) and the **score cache** (`RANK_CACHE_*`): the 30-minute workflow re-uses a
recent judgement for any article it already scored, so a re-run only pays the model for
new articles (measured 8.7s warm). `rank:eval` never uses the cache, so calibration
always reflects the live model. Bump `RANK_CACHE_VERSION` after editing the prompt or
few-shots.

### Tuning the weights

Everything is in **`src/mastra/config/ranking.config.ts`** — do not edit the step code.
The LLM and code components are each 0–10 and the weights `w1..w7` **sum to 10**, so
`Σ wᵢ·componentᵢ` lands in 0–100; keep them summing to 10 when you re-balance.
`regionBalanceAdjustment` and `penalties` are applied afterwards in final-score points.
Also tunable: recency half-life, coverage cap, per-source credibility map, region-balance
boost/lookback, penalties, `MAX_AGE_HOURS`, `MIN_SCORE`, `TOP_N`, blocklist. Any of these
can be overridden at deploy time with the `RANK_*` env vars in `.env.example`.

Calibrate against labels instead of guessing:

```shell
npm run rank:seed:feeds   # append ~40 real headlines from the LIVE feeds to label (no API key)
npm run rank:seed         # alternative: ~30 headlines via Exa (needs EXA_API_KEY)
npm run rank:preview      # rank the fixtures now with a heuristic stand-in (no model) — wiring demo
npm run rank:eval         # score with the real model, report agreement + variance
```

Downstream, the selected story becomes a verified **fact pack**
([`lib/fact-pack.ts`](src/mastra/lib/fact-pack.ts)) — headline, 3–5 grounded facts,
figures, names, source URLs, and any cross-source conflicts — with `factPackLimited`
set for paywalled/thin material so nothing is invented.

`rank:eval` prints tier agreement with your `post | maybe | skip` labels, the biggest
disagreements (with the model's reason), whether the top pick matches a story you
labeled `post`, and score stability across runs (`--runs=N`). Adjust the weights, re-run.

### Adding / editing few-shot examples

Stage B's examples live in **`src/mastra/lib/ranking/fewshot.ts`** (4–6 spanning high /
medium / low / rumor / clickbait). Each is a `(title, summary)` plus the judgement the
model *should* return — edit these to steer scoring, then re-run `rank:eval` to check the
effect. The system prompt itself is in `prompt.ts` (kept short and rule-based).

### Tests

Stage A filters and Stage C math are pure and need no LLM:

```shell
npm test
```

### Wiring into a workflow

The step is `rankStoriesStep` (`src/mastra/workflows/steps/rankStories.ts`). Feed it
clustered stories via `storiesToRankInput()` (`lib/ranking/adapter.ts`); use `result.selected`
as the authoritative pick for the RAS path. Note: `region` resolution depends on the
`Source.region` tag added by the ingestion stage — until that lands, the adapter defaults
region to `GLOBAL` (no region-balance nudge), which is harmless.

## Auto news → RAS pipeline

`autoNewsToRasWorkflow` ([workflows/autoNewsToRasWorkflow.ts](src/mastra/workflows/autoNewsToRasWorkflow.ts))
chains: **ingest → rank (`rankStories`) → fact pack → image sourcing → approval
gate (suspend/resume) → RAS handoff → ledger record.** It is registered in
[index.ts](src/mastra/index.ts) and runnable from Studio or on a schedule.

**Nothing publishes** unless `INSTAGRAM_DRY_RUN=false` **and** approval is granted
(`REQUIRE_APPROVAL`, suspend/resume). Both default **true**.

- **Idempotency:** the posted-ledger ([postedLedger.ts](src/mastra/repositories/postedLedger.ts))
  is keyed on canonical URL + content hash, so a story is never posted twice;
  posted/pending block forever, rejected/failed block for a window.
- **Rate caps** ([posting.config.ts](src/mastra/config/posting.config.ts)): max
  posts/day, min gap, min score — the last gate before publish.
- **Images** download to `IMAGE_DIR` (local; not publicly served — RAS composites
  the file into its rendered PNG, and only that PNG is fetched by Instagram via
  `PUBLIC_BASE_URL` + `/ras-assets`). `rightsStatus` is always `unverified`.
- **Instagram needs JPEG, so the workflow publishes a JPEG copy.** Every post we render
  also gets a `01.jpg`, served by a separate route `/ras-publish/<slug>/01.jpg`
  ([routes/ras-publish.ts](src/mastra/routes/ras-publish.ts)); RAS's PNG route is untouched.
  **Never point a tunnel at the Mastra server (port 4111)** — it also serves agent and
  workflow endpoints. Run `npm run publish:serve` instead (a tiny read-only server on
  port 4112 that serves only those JPEGs, bound to localhost) and tunnel *that*:
  `cloudflared tunnel --url http://localhost:4112`, then set `PUBLIC_BASE_URL` to the
  printed `https://…` host.
- **Instagram login:** set `INSTAGRAM_GRAPH_HOST=https://graph.instagram.com` for tokens
  generated in the Meta dashboard (no Facebook Page needed). Leave it unset for
  Facebook-login tokens.

Dry-run the whole thing (nothing persisted or published) — shows top-5 ranked,
the chosen story, the image + why, and the exact RAS payload:

```bash
npm run auto:dry
```

Check Instagram creds (read-only, never posts):

```bash
npm run ig:check
```

Schedule it (every `AUTO_INTERVAL_MINUTES`, default 30) under PM2/systemd:

```bash
npm run auto:radar
```

`npm run auto:radar:once` runs a single cycle. In dry-run it only records what it
would do; with `REQUIRE_APPROVAL` a live run suspends for approval in Studio.
"Nothing worth posting this run" is a valid outcome, not an error.

## Learn more

To learn more about Mastra, visit our [documentation](https://mastra.ai/docs/). If you're new to AI agents, check out our [course](https://mastra.ai/learn) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join our [Discord](https://discord.gg/mastra-ai) community to get help and share your projects.

## Deploy to the Mastra platform

The [Mastra platform](https://projects.mastra.ai) provides two products for deploying and managing AI applications built with the Mastra framework. Learn more in the [Mastra platform documentation](https://mastra.ai/docs/mastra-platform/overview).
