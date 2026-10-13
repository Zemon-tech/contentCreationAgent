/**
 * ranking.config.ts — the ONE place to tune the news ranker.
 *
 * Everything the `rankStories` step uses to turn clustered items into a ranked
 * shortlist lives here: the page audience, the hard-filter rules, the Stage C
 * weights/half-life/caps, per-source credibility, region balance, penalties,
 * and selection thresholds. Change numbers here, never in the step code.
 *
 * Scales (so the final score lands in 0-100):
 *   - LLM components (topicFit, significance, audienceInterest, visualPotential)
 *     and the code components (recency, coverage, sourceCredibility) are each
 *     0-10. The weights `w1..w7` sum to 10, so Σ wᵢ·componentᵢ ∈ [0,100].
 *   - regionBalanceAdjustment and penalties are applied afterwards in
 *     final-score points, then the result is clamped to [0,100].
 *
 * Env overrides (optional): RANK_MAX_AGE_HOURS, RANK_MIN_SCORE, RANK_TOP_N,
 * RANK_BATCH_SIZE, RANK_TEMPERATURE, RANK_RECENCY_HALFLIFE_HOURS.
 */

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The Instagram page audience. Injected into the Stage B system prompt so the
 * model's `audienceInterest` judgement is anchored to the real readers.
 */
export const AUDIENCE =
  "Indian students, early-career people, and founders who follow AI, startups, " +
  "and deeptech. They want things that are new, significant, and understandable " +
  "at a glance. They do NOT want hype, rumors, or inside-baseball finance.";

export interface RankingConfig {
  audience: string;

  // ---- Stage A: hard filters (pure code, no LLM) ----
  maxAgeHours: number;
  /** "Already rejected" counts only if rejected within this many hours. */
  rejectedWithinHours: number;
  minSummaryLength: number;
  /** Case-insensitive substrings; a match in title OR summary drops the item. */
  blocklist: string[];
  /** Source names (lowercased) that are disabled regardless of upstream flag. */
  disabledSources: string[];

  // ---- Stage B: LLM scoring ----
  batchSize: number;
  temperature: number;
  maxOutputTokens: number;
  /** USD per 1k total tokens, for the cost estimate. 0 for a free local model. */
  costPer1kTokensUsd: number;

  // ---- Stage C: deterministic final score ----
  weights: {
    topicFit: number; // w1
    significance: number; // w2
    audienceInterest: number; // w3
    visualPotential: number; // w4
    recency: number; // w5
    coverage: number; // w6
    sourceCredibility: number; // w7
  };
  /** Recency half-life in hours (exponential decay). */
  recencyHalfLifeHours: number;
  /** clusterSourceCount at/above which coverageScore saturates at 10. */
  coverageCap: number;
  /** Per-source credibility, 0-10, keyed by lowercased source name. */
  sourceCredibility: Record<string, number>;
  defaultSourceCredibility: number;

  // ---- Region balance (small nudge, never promotes a weak story) ----
  /** How many recent posts to inspect for US/IN balance. */
  regionBalanceLookback: number;
  /** Final-score points added to the under-represented region's items. */
  regionBalanceBoost: number;

  // ---- Penalties (subtracted, final-score points) ----
  penalties: {
    isOpinionOrRumor: number;
    isClickbait: number;
    isDuplicateAngle: number;
    unscored: number;
  };

  // ---- Stage D: selection ----
  topN: number;
  minScore: number;
}

export const rankingConfig: RankingConfig = {
  audience: AUDIENCE,

  maxAgeHours: envNum("RANK_MAX_AGE_HOURS", 6),
  rejectedWithinHours: envNum("RANK_REJECTED_WITHIN_HOURS", 24 * 7),
  minSummaryLength: envNum("RANK_MIN_SUMMARY_LENGTH", 40),
  blocklist: [
    // Sports
    "cricket", "ipl", "football", "fifa", "nba", "match highlights", "tournament",
    // Celebrity / entertainment
    "bollywood", "hollywood", "box office", "celebrity", "actor", "actress",
    "red carpet", "dating rumor",
    // Horoscope / astrology
    "horoscope", "zodiac", "astrology", "rashifal",
    // Crime
    "murder", "rape", "assault", "robbery", "shooting",
    // Election politics
    "election", "vote share", "exit poll", "campaign rally", "lok sabha",
    "parliament seat", "ballot",
  ],
  disabledSources: [],

  batchSize: envNum("RANK_BATCH_SIZE", 10),
  temperature: envNum("RANK_TEMPERATURE", 0.15),
  maxOutputTokens: envNum("RANK_MAX_OUTPUT_TOKENS", 4000),
  costPer1kTokensUsd: envNum("RANK_COST_PER_1K_TOKENS_USD", 0),

  weights: {
    topicFit: 2.0,
    significance: 2.5,
    audienceInterest: 2.0,
    visualPotential: 1.0,
    recency: 1.0,
    coverage: 0.75,
    sourceCredibility: 0.75,
  }, // sums to 10.0

  recencyHalfLifeHours: envNum("RANK_RECENCY_HALFLIFE_HOURS", 3),
  coverageCap: envNum("RANK_COVERAGE_CAP", 5),
  sourceCredibility: {
    "wall street journal": 9,
    wsj: 9,
    "mit technology review": 9,
    "the verge": 8,
    techcrunch: 8,
    "ars technica": 8,
    reuters: 9,
    bloomberg: 8,
    "the information": 8,
    "economic times": 7,
    "et tech": 7,
    inc42: 7,
    "analytics india magazine": 7,
    aim: 7,
    venturebeat: 7,
    yourstory: 6,
    entrackr: 6,
    moneycontrol: 6,
    cnn: 6,
    "hacker news": 5,
  },
  defaultSourceCredibility: envNum("RANK_DEFAULT_SOURCE_CREDIBILITY", 3),

  regionBalanceLookback: envNum("RANK_REGION_LOOKBACK", 3),
  regionBalanceBoost: envNum("RANK_REGION_BOOST", 3),

  penalties: {
    isOpinionOrRumor: envNum("RANK_PENALTY_OPINION_RUMOR", 25),
    isClickbait: envNum("RANK_PENALTY_CLICKBAIT", 20),
    isDuplicateAngle: envNum("RANK_PENALTY_DUPLICATE", 15),
    unscored: envNum("RANK_PENALTY_UNSCORED", 30),
  },

  topN: envNum("RANK_TOP_N", 1),
  minScore: envNum("RANK_MIN_SCORE", 55),
};

/** Resolve a source's credibility (0-10) by normalized name. */
export function sourceCredibilityOf(
  source: string,
  config: RankingConfig = rankingConfig,
): number {
  const key = source.trim().toLowerCase();
  return config.sourceCredibility[key] ?? config.defaultSourceCredibility;
}
