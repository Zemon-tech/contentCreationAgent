import type { RankingConfig } from "../../config/ranking.config";
import { rankingConfig } from "../../config/ranking.config";
import type { RankedStory } from "../../schemas/ranking";

/**
 * Stage D — selection. Returns the top N survivors that clear MIN_SCORE, never
 * picking two stories from the same cluster. An empty result is a VALID outcome
 * ("no story worthy this run"), never an error.
 */
export function selectTop(
  ranked: RankedStory[],
  config: RankingConfig = rankingConfig,
): { selected: RankedStory[]; note?: string } {
  const sorted = [...ranked].sort((a, b) => b.finalScore - a.finalScore);
  const selected: RankedStory[] = [];
  const usedClusters = new Set<string>();

  for (const r of sorted) {
    if (selected.length >= config.topN) break;
    if (r.finalScore < config.minScore) continue;
    if (usedClusters.has(r.item.clusterId)) continue;
    usedClusters.add(r.item.clusterId);
    selected.push(r);
  }

  return selected.length === 0
    ? { selected, note: "no story worthy this run" }
    : { selected };
}
