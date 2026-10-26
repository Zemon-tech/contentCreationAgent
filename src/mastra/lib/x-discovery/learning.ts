/**
 * Pure, unit-testable learning math for the X discovery subsystem.
 *
 * NFR / design invariant: the LLM judges MEANING only — every NUMBER that
 * affects promotion, demotion, credibility, or "official" status is computed
 * here in code from real scrape samples. Nothing in this file touches the
 * network, the clock, or storage; callers pass everything in.
 */

import type { XDiscoveryConfig } from "../../config/xDiscovery";
import type { DiscoveredAccount } from "./stores/discoveredAccounts";

/** Median of a numeric list (0 for empty). Does not mutate the input. */
export function median(nums: number[]): number {
  const xs = (nums || []).filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/** Spammy-text heuristic: giveaway / airdrop / engagement-bait patterns. */
const SPAM_RE = /giveaway|airdrop|follow.{0,10}retweet|RT to win|link in bio/i;

/** Fraction (0..1) of recent texts that look like engagement-bait / spam. */
function spamFraction(texts: string[]): number {
  const sample = (texts || []).filter((t) => typeof t === "string" && t.trim());
  if (sample.length === 0) return 0;
  const hits = sample.filter((t) => SPAM_RE.test(t)).length;
  return hits / sample.length;
}

/**
 * credibilityOf — a 0..10 score blending:
 *   - saturating familiarity (how many times we've seen the account),
 *   - median engagement relative to the promotion floor, and
 *   - a spam penalty from the recent-texts sample.
 *
 * Pure: depends only on the account snapshot and config thresholds.
 */
export function credibilityOf(account: DiscoveredAccount, config: XDiscoveryConfig): number {
  // Familiarity: saturates toward 1 as timesSeen approaches ~3x the promote floor.
  const seenFloor = Math.max(1, config.promoteMinTimesSeen);
  const familiarity = Math.min(1, account.timesSeen / (seenFloor * 3));

  // Engagement: median likes relative to the promotion floor, capped at 1.
  const likeFloor = Math.max(1, config.promoteMinMedianLikes);
  const engagement = Math.min(1, account.medianLikes / likeFloor);

  // Reposts add a small secondary signal (capped) so pure-like farms don't dominate.
  const repostFloor = Math.max(1, config.promoteMinMedianLikes / 4);
  const repostSignal = Math.min(1, account.medianReposts / repostFloor);

  // Weighted blend -> 0..10 before penalty.
  const base = 10 * (0.35 * familiarity + 0.45 * engagement + 0.2 * repostSignal);

  // Spam penalty: up to -6 points when the recent sample is all engagement-bait.
  const penalty = 6 * spamFraction(account.recentTexts ?? []);

  const score = base - penalty;
  return Math.max(0, Math.min(10, Math.round(score * 100) / 100));
}

/**
 * statusFor — promotion/demotion decision from the thresholds in config.
 *   promoted: enough sightings AND engagement AND credibility,
 *   demoted : credibility below the spam floor,
 *   candidate: everything in between.
 */
export function statusFor(
  account: DiscoveredAccount,
  config: XDiscoveryConfig,
): DiscoveredAccount["status"] {
  if (account.credibilityScore < config.demoteSpamCredibilityBelow) return "demoted";
  if (
    account.timesSeen >= config.promoteMinTimesSeen &&
    account.medianLikes >= config.promoteMinMedianLikes &&
    account.credibilityScore >= config.promoteMinCredibility
  ) {
    return "promoted";
  }
  return "candidate";
}

/**
 * FIX #2 / FIX #13: an account counts as "official" when it is promoted AND its
 * credibility clears the official floor, OR it is explicitly pinned in config.
 * Pinned handles are matched case-insensitively.
 */
export function isOfficialAccount(account: DiscoveredAccount, config: XDiscoveryConfig): boolean {
  const pinned = (config.pinnedHandles ?? []).some(
    (h) => h.replace(/^@/, "").toLowerCase() === account.handle.toLowerCase(),
  );
  if (pinned) return true;
  return account.status === "promoted" && account.credibilityScore >= config.officialMinCredibility;
}
