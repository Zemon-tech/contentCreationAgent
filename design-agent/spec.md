# Design Agent — Technical Spec

Turns input content text into ready-to-post Instagram images (single or carousel), rendered from hand-authored HTML/CSS templates. Some template slots hold AI-generated imagery from a ComfyUI workflow; text and layout are rendered with headless Chromium. The system produces files only — it does not publish to Instagram.

This document is the build contract for an AI coding agent. Follow it literally. Where it says MUST, there is no discretion.

---

## 1. Scope

### In scope
- Accept content text over an HTTP endpoint.
- Use an LLM (Sarvam) to turn content into a schema-validated `PostPlan`: chosen template, per-slide copy, image prompts, caption, hashtags, alt text.
- Enforce a brand guide (KeilHQ) that the LLM output MUST respect.
- Generate imagery for declared image slots via a ComfyUI workflow on the same VM.
- Composite copy + imagery into final images using hand-authored HTML/CSS templates rendered by Playwright/Chromium.
- Validate output against Instagram constraints and write a per-post output folder to disk.

### Out of scope (do NOT build)
- Publishing to Instagram or any Meta API integration.
- Agent-generated templates. Templates are hand-authored only.
- Video, Reels, or Stories. Static images only.
- A frontend/UI. The HTTP endpoint plus output folder is the entire interface.
- Authentication/multi-tenant concerns beyond a single shared API key.
- Scheduling. One request produces one post.

---

## 2. Stack (fixed — do not substitute)

- **Language:** Python 3.11+
- **HTTP server:** FastAPI + Uvicorn
- **LLM:** Sarvam Chat Completions, model `sarvam-105b`, endpoint `POST https://api.sarvam.ai/v1/chat/completions`, header `api-subscription-key: <key>`. MUST use `response_format` with `{"type": "json_schema", "json_schema": {..., "strict": true}}` for the PostPlan call. Do NOT use `sarvam-30b` (deprecated).
- **Templating:** Jinja2 → HTML string.
- **Renderer:** Playwright (Python), Chromium, headless.
- **Image gen:** ComfyUI HTTP/WebSocket API on the same VM (`http://127.0.0.1:8188` by default).
- **Image post-processing:** Pillow (resize, sRGB conversion, JPEG encode, file-size control).
- **Validation:** Pydantic v2 for all inter-stage contracts.
- **Config:** environment variables + `brand.yaml`.

Rationale for renderer choice (do not revisit): SVG has no working auto text-wrapping in any renderer, and Sarvam output may include Indic scripts that require HarfBuzz shaping. Chromium wraps and shapes both correctly. See §12.

---

## 3. Architecture

Four stages. Each stage has a typed input and a typed output. A stage MUST NOT reach around the contract into another stage's internals.

```
HTTP request (content text + options)
        │
   ┌────▼─────────────┐
   │ 1. PLANNER       │  Sarvam → PostPlan (json_schema strict)
   │                  │  validates against brand + template manifest
   └────┬─────────────┘  out: PostPlan
        │
   ┌────▼─────────────┐
   │ 2. IMAGE ENGINE  │  ComfyUI: one job per image slot that needs generation
   │                  │  POST /prompt → WS wait → GET /history → GET /view
   └────┬─────────────┘  out: slot_id → PNG file on disk
        │
   ┌────▼─────────────┐
   │ 3. COMPOSITOR    │  Jinja2 render HTML → Playwright screenshot per slide
   │                  │  overflow check → Pillow → IG-valid JPEG
   └────┬─────────────┘  out: slide JPEGs
        │
   ┌────▼─────────────┐
   │ 4. ASSEMBLER     │  write output folder: images + caption.txt + post.json
   └──────────────────┘
```

Processing is synchronous per request but MUST run inside a job queue with bounded concurrency (§9). The HTTP call returns a `job_id` immediately; the caller polls a status endpoint.

---

## 4. HTTP API

Single-key auth: every request MUST carry `X-API-Key: <DESIGN_AGENT_API_KEY>`. Reject with 401 if missing/wrong.

### `POST /jobs`
Request body:
```json
{
  "content": "string, required, the source text",
  "format": "single | carousel",          // optional, default: agent decides
  "aspect_ratio": "4:5 | 3:4 | 1:1",       // optional, default "4:5"
  "template_id": "string",                 // optional; if omitted, planner selects
  "max_slides": 10,                         // optional, default 10, hard cap 10
  "language": "string"                      // optional BCP-47 hint, e.g. "hi", "en"
}
```
Response `202`:
```json
{ "job_id": "uuid", "status": "queued" }
```

### `GET /jobs/{job_id}`
Response `200`:
```json
{
  "job_id": "uuid",
  "status": "queued | planning | generating_images | compositing | done | failed",
  "output_dir": "string | null",
  "error": "string | null",
  "post": { /* post.json contents, present when done */ }
}
```

### `GET /health`
Returns `200` with `{ "status": "ok", "comfyui": "reachable | unreachable" }`. Checks ComfyUI via `GET /system_stats`.

### Validation errors
Malformed request → `422` with field detail. Content empty or > 20000 chars → `422`.

---

## 5. Data contracts (Pydantic)

### 5.1 Template manifest
Each template is a directory under `templates/<template_id>/` containing:
- `manifest.json` — the contract below
- `template.html.j2` — Jinja2 template
- `style.css` — styles (may be inlined or linked; MUST be reachable by the renderer)
- optional `assets/` — static images (logo, textures)

`manifest.json` schema:
```json
{
  "id": "string, matches dir name",
  "name": "human label",
  "description": "when to use this template — read by the planner",
  "supports": {
    "formats": ["single", "carousel"],
    "aspect_ratios": ["4:5", "3:4", "1:1"]
  },
  "slides": {
    "min": 1,
    "max": 10,
    "fixed": null            // integer if the template requires an exact count, else null
  },
  "text_slots": [
    {
      "id": "headline",
      "role": "headline | body | eyebrow | cta | caption_line",
      "max_chars": 60,        // hard cap the planner MUST respect
      "min_chars": 0,
      "multiline": true,
      "per_slide": true       // true = one value per slide; false = one value for the post
    }
  ],
  "image_slots": [
    {
      "id": "background",
      "fit": "cover | contain",
      "per_slide": true,
      "comfy_workflow": "workflow_file_name.json",  // API-format workflow in workflows/
      "prompt_slot": true     // true = planner supplies a generation prompt for this slot
    }
  ]
}
```

Rules:
- `text_slots[].max_chars` is a HARD constraint. The planner is instructed with it and the compositor re-checks it (§7.3).
- An `image_slot` with `prompt_slot: true` requires a generation prompt in the PostPlan. With `prompt_slot: false`, the slot uses a static asset from `assets/` referenced in the HTML and no ComfyUI job runs for it.

### 5.2 PostPlan (LLM output, json_schema strict)
```json
{
  "template_id": "string",
  "format": "single | carousel",
  "aspect_ratio": "4:5 | 3:4 | 1:1",
  "slides": [
    {
      "text": { "<text_slot_id>": "string", "...": "..." },
      "images": { "<image_slot_id>": { "prompt": "string" } }
    }
  ],
  "caption": "string, <= 2200 chars",
  "hashtags": ["string", "..."],   // <= 30 items, each without leading '#'
  "alt_texts": ["string per slide, <= 1000 chars each"]
}
```
The JSON Schema passed to Sarvam MUST be generated from the selected template manifest so `text` keys, `images` keys, and slide count are constrained to that template. Do not send a generic schema.

### 5.3 post.json (final output manifest)
```json
{
  "job_id": "uuid",
  "created_at": "ISO-8601",
  "template_id": "string",
  "format": "single | carousel",
  "aspect_ratio": "4:5",
  "slides": [ { "index": 0, "file": "slide_01.jpg", "alt_text": "string" } ],
  "caption": "string",
  "hashtags": ["string"],
  "source_content_sha256": "hex",
  "warnings": ["string"]
}
```

---

## 6. Stage 1 — Planner

1. Load the template manifest. If `template_id` was supplied, use it. If not, the planner selects: send Sarvam the list of `{id, name, description, supports}` for all templates and the content, and have it return one `template_id` (a small json_schema call). Validate the choice against requested `format`/`aspect_ratio`.
2. Build a JSON Schema for the PostPlan from the chosen manifest (constrain slide count, slot keys, and `maxLength` per text slot to `max_chars`).
3. Call Sarvam with:
   - system message: role + brand guide rules (§8) + hard formatting rules (respect `max_chars`, produce exactly N slides, hashtags without `#`, caption ≤ 2200).
   - user message: the content, plus `language` hint if given.
   - `response_format`: json_schema strict with the schema from step 2.
   - `temperature`: 0.3.
4. Validate the returned PostPlan with Pydantic AND against the manifest:
   - every required text slot present and within `max_chars`,
   - slide count within `[slides.min, slides.max]` (or exactly `slides.fixed`),
   - every `prompt_slot: true` image slot has a non-empty prompt,
   - hashtags ≤ 30, caption ≤ 2200.
5. On validation failure, retry ONCE with the validation errors appended to the prompt. On second failure, fail the job with a clear error. Do NOT silently truncate text to make it fit (except see §7.3 auto-fit, which is a rendering concern, not a content one).

Brand enforcement (§8) is applied here as prompt rules AND as a post-generation check for banned words. Banned-word hit → treat as a validation failure and retry once.

---

## 7. Stage 3 — Compositor (Stage 2 is §11)

Runs after images exist on disk. For each slide:

### 7.1 Render
1. Build a Jinja2 context: text slot values, resolved image file paths (as `file://` URLs or base64 data URIs — data URIs preferred so the renderer needs no file-server), brand tokens, aspect ratio.
2. Render `template.html.j2` to an HTML string.
3. In Chromium: set viewport to the target CSS pixel size at `deviceScaleFactor: 1` (canvas is authored at exactly the output size, §7.4). `page.set_content(html, wait_until="load")`, then `await page.evaluate("document.fonts.ready")` BEFORE screenshot. Do NOT use `networkidle`.
4. Screenshot the root element (a single `#canvas` element sized to the exact pixels), not the full page, as PNG.

### 7.2 Fonts
Brand fonts (DM Sans, Inter) MUST be embedded in the template as `@font-face` with local files under `templates/_shared/fonts/` (woff2/ttf). Do NOT rely on system or network fonts. The CSS `font-family` stacks MUST list a Noto fallback for non-Latin text so Indic content shapes correctly.

### 7.3 Overflow / auto-fit
After `document.fonts.ready`, detect overflow by evaluating `scrollHeight > clientHeight` (or width) on each text slot element. If any slot overflows:
1. Reduce that slot's font size by a step (e.g. multiply by 0.94), re-measure, repeat down to a per-slot floor defined in CSS (`--min-font-size`).
2. If it still overflows at the floor, record a warning in `post.json` and proceed (do NOT crash). Auto-fit shrinks type; it MUST NOT alter the text content.

Because `max_chars` is enforced at planning time, auto-fit is a safety net, not the primary mechanism.

### 7.4 Output normalization (Pillow)
- Target pixel sizes: `4:5` → 1080×1350, `3:4` → 1080×1440, `1:1` → 1080×1080. The HTML `#canvas` MUST be authored at exactly these dimensions so the screenshot is already correct size; Pillow verifies and only resizes if mismatched.
- Convert to sRGB, mode RGB.
- Encode JPEG at quality 88. If file > 1_400_000 bytes, step quality down by 4 until under, floor at quality 72.
- Filenames: `slide_01.jpg`, `slide_02.jpg`, … (1-based, zero-padded).

### 7.5 Carousel ratio consistency
All slides in a carousel MUST use the SAME aspect ratio (Instagram crops later slides to slide 1 otherwise). The planner sets one `aspect_ratio` for the whole post; the compositor MUST NOT vary it per slide.

---

## 8. Brand guide (KeilHQ) — `brand.yaml`

The agent MUST load `brand.yaml` and (a) inject its rules into the planner system prompt and (b) expose its tokens to templates as Jinja2/CSS variables. Ship this exact file:

```yaml
name: KeilHQ
voice:
  principles:
    - "Calm over stimulation, substance over spectacle."
    - "Whisper, do not shout. The interface disappears; the work is the hero."
    - "Knowledge done well is careful, not fast. Deliberate, patient, unhurried."
    - "Restraint and quiet confidence. No hype, no exclamation-driven marketing."
  prefer:
    - clear, precise, editorial phrasing
    - short declarative sentences
  avoid:
    - hype words: "revolutionary", "game-changer", "unbelievable", "amazing", "🔥"
    - exclamation marks in body copy (at most one per post, only if truly warranted)
    - emoji spam; at most one tasteful emoji per post, none in headlines
banned_words:
  - "revolutionary"
  - "game-changer"
  - "game changer"
  - "unbelievable"
  - "insane"
  - "🔥"
colors:
  warm_ink: "#171514"       # primary text, primary buttons, highest contrast
  cotton_paper: "#F7F4EE"   # app/background canvas
  linen: "#F1EEE8"          # surfaces, cards
  limestone: "#DDD7CE"      # hairline borders, dividers
  weathered_slate: "#7E7A74" # secondary text, captions
  # accents — use sparingly, per role
  oxidized_copper: "#2B6F6A" # AI states ONLY
  monsoon_forest: "#1D3429"  # team/collaboration/progress
  jaipur_sandstone: "#A98563" # enterprise/trust/archival
  harvest_marigold: "#C68A34" # discovery/new-idea, sparingly
  indigo_dye: "#31425E"       # docs/knowledge/scholarship
  terracotta_clay: "#744739"  # human warmth, editorial
typography:
  headline_font: "DM Sans"
  body_font: "Inter"
  rules:
    - "Words deserve space; never squeeze type."
    - "Headlines: DM Sans. Product/UI/dense text: Inter."
color_usage_rules:
  - "Foundation tones (warm_ink, cotton_paper, linen, limestone, weathered_slate) form 80-90% of any surface."
  - "oxidized_copper is reserved exclusively for AI-related content."
  - "Accents signal specific context; do not mix multiple accents on one surface."
```

Enforcement:
- Planner system prompt includes `voice`, `banned_words`, and a directive to match the calm/editorial tone.
- After generation, scan all text fields (case-insensitive) for `banned_words`; a hit is a validation failure (retry once, then fail).
- Templates consume `colors` and `typography` as CSS custom properties. Color usage rules are a template-authoring guideline, not runtime-enforced.

---

## 9. Concurrency, resources, ComfyUI serialization

- The VM has one GPU. ComfyUI jobs MUST be serialized (a single-slot async lock or a queue of depth 1 for the image-engine stage). Two diffusion jobs at once will OOM.
- Chromium renders are cheap but MUST be bounded: reuse ONE persistent `Browser` instance across requests; create a fresh `BrowserContext` (or page) per slide; cap concurrent pages with an `asyncio.Semaphore` (default 2). Close pages after use to avoid orphaned renderers.
- Job queue: an in-process `asyncio.Queue` with a small worker pool (default 1 worker end-to-end, since the GPU is the bottleneck). Concurrency values MUST be env-configurable.
- Do NOT launch a browser per request. Launch once at startup, close on shutdown.

---

## 10. Configuration (env vars)

```
DESIGN_AGENT_API_KEY          required, the X-API-Key value
SARVAM_API_KEY                required
SARVAM_BASE_URL               default https://api.sarvam.ai
SARVAM_MODEL                  default sarvam-105b
COMFYUI_BASE_URL              default http://127.0.0.1:8188
COMFYUI_TIMEOUT_S             default 300
OUTPUT_DIR                    default ./output
TEMPLATES_DIR                 default ./templates
BRAND_FILE                    default ./brand.yaml
RENDER_CONCURRENCY            default 2
JOB_WORKERS                   default 1
```
Secrets come from env only. Do NOT hardcode keys or log their values.

---

## 11. Stage 2 — ComfyUI image engine

For each image slot with `prompt_slot: true`, per slide:

1. Load the API-format workflow JSON named in `image_slot.comfy_workflow` from `workflows/`. These are exported from ComfyUI via File → Export (API) — NOT the UI-format JSON. Store them in the repo.
2. Each workflow file has a companion `<workflow>.map.json` declaring which node inputs are injectable, e.g. `{ "prompt_node": "6", "prompt_input": "text", "seed_node": "3", "seed_input": "seed", "width_node": ..., "height_node": ... }`. Inject the planner's prompt and a per-request seed via this map. Do NOT hardcode node IDs inline; node IDs are arbitrary per workflow.
3. Set output dimensions on the workflow to match the slide aspect ratio (or a size that the template's `fit: cover` can crop cleanly). The compositor handles final exact-size cropping.
4. Submit: `POST /prompt` with `{ "prompt": <workflow>, "client_id": <uuid> }`. If the response contains `node_errors`, FAIL the job (missing model/bad input — not retryable). Capture `prompt_id`.
5. Wait via WebSocket `ws://<host>/ws?clientId=<same uuid>`: completion is the message `type == "executing"` with `data.node == null` and `data.prompt_id == prompt_id`. Ignore binary preview frames. Enforce `COMFYUI_TIMEOUT_S`.
6. Fetch results: `GET /history/{prompt_id}`, walk `outputs[node].images`, download each via `GET /view?filename=&subfolder=&type=`. Save the PNG to the job's working dir keyed by `slot_id`+slide index.
7. ComfyUI has no auth. If `COMFYUI_BASE_URL` is not localhost, that is an operator concern (reverse proxy); the agent does not manage it.

Image-engine calls run under the GPU serialization lock (§9).

---

## 12. Instagram output constraints (validation, not publishing)

The assembler validates and records; it does not upload. Enforce:
- Dimensions exactly 1080×1350 (4:5), 1080×1440 (3:4), or 1080×1080 (1:1). Width MUST be 1080.
- Color profile sRGB.
- JPEG, each file ≤ ~1.4 MB (stay under IG's ~1.5 MB second-compression trigger).
- Carousel: 1–10 slides, all identical aspect ratio.
- Caption ≤ 2200 chars; ≤ 30 hashtags.
- Keep load-bearing content within a centered safe zone (author templates so key text/logo sit within the central 1012 px width for 4:5, since the profile grid crops to 3:4). This is a template-authoring rule; record a warning only if a template declares a safe zone and content is placed outside it (optional).

Any violation the agent cannot auto-correct → record in `post.json.warnings`; hard violations (wrong dimensions) → fail with a clear message.

---

## 13. Output layout

Per job, write to `OUTPUT_DIR/<job_id>/`:
```
<job_id>/
  slide_01.jpg
  slide_02.jpg          # carousel only
  caption.txt           # caption + blank line + hashtags joined with spaces, each '#'-prefixed
  post.json             # §5.3
  plan.json             # the validated PostPlan, for debugging
```
`caption.txt` is the human-usable artifact: caption text, one blank line, then hashtags.

---

## 14. Repository layout

```
design-agent/
  spec.md
  brand.yaml
  pyproject.toml
  .env.example
  app/
    main.py              # FastAPI app, routes, startup/shutdown (browser lifecycle)
    config.py            # env parsing
    models.py            # Pydantic contracts (§5)
    queue.py             # job queue + worker + status store
    brand.py             # loads brand.yaml, builds prompt rules, banned-word scan
    planner.py           # Stage 1 (Sarvam)
    sarvam.py            # thin Sarvam client (json_schema calls)
    images.py            # Stage 2 (ComfyUI client + workflow injection)
    compositor.py        # Stage 3 (Jinja2 + Playwright + overflow + Pillow)
    assembler.py         # Stage 4 (write output folder)
    templates_loader.py  # discover/validate template manifests, build PostPlan schema
  templates/
    _shared/fonts/       # DM Sans, Inter, Noto fallback (woff2/ttf)
    <template_id>/
      manifest.json
      template.html.j2
      style.css
      assets/
  workflows/
    <workflow>.json      # API-format ComfyUI workflow
    <workflow>.map.json  # injectable node map (§11.2)
  tests/
```

---

## 15. Deployment notes (remote GPU VM, Linux)

- Install Chromium + OS deps: `playwright install --with-deps chromium`.
- Install Indic + emoji fonts at OS level so any Chromium fallback resolves: `fonts-noto-core`, `fonts-noto-cjk`, `fonts-noto-color-emoji`. Brand fonts are embedded in templates regardless.
- Launch Chromium headless with `--no-sandbox --disable-dev-shm-usage` (containers give /dev/shm only 64 MB; alternatively run with `--ipc=host` / larger shm).
- ComfyUI runs separately on `127.0.0.1:8188`; the agent connects as a client. The agent does NOT start or manage ComfyUI.
- Set a process memory cap so a render burst cannot take the box down; enforce render concurrency in code via the semaphore (§9).

---

## 16. Build order (implement in this sequence)

1. Contracts + config + template loader + brand loader (§5, §8, §10). Unit-test manifest → PostPlan JSON Schema generation.
2. Compositor with a hand-authored sample template and PLACEHOLDER images (solid color). Prove the output is a valid, on-brand 1080×1350 JPEG before any AI is wired in. This is the highest-risk step; do it early.
3. Planner (Sarvam json_schema) + brand enforcement. Feed real content → validated PostPlan → composite with placeholders.
4. ComfyUI image engine. Replace placeholders with generated imagery.
5. HTTP API + job queue + status polling + assembler output folder.
6. Deployment hardening (§15): fonts, concurrency caps, health check.

Verify at each step: run the stage end-to-end and inspect the actual JPEG/JSON output. A stage "returning without error" is not proof it is correct.

---

## 17. Non-negotiable invariants (recap)

- No publishing. Files only.
- Templates are hand-authored; the agent fills them, never generates them.
- PostPlan is produced with Sarvam `json_schema` strict, schema derived from the chosen template manifest.
- `text_slot.max_chars` is enforced at planning time; auto-fit only shrinks type, never edits text.
- One aspect ratio per carousel.
- GPU/ComfyUI jobs are serialized; Chromium is one reused browser with bounded pages.
- Brand banned-words scan gates every generation.
- Output images are 1080-wide, sRGB, JPEG ≤ ~1.4 MB.
