# Implementation Plan — RAS Poster Story template integration

Task: finish and wire the new "poster-style" ONE-STORY Instagram template
(`RasPosterStoryTemplate`) into the Mastra + Satori in-process render pipeline.
Template id: **`ras-poster-story`** (kebab-case). Canvas 1080x1350 (4:5), format `single`.

## Key architecture finding (read before touching enums)

There are TWO separate render paths in this repo:

1. **External Design Agent (Python REST, port 8000)** — reached via
   `submitDesignJob()` in `src/mastra/lib/design-agent-client.ts`. Its
   `template_id` union (`tech-announcement | keilhq-editorial | keilhq-text |
   entrepreneur-post | 360labs-news | news-brief`) is repeated in
   `tools/design-tools.ts`, `tools/instagram-tools.ts`, `tools/x-tools.ts`,
   `workflows/newsToPostWorkflow.ts`, `workflows/newsToXWorkflow.ts`,
   `agents/aggregatorAgent.ts` (prose). These ids name templates that live in
   the EXTERNAL service. **Do NOT add `ras-poster-story` here** — the Python
   agent cannot render it and the string would 500/garbage-render.

2. **In-process Satori renderer** — `renderComponentToPng(component, RAS_CANVAS)`
   in `src/mastra/renderer/satori-renderer.ts`. This is the ONLY path that
   renders the React templates in `src/mastra/templates/` (`RasStoryTemplate`,
   `RasCarouselTemplate`, and the new `RasPosterStoryTemplate`). Call sites:
   - `src/mastra/tools/ras-render-tools.ts` (Mastra `createTool` wrappers:
     `renderRasStoryTool`, `renderRasCarouselTool`).
   - `src/mastra/lib/ras/handoff.ts` → `renderRasPost(payload)` (the auto
     pipeline; hardcodes `RasStoryTemplate` today — NO template_id dispatch).

The poster template belongs ENTIRELY to path 2. "Wiring" here means: register
the Anton font cwd-safely, resolve the sharp type gap so the already-present
`Postertools.ts` typechecks, make the logo resolve through the real asset
convention, expose a Mastra tool that calls `preparePosterStory` +
`renderComponentToPng`, register it in `src/mastra/index.ts`, and prove render
with a one-shot demo. The external-agent `template_id` enums are intentionally
left unchanged (documented as a deliberate non-change).

## Verified facts from exploration

- `tsconfig.json`: ES2022, `moduleResolution: "bundler"`, `strict`, `jsx:
  react-jsx`, `types: ["node"]`. Relative TS imports use `.js` specifiers.
- Build/test commands: `npm run typecheck` (`tsc --noEmit`), `npm run
  ras:render:test` (`src/mastra/demo/rasRenderTest.ts`). Never run `mastra
  dev`/`mastra build` or `npm run dev` (long-lived).
- **Baseline typecheck is already RED: exactly 6 errors, all TS7016 "Could not
  find a declaration file for module 'sharp'"** in `demo/rasRenderTest.ts`,
  `lib/image/validate.ts` (x2), `lib/ras/jpeg.ts`, `renderer/images.ts`,
  `tools/Postertools.ts`. Root cause: sharp 0.35.5's `exports` map points the
  ESM `import` types at `dist/index.d.mts`, **which does not exist in the
  installed build** (only `dist/index.d.cts`). `@imgly/background-removal-node`
  DOES ship its own types (`removeBackground(image: ImageSource, config?:
  Config): Promise<Blob>`) — no error there.
- `src/mastra/templates/RasPosterStoryTemplate.tsx` already exists and is
  correct (imports `RAS_THEME` from `./theme.js`, `DISPLAY_FONT = "Anton"`,
  weight 400, text wordmark fallback when `logoBase64` omitted).
- `src/mastra/tools/Postertools.ts` already exists and is correct (imports
  `checkPosterCopy` + `type RasPosterStoryProps`, `sharp`, `removeBackground`,
  `node:fs/promises`; exports `makeHeroCutout`, `loadLogoAsset`,
  `preparePosterStory`). Only blocker is the shared sharp type gap.
- `theme.ts` exports `RAS_THEME` with `colors.paper/ink/inkMuted/vermilion/
  white` and `fonts.sans/mono` — confirmed. Anton is NOT a theme token (correct).
- Fonts: loaded in `src/mastra/renderer/fonts.ts` via `readFileSync(join(
  getFontsDir(), spec.file))` from a `FONT_SPECS` array. `FontConfig.data` is
  `Buffer`; `readFileSync` returns `Buffer` — no ArrayBuffer conversion. Anton
  is intentionally commented out (previously crashed `mastra dev` via a
  cwd-relative top-level read). `getFontsDir()` → `src/mastra/assets/fonts`
  (resolved via module URL, cwd-safe). Existing files: `Inter-Regular.woff`,
  `Inter-Bold.woff`, `Inter-ExtraBold.woff`, `InstrumentSerif-Regular.woff`,
  `IBMPlexMono-Regular.woff`.
- Anton woff present at
  `node_modules/@fontsource/anton/files/anton-latin-400-normal.woff`.
- Logo: `src/mastra/assets/RAS-by-keilhq/` contains only `ras-logo-dark.svg`
  and `ras-logo-light.svg` (NO `ras-logo-black.png`). Existing templates call
  `logoPath("ras-logo-dark.svg")` + `loadLocalLogo` (SVG supported). Asset
  resolution convention: `renderer/assets.ts` `getLogosDir()` / `logoPath()`.
- `RAS_CANVAS = { width: 1080, height: 1350 }` in `satori-renderer.ts`.
- `createTool` signature (from `tools/ras-render-tools.ts`, installed
  `@mastra/core` 1.67.0): `createTool({ id, description, inputSchema (zod),
  outputSchema (zod), execute: async (inputData) => {...} })`. NOTE the
  execute arg in this repo's tools is the input object directly (e.g.
  `renderRasStoryTool`'s `execute: async (inputData) => {...}`). Verify against
  the embedded docs in `node_modules/@mastra/core/dist/docs/` before writing.
- No stale `ras-poster-story.ts`/`RasStoryTemplate-2.tsx` exists. Nothing to
  delete. Do NOT touch `RasStoryTemplate.tsx`.
- `.env`-file flag: the render demo script is run via `npx -y tsx
  --env-file=.env`. The repo scripts already do this.

## Decisions (made here, not deferred)

- **Anton registration = Option A** (copy the woff into
  `src/mastra/assets/fonts/Anton-Regular.woff` and add it to `FONT_SPECS`).
  Rationale: it reuses the existing cwd-safe `getFontsDir()+readFileSync`
  loader exactly, keeps all font loading in one place, and cannot reintroduce
  the cwd-relative top-level read that crashed the dev server. Option B
  (`createRequire(...).resolve`) is viable but adds a second font-loading
  mechanism for no benefit.
- **sharp fix = local ambient re-export shim**
  `src/mastra/types/sharp.d.ts` that re-exports `sharp/dist/index.d.cts` under
  the bare `"sharp"` specifier, exposing the default export AND named type
  members (`Metadata`, `Sharp`, `OutputInfo`, `SharpOptions`, `ResizeOptions`).
  **This exact shim was tested during planning and takes the repo from 6
  TS7016 errors to 0.** Rationale: `@types/sharp` is deprecated for sharp>=0.32
  (types are bundled) and installing it risks version drift; a bare `declare
  module "sharp";` would make sharp `any` everywhere (worse than today for the
  5 other files). The shim restores real sharp types repo-wide. The `types`
  dir is auto-included by `tsconfig` `"include": ["src/**/*"]`.
- **Logo = resolve through `logoPath()`, prefer existing dark SVG, degrade
  gracefully.** `loadLogoAsset` currently takes a literal path and reads it as
  a raster PNG via sharp. For wiring, the render dispatch should resolve the
  logo via `logoPath(...)` and tolerate absence (the template already falls
  back to a text wordmark when `logoBase64` is omitted). Do NOT hardcode
  `src/mastra/lib/public/ras-logo-black.png`. The user still needs to drop a
  real black transparent PNG for the final look, but render must not depend on
  it. (Note: `loadLogoAsset` uses `sharp(buf).metadata()` and expects a
  raster; it will throw on an SVG. So the dispatch must NOT feed the SVG to
  `loadLogoAsset` — either skip the logo, or only call `loadLogoAsset` when a
  real raster PNG exists at the resolved path.)
- **Mastra tool = add `renderRasPosterStoryTool`** in `ras-render-tools.ts`
  (alongside the existing story/carousel tools, same output shape and
  output-dir/view-url plumbing), register it in `src/mastra/index.ts`. This is
  the safe, in-process exposure of `preparePosterStory` + the poster template.
  Do NOT wire the poster into the external-Design-Agent tools or the auto
  pipeline's `renderRasPost` in this task (that is a larger product change;
  record as follow-up).

## Steps

- [ ] 1. Add the sharp type shim so the repo typechecks clean.
      Create `src/mastra/types/sharp.d.ts` declaring `module "sharp"` that
      re-exports `sharp/dist/index.d.cts` (default export + named type aliases
      `Sharp`, `Metadata`, `OutputInfo`, `SharpOptions`, `ResizeOptions` via
      `export import`). Exact content was validated during planning (6→0
      errors). Add a short comment explaining the missing-`.d.mts` root cause.
      Files: `src/mastra/types/sharp.d.ts` (new)
      Verify: `npm run typecheck` → 0 errors (down from the 6 baseline TS7016).

- [ ] 2. Register the Anton font cwd-safely (Option A).
      Copy `node_modules/@fontsource/anton/files/anton-latin-400-normal.woff`
      to `src/mastra/assets/fonts/Anton-Regular.woff`. Add
      `{ file: "Anton-Regular.woff", name: "Anton", weight: 400 }` to
      `FONT_SPECS` in `src/mastra/renderer/fonts.ts` (remove the disabled-Anton
      comment). Family MUST be exactly `"Anton"`, weight 400, style "normal".
      Do not add any module-top-level cwd-relative font read. Update
      `src/mastra/assets/fonts/README.md` with the Anton row.
      Files: `src/mastra/assets/fonts/Anton-Regular.woff` (new, copied),
      `src/mastra/renderer/fonts.ts`, `src/mastra/assets/fonts/README.md`
      Verify: `npm run typecheck` still 0 errors; a one-shot `tsx` snippet that
      calls `loadFonts()` returns an entry with `name === "Anton" && weight ===
      400` and does not throw. (Folded into the demo in step 5.)

- [ ] 3. Make the logo resolution asset-convention based and absence-tolerant.
      In `src/mastra/tools/Postertools.ts`, keep `loadLogoAsset(filePath)` as
      is (it reads a raster PNG), but ensure the RENDER DISPATCH (step 4)
      resolves the logo via `logoPath(...)` from `renderer/assets.ts` and only
      calls `loadLogoAsset` when a raster PNG actually exists at that path;
      otherwise omit `logoBase64`/`logoWidth`/`logoHeight` so the template uses
      its text wordmark fallback. Do not reference `src/mastra/lib/public/...`.
      Files: `src/mastra/tools/Postertools.ts` (only if a helper is added; the
      resolution logic lives in step 4's dispatch)
      Verify: covered by step 4 typecheck + step 5 render (render must succeed
      with NO logo present).

- [ ] 4. Add the in-process Mastra render tool for the poster template.
      In `src/mastra/tools/ras-render-tools.ts` add `renderRasPosterStoryTool`
      via `createTool` (match the existing `renderRasStoryTool` shape: `id:
      "render-ras-poster-story"`, zod `inputSchema` with `slug`, `heroImage`
      (url/path/dataURI), `headlineTop`, `headlineMid`, `headlineHighlight`,
      optional `categoryTag`, optional `accentColor` (reuse `AccentEnum`),
      optional `showMarkers`; same `RenderedAssetSchema` output). In `execute`:
      call `preparePosterStory({ heroSource, headlineTop, headlineMid,
      headlineHighlight, categoryTag, accentColor }, brand)` from
      `Postertools.js`, where `brand` is built by resolving `logoPath(...)` and
      calling `loadLogoAsset` ONLY when a raster PNG exists (else pass a
      brand with empty/omitted logo — build props directly from
      `preparePosterStory` output, which already omits logo fields when the
      template prop is undefined). If `!ready`, still render but surface
      `problems` in the result (or return success:false with problems — pick
      success:true + a `warnings` field to match the non-throwing tool
      convention). Render `<RasPosterStoryTemplate {...props}/>` via
      `React.createElement` + `renderComponentToPng(component, RAS_CANVAS)`,
      write `01.png` under `ensureRasOutputDir(sanitizeSlug(slug))`, return the
      asset with `rasViewUrl`. Use `.js` import specifiers.
      Files: `src/mastra/tools/ras-render-tools.ts`
      Verify: `npm run typecheck` → 0 errors.

- [ ] 5. Register the tool and prove render with a one-shot demo.
      Register `renderRasPosterStoryTool` in `src/mastra/index.ts` (import from
      `./tools/ras-render-tools` and add to the `tools: {...}` map). Add
      `src/mastra/demo/rasPosterRenderTest.ts` that: generates a synthetic
      in-memory transparent PNG hero with sharp (e.g. a filled shape on a
      transparent 800x800 canvas), calls `preparePosterStory` (or
      `makeHeroCutout` directly to skip model cost — but `preparePosterStory`
      exercises more) with three short headline lines, OMITS the logo (text
      wordmark fallback), renders via `renderComponentToPng(<RasPosterStory
      Template {...props}/>, RAS_CANVAS)`, asserts the output Buffer is
      non-empty and starts with the PNG signature bytes `89 50 4E 47`, and
      asserts `loadFonts().some(f => f.name === "Anton" && f.weight === 400)`.
      Add an npm script `"ras:poster:test": "npx -y tsx --env-file=.env
      src/mastra/demo/rasPosterRenderTest.ts"` to `package.json`.
      Files: `src/mastra/index.ts`, `src/mastra/demo/rasPosterRenderTest.ts`
      (new), `package.json`
      Verify: `npm run typecheck` → 0 errors; `npm run ras:poster:test` exits 0
      and prints the PNG dimensions/signature + Anton-present assertion.
      NOTE: `makeHeroCutout` on a synthetic transparent PNG takes the
      `alreadyCutout` branch and skips the ~140MB background-removal model, so
      the demo stays fast and offline.

- [ ] 6. Document the deliberate non-changes and follow-ups.
      Add a short comment near the external-agent `TemplateIdSchema`/enums (at
      least in `tools/design-tools.ts`) noting that `ras-poster-story` is an
      IN-PROCESS Satori template rendered via `renderRasPosterStoryTool` and is
      intentionally NOT part of the external Design Agent template union.
      Record follow-ups NOT done here: (a) wiring the poster into the auto
      pipeline (`lib/ras/handoff.ts` `renderRasPost` template dispatch +
      `RasPayload` 3-line headline fields), (b) a heuristic/LLM route in
      `lib/template-router.ts`, (c) dropping the real `ras-logo-black.png`
      binary into `src/mastra/assets/RAS-by-keilhq/`.
      Files: `src/mastra/tools/design-tools.ts` (comment only)
      Verify: `npm run typecheck` → 0 errors.

## 3-line headline note

The poster template takes three discrete props (`headlineTop`, `headlineMid`,
`headlineHighlight`) + optional `categoryTag`, length-guarded by
`checkPosterCopy`/`POSTER_LIMITS`. The in-process Mastra tool (step 4) accepts
the three lines directly from the caller — no formatter change is needed for
this task. The auto-pipeline formatter (`formatStoryForTemplate` /
`buildRasPayload`) produces single-field editorial copy for the EXTERNAL and
`RasStoryTemplate` paths; splitting that into three poster lines is part of the
deferred auto-pipeline follow-up (6a), not this integration.

## Final verification (whole task)

1. `npm install` (idempotent; packages already in `package.json`).
2. `npm run typecheck` → **0 errors** (baseline had 6; the shim removes them).
3. `npm run ras:poster:test` → exits 0, prints a valid 1080x1350 PNG with the
   PNG signature and confirms Anton weight-400 is loaded, with no logo binary
   present (text wordmark fallback) and no cwd-relative top-level font read.
4. `npm run ras:render:test` still runs (existing RAS story path unbroken).
