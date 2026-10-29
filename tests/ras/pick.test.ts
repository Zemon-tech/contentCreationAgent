import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPostableCandidate, type PreparedPost } from "../../src/mastra/lib/workflow/autoNewsToRas";
import type { RankResult, RankedStory, RankInputItem } from "../../src/mastra/schemas/ranking";

function ranked(id: string, cluster: string, score: number): RankedStory {
  const item: RankInputItem = { id, clusterId: cluster, title: `Story ${id}`, summary: "s".repeat(60), url: `https://ex.com/${id}`, source: "X", region: "US", publishedAt: new Date().toISOString(), rawCategories: [], clusterSourceCount: 1 };
  return { item, llm: null, unscored: false, finalScore: score, components: {} as never, weightedContributions: {}, appliedPenalties: [], reason: "r" };
}

function result(rs: RankedStory[]): RankResult {
  return { ranked: rs, selected: [], droppedByReason: {} } as unknown as RankResult;
}

const prep = (hasImage: boolean): PreparedPost => ({
  payload: { imageLocalPath: hasImage ? "/tmp/i.jpg" : null } as never,
  image: {} as never,
  caps: { ok: true, postsLast24h: 0, lastPostedAt: null },
  scoreOk: true,
});

test("skips an image-less top story and takes the next one with an image", async () => {
  const r = result([ranked("a", "ca", 80), ranked("b", "cb", 70)]);
  const out = await pickPostableCandidate({
    rankResult: r, rawById: new Map(), minScore: 55,
    prepare: async ({ item }) => prep(item.id === "b"),
  });
  assert.equal(out.candidate?.item.id, "b");
  assert.equal(out.tried, 2);
  assert.equal(out.skippedNoImage.length, 1);
});

test("returns null (valid, not an error) when no story has an image", async () => {
  const r = result([ranked("a", "ca", 80), ranked("b", "cb", 70)]);
  const out = await pickPostableCandidate({ rankResult: r, rawById: new Map(), minScore: 55, prepare: async () => prep(false) });
  assert.equal(out.candidate, null);
  assert.equal(out.skippedNoImage.length, 2);
});

test("never goes below the score threshold and never reuses a cluster", async () => {
  const r = result([ranked("a", "same", 80), ranked("b", "same", 79), ranked("c", "cc", 40)]);
  const seen: string[] = [];
  const out = await pickPostableCandidate({ rankResult: r, rawById: new Map(), minScore: 55, prepare: async ({ item }) => { seen.push(item.id); return prep(false); } });
  assert.deepEqual(seen, ["a"]); // b is same cluster, c is below threshold
  assert.equal(out.candidate, null);
});

// --- pickPostableCandidates (plural): batch path for posting the top N ---
import { pickPostableCandidates } from "../../src/mastra/lib/workflow/autoNewsToRas";

test("picks the top N postable stories in rank order", async () => {
  const r = result([ranked("a", "ca", 80), ranked("b", "cb", 70), ranked("c", "cc", 60), ranked("d", "cd", 58)]);
  const out = await pickPostableCandidates({
    rankResult: r, rawById: new Map(), minScore: 55, count: 3,
    prepare: async () => prep(true),
  });
  assert.equal(out.candidates.length, 3);
  assert.deepEqual(out.candidates.map((c) => c.item.id), ["a", "b", "c"]);
  // Highest score first.
  assert.ok(out.candidates[0].finalScore >= out.candidates[1].finalScore);
});

test("skips image-less stories to still collect N with images", async () => {
  const r = result([ranked("a", "ca", 80), ranked("b", "cb", 70), ranked("c", "cc", 60), ranked("d", "cd", 58)]);
  const out = await pickPostableCandidates({
    rankResult: r, rawById: new Map(), minScore: 55, count: 2,
    // "a" has no image; b, c, d do -> should return b and c.
    prepare: async ({ item }) => prep(item.id !== "a"),
  });
  assert.deepEqual(out.candidates.map((c) => c.item.id), ["b", "c"]);
  assert.equal(out.skippedNoImage.length, 1);
});

test("returns fewer than requested when not enough qualify (valid, not an error)", async () => {
  const r = result([ranked("a", "ca", 80), ranked("b", "cb", 40)]); // b below threshold
  const out = await pickPostableCandidates({
    rankResult: r, rawById: new Map(), minScore: 55, count: 3,
    prepare: async () => prep(true),
  });
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].item.id, "a");
});

test("never reuses a cluster across the batch", async () => {
  const r = result([ranked("a", "same", 80), ranked("b", "same", 79), ranked("c", "cc", 70)]);
  const out = await pickPostableCandidates({
    rankResult: r, rawById: new Map(), minScore: 55, count: 3,
    prepare: async () => prep(true),
  });
  // b shares a's cluster -> only a and c survive.
  assert.deepEqual(out.candidates.map((c) => c.item.id), ["a", "c"]);
});
