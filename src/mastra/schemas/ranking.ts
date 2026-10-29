import { z } from "zod";

/**
 * Schemas for the `rankStories` step (Stage 3 of the news pipeline).
 *
 * Boundaries (the spec's rule: the LLM judges meaning, code does the math):
 *   - RankInputItem  : the deduplicated, clustered item the step consumes.
 *   - LlmScore       : Stage B structured output — ONLY the model's judgement.
 *                      The model never produces the final number.
 *   - RankedStory    : Stage C/D result — final score + every component so a
 *                      run is fully explainable.
 *   - RankResult     : the whole run (ranked list, selection, drop log, cost).
 */

/**
 * Region. The spec names only US | IN, but the live source registry includes
 * outlets that are neither (e.g. MIT Tech Review, The Verge are tagged US;
 * truly global wire copy is GLOBAL). GLOBAL items simply get no region-balance
 * adjustment — see config/ranking.config.ts.
 */
export const RegionSchema = z.enum(["US", "IN", "GLOBAL"]);
export type Region = z.infer<typeof RegionSchema>;

/** The clustered item `rankStories` consumes (spec's input shape, adapted). */
export const RankInputItemSchema = z.object({
  id: z.string().min(1),
  clusterId: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  url: z.string(),
  source: z.string(),
  region: RegionSchema,
  /** ISO-8601 publication time (event time where known). */
  publishedAt: z.string(),
  imageUrl: z.string().optional(),
  rawCategories: z.array(z.string()).default([]),
  /** Independent sources covering this cluster — a coverage signal. */
  clusterSourceCount: z.number().int().min(1).default(1),
  /** Optional: upstream can mark a source disabled; config can also disable. */
  sourceDisabled: z.boolean().optional(),

  // ---- X-signal fields (optional; absent/false for RSS items) ----
  /** True when this item came from the X discovery subsystem. */
  isX: z.boolean().optional(),
  isReply: z.boolean().optional(),
  isRepost: z.boolean().optional(),
  /** Non-X outbound URLs cited by the post (normalized, host-lowercased). */
  outboundUrls: z.array(z.string()).optional(),
  /** The quoted post, if any (carried for attribution). */
  quoted: z
    .object({
      text: z.string(),
      author_handle: z.string().nullable(),
      url: z.string(),
      at: z.string(),
    })
    .nullable()
    .optional(),
  /** Author handle, lowercased. */
  authorHandle: z.string().optional(),
  /** Raw engagement counts from the scrape. */
  engagementRaw: z
    .object({
      likes: z.number(),
      reposts: z.number(),
      replies: z.number(),
      views: z.number(),
    })
    .optional(),
  /** The author account's median likes/reposts (0 when too few samples). */
  accountMedianLikes: z.number().optional(),
  accountMedianReposts: z.number().optional(),
  /** Learned account status; the mapper defaults this to 'candidate'. */
  accountStatus: z.string().optional(),
  /** FIX #2: read directly (never recomputed from account fields in scoring). */
  isOfficialAccount: z.boolean().optional(),
  accountCredibilityScore: z.number().optional(),
  // Carried LLM meaning fields the scorer reads for X items.
  isPrimarySource: z.boolean().optional(),
  claimRisk: z.enum(["low", "medium", "high"]).optional(),
  derivedHeadline: z.string().optional(),
  hookPotential: z.number().optional(),
});
export type RankInputItem = z.infer<typeof RankInputItemSchema>;

export const TopicSchema = z.enum(["ai", "startups", "deeptech", "other"]);
export type Topic = z.infer<typeof TopicSchema>;

/**
 * Stage B structured output for ONE item. These are the model's judgements of
 * meaning only — never the final ranking number. Validated with safeParse;
 * on failure the item is retried once, then marked `unscored`.
 */
export const LlmScoreSchema = z.object({
  // Default "" (not min(1)): the model sometimes omits the echoed id. With
  // batchSize 1 the caller re-attaches the only valid id, so a missing id must
  // NOT reject the whole batch (which would mark the item unscored + penalized).
  id: z.string().default(""),
  topic: TopicSchema,
  topicFit: z.number().min(0).max(10),
  significance: z.number().min(0).max(10),
  audienceInterest: z.number().min(0).max(10),
  visualPotential: z.number().min(0).max(10),
  isOpinionOrRumor: z.boolean(),
  isClickbait: z.boolean(),
  isDuplicateAngle: z.boolean(),
  // ---- New meaning-only judgements (code still owns every number) ----
  // The newer meaning fields below are DEFAULTED, not strictly required: the
  // live model (Sarvam) does not always emit every one, and dropping an
  // otherwise-good score over a missing flag marks the whole story `unscored`
  // and penalizes it — which silently cripples ranking. Defaulting keeps the
  // story scored while the LLM/code boundary is preserved (code still owns the
  // numbers). The core judgement fields above stay required.
  /** Does this add genuinely new information (vs a recap/aggregation)? */
  isNewInformation: z.boolean().default(false),
  /** Is the item itself the primary source (first-party announcement/report)? */
  isPrimarySource: z.boolean().default(false),
  /** How concrete/specific the claim is (0 vague … 10 precise). */
  specificity: z.number().min(0).max(10).default(5),
  /** How strong a scroll-stopping hook it has (0 none … 10 strong). */
  hookPotential: z.number().min(0).max(10).default(5),
  /** The model's read of how risky the central claim is if unverified. */
  claimRisk: z.enum(["low", "medium", "high"]).default("low"),
  /** Meaning-only red flags. Each defaults false so a missing flag never
   *  invalidates an otherwise-valid score. */
  flags: z
    .object({
      engagementBait: z.boolean().default(false),
      selfPromotion: z.boolean().default(false),
      giveaway: z.boolean().default(false),
      hotTakeThread: z.boolean().default(false),
    })
    .partial()
    .default({}),
  /** A factual headline the model derived (especially for raw X posts). */
  derivedHeadline: z.string().max(200).default(""),
  /** Proof the headline was derived, not copied blindly. Tolerant of omission. */
  headlineDerived: z.literal(true).optional(),
  reason: z.string().max(400),
});
export type LlmScore = z.infer<typeof LlmScoreSchema>;

/** The whole batch response. Wrapped in an object so extractJson finds it. */
export const LlmBatchResponseSchema = z.object({
  scores: z.array(LlmScoreSchema),
});
export type LlmBatchResponse = z.infer<typeof LlmBatchResponseSchema>;

/** Every additive/subtractive component behind a final score (0-100 points). */
export const ScoreComponentsSchema = z.object({
  // LLM-judged components (0-10 each; 0 when unscored).
  topicFit: z.number(),
  significance: z.number(),
  audienceInterest: z.number(),
  visualPotential: z.number(),
  // Code-derived components (0-10 each).
  recencyScore: z.number(),
  coverageScore: z.number(),
  sourceCredibility: z.number(),
  /** X-only relative-engagement component (0-10; 0 for RSS). */
  engagementComponent: z.number(),
  /** The clamped engagement ratio behind engagementComponent (explainability). */
  engagementRatio: z.number(),
  /** X corroboration component (0-10; 0 for RSS). */
  corroborationComponent: z.number(),
  // Final-score-point adjustments (already on the 0-100 scale).
  regionBalanceAdjustment: z.number(),
  penalties: z.number(),
  /** The 0-100 quality score before the recency multiplier. */
  qualityScore: z.number(),
  /** Freshness multiplier applied LAST to produce the final score. */
  recencyMultiplier: z.number(),
  /** finalScore − qualityScore (how much freshness moved the score). */
  recencyAdjustment: z.number(),
});
export type ScoreComponents = z.infer<typeof ScoreComponentsSchema>;

/** One ranked story with its full, explainable breakdown. */
export const RankedStorySchema = z.object({
  item: RankInputItemSchema,
  llm: LlmScoreSchema.nullable(),
  unscored: z.boolean(),
  /** 0-100 quality score before the recency multiplier. */
  qualityScore: z.number().min(0).max(100),
  /** 0-100, after weighting + adjustments + penalties, clamped, times recency. */
  finalScore: z.number().min(0).max(100),
  components: ScoreComponentsSchema,
  /** Weighted point contribution of each component to the final score. */
  weightedContributions: z.record(z.string(), z.number()),
  /** Names of penalties that applied (e.g. "isClickbait", "unscored"). */
  appliedPenalties: z.array(z.string()),
  /** The model's one-line reason, or an explanation when unscored. */
  reason: z.string(),
  // ---- Optional X-signal explainability / gating ----
  /** The derived factual headline (carried through for the copywriter). */
  derivedHeadline: z.string().optional(),
  hookPotential: z.number().optional(),
  claimRisk: z.enum(["low", "medium", "high"]).optional(),
  /** True when the item/source is verified (official, primary, or corroborated). */
  verified: z.boolean().optional(),
  outboundUrls: z.array(z.string()).optional(),
  quoted: z
    .object({
      text: z.string(),
      author_handle: z.string().nullable(),
      url: z.string(),
      at: z.string(),
    })
    .nullable()
    .optional(),
  /** Attribution line for an X-sourced story. */
  attributionLine: z.string().optional(),
  /** True for an unverified high-risk claim; selection skips it unless overridden. */
  blockedUnlessOverride: z.boolean().optional(),
});
export type RankedStory = z.infer<typeof RankedStorySchema>;

/** A single Stage-A drop, for the grouped-by-reason log. */
export const DropRecordSchema = z.object({
  id: z.string(),
  clusterId: z.string(),
  reason: z.string(),
  detail: z.string().optional(),
});
export type DropRecord = z.infer<typeof DropRecordSchema>;

export const TokenEstimateSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  calls: z.number(),
  costUsd: z.number(),
});
export type TokenEstimate = z.infer<typeof TokenEstimateSchema>;

/** The full, inspectable result of one ranking run. */
export const RankResultSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  inputCount: z.number(),
  droppedCount: z.number(),
  droppedByReason: z.record(z.string(), z.number()),
  drops: z.array(DropRecordSchema),
  scoredCount: z.number(),
  unscoredCount: z.number(),
  /** All survivors, ranked by finalScore desc. */
  ranked: z.array(RankedStorySchema),
  /** Top N clearing MIN_SCORE, one per cluster. May be empty (valid). */
  selected: z.array(RankedStorySchema),
  /** Set when nothing cleared the threshold. */
  note: z.string().optional(),
  tokenEstimate: TokenEstimateSchema,
});
export type RankResult = z.infer<typeof RankResultSchema>;
