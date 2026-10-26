import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRankedStory } from "../../src/mastra/lib/ranking/score";
import { hardFilter, DROP_REASONS } from "../../src/mastra/lib/ranking/hardFilter";
import { rankingConfig } from "../../src/mastra/config/ranking.config";
import type { LlmScore, RankInputItem } from "../../src/mastra/schemas/ranking";

/**
 * FEAT-005 E.1 — the parameterized recency-vs-quality matrix (replaces the old
 * single 18h-vs-2h fixture). All pure, no LLM, with an injected `now`:
 *
 *  (a) For two in-window items whose qualityScore gap exceeds the recency bound,
 *      the HIGHER-quality item wins on finalScore regardless of age.
 *  (b) When qualityScore is equal within a small epsilon, the FRESHER item wins
 *      (its recencyMultiplier is higher).
 *  (c) An item older than maxAgeHours is DROPPED by hardFilter (too_old).
 *
 * The recency bound is bounded by design: finalScore = qualityScore *
 * recencyMultiplier, where the multiplier runs over [minMultiplier, 1.0]. The
 * most freshness can move a 100-point item is 100*(1 - minMultiplier) points,
 * so any quality gap larger than that cannot be overturned by age.
 */

const NOW = new Date("2026-10-13T12:00:00.000Z");
const AGES_H = [1, 6, 12, 18, 23] as const;

function at(ageHours: number): string {
  return new Date(NOW.getTime() - ageHours * 3_600_000).toISOString();
}

function item(id: string, ageHours: number): RankInputItem {
  return {
    id,
    clusterId: id,
    title: "A clear, concrete story headline for the ranker to score",
    summary: "A sufficiently long, concrete summary that comfortably clears the RSS minimum length.",
    url: `https://example.com/${id}`,
    source: "The Verge",
    region: "US",
    publishedAt: at(ageHours),
    rawCategories: [],
    clusterSourceCount: 1,
  };
}

/** A tunable LLM judgement: `level` scales the four meaning components 0-10. */
function llm(id: string, level: number): LlmScore {
  const v = Math.max(0, Math.min(10, level));
  return {
    id,
    topic: "ai",
    topicFit: v,
    significance: v,
    audienceInterest: v,
    visualPotential: v,
    isOpinionOrRumor: false,
    isClickbait: false,
    isDuplicateAngle: false,
    isNewInformation: true,
    isPrimarySource: true,
    specificity: v,
    hookPotential: v,
    claimRisk: "low",
    flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
    derivedHeadline: "A clear, concrete story headline",
    headlineDerived: true,
    reason: "matrix fixture",
  };
}

/** Max final-score points freshness can add to a 100-pt item (the recency bound). */
const recencyBoundPoints =
  100 * (rankingConfig.recencyTiebreaker.maxMultiplier - rankingConfig.recencyTiebreaker.minMultiplier);

test("(a) higher qualityScore wins on finalScore regardless of age, across the matrix", () => {
  // A high-quality item at the OLDEST age vs a low-quality item at the FRESHEST
  // age. The quality gap must exceed the recency bound for the guarantee.
  for (const highAge of AGES_H) {
    for (const lowAge of AGES_H) {
      const high = computeRankedStory(item("high", highAge), llm("high", 9), { now: NOW });
      const low = computeRankedStory(item("low", lowAge), llm("low", 3), { now: NOW });

      const gap = high.qualityScore - low.qualityScore;
      assert.ok(gap > recencyBoundPoints, `quality gap ${gap} should exceed the recency bound ${recencyBoundPoints}`);
      assert.ok(
        high.finalScore > low.finalScore,
        `high(level9,age${highAge}h)=${high.finalScore} should beat low(level3,age${lowAge}h)=${low.finalScore}`,
      );
    }
  }
});

test("(a') the quality winner holds even when it is the OLDEST and the loser is the FRESHEST", () => {
  const high = computeRankedStory(item("high", 23), llm("high", 9), { now: NOW }); // oldest in-window
  const low = computeRankedStory(item("low", 1), llm("low", 3), { now: NOW }); // freshest
  assert.ok(high.qualityScore > low.qualityScore);
  assert.ok(high.finalScore > low.finalScore);
  // The fresher loser still gets the larger recency multiplier — age helped it,
  // just not enough to overcome the quality gap.
  assert.ok(low.components.recencyMultiplier > high.components.recencyMultiplier);
});

test("(b) equal quality (within epsilon): the fresher item wins via a higher recency multiplier", () => {
  for (let i = 0; i < AGES_H.length - 1; i++) {
    const fresherAge = AGES_H[i]!;
    const olderAge = AGES_H[i + 1]!;
    const fresher = computeRankedStory(item("fresher", fresherAge), llm("fresher", 7), { now: NOW });
    const older = computeRankedStory(item("older", olderAge), llm("older", 7), { now: NOW });

    // Same judgement + source + coverage -> identical qualityScore.
    assert.ok(Math.abs(fresher.qualityScore - older.qualityScore) < 1e-6);
    assert.ok(
      fresher.components.recencyMultiplier > older.components.recencyMultiplier,
      `fresher(${fresherAge}h) multiplier should exceed older(${olderAge}h)`,
    );
    assert.ok(
      fresher.finalScore >= older.finalScore,
      `fresher(${fresherAge}h)=${fresher.finalScore} should win over older(${olderAge}h)=${older.finalScore}`,
    );
  }
});

test("(c) an item older than maxAgeHours is dropped by hardFilter (too_old)", () => {
  const stale = item("stale", rankingConfig.maxAgeHours + 1); // 25h by default
  const res = hardFilter({ items: [stale], now: NOW });
  assert.equal(res.kept.length, 0);
  assert.equal(res.drops[0]?.reason, DROP_REASONS.TOO_OLD);
});

test("(c') every in-window matrix age survives hardFilter", () => {
  const items = AGES_H.map((h) => item(`age-${h}`, h));
  const res = hardFilter({ items, now: NOW });
  assert.equal(res.kept.length, AGES_H.length);
  assert.equal(res.drops.length, 0);
});
