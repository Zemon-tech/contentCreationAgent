import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRankedStory,
  recencyScore,
  coverageScore,
  regionBalanceAdjustment,
} from "../../src/mastra/lib/ranking/score";
import { rankingConfig, type RankingConfig } from "../../src/mastra/config/ranking.config";
import type { LlmScore, RankInputItem } from "../../src/mastra/schemas/ranking";

const NOW = new Date("2026-10-13T12:00:00.000Z");

function item(overrides: Partial<RankInputItem> = {}): RankInputItem {
  return {
    id: "i1",
    clusterId: "c1",
    title: "A story",
    summary: "A sufficiently long summary for the ranker to consider seriously.",
    url: "https://example.com/x",
    source: overrides.source ?? "The Verge",
    region: overrides.region ?? "US",
    publishedAt: overrides.publishedAt ?? NOW.toISOString(),
    rawCategories: [],
    clusterSourceCount: overrides.clusterSourceCount ?? 1,
  };
}

function llm(overrides: Partial<LlmScore> = {}): LlmScore {
  return {
    id: "i1",
    topic: "ai",
    topicFit: overrides.topicFit ?? 10,
    significance: overrides.significance ?? 10,
    audienceInterest: overrides.audienceInterest ?? 10,
    visualPotential: overrides.visualPotential ?? 10,
    isOpinionOrRumor: overrides.isOpinionOrRumor ?? false,
    isClickbait: overrides.isClickbait ?? false,
    isDuplicateAngle: overrides.isDuplicateAngle ?? false,
    reason: overrides.reason ?? "strong, concrete, relevant",
  };
}

test("recencyScore: 10 at age 0, half at one half-life, decreasing", () => {
  const hl = rankingConfig.recencyHalfLifeHours;
  assert.equal(recencyScore(NOW.toISOString(), NOW, hl), 10);
  const halfLifeAgo = new Date(NOW.getTime() - hl * 3_600_000).toISOString();
  assert.ok(Math.abs(recencyScore(halfLifeAgo, NOW, hl) - 5) < 1e-9);
  const older = recencyScore(new Date(NOW.getTime() - 2 * hl * 3_600_000).toISOString(), NOW, hl);
  assert.ok(older < 5 && older > 0);
});

test("coverageScore: saturates at the cap", () => {
  assert.equal(coverageScore(10, 5), 10);
  assert.equal(coverageScore(5, 5), 10);
  assert.equal(coverageScore(1, 5), 2);
});

test("regionBalanceAdjustment: boosts the minority region only", () => {
  const b = rankingConfig.regionBalanceBoost;
  assert.equal(regionBalanceAdjustment("IN", ["US", "US", "US"], b), b); // IN is minority
  assert.equal(regionBalanceAdjustment("US", ["US", "US", "US"], b), 0); // US is majority
  assert.equal(regionBalanceAdjustment("US", ["IN", "IN"], b), b);
  assert.equal(regionBalanceAdjustment("GLOBAL", ["US", "IN"], b), 0); // never for GLOBAL
  assert.equal(regionBalanceAdjustment("IN", ["US", "IN"], b), 0); // balanced -> no nudge
});

test("a perfect item with no recent posts scores near the top", () => {
  const r = computeRankedStory(item({ clusterSourceCount: 5, source: "wsj" }), llm(), { now: NOW });
  // All weighted components max out (sum of weights = 10 -> 100 scale).
  assert.ok(r.finalScore > 90, `expected >90, got ${r.finalScore}`);
  assert.equal(r.appliedPenalties.length, 0);
  assert.equal(r.unscored, false);
});

test("weighted contributions reflect the configured weights", () => {
  const r = computeRankedStory(item(), llm(), { now: NOW });
  assert.equal(r.weightedContributions.topicFit, rankingConfig.weights.topicFit * 10);
  assert.equal(r.weightedContributions.significance, rankingConfig.weights.significance * 10);
});

test("penalties reduce the score and are listed", () => {
  const clean = computeRankedStory(item(), llm(), { now: NOW });
  const penalized = computeRankedStory(item(), llm({ isClickbait: true, isOpinionOrRumor: true }), { now: NOW });
  assert.ok(penalized.finalScore < clean.finalScore);
  assert.deepEqual(penalized.appliedPenalties.sort(), ["isClickbait", "isOpinionOrRumor"]);
  const expectedDrop = rankingConfig.penalties.isClickbait + rankingConfig.penalties.isOpinionOrRumor;
  assert.ok(Math.abs((clean.finalScore - penalized.finalScore) - expectedDrop) < 1e-6);
});

test("unscored items zero the LLM components and apply the unscored penalty", () => {
  const r = computeRankedStory(item({ clusterSourceCount: 3 }), null, { now: NOW });
  assert.equal(r.unscored, true);
  assert.equal(r.components.topicFit, 0);
  assert.equal(r.components.significance, 0);
  assert.ok(r.appliedPenalties.includes("unscored"));
  assert.equal(r.components.penalties, rankingConfig.penalties.unscored);
});

test("final score is clamped to [0,100]", () => {
  const cfg: RankingConfig = { ...rankingConfig, penalties: { ...rankingConfig.penalties, unscored: 9999 } };
  const r = computeRankedStory(item(), null, { now: NOW, config: cfg });
  assert.equal(r.finalScore, 0);
});
