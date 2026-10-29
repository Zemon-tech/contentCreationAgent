# Implementation Plan — Post to X inside `autoNewsToRasWorkflow`

Wire X (Twitter) posting into the existing "auto news to RAS" flow so a single run posts the
SAME rendered graphic to BOTH Instagram and X. The only content difference is the X caption:
a standalone, punchy tweet `<= 280` chars generated to X criteria (NOT a truncation of the IG
caption). The standalone `newsToXWorkflow.ts` is the reference and MUST NOT be modified.

All paths are relative to the worktree:
`c:\Users\sanav\OneDrive\Documents\GitHub\contentCreationAgent\.worktrees\x-posting`

## Design decisions (made here, grounded in the code read)

1. Independence / ledger authority (AMBIGUITY 1 — resolved).
   Instagram stays ledger-authoritative exactly as today: `runHandoff` writes `pending` before
   the IG publish and records `posted`/`dry_run`/`failed` based ONLY on the IG outcome. X is an
   ADDITIONAL, fail-soft side effect attached to the result as `x: { attempted, success, ... }`.
   - X is attempted only on the live + approved publish path (the same branch that calls the IG
     `publish` dep), AFTER the IG attempt, using the SAME rendered PNG (`rendered.filePath`).
   - A X failure or missing-session NEVER flips a successful IG `posted` to `failed`, and NEVER
     writes to or corrupts the posted ledger (X outcome is not recorded in the ledger at all).
   - Conversely an IG failure does not block X being reported — but because X runs on the IG
     publish branch, if the run never reaches that branch (dry-run, not approved, preflight
     skip, already-posted), X is NOT attempted. Documented explicitly: when IG is SKIPPED for a
     config/ledger reason the whole publish branch is skipped, so X is skipped too; this keeps
     the existing never-double-post + ledger tests untouched. `publishToX` is called with the
     handoff `dryRun` so the IG env dry-run decline path (`published:false`) still attempts X in
     dry-run mode via `publishToX({... dryRun:true})` (X's own dry-run, posts nothing).

2. Env toggle (AMBIGUITY 2 — resolved).
   Add `X_POST_ENABLED` (default **true** = enabled-when-session-available) and reuse the global
   handoff `dryRun` (driven by `INSTAGRAM_DRY_RUN`) as X's dry-run — no separate `X_DRY_RUN`, so
   X obeys the same single safety switch as IG and cannot post live while IG is in dry-run.
   `X_POST_ENABLED=false` disables the X attempt entirely (IG unchanged). A missing/not-logged-in
   X session does NOT fail the run: `xPublishReady()` returns not-ready and X is skipped with a
   clear reason, IG proceeds normally.

## Ordered implementation items

- [ ] 1. Add the X caption to the editorial copy schema + prompts.
      In `EditorialCopySchema` add `xCaption: z.string().max(280).optional()` (OPTIONAL so an
      invalid/missing value never fails validation and lose the good IG caption). Extend
      `COPY_SYSTEM_PROMPT` + the JSON key list in `COPY_SYSTEM_PROMPT` and `buildUserPrompt` to
      request `xCaption`: a single standalone tweet, hook in the first line, punchy, `<= 280`
      chars, 0-2 topical hashtags max, include the source URL only if it still fits under 280,
      SAME strict grounding/fidelity rules as the IG caption, and explicitly NOT a truncated IG
      caption. Keep the retry/fallback behavior intact (if the whole object is invalid it still
      falls back to template; `xCaption` being absent must stay valid on the llm path).
      Files: src/mastra/lib/ras/copywriter.ts
      Verify: `npx -y tsx --test tests/ras/copywriter.test.ts` — existing tests still pass
      (validCopy without `xCaption` still takes the llm path).

- [ ] 2. Add `xCaption` to the RAS payload schema.
      In `RasPayloadSchema` add `xCaption: z.string().default("")` (defaulted so every existing
      payload — including the test fixtures in tests/ras/handoff.test.ts and payloadX.test.ts —
      validates unchanged).
      Files: src/mastra/schemas/handoff.ts
      Verify: `npx -y tsx --test tests/ras/payloadX.test.ts tests/ras/handoff.test.ts` — pass
      unchanged.

- [ ] 3. Build `xCaption` deterministically in `buildRasPayload` (`<= 280`, word-boundary-safe).
      Add a small local helper `clipTweet(text, 280)` (reuse `clipWords` from payload.ts for the
      word-boundary cut, no ellipsis) and set `xCaption` on the returned payload:
      prefer `llmCopy?.xCaption`; deterministic fallback = derived/base headline + ` ` +
      `attributionLine` (`per @handle on X`, when X-only) or the primary source
      (`factPack.primarySource ?? sourceUrls[0] ?? item.url`), all clipped word-safe to `<= 280`.
      Always `<= 280`. Pass it through `safeLatin` like the other copy fields.
      Files: src/mastra/lib/ras/payload.ts
      Verify: covered by the new payload test in item 8.

- [ ] 4. Add an async X readiness check (do NOT change `publishPreflight`).
      Add `export async function xPublishReady(check = checkXSession): Promise<{ ok: boolean;
      reason?: string; handle?: string | null }>` to preflight.ts (import `checkXSession` from
      `../x-publisher`). `ok` is true only when `check()` returns `loggedIn === true`; otherwise
      `ok:false` with a human reason (e.g. "X session not logged in"). Also gate on
      `X_POST_ENABLED` (default true): when disabled, return `ok:false, reason:"X_POST_ENABLED=false"`.
      Keep `publishPreflight()` pure and synchronous exactly as-is. The `check` arg is injectable
      so tests never shell out to Python/browser.
      Files: src/mastra/lib/ras/preflight.ts
      Verify: `npx -y tsx --test tests/ras/preflight.test.ts` — existing IG preflight tests
      unchanged; add a focused X-readiness test in item 9.

- [ ] 5. Extend `HandoffResult` to carry the X outcome.
      Add `x: z.object({ attempted: z.boolean(), success: z.boolean(), tweetUrl: z.string()
      .optional(), dryRun: z.boolean().optional(), error: z.string().optional() }).optional()`
      to `HandoffResultSchema`.
      Files: src/mastra/schemas/handoff.ts
      Verify: `npx run typecheck` (item 10) type-checks; result consumers updated in items 6-7.

- [ ] 6. Thread X publishing into `runHandoff` (fail-soft, IG stays authoritative).
      In handoff.ts:
      - Extend `HandoffDeps` with `xPublish: (a: { text: string; imagePath?: string; dryRun:
        boolean }) => Promise<XPublishResult>` and `xReady: () => Promise<{ ok: boolean; reason?:
        string }>`; default `xPublish` = a thin wrapper over `publishToX` (map
        `{text,imagePath,dryRun}` -> `publishToX`), default `xReady` = `xPublishReady` from
        preflight.ts. (Injectable so tests don't shell out.)
      - Change `deps.render`/the internal render so the handoff keeps the FULL render result
        (it already returns `filePath`); capture `rendered.filePath` (absolute PNG) to pass to X.
      - After the IG publish decision is finalized and recorded (both the `published:true`
        `posted` branch AND the `published:false` env-dry-run `dry_run` branch), attempt X in a
        try/catch that CANNOT throw out: first `await deps.xReady()`; if not ok set
        `x = { attempted:false, success:false, error:<reason> }`; else call
        `deps.xPublish({ text: payload.xCaption, imagePath: renderedFilePath, dryRun: args.dryRun })`
        and map `XPublishResult` -> `x = { attempted:true, success, tweetUrl, dryRun, error }`.
        `publishToX` never throws for post failures, but wrap anyway so a thrown
        `empty text`/unexpected error is swallowed into `x.error` and NEVER changes the IG status.
      - Attach `x` to the returned `HandoffResult` on the `posted` and env-dry-run `dry_run`
        branches only (the live+approved path). Do NOT attempt X on: the never-double-post skip,
        the pre-publish `dryRun` early return, the `not approved` skip, or render failure.
      - Guard an empty `payload.xCaption`: if blank, skip X with
        `x = { attempted:false, success:false, error:"no X caption" }` (publishToX throws on empty).
      Files: src/mastra/lib/ras/handoff.ts
      Verify: `npx -y tsx --test tests/ras/handoff.test.ts` plus the new handoff-X test (item 8)
      — all pass; existing IG ledger/double-post tests unchanged.

- [ ] 7. Surface the X caption in the approval preview and the X outcome in the workflow output.
      In autoNewsToRasWorkflow.ts:
      - Add `xCaption: z.string()` to `PreviewSchema` and populate it in `suspend({ preview })`
        from `prepared.payload.xCaption` (append char count in the string is optional/if easy).
      - Add `x: z.object({ attempted: z.boolean(), success: z.boolean(), tweetUrl:
        z.string().optional(), dryRun: z.boolean().optional(), error: z.string().optional()
        }).optional()` to `OutputSchema`, and pass `...(result.x ? { x: result.x } : {})` through
        the step return.
      - No change to the OutputSchema status enum (X never changes overall status — IG-authoritative).
      Files: src/mastra/workflows/autoNewsToRasWorkflow.ts
      Verify: `npm run typecheck` (item 10) and `npm run build` (item 11) succeed.

- [ ] 8. Add new payload + handoff X tests and register them.
      Create `tests/ras/payloadXcaption.test.ts`: assert `buildRasPayload` produces `xCaption`
      `<= 280` in (a) the LLM-copy path (`llmCopy.xCaption` present and honored), (b) the
      deterministic fallback path (no `llmCopy.xCaption`), and (c) an X-only story includes the
      `per @handle on X` attribution within the 280 budget. Validate the payload against
      `RasPayloadSchema`.
      Create `tests/ras/handoffX.test.ts`: using injected `xPublish`/`xReady`/`render` fakes
      (mirroring the existing `fakeDeps` pattern in handoff.test.ts), assert: live+approved calls
      `xPublish` ONCE with `text === payload.xCaption` and `imagePath === rendered.filePath`;
      X is NOT called in dry-run (`dryRun:true`) or not-approved; a X failure
      (`xPublish` returns `success:false` OR throws) leaves IG `status === "posted"`; and
      `xReady` returning `ok:false` yields `x.attempted === false` with IG still `posted`.
      Add both files to the explicit list in the `test` script in package.json.
      Files: tests/ras/payloadXcaption.test.ts, tests/ras/handoffX.test.ts, package.json
      Verify: `npx -y tsx --test tests/ras/payloadXcaption.test.ts tests/ras/handoffX.test.ts`
      — all new tests pass.

- [ ] 9. Add a focused `xPublishReady` test.
      In `tests/ras/preflight.test.ts` add cases using an injected `check` stub: logged-in ->
      `ok:true`; not-logged-in -> `ok:false` with a reason; and `X_POST_ENABLED=false` ->
      `ok:false` (stub/restore `process.env.X_POST_ENABLED`). No Python/browser is spawned.
      Files: tests/ras/preflight.test.ts
      Verify: `npx -y tsx --test tests/ras/preflight.test.ts` — all pass.

- [ ] 10. Keep the offline dry-run demos green (wire mock X only on `--mock-x`).
      Read src/mastra/demo/autoNewsDryRun.ts: it already runs `runHandoff(... dryRun:true,
      approved:false ...)`, so X is NOT attempted there (correct — X only runs on live+approved).
      Confirm it still compiles/runs with the new payload field. OPTIONAL low-risk: on the
      `--mock-x` path, print `prepared.payload.xCaption` in the payload dump so the demo shows the
      generated tweet; do NOT inject a live X publish into the dry-run (keeps it offline).
      Files: src/mastra/demo/autoNewsDryRun.ts (print-only, optional)
      Verify: `npm run auto:dry` and `npm run auto:dry:mockx` both complete without error.

- [ ] 11. Document the new env switch (no secret values printed).
      In `.env.example`, under the "Auto news -> RAS pipeline" block (next to `INSTAGRAM_DRY_RUN`
      / `REQUIRE_APPROVAL`), add `X_POST_ENABLED=true` with a comment: X posts the same graphic
      alongside Instagram on the live+approved path; obeys the same `INSTAGRAM_DRY_RUN` safety
      switch; needs a logged-in tweetytweets session (`PYTHON_PATH` optional). Add a short note
      to the top-of-file comment in handoff.ts describing the X side effect + independence rule.
      Do NOT echo any secret values.
      Files: .env.example, src/mastra/lib/ras/handoff.ts (comment)
      Verify: `npm run typecheck` still clean (docs/comment only).

- [ ] 12. Full verification gate.
      Run the whole suite and build after all edits.
      Files: (none — verification only)
      Verify (all must pass, zero NEW errors):
      - `npm run typecheck`
      - `npm run build`
      - `npm test`  (existing + the 2 new files registered in item 8)
      - `npm run auto:dry` and `npm run auto:dry:mockx` complete.

## Notes / assumptions

- Assume the real X limit is 280 (not Premium longer limits), per the task. `checkXSession()`
  reports `maxChars` but we clip to 280 deterministically regardless.
- The same rendered PNG (`rendered.filePath`) is shared; no second render for X. IG publishes the
  JPEG via public URL as today; X attaches the local PNG file path directly (publishToX resolves
  and uploads it via the Playwright/CDP automation).
- `newsToXWorkflow.ts` is the reference for the 280-char drafting approach and is NOT modified.
- Register nothing new in `src/mastra/index.ts` — no new agent/tool/workflow is added; the change
  is internal to the existing `autoNewsToRasWorkflow` and its libs.

## Verification note (first iteration — implemented + run in the worktree)

All commands run in `.worktrees/x-posting` on branch `feat/x-posting`:

- `npm run typecheck` (tsc --noEmit) — PASS (exit 0, zero errors).
- `npm run build` (mastra build) — PASS ("Build successful"). The only warning is a
  PRE-EXISTING circular dep in rankStories <-> score, unrelated to this change.
- `npm test` — PASS, 158/158 (existing suite + the 2 new files
  tests/ras/payloadXcaption.test.ts and tests/ras/handoffX.test.ts).
- `npm run auto:dry` — PASS (offline). Payload dump shows a deterministic
  xCaption "…IPV https://entrackr.com/… (183/280)", confirming the <=280 fallback.
- `npm run auto:dry:mockx` — PASS (offline, mock X-signal merge).

A gitignored placeholder `.env` (no secrets) was added to the worktree so the
`--env-file=.env` demo scripts resolve; it is NOT committed.

## Verification note (second iteration — review findings fixed + run in the worktree)

Addressed all 5 review.json findings (4 blocking + 1 non-blocking):

1. (blocking) Instagram dry-run can post live to X — handoff.ts now forces X into
   its OWN dry-run on the IG env-decline (`!res.published`) branch: `attemptX(..., true)`
   instead of `args.dryRun`. X can no longer post live while IG published nothing.
2. (blocking) Over-length optional xCaption discarded valid IG copy — EditorialCopySchema's
   `xCaption` is now `z.string().optional()` (dropped `.max(280)`); a present over-280 value
   no longer fails the whole parse, so the good IG fields survive. clipTweet still guarantees
   <=280 downstream.
3. (blocking) Hashtag 0-2 cap was prompt-only — buildRasPayload now runs `capHashtags()` on the
   LLM xCaption (keeps the first two hashtags, strips extras) before clipping. Tested on the
   final payload.
4. (blocking) Deterministic clipper could split words/URLs — the deterministic fallback now uses
   `buildTweetWithSuffix()`: the source/attribution is an ATOMIC suffix appended only when the
   whole string fits <=280 (dropped whole otherwise), and `clipTweetBody()` never emits a partial
   URL. Added tests for the long-URL-dropped and URL-kept-whole cases.
5. (non-blocking) Test encoded the wrong dry-run value — handoffX.test.ts now asserts
   `xArgs.dryRun === true` on the IG env-decline branch (X cannot post live there).

Added tests: copywriter.test.ts (over-length xCaption keeps IG copy), payloadXcaption.test.ts
(hashtag cap, URL-dropped, URL-kept-whole). All run in `.worktrees/x-posting` on `feat/x-posting`:

- `npm run typecheck` (tsc --noEmit) — PASS (exit 0, zero errors).
- `npm run build` (mastra build) — PASS ("Build successful"). Only the PRE-EXISTING
  rankStories<->score circular-dep warning, unrelated to this change.
- `npm test` — PASS, 162/162 (158 prior + 4 new regression tests for the findings).
- `npm run auto:dry` — PASS (offline). xCaption dump: whole source URL kept, "(183/280)".
- `npm run auto:dry:mockx` — PASS (offline).

## Verification note (fourth iteration — review.json findings fixed + run in the worktree)

Fixed both BLOCKING review.json findings plus both NON-BLOCKING ones. Changed
src/mastra/lib/ras/payload.ts, src/mastra/schemas/handoff.ts,
src/mastra/workflows/autoNewsToRasWorkflow.ts, tests/ras/payloadXcaption.test.ts:

1. (blocking) Deterministic caption bypassed the 2-hashtag cap — introduced a single
   `buildXCaption(modelCaption, headline, suffix, 280)` helper that applies `capHashtags`
   to the FINAL caption for BOTH the model and deterministic paths (previously only the
   model path ran capHashtags via clipTweet). capHashtags shields URLs, so atomic source
   URLs are preserved; capping only shrinks, so the <=280 guarantee holds. New regression
   `deterministic fallback headline with >2 hashtags is capped to two`.
2. (blocking) A model caption that normalizes to EMPTY (whitespace-only, or a single
   unbreakable overlong token) previously skipped X instead of falling back. `buildXCaption`
   now normalizes the model value FIRST (clipTweet) and, only when that result is empty,
   falls back to the deterministic `buildTweetWithSuffix(headline, source)`. New regressions
   `whitespace-only model caption falls back to deterministic headline copy` and
   `unbreakable-token model caption falls back to deterministic headline copy` (both require
   non-empty deterministic copy). The pre-existing single-token tests still pass (when a
   usable headline+source exist the value is now the deterministic fallback, which still
   excludes the bad token; the no-usable-data case stays empty by design).
3. (non-blocking) No schema-level 280 cap — `RasPayloadSchema.xCaption` is now
   `z.string().max(280).default("")` as defense in depth; buildRasPayload already guarantees
   <=280 so the producer is unaffected.
4. (non-blocking) Preview "(0/280)" on an empty caption — the approval preview now shows
   "(no X caption — X post will be skipped)" when xCaption is empty instead of "(0/280)".

All run in `.worktrees/x-posting` on `feat/x-posting`:

- `npm run typecheck` (tsc --noEmit) — PASS (exit 0, zero errors).
- `npm run build` (mastra build) — PASS ("Build successful"). Only the PRE-EXISTING
  rankStories<->score circular-dep warning, unrelated to this change.
- `npm test` — PASS, 172/172 (169 prior + 3 new regression tests for the 2 blocking findings).
- `npm run auto:dry` — PASS (offline). xCaption dump: whole source URL kept, "(183/280)".
- `npm run auto:dry:mockx` — PASS (offline).

## Verification note (third iteration — review.json findings fixed + run in the worktree)

Fixed all 3 blocking reviewer-B findings (reviewer A was APPROVED; its 2 items were non-blocking,
no action). Only 2 source files + 2 test files changed:

1. (blocking) Malformed/non-string xCaption discarded valid IG copy — `EditorialCopySchema.xCaption`
   is now `z.string().optional().catch(undefined)` (copywriter.ts). A model response with
   `xCaption: null` or a number no longer fails the whole-object parse; the bad field collapses to
   `undefined` (recovered independently) so serifHeadline/deck/caption survive and the deterministic
   X fallback kicks in. New regressions in copywriter.test.ts: `xCaption: null` and `xCaption: 42`
   both stay on the `llm` path with IG copy intact.
2. (blocking) Punctuation bypassed the hashtag cap — `capHashtags` (payload.ts) now shields URLs
   first (so a `#fragment` inside a URL is never a hashtag), then matches X-recognized tags via
   `(^|[^\w#])#...` so tags after `(`, `/`, etc. are counted and capped. Regressions added:
   `News (#ai) #ml #tech`, `#ai/#ml/#tech`, and a URL-fragment case — all cap to exactly 2 tags.
3. (blocking) Single overlength token hard-cut mid-word — `clipTweetBody` (payload.ts) now DROPS an
   unbreakable single token (no internal whitespace up to `max`) to an empty string instead of
   publishing a mid-word / partial-URL fragment; the handoff then cleanly skips X with "no X
   caption". Regressions added: a 300-char single-token LLM caption and a 320-char single-token
   deterministic headline — neither leaks a fragment.

All run in `.worktrees/x-posting` on `feat/x-posting`:

- `npm run typecheck` (tsc --noEmit) — PASS (exit 0, zero errors).
- `npm run build` (mastra build) — PASS ("Build successful"). Only the PRE-EXISTING
  rankStories<->score circular-dep warning, unrelated to this change.
- `npm test` — PASS, 169/169 (162 prior + 7 new regression tests for the 3 findings).
- `npm run auto:dry` — PASS (offline). xCaption dump: whole source URL kept, "(183/280)".
- `npm run auto:dry:mockx` — PASS (offline).
