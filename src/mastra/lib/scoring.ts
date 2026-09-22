import {
  DEFAULT_SCORING_WEIGHTS,
  type ScoringWeights,
} from "../config/industry";
import type { StoryScores } from "../schemas/story";

export interface ScoreInputs {
  relevance: number; // 0-10 (LLM or heuristic)
  novelty: number; // 0-10 (LLM or heuristic)
  impact: number; // 0-10 (LLM or heuristic)
  audienceInterest: number; // 0-10 (LLM or heuristic)
  contentPotential: number; // 0-10 (LLM or heuristic)
  velocity: number; // 0-10 deterministic
  authority: number; // 0-10 deterministic
}

/**
 * Deterministic weighted overall score (0-100). The LLM never computes
 * this — it only supplies judgment inputs; math stays in code.
 */
export function computeOverallScore(
  inputs: ScoreInputs,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  const total =
    weights.relevanceWeight +
    weights.noveltyWeight +
    weights.impactWeight +
    weights.velocityWeight +
    weights.authorityWeight +
    weights.audienceInterestWeight +
    weights.contentPotentialWeight;
  const w = (x: number) => x / (total || 1);
  const score10 =
    inputs.relevance * w(weights.relevanceWeight) +
    inputs.novelty * w(weights.noveltyWeight) +
    inputs.impact * w(weights.impactWeight) +
    inputs.velocity * w(weights.velocityWeight) +
    inputs.authority * w(weights.authorityWeight) +
    inputs.audienceInterest * w(weights.audienceInterestWeight) +
    inputs.contentPotential * w(weights.contentPotentialWeight);
  return Math.round(score10 * 10 * 10) / 10;
}

/**
 * Velocity 0-10 from recency + mention dynamics. Deterministic.
 * - fresh (<24h) multi-source clusters score highest
 * - single old mentions score lowest
 */
export function computeVelocity(
  firstSeenAt: string,
  lastUpdatedAt: string,
  mentionCount: number,
  sourceCount: number,
  now: Date = new Date(),
): number {
  const first = new Date(firstSeenAt).getTime();
  const last = new Date(lastUpdatedAt).getTime();
  const ageH = Math.max(0, (now.getTime() - first) / 3_600_000);
  const spanH = Math.max(0, (last - first) / 3_600_000);

  const recency = ageH <= 6 ? 4 : ageH <= 24 ? 3 : ageH <= 72 ? 2 : ageH <= 168 ? 1 : 0;
  const volume = Math.min(3, Math.log2(mentionCount + 1) * 1.5);
  const breadth = Math.min(2, sourceCount - 1);
  const developing = spanH > 1 && mentionCount > 1 ? 1 : 0;
  return Math.round(Math.min(10, recency + volume + breadth + developing) * 10) / 10;
}

/** Authority 0-10 = mean source authorityScore (0-100) / 10. Deterministic. */
export function computeAuthority(authorityScores: number[]): number {
  if (authorityScores.length === 0) return 0;
  const mean =
    authorityScores.reduce((s, v) => s + v, 0) / authorityScores.length;
  return Math.round(Math.min(10, mean / 10) * 10) / 10;
}

/** Engagement 0-10 from likes/comments/shares/views (log-scaled). */
export function computeEngagementScore(e: {
  likes?: number;
  comments?: number;
  shares?: number;
  views?: number;
}): number {
  const total =
    (e.likes ?? 0) + (e.comments ?? 0) * 3 + (e.shares ?? 0) * 4 + (e.views ?? 0) * 0.01;
  return Math.round(Math.min(10, Math.log10(total + 1) * 2.5) * 10) / 10;
}

/** Aggregate engagement across story members (summed channels). */
export function aggregateEngagementScore(
  members: { engagement?: { likes?: number; comments?: number; shares?: number; views?: number } }[],
): number {
  const sum = { likes: 0, comments: 0, shares: 0, views: 0 };
  for (const m of members) {
    sum.likes += m.engagement?.likes ?? 0;
    sum.comments += m.engagement?.comments ?? 0;
    sum.shares += m.engagement?.shares ?? 0;
    sum.views += m.engagement?.views ?? 0;
  }
  return computeEngagementScore(sum);
}

export function buildStoryScores(
  inputs: Omit<ScoreInputs, "velocity" | "authority"> & {
    velocity: number;
    authority: number;
  },
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): StoryScores {
  return {
    relevance: inputs.relevance,
    novelty: inputs.novelty,
    impact: inputs.impact,
    velocity: inputs.velocity,
    authority: inputs.authority,
    audienceInterest: inputs.audienceInterest,
    contentPotential: inputs.contentPotential,
    overall: computeOverallScore(inputs, weights),
  };
}

export function priorityForScore(overall: number): "low" | "medium" | "high" | "breaking" {
  if (overall >= 85) return "breaking";
  if (overall >= 70) return "high";
  if (overall >= 50) return "medium";
  return "low";
}
