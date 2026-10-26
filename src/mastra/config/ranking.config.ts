/**
 * ranking.config.ts — the ONE place to tune the news ranker.
 *
 * Everything the `rankStories` step uses to turn clustered items into a ranked
 * shortlist lives here: the page audience, the hard-filter rules, the Stage C
 * weights/half-life/caps, per-source credibility, region balance, penalties,
 * and selection thresholds. Change numbers here, never in the step code.
 *
 * Scales (so the quality score lands in 0-100):
 *   - LLM components (topicFit, significance, audienceInterest, visualPotential)
 *     and the code components (recency, coverage, sourceCredibility, engagement,
 *     corroboration) are each 0-10. The nine weights sum to EXACTLY 10, so
 *     Σ wᵢ·componentᵢ ∈ [0,100]. recency now carries weight 0 — it no longer
 *     feeds the quality score; freshness is applied LAST as a bounded
 *     [0.95,1.0] multiplier (recencyTiebreaker) to produce the final score.
 *   - engagement (0-10) is X-only (relative to the account's own median); RSS
 *     items score 0 there. corroboration (0-10) rewards an X claim that is
 *     backed by an RSS source or by multiple credible accounts.
 *   - regionBalanceAdjustment and penalties are applied to the quality score in
 *     points, then clamped to [0,100]; the recency multiplier is applied after.
 *
 * Env overrides (optional): RANK_MAX_AGE_HOURS, RANK_MIN_SCORE, RANK_TOP_N,
 * RANK_BATCH_SIZE, RANK_TEMPERATURE, RANK_RECENCY_HALFLIFE_HOURS,
 * RANK_ALLOW_UNVERIFIED_HIGH_RISK.
 */

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
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
  /** Max item age in hours; the single source of truth for the `too_old` drop. */
  maxAgeHours: number;
  /** Hard ceiling maxAgeHours can be raised to via env (defaults to 36). */
  maxAgeCeilingHours: number;
  /** "Already rejected" counts only if rejected within this many hours. */
  rejectedWithinHours: number;
  minSummaryLength: number;
  /** Case-insensitive substrings; a match in title OR summary drops the item. */
  blocklist: string[];
  /** Source names (lowercased) that are disabled regardless of upstream flag. */
  disabledSources: string[];

  // ---- Stage B: LLM scoring ----
  batchSize: number;
  concurrency: number;
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
    recency: number; // w5 — now 0; freshness is a final multiplier, not a weight
    coverage: number; // w6
    sourceCredibility: number; // w7
    engagement: number; // w8 — X-only relative engagement
    corroboration: number; // w9 — X claim backed by RSS or multiple accounts
  };
  /**
   * Recency tiebreaker. After the 0-100 quality score is computed, the final
   * score = qualityScore * recencyMultiplier, where the multiplier runs from
   * minMultiplier (oldest, at maxAgeHours) to maxMultiplier (freshest). Bounded
   * so freshness only breaks near-ties; it never promotes a weak story.
   */
  recencyTiebreaker: {
    minMultiplier: number;
    maxMultiplier: number;
  };
  /** Recency half-life in hours (kept for the recencyScore breakdown + unit test). */
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

  // ---- X-signal ranking knobs (global config; RSS items ignore these) ----
  x: {
    /** Drop an X item whose likes+reposts+replies is below this (hard filter). */
    minEngagementFloor: number;
    /** An X item with no outbound link must have at least this much text. */
    minTextLength: number;
    /** Relative-engagement ratio is clamped to [0, cap]. */
    engagementRatioCap: number;
    /** Ratio used when the account has too few samples for a reliable median. */
    neutralEngagementRatio: number;
    /** A non-zero accountMedianLikes implies at least this many samples. */
    minSamplesForMedian: number;
    /** Max points views can add to the engagement component (0 = tiebreak only). */
    viewsBonusMax: number;
    /** Share of the corroboration component earned by matching an RSS source. */
    corroborationRssShare: number;
    /** Share of the corroboration component earned by >=2 credible accounts. */
    corroborationMultiAccountShare: number;
    /** Quality-score penalty when an unverified item makes a high-risk claim. */
    claimRiskHighPenalty: number;
    /** Allow selecting an unverified high-risk (blocked) item. Default false. */
    allowUnverifiedHighRisk: boolean;
  };
}

export const rankingConfig: RankingConfig = {
  audience: AUDIENCE,

  // Default 24h, env-raisable up to the 36h ceiling (never beyond).
  maxAgeHours: Math.min(envNum("RANK_MAX_AGE_HOURS", 24), 36),
  maxAgeCeilingHours: 36,
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

  // Sarvam-tuned: Sarvam spends ~2k REASONING tokens per item on top of the
  // JSON text, so a big budget + small batch prevents the JSON being truncated
  // (which leaves items unscored). Matches lib/leads/judge.ts (16384 budget).
  // batchSize 1 is the robust default for Sarvam: a single item's JSON always
  // fits well under the budget even with its ~2k reasoning tokens, so nothing
  // is lost to truncation. Raise RANK_BATCH_SIZE for a cheaper model.
  batchSize: envNum("RANK_BATCH_SIZE", 1),
  // Model calls in flight at once. Sarvam calls are slow (~5s each) but
  // independent, so running a few in parallel cuts wall-clock time ~linearly.
  // Lower it (or set 1) if the provider starts returning 429s.
  concurrency: envNum("RANK_CONCURRENCY", 4),
  temperature: envNum("RANK_TEMPERATURE", 0.15),
  maxOutputTokens: envNum("RANK_MAX_OUTPUT_TOKENS", 16384),
  costPer1kTokensUsd: envNum("RANK_COST_PER_1K_TOKENS_USD", 0),

  // Quality-first weights. recency folded to 0 (freshness is a final
  // multiplier, see recencyTiebreaker); the freed 1.0 is redistributed to the
  // two new X-signal components. The nine weights sum to EXACTLY 10.0:
  //   2.5 + 2.0 + 1.5 + 1.0 + 0.0 + 0.75 + 0.75 + 1.0 + 0.5 = 10.0
  weights: {
    topicFit: 2.0,
    significance: 2.5,
    audienceInterest: 1.5,
    visualPotential: 1.0,
    recency: 0.0,
    coverage: 0.75,
    sourceCredibility: 0.75,
    engagement: 1.0,
    corroboration: 0.5,
  }, // sums to 10.0

  recencyTiebreaker: {
    minMultiplier: envNum("RANK_RECENCY_MIN_MULTIPLIER", 0.95),
    maxMultiplier: envNum("RANK_RECENCY_MAX_MULTIPLIER", 1.0),
  },
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

  // Conservative X-signal defaults. Every number env-overridable.
  x: {
    minEngagementFloor: envNum("RANK_X_MIN_ENGAGEMENT_FLOOR", 20),
    minTextLength: envNum("RANK_X_MIN_TEXT_LENGTH", 60),
    engagementRatioCap: envNum("RANK_X_ENGAGEMENT_RATIO_CAP", 3),
    neutralEngagementRatio: envNum("RANK_X_NEUTRAL_ENGAGEMENT_RATIO", 1),
    minSamplesForMedian: envNum("RANK_X_MIN_SAMPLES_FOR_MEDIAN", 3),
    // FIX #7: views contribute 0 points to the score; they break ties only.
    viewsBonusMax: envNum("RANK_X_VIEWS_BONUS_MAX", 0),
    corroborationRssShare: envNum("RANK_X_CORROBORATION_RSS_SHARE", 0.6),
    corroborationMultiAccountShare: envNum("RANK_X_CORROBORATION_MULTI_ACCOUNT_SHARE", 0.4),
    claimRiskHighPenalty: envNum("RANK_X_CLAIM_RISK_HIGH_PENALTY", 15),
    allowUnverifiedHighRisk: envFlag("RANK_ALLOW_UNVERIFIED_HIGH_RISK", false),
  },
};

/** Resolve a source's credibility (0-10) by normalized name. */
export function sourceCredibilityOf(
  source: string,
  config: RankingConfig = rankingConfig,
): number {
  const key = source.trim().toLowerCase();
  return config.sourceCredibility[key] ?? config.defaultSourceCredibility;
}
