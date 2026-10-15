import { rankingConfig, type RankingConfig } from "../../config/ranking.config";
import type { RankInputItem, RankResult, RankedStory } from "../../schemas/ranking";
import { makeId, nowIso } from "../ids";
import { hardFilter, type BlockState } from "./hardFilter";
import { canonicalKeyForItem } from "../safety/ledger-key";
import { scoreItems, type RankGenerate } from "./llmScore";
import { computeRankedStory } from "./score";
import { selectTop } from "./select";
import { libSqlRankGateway, type RankStorageGateway } from "./storage";

/**
 * rankStories core — Stage A (hard filters) -> Stage B (LLM scoring) ->
 * Stage C (deterministic final score) -> Stage D (selection). Pure
 * orchestration with injectable storage + model so it runs identically in the
 * workflow, in `rank:eval`, and in tests.
 *
 * The LLM judges meaning; code does every number that decides ranking.
 */

export interface RankStoriesOptions {
  config?: RankingConfig;
  gateway?: RankStorageGateway;
  /** Injectable Stage B generator (tests/eval); defaults to the real model. */
  generate?: RankGenerate;
  now?: Date;
  /** Persist the run log (default true). */
  persist?: boolean;
  /** Structured logger; defaults to JSON lines on the console. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

export async function rankStories(
  items: RankInputItem[],
  opts: RankStoriesOptions = {},
): Promise<RankResult> {
  const config = opts.config ?? rankingConfig;
  const gateway = opts.gateway ?? libSqlRankGateway;
  const now = opts.now ?? new Date();
  const persist = opts.persist ?? true;
  const runId = makeId("rank");
  const startedAt = nowIso();
  const log =
    opts.log ??
    ((event, data) => console.log(JSON.stringify({ runId, step: event, ...data })));

  log("rank-start", { inputCount: items.length });

  // ---- Stage A: hard filters ----
  // Blocked set is keyed by CANONICAL key (url + content hash); translate to
  // item ids so an already-posted/rejected story is never re-selected, even
  // though its cluster/story id is regenerated each run.
  const blockedKeys = await gateway
    .getBlocked({ rejectedWithinHours: config.rejectedWithinHours, now })
    .catch((err) => {
      log("rank-storage-warn", { op: "getBlocked", error: String(err) });
      return new Map<string, BlockState>();
    });
  const blocked = new Map<string, BlockState>();
  for (const it of items) {
    const st = blockedKeys.get(canonicalKeyForItem(it));
    if (st) blocked.set(it.id, st);
  }
  const { kept, drops, droppedByReason } = hardFilter({ items, config, now, blocked });
  log("rank-hard-filter", {
    input: items.length,
    kept: kept.length,
    dropped: drops.length,
    droppedByReason,
  });

  // ---- Stage B: LLM scoring ----
  const { scores, unscoredIds, tokenEstimate } = await scoreItems(kept, {
    config,
    generate: opts.generate,
    log,
  });
  log("rank-llm-score", {
    scored: scores.size,
    unscored: unscoredIds.length,
    tokens: tokenEstimate.totalTokens,
    costUsd: tokenEstimate.costUsd,
  });

  // ---- Stage C: deterministic final score ----
  const recentRegions = await gateway.getRecentRegions(config.regionBalanceLookback).catch((err) => {
    log("rank-storage-warn", { op: "getRecentRegions", error: String(err) });
    return [];
  });
  const ranked: RankedStory[] = kept
    .map((item) => computeRankedStory(item, scores.get(item.id) ?? null, { config, now, recentRegions }))
    .sort((a, b) => b.finalScore - a.finalScore);

  // top-10 breakdown (observability)
  for (const [i, r] of ranked.slice(0, 10).entries()) {
    log("rank-top", {
      rank: i + 1,
      id: r.item.id,
      clusterId: r.item.clusterId,
      title: r.item.title.slice(0, 100),
      region: r.item.region,
      finalScore: r.finalScore,
      components: r.components,
      penalties: r.appliedPenalties,
      unscored: r.unscored,
      reason: r.reason,
    });
  }

  // ---- Stage D: selection ----
  const { selected, note } = selectTop(ranked, config);
  if (note) log("rank-no-winner", { note });
  for (const s of selected) {
    log("rank-selected", {
      id: s.item.id,
      clusterId: s.item.clusterId,
      title: s.item.title.slice(0, 120),
      finalScore: s.finalScore,
      url: s.item.url,
    });
  }

  const result: RankResult = {
    runId,
    startedAt,
    completedAt: nowIso(),
    inputCount: items.length,
    droppedCount: drops.length,
    droppedByReason,
    drops,
    scoredCount: scores.size,
    unscoredCount: unscoredIds.length,
    ranked,
    selected,
    ...(note ? { note } : {}),
    tokenEstimate,
  };

  if (persist) {
    await gateway.saveRunLog(result).catch((err) => log("rank-storage-warn", { op: "saveRunLog", error: String(err) }));
  }
  log("rank-done", {
    selected: selected.length,
    ranked: ranked.length,
    tokens: tokenEstimate.totalTokens,
  });
  return result;
}
