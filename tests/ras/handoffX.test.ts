import { test } from "node:test";
import assert from "node:assert/strict";
import { runHandoff, type HandoffDeps } from "../../src/mastra/lib/ras/handoff";
import type { RasPayload } from "../../src/mastra/schemas/handoff";
import type { XPublishResult } from "../../src/mastra/lib/x-publisher";

/**
 * X-posting side effect inside runHandoff:
 *  - live+approved calls xPublish ONCE with text === payload.xCaption and
 *    imagePath === rendered.filePath;
 *  - X is NOT attempted in dry-run or when not approved;
 *  - a X failure (xPublish success:false OR throws) leaves IG status "posted";
 *  - xReady returning ok:false yields x.attempted === false and IG still "posted".
 */

const RENDERED_PNG = "/abs/output/s/01.png";
const X_CAPTION = "Acme raised $20M (Series A) to scale its AI stack. per @acme on X";

function payload(): RasPayload {
  return {
    headline: "Test story", factPack: { headline: "Test story", keyFacts: ["a fact"], figures: [], names: [], sourceUrls: ["https://ex.com/a"], conflicts: [], factPackLimited: false },
    sourceUrls: ["https://ex.com/a"], primaryUrl: "https://ex.com/a", region: "US", suggestedFormat: "single", suggestedCaptionAngle: "Why it matters",
    imageLocalPath: "/tmp/x.jpg", imageSourceUrl: "https://ex.com/x.jpg", imageAttribution: "ex.com", rightsStatus: "unverified", imageUnder1080: false,
    serifHeadline: "Test story", categoryTag: "AI", deckLead: "lead", deckHighlight: "hi", deckTail: "tail", accentColor: "#2F7C74", caption: "cap", xCaption: X_CAPTION, hashtags: ["#ai"], factPackLimited: false,
  };
}

function fakeDeps() {
  const calls = { publish: 0, xPublish: 0, xReady: 0 };
  const xArgs: { text?: string; imagePath?: string; dryRun?: boolean } = {};
  let xResult: XPublishResult | Error = { success: true, verified: true, text: X_CAPTION, tweetUrl: "https://x.com/p/1", message: "ok" };
  const deps: Partial<HandoffDeps> = {
    render: async () => ({ viewUrls: ["https://host/ras-assets/s/01.png"], filePath: RENDERED_PNG, publishPaths: ["/ras-publish/s/01.jpg"] }),
    publish: async () => { calls.publish++; return { published: true, mediaId: "m1", permalink: "https://ig/p/1" }; },
    getRow: async () => undefined,
    record: async () => {},
    xReady: async () => { calls.xReady++; return { ok: true }; },
    xPublish: async (a) => {
      calls.xPublish++;
      xArgs.text = a.text; xArgs.imagePath = a.imagePath; xArgs.dryRun = a.dryRun;
      if (xResult instanceof Error) throw xResult;
      return xResult;
    },
  };
  return { deps, calls, xArgs, setXResult: (r: XPublishResult | Error) => { xResult = r; } };
}

test("live + approved: xPublish called ONCE with the xCaption and the rendered PNG path", async () => {
  const { deps, calls, xArgs } = fakeDeps();
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "posted");
  assert.equal(calls.xPublish, 1);
  assert.equal(xArgs.text, X_CAPTION);
  assert.equal(xArgs.imagePath, RENDERED_PNG);
  assert.equal(xArgs.dryRun, false);
  assert.equal(res.x?.attempted, true);
  assert.equal(res.x?.success, true);
  assert.equal(res.x?.tweetUrl, "https://x.com/p/1");
});

test("DRY-RUN handoff: X is NOT attempted (render/publish never run)", async () => {
  const { deps, calls } = fakeDeps();
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: true, approved: true, deps });
  assert.equal(res.status, "dry_run");
  assert.equal(calls.xPublish, 0);
  assert.equal(res.x, undefined);
});

test("NOT approved (live): X is NOT attempted", async () => {
  const { deps, calls } = fakeDeps();
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: false, deps });
  assert.equal(res.status, "skipped");
  assert.equal(calls.xPublish, 0);
  assert.equal(res.x, undefined);
});

test("X failure (success:false) does NOT flip the Instagram post to failed", async () => {
  const { deps, setXResult } = fakeDeps();
  setXResult({ success: false, verified: false, text: X_CAPTION, error: "X down", message: "fail" });
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "posted");
  assert.equal(res.x?.attempted, true);
  assert.equal(res.x?.success, false);
  assert.equal(res.x?.error, "X down");
});

test("X throwing does NOT flip the Instagram post to failed", async () => {
  const { deps, setXResult } = fakeDeps();
  setXResult(new Error("unexpected X throw"));
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "posted");
  assert.equal(res.x?.attempted, true);
  assert.equal(res.x?.success, false);
});

test("xReady not ok: x.attempted false, X not called, IG still posted", async () => {
  const { deps, calls } = fakeDeps();
  deps.xReady = async () => ({ ok: false, reason: "X session not logged in" });
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "posted");
  assert.equal(calls.xPublish, 0);
  assert.equal(res.x?.attempted, false);
  assert.equal(res.x?.error, "X session not logged in");
});

test("IG env dry-run (published:false): X is attempted but CANNOT post live", async () => {
  const { deps, calls, xArgs } = fakeDeps();
  deps.publish = async () => ({ published: false, dryRun: true });
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "dry_run");
  assert.equal(calls.xPublish, 1);
  // IG published nothing (its env dry-run), so X must NOT post live either:
  // the single safety switch forces X into its own dry-run on this branch.
  assert.equal(xArgs.dryRun, true);
  assert.equal(res.x?.attempted, true);
});

test("empty xCaption: X skipped with 'no X caption', IG still posted", async () => {
  const { deps, calls } = fakeDeps();
  const p = payload();
  p.xCaption = "";
  const res = await runHandoff({ ledgerKey: "k", payload: p, storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "posted");
  assert.equal(calls.xPublish, 0);
  assert.equal(res.x?.attempted, false);
  assert.equal(res.x?.error, "no X caption");
});
