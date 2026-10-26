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
import {
  corroborationGroupKey,
  matchOutboundToRss,
  type CorroborationContext,
} from "./rankStories";

/**
 * Stage C — the deterministic score. Pure math, no LLM. Takes the model's
 * judgement (or null for unscored) plus code-derived signals and produces a
 * fully explainable score in two steps:
 *
 *   qualityScore = clamp(Σ wᵢ·componentᵢ + regionBalanceAdjustment − penalties, 0, 100)
 *   finalScore   = round2(qualityScore * recencyMultiplier)
 *
 * The recency weight is 0 — freshness never feeds qualityScore. Instead it is
 * applied LAST as a bounded [minMultiplier, maxMultiplier] multiplier so it
 * only breaks near-ties and can never promote a weak story.
 *
 * FIX #5 (INTENTIONAL, documented, NOT reweighted): a maxed UNCORROBORATED RSS
 * item earns 0 on the engagement component (X-only) and 0 on corroboration, so
 * its qualityScore caps at ~85 (100 − 10 engagement − 5 corroboration). It only
 * reaches ~90 when cross-corroborated. This is acceptable: ~85 still clears the
 * default minScore of 55 comfortably, and the cap keeps uncorroborated items a
 * notch below corroborated ones by design. Do NOT reweight to lift this cap.
 */

export interface ScoreContext {
  config?: RankingConfig;
  now?: Date;
  /** Regions of recent posts, most-recent first (for region balance). */
  recentRegions?: Region[];
  /** Pre-built corroboration context (RSS url set + credible-account counts). */
  corroboration?: CorroborationContext;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Pure X relative-engagement: how a post performs against the account's OWN
 * median, clamped and scaled to a 0-10 component. RSS items (no engagementRaw)
 * score 0. When the account has too few samples (median 0) we use the neutral
 * ratio so a credible-but-quiet account isn't punished.
 */
export function relativeEngagement(
  item: RankInputItem,
  config: RankingConfig,
): { ratio: number; component: number } {
  const eng = item.engagementRaw;
  if (item.isX !== true || !eng) return { ratio: 0, component: 0 };
  const x = config.x;
  const interactions = eng.likes + eng.reposts + eng.replies;
  const median = item.accountMedianLikes ?? 0;
  // A non-zero median implies the account has enough samples to be reliable.
  const hasEnoughSamples = median > 0;
  const ratio = hasEnoughSamples
    ? clamp(interactions / Math.max(median, 1), 0, x.engagementRatioCap)
    : x.neutralEngagementRatio;
  let component = clamp((ratio / x.engagementRatioCap) * 10, 0, 10);
  // Views contribute at most viewsBonusMax tenths (default 0 -> no effect).
  if (x.viewsBonusMax > 0 && eng.views > 0) {
    component = clamp(component + x.viewsBonusMax / 10, 0, 10);
  }
  return { ratio: round2(ratio), component: round2(component) };
}

/**
 * Pure X corroboration component (0-10). An X claim earns corroborationRssShare
 * of the 10 points when one of its outbound links matches an RSS source in the
 * run, plus corroborationMultiAccountShare when >=2 distinct promoted accounts
 * carry the same claim. RSS items score 0.
 */
export function corroborationComponent(
  item: RankInputItem,
  ctx: CorroborationContext | undefined,
  config: RankingConfig,
): number {
  if (item.isX !== true || !ctx) return 0;
  const x = config.x;
  let component = 0;
  if (matchOutboundToRss(item.outboundUrls, ctx.rssUrlSet)) {
    component += x.corroborationRssShare * 10;
  }
  const groupCount = ctx.credibleAccountsByGroup.get(corroborationGroupKey(item)) ?? 0;
  if (groupCount >= 2) {
    component += x.corroborationMultiAccountShare * 10;
  }
  return round2(clamp(component, 0, 10));
}

/** The bounded freshness multiplier applied LAST (never feeds qualityScore). */
export function recencyMultiplierOf(
  publishedAt: string,
  now: Date,
  config: RankingConfig,
): number {
  const { minMultiplier, maxMultiplier } = config.recencyTiebreaker;
  const age = ageInHours(publishedAt, now);
  if (age === null) return minMultiplier;
  const freshness = clamp(1 - age / config.maxAgeHours, 0, 1);
  return minMultiplier + (maxMultiplier - minMultiplier) * freshness;
}

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

  const engagement = relativeEngagement(item, config);
  const corroboration = corroborationComponent(item, ctx.corroboration, config);

  const components: ScoreComponents = {
    topicFit: llm?.topicFit ?? 0,
    significance: llm?.significance ?? 0,
    audienceInterest: llm?.audienceInterest ?? 0,
    visualPotential: llm?.visualPotential ?? 0,
    recencyScore: round2(recencyScore(item.publishedAt, now, config.recencyHalfLifeHours)),
    coverageScore: round2(coverageScore(item.clusterSourceCount, config.coverageCap)),
    sourceCredibility: sourceCredibilityOf(item.source, config),
    engagementComponent: engagement.component,
    engagementRatio: engagement.ratio,
    corroborationComponent: corroboration,
    regionBalanceAdjustment: regionBalanceAdjustment(item.region, recentRegions, config.regionBalanceBoost),
    penalties: 0, // filled below
    qualityScore: 0, // filled below
    recencyMultiplier: 1, // filled below
    recencyAdjustment: 0, // filled below
  };

  const w = config.weights;
  const weightedContributions: Record<string, number> = {
    topicFit: round2(w.topicFit * components.topicFit),
    significance: round2(w.significance * components.significance),
    audienceInterest: round2(w.audienceInterest * components.audienceInterest),
    visualPotential: round2(w.visualPotential * components.visualPotential),
    recency: round2(w.recency * components.recencyScore), // weight 0 -> always 0
    coverage: round2(w.coverage * components.coverageScore),
    sourceCredibility: round2(w.sourceCredibility * components.sourceCredibility),
    engagement: round2(w.engagement * components.engagementComponent),
    corroboration: round2(w.corroboration * components.corroborationComponent),
  };
  const weightedSum = Object.values(weightedContributions).reduce((a, b) => a + b, 0);

  // ---- Verification (FIX #2: read item.isOfficialAccount DIRECTLY) ----
  const corroboratedByRss = matchesRss(item, ctx.corroboration);
  const outboundPointsToPrimary = (item.outboundUrls?.length ?? 0) > 0 && (llm?.isPrimarySource ?? item.isPrimarySource ?? false);
  const isPrimarySource = llm?.isPrimarySource ?? item.isPrimarySource ?? false;
  const verified =
    item.isOfficialAccount === true ||
    isPrimarySource ||
    outboundPointsToPrimary ||
    corroboratedByRss;

  const claimRisk = llm?.claimRisk ?? item.claimRisk;

  // ---- Penalties ----
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
  // High-risk gate: an unverified high-risk claim is penalized AND blocked from
  // selection unless the operator explicitly allows it (config.x.allowUnverifiedHighRisk).
  let blockedUnlessOverride = false;
  if (!verified && claimRisk === "high") {
    appliedPenalties.push("unverifiedHighRisk");
    penaltyTotal += config.x.claimRiskHighPenalty;
    blockedUnlessOverride = true;
  }
  components.penalties = penaltyTotal;

  // ---- Quality score (freshness NOT included) ----
  const qualityScore = round2(
    clamp(weightedSum + components.regionBalanceAdjustment - penaltyTotal, 0, 100),
  );
  components.qualityScore = qualityScore;

  // ---- Recency tiebreaker applied LAST ----
  const recencyMultiplier = recencyMultiplierOf(item.publishedAt, now, config);
  components.recencyMultiplier = round2(recencyMultiplier);
  const finalScore = round2(qualityScore * recencyMultiplier);
  components.recencyAdjustment = round2(finalScore - qualityScore);

  const derivedHeadline = llm?.derivedHeadline ?? item.derivedHeadline;
  const hookPotential = llm?.hookPotential ?? item.hookPotential;

  return {
    item,
    llm,
    unscored,
    qualityScore,
    finalScore,
    components,
    weightedContributions,
    appliedPenalties,
    reason: llm?.reason ?? "unscored: model returned no valid judgement",
    ...(derivedHeadline !== undefined ? { derivedHeadline } : {}),
    ...(hookPotential !== undefined ? { hookPotential } : {}),
    ...(claimRisk !== undefined ? { claimRisk } : {}),
    verified,
    ...(item.outboundUrls ? { outboundUrls: item.outboundUrls } : {}),
    ...(item.quoted !== undefined ? { quoted: item.quoted } : {}),
    ...(blockedUnlessOverride ? { blockedUnlessOverride } : {}),
  };
}

/** True when the item is an X post corroborated by an RSS source in this run. */
function matchesRss(item: RankInputItem, ctx: CorroborationContext | undefined): boolean {
  if (item.isX !== true || !ctx) return false;
  return matchOutboundToRss(item.outboundUrls, ctx.rssUrlSet);
}
