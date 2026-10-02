# Implementation Plan: Autonomous News Radar & Visual Content Engine

## 1. Context & Background

The application is an **Autonomous Industry Intelligence & Visual Content Engine** consisting of two interconnected subsystems:
1. **Mastra TypeScript Backend (`src/mastra/`)**: Ingests feeds, deduplicates, verifies evidence, clusters items into stories, scores them (0–100), and manages workflows and storage.
2. **Python FastAPI Design Agent (`design-agent/`)**: Jinja2 + Playwright compositor that turns structured text and image prompts into multi-slide Instagram carousels and single posts across 5 visual templates.

### Current State
- **Implemented**: Multi-source collector (RSS, arXiv, GitHub), 3-level dedup (URL, content-hash, embedding cosine), Union-Find story clustering, evidence hierarchy (T0–T3), scoring/decision gate (`POST_NOW`, `WORTH_COVERING`, `MONITOR`, `DO_NOT_POST`), SQLite persistence (`mastra.db`), Exa search/scrape, and 5 Design Agent templates.
- **Problem**: The Radar Pipeline (`industryAggregationWorkflow`) and the Design Post Workflow (`newsToPostWorkflow`) operate in silos. News stories are not automatically formatted or routed to the Design Agent, and there is no approval queue or social webhook export.

---

## 2. Architectural Decisions

1. **Ingestion Strategy (The "Alpha Radar")**:
   - **Discovery**: Scheduled sweep of primary sources (RSS, arXiv, GitHub Releases) to detect raw events at minute-zero before mainstream media covers them.
   - **Enrichment & Verification**: Automatically trigger targeted Exa searches on detected primary events to gather live reactions, corroboration, and context.
2. **Human-in-the-Loop (HITL) Placement**:
   - Review occurs **before** the Design Agent runs. Discovered stories enter a "Candidate / Draft" state; user reviews/approves the headline and angle before spending image/render compute.
3. **Template Routing**:
   - Use the **Typesafe JEV model via OpenRouter** for high-speed, schema-constrained routing that matches approved stories to the best template manifest.
4. **Publishing & Storage**:
   - Rendered deliverables persist in `workspace/output/<job_id>/` and are served via `/post-assets/:jobId/:filename`.
   - A standardized webhook payload exports approved posts to external social publishers (Buffer, Postiz, Make/Zapier, or direct Meta Graph / X APIs).
5. **Autonomy Progression**:
   - Phase 1–3 run in **Human-in-the-Loop** mode. Phase 4 introduces a configurable autonomous scheduler toggle (`AUTO_PUBLISH=true`).

---

## 3. Constraints & Technical Invariants

- **Runtime & Modules**: Node.js $\ge 22.13.0$, TypeScript with ES2022 modules (`type: "module"`). Do not use CommonJS.
- **Mastra Framework**: Must adhere to `@mastra/core` 1.67.0. Register all agents, tools, and workflows in `src/mastra/index.ts`.
- **Database**: SQLite backed by `@libsql/client` writing to `file:./mastra.db` (or Turso when `TURSO_DATABASE_URL` is set).
- **Design Agent API**: Must communicate via HTTP REST with `design-agent` (`POST /jobs` with `X-API-Key`, polling `GET /jobs/:id`).
- **Attribution & Evidence**: Never discard source URLs or timestamps. Maintain separation between `event_at` and `discovered_at`.
- **Verification Tests**: All changes must pass `npm run typecheck` (`tsc --noEmit`) and `npm run verify` (`verifyPipeline.ts`).

---

## 4. Phase-Wise Implementation Todos

### Phase 1: Unify Ingestion (Radar Discovery + Exa Verification) [COMPLETED]
- [x] In `src/mastra/workflows/industryAggregationWorkflow.ts`, create a verification step `enrichWithExaStep` (via `enrichStoriesWithExa` in `verify.ts`):
  - For top stories passing the initial hard filter, triggers `searchExa` to fetch external corroboration and reactions.
  - Merges scraped Exa findings into the story's `evidenceList` and updates `independent_source_count`.
- [x] Add an operational toggle (`useExaEnrichment: boolean`, default `true`) to allow offline/demo testing.
- [x] Verify `npm run verify` continues to pass with mock and live options.

### Phase 2: Human-in-the-Loop (HITL) Approval Queue [COMPLETED]
- [x] Add an `editorial_status` field to `StorySchema` / SQLite `stories` table:
  - Statuses: `DISCOVERED` | `PENDING_REVIEW` | `APPROVED` | `REJECTED` | `SENT_TO_DESIGN` | `PUBLISHED`.
- [x] In `src/mastra/repositories/store.ts`:
  - Added helper queries to list stories pending review (`listPendingStories()`, `updateStoryEditorialStatus()`).
- [x] Created tools for editorial approval:
  - `listPendingNewsTool`: Returns stories with `PENDING_REVIEW` status.
  - `approveNewsStoryTool`: Marks story as `APPROVED`, with optional overrides for title, angle, or hook.
  - `rejectNewsStoryTool`: Marks story as `REJECTED` with reason.

### Phase 3: JEV Router (OpenRouter) & Template Slot Formatter [COMPLETED]
- [x] Create `src/mastra/lib/template-router.ts`:
  - Queries OpenRouter using the Typesafe JEV model endpoint (`typesafe/jev`).
  - Prioritizes user's designated test template `news-brief`.
  - Fallback: Deterministic heuristic router if `OPENROUTER_API_KEY` is not present.
- [x] Create `src/mastra/lib/content-formatter.ts`:
  - Converts approved `Story` + `ContentOpportunity` into the exact slots declared by `news-brief` / template `manifest.json`:
    - `eyebrow`: Classification tag or freshness badge ($\le 40$ chars).
    - `headline`: Hook-driven headline ($\le 110$ chars).
    - `body`: Structured narrative key facts and thesis ($\le 480$ chars).
    - `cta`: Contextual call-to-action.
    - `caption`: Full Instagram caption copy with `#hashtags`.
    - `cover_image_url`: Direct source image or prompt for hero slot.

### Phase 4: Design Agent Dispatch & Delivery [COMPLETED]
- [x] In `src/mastra/tools/design-tools.ts`:
  - Added `renderPostFromApprovedStoryTool`: Takes an approved story ID, routes template (defaulting to `news-brief`), formats payload, updates status to `SENT_TO_DESIGN`, and submits to `design-agent-client.ts`.
- [x] Updated `src/mastra/agents/aggregatorAgent.ts` and `src/mastra/index.ts`:
  - Registered all Phase 2 & 3 editorial and rendering tools.

### Phase 5: Social Webhook & Autonomous Scheduler Toggle
- [ ] Create `src/mastra/tools/publish-tools.ts`:
  - `exportToSocialWebhookTool`: Reads the completed `post.json`, slide image paths, caption, and hashtags from `workspace/output/<job_id>/`.
  - Dispatches HTTP POST webhook payload to configured endpoint (`SOCIAL_WEBHOOK_URL` e.g. Make, Zapier, Postiz, or Buffer).
- [ ] Add autonomous execution mode:
  - Add a scheduled runner (`src/mastra/workflows/scheduledNewsRunner.ts`) that checks `AUTO_PUBLISH=true` in `.env`.
  - When enabled: automatically approves top story with score $\ge 85$, routes template, renders post, and triggers webhook.
  - When disabled (default): stops at `PENDING_REVIEW` for human sign-off.

---

## 5. Single Definition of Done

The system is considered **DONE** when:
1. Running `npm run sweep` or triggering `industryAggregationWorkflow` sweeps primary sources, enriches breaking events with Exa, and queues top-scoring stories into SQLite with status `PENDING_REVIEW`.
2. A human can view the candidate story, approve/edit the angle, and trigger `dispatchApprovedStoryToDesignTool`.
3. The Typesafe JEV model on OpenRouter selects the optimal template (`tech-announcement`, `360labs-news`, etc.) based on story classification and format.
4. The Design Agent successfully compiles the slides, renders high-resolution JPG images to `workspace/output/<job_id>/`, and generates public preview URLs via `/post-assets/:jobId/:filename`.
5. The post package (images, caption, hashtags) can be dispatched via `exportToSocialWebhookTool` to an external social webhook.
6. All existing and new tests pass cleanly with `npm run typecheck` and `npm run verify`.
