import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreItems, type ScoreCache, type RankGenerate } from "../../src/mastra/lib/ranking/llmScore";
import { rankingConfig } from "../../src/mastra/config/ranking.config";
import type { LlmScore, RankInputItem } from "../../src/mastra/schemas/ranking";

function item(id: string): RankInputItem {
  return { id, clusterId: `c-${id}`, title: `T ${id}`, summary: "x".repeat(60), url: `https://ex.com/${id}`, source: "X", region: "US", publishedAt: new Date().toISOString(), rawCategories: [], clusterSourceCount: 1 };
}
const judged = (id: string): LlmScore => ({ id, topic: "ai", topicFit: 7, significance: 6, audienceInterest: 6, visualPotential: 5, isOpinionOrRumor: false, isClickbait: false, isDuplicateAngle: false, isNewInformation: true, isPrimarySource: false, specificity: 6, hookPotential: 5, claimRisk: "low", flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false }, derivedHeadline: `T ${id}`, headlineDerived: true, reason: "ok" });

// Generator that answers whatever ids are in the prompt, tracking concurrency.
function trackedGenerate() {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const generate: RankGenerate = async (prompt) => {
    stats.calls++; stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    await new Promise((r) => setTimeout(r, 15));
    stats.inFlight--;
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]!);
    return { text: JSON.stringify({ scores: ids.map(judged) }), usage: { totalTokens: 10 } };
  };
  return { generate, stats };
}

const cfg = (concurrency: number) => ({ ...rankingConfig, batchSize: 1, concurrency });

test("scores everything and respects the concurrency limit", async () => {
  const { generate, stats } = trackedGenerate();
  const items = Array.from({ length: 10 }, (_, i) => item(`i${i}`));
  const out = await scoreItems(items, { config: cfg(3), generate });
  assert.equal(out.scores.size, 10);
  assert.equal(out.unscoredIds.length, 0);
  assert.equal(stats.calls, 10);
  assert.ok(stats.maxInFlight <= 3, `max in flight was ${stats.maxInFlight}`);
  assert.ok(stats.maxInFlight >= 2, "should actually run in parallel");
});

test("concurrency 1 stays sequential", async () => {
  const { generate, stats } = trackedGenerate();
  await scoreItems(Array.from({ length: 4 }, (_, i) => item(`s${i}`)), { config: cfg(1), generate });
  assert.equal(stats.maxInFlight, 1);
});

test("cache hits skip the model, and ids are remapped to this run", async () => {
  const store = new Map<string, LlmScore>();
  const cache: ScoreCache = { async get(i) { return store.get(i.url); }, async set(i, s) { store.set(i.url, s); } };
  const first = trackedGenerate();
  await scoreItems([item("a"), item("b")], { config: cfg(2), generate: first.generate, cache });
  assert.equal(first.stats.calls, 2);

  // Next "cycle": same articles, NEW ids (cluster/story ids regenerate each run).
  const second = trackedGenerate();
  const out = await scoreItems([{ ...item("a"), id: "a-new" }, { ...item("b"), id: "b-new" }, item("fresh")], { config: cfg(2), generate: second.generate, cache });
  assert.equal(second.stats.calls, 1, "only the new article should hit the model");
  assert.equal(out.cacheHits, 2);
  assert.ok(out.scores.has("a-new") && out.scores.has("b-new") && out.scores.has("fresh"));
  assert.equal(out.scores.get("a-new")!.id, "a-new");
});

test("unscored items are never cached", async () => {
  const store = new Map<string, LlmScore>();
  const cache: ScoreCache = { async get(i) { return store.get(i.url); }, async set(i, s) { store.set(i.url, s); } };
  const bad: RankGenerate = async () => ({ text: "not json at all", usage: {} });
  const out = await scoreItems([item("z")], { config: cfg(1), generate: bad, cache });
  assert.equal(out.unscoredIds.length, 1);
  assert.equal(store.size, 0);
});
