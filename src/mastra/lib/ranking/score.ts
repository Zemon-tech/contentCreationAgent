import type { RankingConfig } from "../../config/ranking.config";
import { rankingConfig, sourceCredibilityOf } from "../../config/ranking.config";
import type {
  LlmScore,
  RankInputItem,
  RankedStory,
  Region,
  ScoreComponents,
} from "../../schemas/ranking";
import { ageInHours } from "./hardFilter";

/**
 * Stage C — the deterministic final score. Pure math, no LLM. Takes the
 * model's judgement (or null for unscored) plus code-derived signals and
 * produces a 0-100 score with every component exposed for explainability.
 *
 *   final = Σ wᵢ·componentᵢ (0-100) + regionBalanceAdjustment − penalties,
 *   clamped to [0,100].
 */

export interface ScoreContext {
  config?: RankingConfig;
  now?: Date;
  /** Regions of recent posts, most-recent first (for region balance). */
  recentRegions?: Region[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Exponential recency decay to a 0-10 score. */
export function recencyScore(publishedAt: string, now: Date, halfLifeHours: number): number {
  const age = ageInHours(publishedAt, now);
  if (age === null) return 0;
  return clamp(10 * Math.pow(0.5, Math.max(0, age) / halfLifeHours), 0, 10);
}

/** Coverage (independent sources) to a capped 0-10 score. */
export function coverageScore(clusterSourceCount: number, cap: number): number {
  return clamp((Math.min(clusterSourceCount, cap) / cap) * 10, 0, 10);
}

/**
 * Region-balance nudge (final-score points). If the item's region is the
 * strict minority among recent posts, add a small boost; otherwise 0. Never
 * large enough to promote a weak story on its own.
 */
export function regionBalanceAdjustment(
  region: Region,
  recentRegions: Region[],
  boost: number,
): number {
  if (region !== "US" && region !== "IN") return 0;
  const us = recentRegions.filter((r) => r === "US").length;
  const inn = recentRegions.filter((r) => r === "IN").length;
  if (region === "US" && us < inn) return boost;
  if (region === "IN" && inn < us) return boost;
  return 0;
}

export function computeRankedStory(
  item: RankInputItem,
  llm: LlmScore | null,
  ctx: ScoreContext = {},
): RankedStory {
  const config = ctx.config ?? rankingConfig;
  const now = ctx.now ?? new Date();
  const recentRegions = ctx.recentRegions ?? [];
  const unscored = llm === null;

  const components: ScoreComponents = {
    topicFit: llm?.topicFit ?? 0,
    significance: llm?.significance ?? 0,
    audienceInterest: llm?.audienceInterest ?? 0,
    visualPotential: llm?.visualPotential ?? 0,
    recencyScore: round2(recencyScore(item.publishedAt, now, config.recencyHalfLifeHours)),
    coverageScore: round2(coverageScore(item.clusterSourceCount, config.coverageCap)),
    sourceCredibility: sourceCredibilityOf(item.source, config),
    regionBalanceAdjustment: regionBalanceAdjustment(item.region, recentRegions, config.regionBalanceBoost),
    penalties: 0, // filled below
  };

  const w = config.weights;
  const weightedContributions: Record<string, number> = {
    topicFit: round2(w.topicFit * components.topicFit),
    significance: round2(w.significance * components.significance),
    audienceInterest: round2(w.audienceInterest * components.audienceInterest),
    visualPotential: round2(w.visualPotential * components.visualPotential),
    recency: round2(w.recency * components.recencyScore),
    coverage: round2(w.coverage * components.coverageScore),
    sourceCredibility: round2(w.sourceCredibility * components.sourceCredibility),
  };
  const weightedSum = Object.values(weightedContributions).reduce((a, b) => a + b, 0);

  // Penalties.
  const appliedPenalties: string[] = [];
  let penaltyTotal = 0;
  if (llm?.isOpinionOrRumor) {
    appliedPenalties.push("isOpinionOrRumor");
    penaltyTotal += config.penalties.isOpinionOrRumor;
  }
  if (llm?.isClickbait) {
    appliedPenalties.push("isClickbait");
    penaltyTotal += config.penalties.isClickbait;
  }
  if (llm?.isDuplicateAngle) {
    appliedPenalties.push("isDuplicateAngle");
    penaltyTotal += config.penalties.isDuplicateAngle;
  }
  if (unscored) {
    appliedPenalties.push("unscored");
    penaltyTotal += config.penalties.unscored;
  }
  components.penalties = penaltyTotal;

  const finalScore = round2(
    clamp(weightedSum + components.regionBalanceAdjustment - penaltyTotal, 0, 100),
  );

  return {
    item,
    llm,
    unscored,
    finalScore,
    components,
    weightedContributions,
    appliedPenalties,
    reason: llm?.reason ?? "unscored: model returned no valid judgement",
  };
}
