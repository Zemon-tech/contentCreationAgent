# LLM editorial copywriter for RAS post copy (Exa-enriched, template fallback)

Replaces the template-filled post copy (serifHeadline/deck lines/caption) with LLM-written editorial copy. A new `lib/ras/copywriter.ts` module enriches the story with free third-party Exa coverage, asks the existing Sarvam ranker model to write strict-JSON copy grounded only in the fact pack plus Exa snippets, validates it with Zod (retry once), and falls back to the deterministic template on any failure. `buildRasPayload` keeps ownership of categoryTag/accentColor/hashtags and still runs every copy field — LLM or template — through `safeLatin` + hard length clipping as the final backstop. Config lives in `copy.config.ts` behind `COPY_*` envs; the user's `.env` is untouched and `.env.example` documents the new knobs.

Watch for:
- **Unrelated changes bundled in (confirmed):** a new `persistRankLog` option on `collectRankSelect` and a publish-path PNG-path fix in `rasRenderTest.ts` ride along in this commit. Neither is part of the copywriter feature. Non-blocking, but reviewers should know the diff is wider than its title.
- **Caption attribution is prompt-only, not enforced (likely):** the required `Source: <url>` trailer is instructed in the prompt but the Zod schema does not require it, so a model that drops it still validates and takes the `llm` path. The template fallback always includes it; the LLM path can silently omit it.

**Verdict**: APPROVED

## High-level view

The copywriter sits between fact-pack construction and payload assembly inside `prepareForHandoff`. It is a pure library function (no agent/tool/workflow/scorer), reusing the already-registered `rankScoringAgent`, so no new registration in `src/mastra/index.ts` is required and none was added. The write path is a near-exact clone of `llmScore.ts` `defaultGenerate`: same model, `reasoning_effort: "none"`, injectable `generate`, `extractJson` + Zod `safeParse`, one retry with the validation error appended, then fallback.

Grounding is the design's spine. Exa enrichment runs for every item including paywalled/limited ones, but only pulls Exa's own text snippets (capped at 2000 chars by `searchExa`), never the paywalled article body. Enrichment fails open: a missing `EXA_API_KEY` or any search error yields empty coverage and the model works from the fact pack alone — it never throws. The system prompt bakes in inverted-pyramid structure, a 5 Ws + H lead, an accurate-but-hooky non-clickbait headline rule, plain language, and a hard "use only the supplied facts, invent nothing" constraint.

The length contract is enforced twice. The Zod schema caps the five fields at 120/60/40/60/2000, and `buildRasPayload` independently re-clips each field through `clip`/`clipWords` (which call `safeLatin` first). An over-length or glyph-unsafe model response therefore can never reach the renderer; if the model stays over-length after the retry, the whole thing falls back to the template.

The deterministic template is fully intact as the fallback — `buildRasPayload` only overrides the five fields when `llmCopy` is non-null, and otherwise fills them exactly as before. The publish/Instagram path, ledger, ranker scoring, and image sourcing are not touched by the copy logic.

<details>
<summary>Issues (3)</summary>

1. **Bundled unrelated changes** — `persistRankLog` on `collectRankSelect` and the `rasRenderTest.ts` publish-path PNG-path normalization are unrelated to the copywriter; consider splitting them out or at least calling them out in the PR description. Non-blocking.
2. **Caption attribution not schema-enforced** — the `Source:` trailer is required only by prompt instruction, not by the Zod schema, so an LLM-path caption can validate without it while the template path always includes it. Consider a `.refine()` on `caption` or appending the source line post-validation if attribution must be guaranteed. Non-blocking.
3. **Redundant snippet slice** — `enrich` re-slices Exa text to 2000 chars though `searchExa` already caps at 2000 via `contents.text.maxCharacters`. Harmless; drop for clarity. Non-blocking.

</details>

<details>
<summary>Details</summary>

### Write path mirrors llmScore exactly

`defaultGenerate` in `copywriter.ts` is line-for-line the same shape as `llmScore.ts`: `rankScoringAgent.generate(prompt, { modelSettings: { temperature, maxOutputTokens, maxRetries: 2 }, providerOptions: { sarvam: { reasoning_effort: "none", reasoningEffort: "none" } } })`, returning `{ text: res.text ?? "", usage }`. The retry loop is also the same pattern — two attempts, `extractJson` + `EditorialCopySchema.safeParse`, on failure the prompt becomes `basePrompt` plus the sliced Zod issues and a "respecting every max length" instruction; on a transport throw it logs `copy-llm-call-error` and retries the base prompt. The `generate` function is injectable, which the offline demo stub and the unit tests use.

One behavioral difference from the ranker: the ranker leaves un-scored items for Stage C to penalize, whereas the copywriter has nowhere to degrade to, so it returns `copy: null` and `path: "fallback"` — a run never fails because of copy.

Logging distinguishes the paths as required: `copy-write` with `path: "llm"` (plus attempt and enriched-source count) on success, `path: "fallback"` with a `reason` (`llm-disabled` / `invalid-after-retry`) otherwise, and `copy-enrich` / `copy-enrich-skip` / `copy-enrich-error` for the Exa stage.

### Exa enrichment: fail-open and paywall-safe

`enrich` short-circuits to empty grounding when `exaEnabled` is false or `EXA_API_KEY` is absent (logged as `copy-enrich-skip`), and wraps the `searchExa` call so any error returns `{ snippets: "", sourceUrls: [] }` rather than throwing (`copy-enrich-error`). There is no paywall gate in `enrich`, so it runs for `factPackLimited`/paywalled items too — matching the contract that enrichment applies to all items.

Paywall safety holds: the module calls `searchExa({ query: headline, numResults, includeText: true, category: "news" })` and only ever reads `r.text` from the search response, which `searchExa` sources from Exa's `contents.text` (its own cached/returned snippets, capped at 2000 chars). It never calls `scrapeExa` and never fetches the primary article body. New source URLs are trimmed, de-duplicated against the known set (`factPack.sourceUrls` + `item.url`), and returned as `enrichedSourceUrls`, which `buildRasPayload` merges into `sourceUrls` via a `Set` — so the citable list grows without duplicates and `factPack.sourceUrls` itself is not mutated.

```
prepareForHandoff
  ├─ buildFactPack (unchanged)
  ├─ sourceImage (unchanged)
  ├─ writeEditorialCopy
  │     ├─ enrich ──(fail-open)──> snippets + newUrls   [Exa /search, text snippets only]
  │     └─ generate ×≤2 ─ extractJson ─ Zod ─ retry ─ fallback(null)
  └─ buildRasPayload({ llmCopy, extraSourceUrls })
        └─ safeLatin + clip/clipWords on every field (final backstop)
```

### Double length enforcement and the backstop

`EditorialCopySchema` enforces `serifHeadline ≤120`, `deckLead ≤60`, `deckHighlight ≤40`, `deckTail ≤60`, `caption ≤2000` — the exact maxima in the contract. Independently, `buildRasPayload` applies `clip(serifHeadline,120)`, `clipWords(deckLead,60)`, `clipWords(deckHighlight,40)`, `clipWords(deckTail,60)`, `clip(caption,2000)`, each of which runs `safeLatin` first. So the sanitize + hard-clip backstop is unconditional and identical whether the copy came from the model or the template. `categoryTag`, `accentColor`, and `hashtags` remain rule-based and untouched by `llmCopy`.

The template fallback branch is byte-for-byte the previous behavior: when `llmCopy` is null the fields resolve to `factPack.headline`, `factPack.keyFacts[0] || item.summary`, `factPack.figures[0] || names[0] || "Why it matters"`, `factPack.keyFacts[1] || ""`, and the `${headline}. ${keyFacts.slice(0,2)}…Source:` caption — so disabling the LLM (`COPY_LLM_ENABLED=false`) restores the old output exactly.

### Caption attribution gap

The user prompt instructs the model to end the caption with `Source: <srcLine><limitNote>` on its own line, but `EditorialCopySchema` only checks `caption` length and non-emptiness. A model that omits the attribution still validates and is returned on the `llm` path, so the LLM caption can ship without a source line even though the deterministic fallback always carries one. If attribution is a hard requirement rather than a nicety, enforce it (a `.refine` checking for a `Source:` trailer, or append the attribution after validation). Flagged as likely because it is a prompt-vs-schema asymmetry, not a traced production failure.

### Test coverage

`tests/ras/copywriter.test.ts` drives the module fully offline (Exa disabled in every case, model injected) and covers the paths that matter: valid output → `llm`; invalid-then-valid → retry once, two calls, `llm`; invalid-after-retry → two calls, `fallback`, null copy; model throws → `fallback`, never throws; over-length `serifHeadline` → rejected both attempts → `fallback`; `llmEnabled=false` → zero model calls, `fallback`. I ran this file as a spot-check and all six pass.

Not tested: the Exa enrichment branch itself (snippet assembly, URL de-dup, fail-open on thrown search error) has no unit test — `enrich` is only exercised indirectly with Exa disabled. The source-URL merge/de-dup in `buildRasPayload` is likewise not directly asserted. Neither is a blocker given the fail-open design, but the enrichment path carries the grounding guarantee and would benefit from a stubbed-`searchExa` test.

### Bundled unrelated changes

Two changes in this commit are outside the copywriter feature. `collectRankSelect` gains a `persistRankLog` option (defaulting on, decoupled from `persist`) so dry runs still write the `rank_runs` observability log; the two demos pass `persistRankLog: false`. Separately, `rasRenderTest.ts` now normalizes both `/ras-assets/` and `/ras-publish/` URLs and maps `.jpg`→`.png` when locating the rendered PNG. Both look reasonable in isolation, but they are ranker/observability and render-test concerns, not copy. Worth splitting or noting in the PR description so the review scope is clear.

### Registration

No new agent/tool/workflow/scorer was introduced — the copywriter is a library function reusing the already-registered `rankScoringAgent` through the same `.generate(...)` call shape the ranker uses, so `src/mastra/index.ts` needed no change. This matches the contract's "register if needed" caveat.

</details>

<details>
<summary>File map</summary>

- `src/mastra/lib/ras/copywriter.ts` — new: Exa enrich → LLM write (retry once) → fallback; Zod schema with the five max lengths.
- `src/mastra/config/copy.config.ts` — new: `COPY_*` env config via `envNum`/`envBool`.
- `src/mastra/lib/ras/payload.ts` — `buildRasPayload` takes `llmCopy`/`extraSourceUrls`; overrides the five fields when present, keeps safeLatin+clip backstop and rule-based category/accent/hashtags; merges enrichment URLs into `sourceUrls`.
- `src/mastra/lib/workflow/autoNewsToRas.ts` — `prepareForHandoff` calls `writeEditorialCopy` and feeds the result to `buildRasPayload`; also adds the unrelated `persistRankLog` option.
- `src/mastra/demo/offlineCopyStub.ts` — new: offline `CopyGenerate` + Exa-off config for the heuristic demos.
- `src/mastra/demo/autoNewsDryRun.ts`, `src/mastra/demo/rasRenderTest.ts` — wire the offline copy stub; render test adds publish-path PNG normalization.
- `tests/ras/copywriter.test.ts` — new: six offline cases over the write/retry/fallback paths.
- `.env.example` — new `COPY_*` block with comments.
- `package.json` — add the copywriter test to the `test` script.

Full diff: `git diff origin/main`.

</details>
