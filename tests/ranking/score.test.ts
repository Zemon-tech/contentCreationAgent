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
    isNewInformation: overrides.isNewInformation ?? true,
    isPrimarySource: overrides.isPrimarySource ?? true,
    specificity: overrides.specificity ?? 10,
    hookPotential: overrides.hookPotential ?? 10,
    claimRisk: overrides.claimRisk ?? "low",
    flags: overrides.flags ?? { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
    derivedHeadline: overrides.derivedHeadline ?? "A story",
    headlineDerived: true,
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

test("a maxed, cross-corroborated X item scores >= 90", () => {
  // engagement: interactions (120) vs account median (40) -> ratio clamps to
  // the cap (3) -> engagement component maxes at 10.
  // corroboration: outbound matches an RSS url in the context AND >=2 promoted
  // accounts carry the claim -> 0.6*10 + 0.4*10 = 10.
  const xItem = item({
    clusterSourceCount: 5,
    source: "wsj",
    url: "https://x.com/acme/status/1",
  }) as RankInputItem;
  xItem.isX = true;
  xItem.authorHandle = "@acme";
  xItem.accountStatus = "promoted";
  xItem.accountMedianLikes = 40;
  xItem.engagementRaw = { likes: 100, reposts: 15, replies: 5, views: 10_000 };
  xItem.outboundUrls = ["https://acme.example/post"];

  const corroboration = {
    rssUrlSet: new Set<string>(["https://acme.example/post"]),
    credibleAccountsByGroup: new Map<string, number>([["host:acme.example", 2]]),
  };

  // A fully-maxed item needs every 0-10 component at 10, including source
  // credibility (the live registry caps at 9), so pin it to 10 for this case.
  const cfg: RankingConfig = {
    ...rankingConfig,
    sourceCredibility: { ...rankingConfig.sourceCredibility, wsj: 10 },
  };
  const r = computeRankedStory(xItem, llm(), { now: NOW, corroboration, config: cfg });
  // All nine weighted components max out (sum of weights = 10 -> 100 scale);
  // recency multiplier is 1.0 at age 0, so finalScore maxes too.
  assert.equal(r.qualityScore, 100, `expected qualityScore 100, got ${r.qualityScore}`);
  assert.ok(r.finalScore >= 90, `expected >=90, got ${r.finalScore}`);
  assert.equal(r.appliedPenalties.length, 0);
  assert.equal(r.unscored, false);
  assert.equal(r.verified, true);
});

// FIX #5 (INTENTIONAL): a maxed UNCORROBORATED RSS item earns 0 on the X-only
// engagement and corroboration components, so its qualityScore caps at ~85 by
// design. It still clears the default minScore (55) comfortably.
test("a maxed uncorroborated RSS item caps at ~85 by design", () => {
  const r = computeRankedStory(item({ clusterSourceCount: 5, source: "wsj" }), llm(), { now: NOW });
  assert.ok(r.qualityScore >= 84 && r.qualityScore <= 86, `expected ~85, got ${r.qualityScore}`);
  assert.ok(r.qualityScore > rankingConfig.minScore);
  assert.equal(r.components.engagementComponent, 0);
  assert.equal(r.components.corroborationComponent, 0);
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
