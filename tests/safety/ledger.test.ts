import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalKey } from "../../src/mastra/lib/safety/ledger-key";
import { computeBlocked, type PostedLedgerRow } from "../../src/mastra/repositories/postedLedger";
import { evaluateCaps } from "../../src/mastra/lib/safety/posting-gate";

const NOW = new Date("2026-10-15T12:00:00Z");

function row(o: Partial<PostedLedgerRow>): PostedLedgerRow {
  return { id: "k", status: "posted", storyId: "s", url: "u", title: "t", region: "US", at: NOW.toISOString(), createdAt: NOW.toISOString(), ...o };
}

test("canonicalKey is stable and ignores tracking params, differs by content", () => {
  const a = canonicalKey("https://ex.com/story?utm_source=x", "Title", "Summary");
  const b = canonicalKey("https://ex.com/story", "Title", "Summary");
  assert.equal(a, b);
  assert.notEqual(a, canonicalKey("https://ex.com/story", "Different", "Summary"));
  assert.notEqual(a, canonicalKey("https://ex.com/other", "Title", "Summary"));
});

test("posted and pending always block; dry_run never blocks", () => {
  const m = computeBlocked(
    [row({ id: "posted", status: "posted" }), row({ id: "pending", status: "pending" }), row({ id: "dry", status: "dry_run" })],
    { now: NOW, blockRejectedForHours: 168 },
  );
  assert.equal(m.get("posted"), "posted");
  assert.equal(m.get("pending"), "pending");
  assert.equal(m.has("dry"), false);
});

test("rejected/failed block only within the window", () => {
  const recent = row({ id: "r", status: "rejected", at: new Date(NOW.getTime() - 3600_000).toISOString() });
  const old = row({ id: "o", status: "failed", at: new Date(NOW.getTime() - 200 * 3600_000).toISOString() });
  const m = computeBlocked([recent, old], { now: NOW, blockRejectedForHours: 168 });
  assert.equal(m.get("r"), "rejected");
  assert.equal(m.has("o"), false);
});

test("daily cap blocks posting", () => {
  const g = evaluateCaps({ postsLast24h: 4, lastPostedAt: null, now: NOW, config: { maxPostsPerDay: 4, minGapHours: 3, minScore: 55, blockRejectedForHours: 168 } });
  assert.equal(g.ok, false);
  assert.match(g.reason!, /daily cap/);
});

test("min gap blocks posting", () => {
  const last = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // 1h ago
  const g = evaluateCaps({ postsLast24h: 1, lastPostedAt: last, now: NOW, config: { maxPostsPerDay: 4, minGapHours: 3, minScore: 55, blockRejectedForHours: 168 } });
  assert.equal(g.ok, false);
  assert.match(g.reason!, /min gap/);
});

test("clears when under cap and past the gap", () => {
  const last = new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString();
  const g = evaluateCaps({ postsLast24h: 1, lastPostedAt: last, now: NOW, config: { maxPostsPerDay: 4, minGapHours: 3, minScore: 55, blockRejectedForHours: 168 } });
  assert.equal(g.ok, true);
});
