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
  id: z.string().min(1),
  topic: TopicSchema,
  topicFit: z.number().min(0).max(10),
  significance: z.number().min(0).max(10),
  audienceInterest: z.number().min(0).max(10),
  visualPotential: z.number().min(0).max(10),
  isOpinionOrRumor: z.boolean(),
  isClickbait: z.boolean(),
  isDuplicateAngle: z.boolean(),
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
  // Final-score-point adjustments (already on the 0-100 scale).
  regionBalanceAdjustment: z.number(),
  penalties: z.number(),
});
export type ScoreComponents = z.infer<typeof ScoreComponentsSchema>;

/** One ranked story with its full, explainable breakdown. */
export const RankedStorySchema = z.object({
  item: RankInputItemSchema,
  llm: LlmScoreSchema.nullable(),
  unscored: z.boolean(),
  /** 0-100, after weighting + adjustments + penalties, clamped. */
  finalScore: z.number().min(0).max(100),
  components: ScoreComponentsSchema,
  /** Weighted point contribution of each component to the final score. */
  weightedContributions: z.record(z.string(), z.number()),
  /** Names of penalties that applied (e.g. "isClickbait", "unscored"). */
  appliedPenalties: z.array(z.string()),
  /** The model's one-line reason, or an explanation when unscored. */
  reason: z.string(),
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
