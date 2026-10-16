import { test } from "node:test";
import assert from "node:assert/strict";
import { runHandoff, type HandoffDeps } from "../../src/mastra/lib/ras/handoff";
import type { RasPayload } from "../../src/mastra/schemas/handoff";

function payload(): RasPayload {
  return {
    headline: "Test story", factPack: { headline: "Test story", keyFacts: ["a fact"], figures: [], names: [], sourceUrls: ["https://ex.com/a"], conflicts: [], factPackLimited: false },
    sourceUrls: ["https://ex.com/a"], primaryUrl: "https://ex.com/a", region: "US", suggestedFormat: "single", suggestedCaptionAngle: "Why it matters",
    imageLocalPath: "/tmp/x.jpg", imageSourceUrl: "https://ex.com/x.jpg", imageAttribution: "ex.com", rightsStatus: "unverified", imageUnder1080: false,
    serifHeadline: "Test story", categoryTag: "AI", deckLead: "lead", deckHighlight: "hi", deckTail: "tail", accentColor: "#2F7C74", caption: "cap", hashtags: ["#ai"], factPackLimited: false,
  };
}

function fakeDeps() {
  const calls = { render: 0, publish: 0, recorded: [] as string[] };
  const deps: Partial<HandoffDeps> = {
    render: async () => { calls.render++; return { viewUrls: ["https://host/ras-assets/s/01.png"] }; },
    publish: async () => { calls.publish++; return { published: true, mediaId: "m1", permalink: "https://ig/p/1" }; },
    getRow: async () => undefined,
    record: async (r) => { calls.recorded.push(r.status); },
  };
  return { deps, calls };
}

test("DRY-RUN: never calls render or publish", async () => {
  const { deps, calls } = fakeDeps();
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: true, approved: true, deps });
  assert.equal(res.status, "dry_run");
  assert.equal(calls.render, 0);
  assert.equal(calls.publish, 0);
  assert.deepEqual(calls.recorded, ["dry_run"]);
});

test("NOT approved (live): never calls publish, records nothing", async () => {
  const { deps, calls } = fakeDeps();
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: false, deps });
  assert.equal(res.status, "skipped");
  assert.equal(calls.publish, 0);
  assert.equal(calls.recorded.length, 0);
});

test("live + approved: publishes once, records pending then posted", async () => {
  const { deps, calls } = fakeDeps();
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "posted");
  assert.equal(calls.publish, 1);
  assert.deepEqual(calls.recorded, ["pending", "posted"]);
});

test("already posted: skips, never publishes again (no double post)", async () => {
  const { deps, calls } = fakeDeps();
  deps.getRow = async () => ({ status: "posted" });
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "skipped");
  assert.equal(calls.publish, 0);
});

test("publish failure marks failed and does NOT re-publish", async () => {
  const { deps, calls } = fakeDeps();
  deps.publish = async () => { calls.publish++; throw new Error("IG down"); };
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "failed");
  assert.equal(calls.publish, 1); // exactly one publish attempt
  assert.ok(calls.recorded.includes("failed"));
});

test("client declines to publish (env dry-run): records dry_run, NEVER posted", async () => {
  const { deps, calls } = fakeDeps();
  deps.publish = async () => { calls.publish++; return { published: false, dryRun: true }; };
  const res = await runHandoff({ ledgerKey: "k", payload: payload(), storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "dry_run");
  assert.ok(!calls.recorded.includes("posted"));
  assert.deepEqual(calls.recorded, ["pending", "dry_run"]);
});
