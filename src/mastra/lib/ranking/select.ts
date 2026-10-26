import type { RankingConfig } from "../../config/ranking.config";
import { rankingConfig } from "../../config/ranking.config";
import type { RankedStory } from "../../schemas/ranking";

/**
 * Stage D — selection. Returns the top N survivors that clear MIN_SCORE, never
 * picking two stories from the same cluster. An empty result is a VALID outcome
 * ("no story worthy this run"), never an error.
 */
/** Near-tie epsilon for the views tiebreak (final-score points). */
const TIE_EPSILON = 0.01;

export function selectTop(
  ranked: RankedStory[],
  config: RankingConfig = rankingConfig,
): { selected: RankedStory[]; note?: string } {
  // Sort by finalScore desc; FIX #7: within a near-tie, prefer more views.
  // RSS items (no engagementRaw) sort as 0 views — a stable no-op.
  const sorted = [...ranked].sort((a, b) => {
    const diff = b.finalScore - a.finalScore;
    if (Math.abs(diff) > TIE_EPSILON) return diff;
    const av = a.item.engagementRaw?.views ?? 0;
    const bv = b.item.engagementRaw?.views ?? 0;
    return bv - av;
  });
  const selected: RankedStory[] = [];
  const usedClusters = new Set<string>();

  for (const r of sorted) {
    if (selected.length >= config.topN) break;
    if (r.finalScore < config.minScore) continue;
    // High-risk gate: skip an unverified high-risk item unless overridden.
    if (r.blockedUnlessOverride && !config.x.allowUnverifiedHighRisk) continue;
    if (usedClusters.has(r.item.clusterId)) continue;
    usedClusters.add(r.item.clusterId);
    selected.push(r);
  }

  return selected.length === 0
    ? { selected, note: "no story worthy this run" }
    : { selected };
}
