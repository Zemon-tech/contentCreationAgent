# SETUP — RAS Satori Design Agent (MVP)

How to install, configure, and run the new agent that renders Rise & Shine (RAS)
social graphics in-process with Satori and posts to Instagram after approval.

> Status: scaffolding stage. This document is written ahead of the code so the
> steps are ready; sections marked (pending) land as the implementation does.

---

## 1. Prerequisites

- Node.js >= 22.13 (see `package.json` `engines`).
- The repo already uses Mastra 1.67, Zod v4, ESM.
- Run via the repo scripts (per AGENTS.md): `npm run dev` and `npm run build`.
  Do NOT call `mastra dev` / `mastra build` directly.

---

## 2. Install dependencies (pending implementation)

The Satori engine needs three new runtime packages plus React types:

```bash
npm install satori @resvg/resvg-js react
npm install -D @types/react
```

- `satori` — React element → SVG.
- `@resvg/resvg-js` — SVG → PNG (native Rust binding).
- `react` — only for `React.createElement` in the templates (no DOM, no hooks).

> `@mastra/core` and `zod` are already installed.

---

## 3. Static assets (you provide the files)

Two folders are created for you. Drop the real binaries in:

### Fonts → `src/mastra/assets/fonts/`
See `src/mastra/assets/fonts/README.md`. Required filenames:

- `Inter-Regular.woff` (400)
- `Inter-Bold.woff` (700)
- `Inter-ExtraBold.woff` (800)
- `InstrumentSerif-Regular.woff` (400)
- `IBMPlexMono-Regular.woff` (400)

### Logos → `src/mastra/assets/RAS-by-keilhq/`
See `src/mastra/assets/RAS-by-keilhq/README.md`. Expected filenames:

- `ras-logo-dark.png`
- `ras-logo-light.png`
- `ras-by-keilhq-logo-dark.png`
- `ras-by-keilhq-logo-light.png`

> If your actual filenames differ (e.g. the existing `*-light-mode.png`), tell me
> and the renderer filenames will be adjusted to match.

---

## 4. Environment variables

Add / confirm these in `.env` (see `.env.example`). Only the Instagram ones are
new to this feature; the model + Exa keys are already used by the repo.

| Variable | Required for | Notes |
|----------|--------------|-------|
| `EXA_API_KEY` | search | Already used by the existing Exa tools. |
| `LOCAL_MODEL_BASE_URL` / `LOCAL_MODEL_NAME` / `LOCAL_MODEL_API_KEY` (or `SARVAM_API_KEY`) | the agent's model | Same Sarvam setup used by the other agents via `resolveChatModel()`. |
| `INSTAGRAM_ACCOUNT_ID` | posting | Instagram Professional account id. |
| `INSTAGRAM_ACCESS_TOKEN` | posting | Long-lived Graph API token. |
| `INSTAGRAM_DRY_RUN` | localhost testing | Set `true` for MVP localhost — renders + builds payload but does NOT post. |
| `PUBLIC_BASE_URL` | real posting | Public HTTPS base that serves the rendered PNGs to Meta. See §6. |

---

## 5. Run it (localhost)

```bash
npm run dev
```

Then open Mastra Studio at http://localhost:4111 and pick the new RAS design agent.

Typical MVP flow:
1. Give the agent a topic ("Anthropic Claude enterprise news") or paste news text.
2. The agent searches/reads, drafts copy, and proposes a format (single or carousel).
3. It asks which hero image to use (your upload, or a web image it found).
4. It renders the PNG(s) and shows them inline, with the caption + hashtags.
5. It asks for approval to post. On approval it publishes (or dry-runs — see §6).

---

## 6. Posting to Instagram: localhost vs. live

Instagram's Graph API does not accept image bytes directly — it fetches each
image from a **public HTTPS URL**. Consequences:

- **Localhost (MVP default):** keep `INSTAGRAM_DRY_RUN=true`. The pipeline renders,
  builds the exact publish request, and reports what it *would* post. Nothing is
  posted. This exercises the full search → render → approve flow safely.
- **Going live:** expose the Mastra server over a public HTTPS URL and set
  `PUBLIC_BASE_URL` to it, then set `INSTAGRAM_DRY_RUN=false`.
  - Local tunnel option: `ngrok http 4111` (or `cloudflared`), then
    `PUBLIC_BASE_URL=https://<id>.ngrok.app`.
  - Deployed option: your deployed host, e.g. `PUBLIC_BASE_URL=https://ras.example.com`.
  - Verify the connection first with the `checkInstagramConnection` tool — it
    reports the account and the remaining daily publishing quota.

---

## 7. Verification

Render a single story and a 4-slide carousel with mock payloads (no network, no Instagram):

```bash
npx -y tsx src/mastra/demo/verifyRasDesign.ts
```

Expected: 5 PNGs written under `workspace/output/ras/verify-story/` and
`workspace/output/ras/verify-carousel/`, all 1080×1350, printed as `OK`, ending in `PASS`.

---

## 8. Troubleshooting (pending)

- "snapshot not found" on approval → storage not configured; this repo uses LibSQL,
  so confirm `TURSO_DATABASE_URL` or the default `file:./mastra.db` is reachable.
- Fonts render as empty boxes → a required WOFF is missing from `assets/fonts/`,
  or the text used a non-Latin glyph/emoji.
- Instagram publish fails with a URL error → `PUBLIC_BASE_URL` is unset or points at
  localhost; Meta cannot fetch the image. Use a tunnel or stay in dry-run.
