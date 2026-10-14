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
npm run rank:seed     # append ~30 real recent headlines (needs EXA_API_KEY) to label
npm run rank:eval     # score the golden set, report agreement + variance
```

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

## Learn more

To learn more about Mastra, visit our [documentation](https://mastra.ai/docs/). If you're new to AI agents, check out our [course](https://mastra.ai/learn) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join our [Discord](https://discord.gg/mastra-ai) community to get help and share your projects.

## Deploy to the Mastra platform

The [Mastra platform](https://projects.mastra.ai) provides two products for deploying and managing AI applications built with the Mastra framework. Learn more in the [Mastra platform documentation](https://mastra.ai/docs/mastra-platform/overview).
