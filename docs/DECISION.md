# DECISION LOG — RAS Satori Design Agent (MVP)

A running record of the decisions made for the new agent that searches news,
renders Rise & Shine (RAS) social graphics in-process with Satori, and posts to
Instagram after human approval.

Last updated: 2026-10-09

---

## 1. Goal (MVP)

A single new Mastra agent that:

1. Takes a news topic or pasted news from the user.
2. Searches / reads the news (reusing the existing Exa tools).
3. Decides the format (single story post vs. multi-slide carousel) — the user
   can force a choice, otherwise the LLM decides based on how much there is to say.
4. Generates the editorial copy, the on-image text payload, and the Instagram
   caption + hashtags (RAS brand voice).
5. Renders production-ready 1080×1350 PNG(s) in-process via Satori + resvg.
6. Asks the user which image to use for the hero, and asks for explicit approval
   before posting to Instagram.
7. Posts to Instagram only on approval.

Longer-term (NOT in this MVP): a fully automated workflow that searches, creates,
and posts on a schedule with no human in the loop. The MVP is the manual,
interactive version used to validate the pipeline first.

---

## 2. Confirmed decisions (from the user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Search tool | **Reuse** existing `exaSearchTool` / `exaScrapeTool`. Do NOT rebuild. |
| 1 | Instagram publish | **Reuse** the existing Instagram publishing core (`publishImagesToInstagram`). |
| 1 | Render tools | **Build new** Satori render tools (`render-ras-story`, `render-ras-carousel`). |
| 2 | Formats | **Both** single story and carousel. Format chosen by user override, else by the LLM (single if the story fits one post). |
| 3 | Approval gate | **Mastra HITL (option a)**: the final Instagram publish is gated via `requireApproval` / `suspend()` so the agent pauses for explicit approval in Studio chat. |
| 4 | Hero image source | **User-provided image first**; may also search the web for an image. The agent ASKS the user which image to keep before rendering. |
| 5 | Brand assets | User will provide fonts + logos. We create the folders to drop them into. |
| 6 | Environment | Test on **localhost** first. |
| 7 | Model | **Same Sarvam model** via the existing `resolveChatModel()`. |
| 8 | Caption | Agent **generates the Instagram caption + hashtags** too (separate from on-image text). |

---

## 3. Decisions made by the engineer (defaults — change if you disagree)

- **D1 — Approval mechanism:** The final `publish-ras-to-instagram` tool is marked
  `requireApproval: true`. The agent pauses and emits a `tool-call-approval`
  (handled natively by Studio) before any real post. This is Mastra's recommended
  HITL path and requires configured storage (LibSQL is already configured).
  Rationale: robust, and it is the same gate the future automated workflow can reuse.

- **D2 — Image-choice question:** "Which image to keep" is asked via a `suspend()`
  question (the built-in `askUserTool`, or a dedicated suspend) that offers the
  options the agent found (user upload / web image / optional Flux generation).
  `autoResumeSuspendedTools` lets the user answer in natural language.

- **D3 — Instagram needs public HTTPS URLs even locally.** Meta fetches images from
  its own servers, so pure localhost cannot post for real. For MVP localhost
  testing we default to `INSTAGRAM_DRY_RUN=true` — the pipeline renders, builds the
  exact publish payload, and reports "would post" without posting. Going live needs
  a public tunnel/host via `PUBLIC_BASE_URL` (documented in SETUP.md).

- **D4 — New publish tool wraps the existing core.** Rather than reuse the
  Design-Agent-coupled `publishStoryToInstagram` / `publishDesignJobToInstagram`
  (which depend on `job_id` and the external Python service), the new agent gets a
  thin publish tool that takes **local PNG paths**, serves them via an asset route
  (mirroring `/post-assets`), and calls the same `publishImagesToInstagram` client.
  The low-level `publishToInstagramTool` (raw URLs) remains available as a fallback.

- **D5 — In-process Satori replaces the external Design Agent for THIS agent only.**
  The existing aggregator pipeline and its external Design Agent are left untouched.
  The new agent is self-contained and does not call the Python service.

- **D6 — PRD code adapted to this repo, not copied verbatim.** Specifically:
  - Mastra 1.67 tool `execute` uses `async ({ inputData, ... })`, not `async (input)`.
  - Zod v4 is in use.
  - A real `theme.ts` (`RAS_THEME`) is created (the PRD templates import it but never define the file).
  - Asset paths resolve against `src/mastra/assets/...` (bundler-safe), not a cwd-relative `./public`.

- **D7 — Output location.** Rendered PNGs go to the Mastra workspace output folder
  (same convention the asset route serves from) so they display inline in Studio.

---

## 4. Reused vs. new (component map)

| Component | Status | Location |
|-----------|--------|----------|
| Exa search / scrape | reuse | `src/mastra/tools/exa-tools.ts` |
| Instagram publish core | reuse | `src/mastra/lib/instagram-client.ts` (`publishImagesToInstagram`) |
| Satori renderer (fonts/images/render) | new | `src/mastra/renderer/*` |
| RAS theme tokens | new | `src/mastra/templates/theme.ts` |
| Story + carousel templates | new | `src/mastra/templates/*` |
| Render tools (story, carousel) | new | `src/mastra/tools/ras-render-tools.ts` (TBD name) |
| Local-PNG Instagram publish tool | new | `src/mastra/tools/*` (TBD) |
| New agent | new | `src/mastra/agents/rasDesignAgent.ts` (TBD name) |
| Registration | edit | `src/mastra/index.ts` (per AGENTS.md) |

> Everything new must be registered in `src/mastra/index.ts` (AGENTS.md rule).

---

## 5. Resolved (round 2)

- **Assets delivered and verified.** All 5 WOFF fonts and all 4 logo PNGs are present
  with the exact expected filenames and are valid (WOFF1 `wOFF` signature; valid PNGs).
  - Symbol logos are **207×204** (not the PRD's 160×160 / 160×124). The templates will
    set `<img>` display dimensions preserving the real aspect ratio to avoid squishing.
- **No Flux in the MVP.** Hero image is user-provided OR web-found (via Exa) only.
  The agent asks which to keep before rendering. Flux may be added later.
- **Naming:** agent = "RAS Design" (`id: ras-design-agent`); tool ids
  `render-ras-story`, `render-ras-carousel`, `publish-ras-to-instagram`.

## 5b. Verified Mastra v1 (1.67) API facts (confirmed via docs, affects the build)

- **`createTool` execute signature is `async (inputData, context)`** — `inputData` is the
  validated input (first param), `context` is second (holds `requestContext`, `abortSignal`,
  and the namespaced `context.agent` / `context.workflow`). The PRD's `async (input)` is adapted.
- **`requireApproval` accepts a function** evaluated per call, e.g.
  `requireApproval: async ({ isDryRun }) => !isDryRun`. Lets the publish tool skip the
  approval pause on dry runs and require it only for real posts.
- **suspend/resume**: use `context?.agent?.suspend(payload)` + `context?.agent?.resumeData`,
  with `suspendSchema` / `resumeSchema`. `autoResumeSuspendedTools: true` resumes from the
  user's next chat message. This drives the "which image to keep" question.
- **`outputSchema` is validated at runtime** (strict). Tool return values must match the
  schema exactly or Mastra returns a `ValidationError`.
- **Satori API confirmed**: `satori(element, { width, height, fonts: [{ name, data, weight, style }] })`
  → SVG; `new Resvg(svg, { fitTo }).render().asPng()` → PNG. WOFF1 loads natively via `fs` Buffer.

---

## 6. Build notes (what was actually implemented)

- Installed `satori@0.44`, `@resvg/resvg-js@2.6`, `react@19`, `@types/react@19`.
- Added `"jsx": "react-jsx"` + `"jsxImportSource": "react"` to `tsconfig.json` so `.tsx` compiles.
- Renderer (`src/mastra/renderer/`): `assets.ts` (locates `src/mastra/assets` via module-dir
  walk, bundler-safe), `fonts.ts`, `images.ts` (local + remote hero resolution, PNG dimension
  probe), `satori-renderer.ts`, `output.ts` (writes under `<workspaceOutput>/ras/<slug>/`).
- Templates (`src/mastra/templates/`): `theme.ts`, `RasStoryTemplate.tsx`, `RasCarouselTemplate.tsx`
  (cover + body + text slides). Symbol logos scaled by real aspect ratio.
- Tools: `ras-render-tools.ts` (`render-ras-story`, `render-ras-carousel`),
  `ras-instagram-tool.ts` (`publish-ras-to-instagram`, `requireApproval` = non-dry-run,
  wraps `publishImagesToInstagram`). Agent reuses the existing `checkInstagramConnectionTool`.
- Route: `routes/ras-assets.ts` serves `/ras-assets/<slug>/<file>.png`.
- Agent: `agents/rasDesignAgent.ts` (id `ras-design-agent`, name "RAS Design"), Sarvam model via
  `resolveChatModel()`, `autoResumeSuspendedTools: true`, `ask_user` for hero-image choice.
- Registered agent, 3 tools, and the route in `src/mastra/index.ts`.
- Verification: `src/mastra/demo/verifyRasDesign.ts` renders 1 story + 4-slide carousel with
  mock payloads. Result: 5 PNGs, all 1080×1350, no Satori errors. Visual check passed.
- Fixed a Satori box-model bug: `position:absolute` masthead with explicit `width:1080` + side
  padding overflowed and clipped "BY KEILHQ"; switched to `left:0; right:0` anchoring.

## 7. Changelog

- 2026-10-09 — Initial decision log created after requirements interview.
- 2026-10-09 — MVP implemented and verified (renderer, templates, tools, agent, route, verify script).
- 2026-10-09 — Fixed inline-image rendering in Studio chat. Root cause: render tools returned a
  server-relative view_url (`/ras-assets/...`); the model dropped the leading slash when writing
  Markdown, so the browser treated `ras-assets` as a hostname (`https://ras-assets/...` →
  ERR_NAME_NOT_RESOLVED). Fix: `rasViewUrl` now returns an ABSOLUTE URL via `mastraPublicUrl()`
  (`http://localhost:4111/ras-assets/...`, overridable with `MASTRA_PUBLIC_URL`), matching the
  working Flux pattern. Added `rasAssetPath()` for the server-relative path; the Instagram tool
  maps either an absolute view_url or a bare path onto `PUBLIC_BASE_URL`. Agent instructed to paste
  the view_url verbatim.
