import { rankingConfig } from "./ranking.config";

/**
 * posting.config.ts — rate caps + the post-time score threshold. All env-driven.
 * These are the LAST safety gate before publish, independent of how often the
 * workflow runs: the schedule may fire every 30 min, but these decide whether a
 * post may actually go out.
 */

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface PostingConfig {
  /** Max real posts allowed in a rolling 24h window. */
  maxPostsPerDay: number;
  /** Minimum gap (hours) between two real posts. */
  minGapHours: number;
  /** Minimum final score (0-100) for a story to be eligible to post. */
  minScore: number;
  /** "Already rejected/failed" blocks re-selection for this many hours. */
  blockRejectedForHours: number;
}

export const postingConfig: PostingConfig = {
  maxPostsPerDay: envNum("POST_MAX_PER_DAY", 4),
  minGapHours: envNum("POST_MIN_GAP_HOURS", 0),
  // Defaults to the ranker's MIN_SCORE; override independently if desired.
  minScore: envNum("POST_MIN_SCORE", rankingConfig.minScore),
  blockRejectedForHours: envNum("POST_BLOCK_REJECTED_HOURS", rankingConfig.rejectedWithinHours),
};
