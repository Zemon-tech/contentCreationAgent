import { postingConfig, type PostingConfig } from "../../config/posting.config";
import { countPostedLast24h, lastPostedAt } from "../../repositories/postedLedger";

/**
 * Rate caps (Step 7): max posts/day + minimum gap between posts. Independent of
 * how often the workflow runs — the schedule may fire every 30 min, but a post
 * only goes out when these clear. A "no" here is a valid outcome, not an error.
 */

export interface GateResult {
  ok: boolean;
  reason?: string;
  postsLast24h: number;
  lastPostedAt: string | null;
}

/** Pure caps rule (testable without a DB). */
export function evaluateCaps(args: { postsLast24h: number; lastPostedAt: string | null; now: Date; config?: PostingConfig }): GateResult {
  const cfg = args.config ?? postingConfig;
  const { postsLast24h, lastPostedAt: last, now } = args;
  if (postsLast24h >= cfg.maxPostsPerDay) {
    return { ok: false, reason: `daily cap reached (${postsLast24h}/${cfg.maxPostsPerDay} in 24h)`, postsLast24h, lastPostedAt: last };
  }
  if (last) {
    const gapH = (now.getTime() - Date.parse(last)) / 3_600_000;
    if (gapH < cfg.minGapHours) {
      return { ok: false, reason: `min gap not met (${gapH.toFixed(1)}h < ${cfg.minGapHours}h)`, postsLast24h, lastPostedAt: last };
    }
  }
  return { ok: true, postsLast24h, lastPostedAt: last };
}

export async function canPostNow(opts: { now?: Date; config?: PostingConfig } = {}): Promise<GateResult> {
  const now = opts.now ?? new Date();
  const postsLast24h = await countPostedLast24h(now);
  const last = await lastPostedAt();
  return evaluateCaps({ postsLast24h, lastPostedAt: last, now, config: opts.config });
}

export function meetsScoreThreshold(score: number, config: PostingConfig = postingConfig): boolean {
  return score >= config.minScore;
}
