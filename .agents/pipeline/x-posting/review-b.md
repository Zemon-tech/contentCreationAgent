# X publishing alongside Instagram in the auto-news workflow

The change gives the auto-news workflow a standalone X caption and posts the already-rendered PNG to X after Instagram reaches a publish outcome. Caption generation now covers both model-written and deterministic paths, while X readiness and publishing remain fail-soft and outside the Instagram ledger. The latest commit resolves the earlier reviewer-B findings around deterministic hashtag capping, empty normalized model copy, schema defense, and empty-caption preview text. One existing no-publish render harness now inherits the default live X side effect and can publish unexpectedly, so this branch should not ship yet.

Watch for: **confirmed** `npm run ras:render:test` can create a real X post through the new default `runHandoff` dependency even though the harness fakes Instagram publishing and promises that it never creates a real post.

**Verdict**: NEEDS_CHANGES

## High-level view

`buildRasPayload` creates X-native copy independently from the Instagram caption. Both model and deterministic paths enforce 280 ASCII characters and two hashtags; unusable model output falls back to headline-plus-source copy, and source URLs are kept whole or omitted.

The auto-news workflow renders once before approval, then injects that render result into `runHandoff`. Instagram receives the JPEG publish path while X receives the local PNG `filePath`. X only runs after the approved, non-handoff-dry-run Instagram attempt; an Instagram environment dry-run forces X into dry-run, and X readiness or publishing failures cannot change the Instagram-derived status or ledger.

The new X behavior is implemented as a default side effect of every live+approved `runHandoff` call, not only the auto-news workflow. That makes the existing `ras:render:test` command unsafe: its fake Instagram result looks like a successful live publish to `runHandoff`, which then uses the default X session check and publisher with `dryRun:false`.

`X_POST_ENABLED` defaults to enabled as agreed, and an unavailable session produces a clear skip result. The approval preview carries the final X caption, output carries the X outcome, both new test files are registered in `npm test`, and the plan records successful typecheck, build, 172 tests, and both offline auto-news demos after the latest fixes.

<details>
<summary>Issues (1)</summary>

1. **No-publish render harness can post to X — confirmed** — `rasRenderTest.ts` calls `runHandoff` with `dryRun:false`, `approved:true`, and a fake successful Instagram publisher but does not inject safe X dependencies, so a logged-in default X session can publish for real. Disable/inject X in this harness and add a regression that proves the command's no-publish contract across both channels.

</details>

<details>
<summary>Details</summary>

### The no-publish render harness now has a live X path

**Confirmed:** `src/mastra/demo/rasRenderTest.ts:81-82` deliberately calls `runHandoff` with `dryRun:false` and `approved:true` so the real renderer executes. Its default branch replaces only `publish` with a fake that returns `{ published: true, ... }` (`rasRenderTest.ts:87-96`), and the command ends by saying no real publish was created (`rasRenderTest.ts:119`). This command is exposed as `npm run ras:render:test` in `package.json:31`.

The modified handoff merges partial dependencies over `defaultHandoffDeps` (`src/mastra/lib/ras/handoff.ts:84`), where `xPublish` is the real `publishToX` wrapper (`handoff.ts:71`). Once the fake Instagram publisher returns `published:true`, the added path calls `attemptX(..., args.dryRun)` (`handoff.ts:160`); `args.dryRun` is false in this harness. With the logged-in browser session already used by the repository's X scraper, running a render-only test can therefore create a real X post while Instagram remains fake.

The harness should inject `xReady: async () => ({ ok:false, reason:"render test" })` or a dry-run/fake `xPublish`, and its output should state that neither channel published. A focused regression should assert that X is not called.

### X captions remain independent from Instagram copy

The copywriter asks for a fresh `xCaption` with X-specific hook, grounding, URL, hashtag, and length rules. `EditorialCopySchema.xCaption` is optional with a field-level catch, so omission or a malformed X-only value does not discard valid Instagram copy. The producer normalizes model copy or builds a deterministic caption from the headline and atomic source/attribution suffix; neither path reads or truncates the Instagram caption.

The current diff addresses the earlier reviewer-B findings: final hashtag capping covers both paths, empty normalized model values trigger deterministic fallback, `RasPayloadSchema` rejects values above 280, and the preview explains an empty caption as a skipped X post. Focused tests cover these cases, X-only attribution, hashtag punctuation, and whole-URL handling.

### Instagram remains ledger-authoritative

The handoff records Instagram's `posted` or `dry_run` result before attempting X, and `attemptX` catches readiness and publisher failures into an optional X outcome without writing the ledger. The pre-publish dry-run, rejection, existing posted/pending row, render failure, and thrown Instagram publish paths do not reach X. When the Instagram client reports its own environment dry-run, X is invoked with `dryRun:true`, preventing the shared safety switch from suppressing Instagram while allowing a live X post.

The workflow passes the existing render object back into the handoff, preserving its PNG `filePath` and JPEG `publishPaths`; the handoff sends the former to X and the latter to Instagram. Handoff tests cover PNG threading, approval and dry-run gates, readiness and publishing failures, and empty-caption skip.

### Verification evidence and scope

The plan's latest verification note and the latest commit message record `npm run typecheck` passing with no errors, `npm run build` passing with only the pre-existing rank/score circular-dependency warning, `npm test` passing 172/172, and both `npm run auto:dry` and `npm run auto:dry:mockx` passing offline. The new `payloadXcaption.test.ts` and `handoffX.test.ts` files are present in the explicit package test command. No suite was rerun because this evidence is complete; the blocker is an uncovered existing package command whose runtime behavior changed through the new default handoff dependency.

</details>

<details>
<summary>File map</summary>

- `.env.example` — documents the default-enabled X side effect and shared Instagram dry-run switch.
- `package.json` — registers the X caption and handoff tests; also exposes the affected `ras:render:test` harness.
- `src/mastra/demo/autoNewsDryRun.ts` — prints generated X copy with its character count.
- `src/mastra/lib/ras/copywriter.ts` — requests standalone X copy and recovers malformed X-only fields independently.
- `src/mastra/lib/ras/handoff.ts` — adds default, injectable, fail-soft X publishing after Instagram outcomes.
- `src/mastra/lib/ras/payload.ts` — builds and normalizes model or deterministic X captions.
- `src/mastra/lib/ras/preflight.ts` — adds default-enabled X session readiness checks.
- `src/mastra/schemas/handoff.ts` — adds the bounded X caption and optional X outcome schemas.
- `src/mastra/workflows/autoNewsToRasWorkflow.ts` — exposes X copy for approval and X results in workflow output.
- `tests/ras/copywriter.test.ts` — verifies malformed X fields preserve Instagram copy.
- `tests/ras/handoff.test.ts` — injects X fakes into the existing handoff contract tests.
- `tests/ras/handoffX.test.ts` — covers X gating, PNG threading, dry-run behavior, and fail-soft outcomes.
- `tests/ras/payloadXcaption.test.ts` — covers both caption paths, limits, fallback, hashtags, and URLs.
- `tests/ras/preflight.test.ts` — covers the X toggle, session state, and thrown readiness checks.

Full diff: `git -C "c:\Users\sanav\OneDrive\Documents\GitHub\contentCreationAgent\.worktrees\x-posting" diff main`

</details>
