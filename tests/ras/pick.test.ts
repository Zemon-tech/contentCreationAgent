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
