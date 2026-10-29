# Post the same graphic to X alongside Instagram with an X-native 280-char caption

This pass reviews the state after the fourth fix iteration (HEAD `d180115`), which closed the two blocking and two non-blocking findings from the prior round: the deterministic caption path now runs the two-hashtag cap, a model caption that normalizes to empty falls back to the deterministic headline copy, `RasPayloadSchema.xCaption` carries a `.max(280)` as defense in depth, and the approval preview no longer shows "(0/280)" for an empty caption. The X post remains an additional, fail-soft side effect of `runHandoff`: Instagram stays ledger-authoritative, and an X failure, missing session, or empty caption never flips a successful IG post to failed and never touches the posted ledger.

Watch for: nothing blocking. One confirmed cosmetic leftover — the offline demo dump still formats the X caption as `(length/280)` without the empty-caption guard the approval preview received, so a tweet-less story prints "(0/280)" in the debug dump only.

**Verdict**: APPROVED

## High-level view

The two prior blocking findings are closed at the source. `buildXCaption` is now the single entry point for both caption paths: it normalizes the model value first (hashtags capped, word-safe clip), falls back to the deterministic headline+source tweet only when that normalized value is empty, then runs a final hashtag cap over whichever caption won. That final pass is what brings the deterministic path under the two-hashtag limit, and the normalize-first ordering is what lets a whitespace-only or unbreakable-token model value yield real headline copy instead of skipping X. New regression tests pin both.

The independence contract holds exactly as the plan requires. X is attempted only on the two live+approved publish branches (IG `posted`, and IG env-dry-run `published:false`); it is skipped on the never-double-post skip, the pre-publish dry-run return, the not-approved skip, and render failure. On the env-dry-run branch X is forced into its own dry-run so it can never post live while Instagram published nothing. `attemptX` cannot throw out and never writes the ledger.

The 280 guarantee is enforced in `buildXCaption` (final `clipTweetBody`) and now also asserted at the schema boundary. Both captions are headline-derived, never a cut of the 2000-char IG caption. The same rendered PNG (`rendered.filePath`) threads to X while IG publishes the JPEG `publishPaths`; the workflow renders once and injects the result, so nothing renders twice.

Gracefulness is layered: `EditorialCopySchema.xCaption` is `z.string().optional().catch(undefined)`, so a null/numeric/over-length model value collapses to `undefined` and the good IG copy survives. `xPublishReady` gates on `X_POST_ENABLED` (default enabled) and a logged-in session, swallowing a thrown check into `ok:false`. The injectable `xPublish`/`xReady`/`check` deps keep tests off Python. `X_POST_ENABLED` is documented in `.env.example` with no secrets, and both new test files are registered in the `test` script.

<details>
<summary>Issues (1)</summary>

1. **Demo dump shows "(0/280)" for an empty caption** — confirmed, non-blocking, cosmetic. `src/mastra/demo/autoNewsDryRun.ts` formats `xCaption` as `${xCaption} (${length}/280)` without the empty-caption guard the approval preview got; an empty deterministic caption prints "(0/280)" in the offline debug dump. Debug output only, not user-facing. Mirror the preview's `(no X caption — X post will be skipped)` string if consistency is wanted.

</details>

<details>
<summary>Details</summary>

### Both prior blocking findings closed in `buildXCaption`

The two prior-pass blocking findings both lived in caption construction, and both are now fixed by routing every path through one helper:

```
buildXCaption(modelCaption, headline, suffix, 280)
  fromModel = modelCaption ? clipTweet(modelCaption, 280) : ""   // capHashtags + clipTweetBody
  base      = fromModel || buildTweetWithSuffix(headline, suffix, 280)
  return clipTweetBody(capHashtags(base), 280)                   // FINAL cap applies to BOTH paths
```

The final `capHashtags(base)` is the fix for the deterministic-caption finding: `buildTweetWithSuffix` never capped hashtags, so a fallback headline like `"Launch #ai #ml #tech"` previously kept three tags; the final pass now reduces it to two. `payloadXcaption.test.ts` asserts `["#ai", "#ml"]` survive on the deterministic path.

The normalize-first ordering is the fix for the empty-caption finding: `fromModel` is computed before the fallback decision, so a whitespace-only value (collapses to empty in `safeLatin`) or a single unbreakable overlong token (dropped to `""` by `clipTweetBody`) yields `fromModel === ""` and the deterministic `buildTweetWithSuffix(headline, suffix)` takes over. The two regressions require non-empty headline-derived copy and assert the bad token does not leak in. `capHashtags` shields URLs before matching, so the atomic source URL in the deterministic suffix is never broken, and since capping only shrinks, the `<=280` guarantee from the builders survives the final pass.

### Independence and the ledger

`runHandoff` records the IG outcome to the ledger first, then calls `attemptX`, which returns an `XOutcome` and is wrapped so nothing it does propagates to the IG status:

```
IG publish decision recorded in ledger
        |
        +-- posted            -> attemptX(..., dryRun = args.dryRun = false)
        +-- published:false   -> attemptX(..., dryRun = TRUE)   <-- forced
        |
   (X result attached as result.x; ledger untouched; IG status unchanged)
```

On the `posted` branch `args.dryRun` is always false because a true handoff dry-run returns at the pre-publish early return, so X posts live there. On the env-dry-run branch X is forced to `true` so it cannot post live while IG published nothing. `attemptX` guards an empty caption first (`publishToX` throws on empty), checks readiness, then publishes, swallowing both a `success:false` return and any thrown error. `handoffX.test.ts` confirms a `success:false` return, a thrown error, and a not-ready readiness all leave IG `status === "posted"`, and that X is not called in handoff dry-run or not-approved.

### Same PNG to X, JPEG URLs to IG

`runHandoff` keeps the full render result and threads `rendered.filePath` (absolute PNG) to X while IG publishes via `forPublish(rendered) = publishPaths ?? viewUrls` (the JPEG siblings). The workflow renders once before the approval gate and injects `render: async () => rendered`, so one object feeds both channels. `handoffX.test.ts` asserts `xArgs.imagePath === rendered.filePath`.

### Readiness, schema recovery, and the env toggle

`xPublishReady` is async and separate from the synchronous `publishPreflight`. It returns `ok:false` with a reason when `X_POST_ENABLED` is `0/false/no/off`, when the session is not logged in, or when the session check throws; an unset toggle proceeds to the session check (default-enabled), matching the plan. `EditorialCopySchema.xCaption` as `z.string().optional().catch(undefined)` keeps a null/numeric/over-length model value from dragging the whole parse to the template fallback. `RasPayloadSchema.xCaption` adds `.max(280)` as the schema-boundary backstop the prior pass asked for. The injectable `check` arg means `preflight.test.ts` covers logged-in, not-logged-in, disabled, unset-default, and thrown-check without spawning Python.

### Verification evidence

The plan's fourth-iteration note records, run in the worktree on `feat/x-posting`: `npm run typecheck` PASS (0 errors), `npm run build` PASS (only the pre-existing rankStories<->score circular-dep warning), `npm test` PASS 172/172 (169 prior + 3 new regressions for the two blocking findings), and both `auto:dry` / `auto:dry:mockx` green offline. The two new test files are registered in the `test` script, and `handoff.test.ts` was changed minimally (injected X fakes) without altering its IG ledger/double-post assertions. Evidence is present and specific, so no suite was re-run here.

</details>

<details>
<summary>File map</summary>

- `src/mastra/lib/ras/payload.ts` — `buildXCaption` unifies both caption paths; final `capHashtags` + `clipTweetBody` guarantees `<=280`, two hashtags, no partial URL, headline-derived.
- `src/mastra/lib/ras/handoff.ts` — fail-soft `attemptX` on the two live+approved branches; injectable `xPublish`/`xReady`; independence doc comment.
- `src/mastra/lib/ras/copywriter.ts` — `xCaption` prompt + `EditorialCopySchema` as `z.string().optional().catch(undefined)`.
- `src/mastra/lib/ras/preflight.ts` — async `xPublishReady` gated on `X_POST_ENABLED` + session, injectable check.
- `src/mastra/schemas/handoff.ts` — `xCaption` `.max(280).default("")`; `XOutcomeSchema`; `x` on `HandoffResultSchema`.
- `src/mastra/workflows/autoNewsToRasWorkflow.ts` — `xCaption` in `PreviewSchema` (empty-caption guard), `x` in `OutputSchema`, passed through.
- `src/mastra/demo/autoNewsDryRun.ts` — prints `xCaption` with char count (no empty-caption guard).
- `.env.example` — documents `X_POST_ENABLED=true`, no secrets.
- `tests/ras/payloadXcaption.test.ts`, `tests/ras/handoffX.test.ts` — new; registered in the `test` script.
- `tests/ras/copywriter.test.ts`, `tests/ras/preflight.test.ts`, `tests/ras/handoff.test.ts` — extended for X gracefulness, readiness, and injected X fakes.

Full diff: `git -C "c:\Users\sanav\OneDrive\Documents\GitHub\contentCreationAgent\.worktrees\x-posting" diff main`

</details>
