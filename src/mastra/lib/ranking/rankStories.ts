import { rankingConfig, type RankingConfig } from "../../config/ranking.config";
import type { RankInputItem, RankResult, RankedStory } from "../../schemas/ranking";
import { makeId, nowIso } from "../ids";
import { normalizeUrl } from "../normalize";
import { hardFilter, type BlockState } from "./hardFilter";
import { canonicalKeyForItem } from "../safety/ledger-key";
import { scoreItems, type RankGenerate, type ScoreCache } from "./llmScore";
import { computeRankedStory } from "./score";
import { selectTop } from "./select";
import { libSqlRankGateway, type RankStorageGateway } from "./storage";

/**
 * Corroboration helpers — exported so FEAT-005's corroboration.test.ts can
 * target them directly. All pure; they NEVER touch storage or the network.
 */

/**
 * FIX #4: the ONE canonical URL key for corroboration. normalizeUrl strips
 * tracking/hash/AMP/trailing-slash but does NOT lowercase the host, so two
 * links that differ only in host case would miss. This wrapper lowercases the
 * host (and only the host) on top of normalizeUrl so matching is case-stable.
 */
export function urlKey(u: string): string {
  const normalized = normalizeUrl(u);
  try {
    const url = new URL(normalized);
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

/** The host portion of a urlKey, for host-level corroboration matching. */
function hostOf(u: string): string | null {
  try {
    return new URL(urlKey(u)).hostname;
  } catch {
    return null;
  }
}

/**
 * FIX #3: the ONE shared text-grouping key. Lowercase, NFKC-normalize, strip
 * punctuation, take the first 12 tokens. Used to cluster X items that cite the
 * same claim when they share no outbound host.
 */
export function groupTextKey(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .join(" ");
}

/**
 * True when any of the item's outbound URLs matches an RSS source in the run,
 * by full urlKey OR by host. Pure; takes the pre-built rssUrlSet.
 */
export function matchOutboundToRss(
  outboundUrls: string[] | undefined,
  rssUrlSet: Set<string>,
): boolean {
  if (!outboundUrls?.length || rssUrlSet.size === 0) return false;
  const rssHosts = new Set<string>();
  for (const k of rssUrlSet) {
    const h = hostOf(k);
    if (h) rssHosts.add(h);
  }
  for (const out of outboundUrls) {
    const key = urlKey(out);
    if (rssUrlSet.has(key)) return true;
    const h = hostOf(out);
    if (h && rssHosts.has(h)) return true;
  }
  return false;
}

/**
 * Pre-scoring corroboration context, assembled once from the kept list (no
 * gateway call) and injected into every computeRankedStory call.
 */
export interface CorroborationContext {
  /** urlKeys of every RSS (non-X) item's canonical URL in this run. */
  rssUrlSet: Set<string>;
  /** group key -> count of DISTINCT promoted author handles on that claim. */
  credibleAccountsByGroup: Map<string, number>;
}

/**
 * The group key an X item belongs to: its first shared outbound-URL host if it
 * has any outbound links, else its groupTextKey over title+summary.
 */
export function corroborationGroupKey(item: RankInputItem): string {
  const host = item.outboundUrls?.map(hostOf).find((h): h is string => Boolean(h));
  if (host) return `host:${host}`;
  return `text:${groupTextKey(`${item.title ?? ""} ${item.summary ?? ""}`)}`;
}

/** Build the CorroborationContext from the kept items. Pure. */
export function buildCorroborationContext(kept: RankInputItem[]): CorroborationContext {
  const rssUrlSet = new Set<string>(
    kept.filter((i) => i.isX !== true).map((i) => urlKey(i.url)),
  );

  // Group X items and count distinct promoted author handles per group.
  const handlesByGroup = new Map<string, Set<string>>();
  for (const i of kept) {
    if (i.isX !== true) continue;
    if (i.accountStatus !== "promoted") continue;
    const handle = (i.authorHandle ?? "").trim().toLowerCase();
    if (!handle) continue;
    const key = corroborationGroupKey(i);
    const set = handlesByGroup.get(key) ?? new Set<string>();
    set.add(handle);
    handlesByGroup.set(key, set);
  }
  const credibleAccountsByGroup = new Map<string, number>();
  for (const [key, set] of handlesByGroup) credibleAccountsByGroup.set(key, set.size);

  return { rssUrlSet, credibleAccountsByGroup };
}

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
  /** Optional Stage-B score cache (scheduled workflow only; never used by rank:eval). */
  scoreCache?: ScoreCache;
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
  const scoringStarted = Date.now();
  const { scores, unscoredIds, tokenEstimate, cacheHits } = await scoreItems(kept, {
    config,
    generate: opts.generate,
    log,
    cache: opts.scoreCache,
  });
  log("rank-llm-score", {
    scored: scores.size,
    cacheHits,
    modelCalls: tokenEstimate.calls,
    elapsedMs: Date.now() - scoringStarted,
    unscored: unscoredIds.length,
    tokens: tokenEstimate.totalTokens,
    costUsd: tokenEstimate.costUsd,
  });

  // ---- Stage C: deterministic final score ----
  const recentRegions = await gateway.getRecentRegions(config.regionBalanceLookback).catch((err) => {
    log("rank-storage-warn", { op: "getRecentRegions", error: String(err) });
    return [];
  });
  // Pre-scoring stage: build the corroboration context from the kept list (no
  // gateway call) so every X item can see the run's RSS sources and credible
  // accounts when its corroboration component is computed.
  const corroboration = buildCorroborationContext(kept);
  const ranked: RankedStory[] = kept
    .map((item) =>
      computeRankedStory(item, scores.get(item.id) ?? null, { config, now, recentRegions, corroboration }),
    )
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
