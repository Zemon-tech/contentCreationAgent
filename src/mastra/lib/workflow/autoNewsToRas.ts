import type { RawContent } from "../../schemas/rawContent";
import type { RankInputItem, RankResult, Region } from "../../schemas/ranking";
import type { Story } from "../../schemas/story";
import type { RasPayload } from "../../schemas/handoff";
import { NEWS_FEED_SOURCES } from "../../config/newsFeeds";
import { ingestFeeds } from "../ingest-feeds";
import { collectXPosts } from "../collect-x-posts";
import { rankStories } from "../ranking/rankStories";
import { createScoreCache, cacheEnabled } from "../ranking/scoreCache";
import type { RankGenerate } from "../ranking/llmScore";
import { canonicalKey } from "../safety/ledger-key";
import { buildFactPack } from "../fact-pack";
import { sourceImage, type ImageResult } from "../image/sourcing";
import { buildRasPayload } from "../ras/payload";
import { writeEditorialCopy, type CopyGenerate } from "../ras/copywriter";
import type { CopyConfig } from "../../config/copy.config";
import { canPostNow, meetsScoreThreshold, type GateResult } from "../safety/posting-gate";

/**
 * Orchestration building blocks shared by the Mastra workflow and the dry-run
 * demo. Ingest -> (light map to rank items) -> rank -> select -> fact pack ->
 * image -> payload + safety gate. Nothing here publishes.
 *
 * NOTE: this uses a LIGHT mapping (each feed item = its own rank item). The
 * production path should run the existing cross-source clustering
 * (industryAggregationWorkflow) before ranking so clusterSourceCount reflects
 * real multi-source coverage. Flagged.
 */

export interface CollectRankSelect {
  rankResult: RankResult;
  selected: RankResult["selected"][number] | null;
  /** Feed image candidate URLs for the selected item. */
  feedCandidateUrls: string[];
  /** The raw content behind the selected item (for paywall/limited flags). */
  selectedRaw: RawContent | null;
  /** All ingested raws keyed by item id (for image candidates / flags per item). */
  rawById: Map<string, RawContent>;
  itemsConsidered: number;
}

/** Feed image candidate URLs for a given raw content item. */
export function feedCandidatesFor(raw: RawContent | null | undefined): string[] {
  return (raw?.imageCandidates ?? []).map((c) => c.url);
}

function rawToRankItem(raw: RawContent): RankInputItem {
  const summary = (raw.content || raw.title || "").replace(/\s+/g, " ").trim().slice(0, 800);
  return {
    id: raw.id,
    clusterId: canonicalKey(raw.url, raw.title || "", summary),
    title: (raw.title || "").trim(),
    summary,
    url: raw.url,
    source: raw.sourceName,
    region: ((raw.metadata?.["region"] as Region) ?? "GLOBAL"),
    publishedAt: raw.publishedAt ?? raw.collectedAt,
    rawCategories: [],
    clusterSourceCount: 1,
  };
}

export async function collectRankSelect(opts: {
  rankGenerate?: RankGenerate;
  now?: Date;
  /** Persist ingestion state (feed health, dedup). Tied to the publish path:
   *  false in dry-run so a dry-run never mutates ingestion state. */
  persist?: boolean;
  /**
   * Persist the ranking RUN LOG to the `rank_runs` table. This is observability,
   * NOT publish state, so it defaults to ON independently of `persist` — a
   * dry-run still leaves a queryable, inspectable record for tuning. Set false
   * only for offline/heuristic previews that shouldn't touch the DB.
   */
  persistRankLog?: boolean;
  log?: (ev: string, data: Record<string, unknown>) => void;
}): Promise<CollectRankSelect> {
  const { items: feedRaws } = await ingestFeeds({ sources: NEWS_FEED_SOURCES, dryRun: !(opts.persist ?? false), now: opts.now });

  // Merge in the X/Twitter signal: READ the posts the X discovery subsystem
  // saved on its own schedule (collect-x-posts no longer scrapes). Each post is
  // a signal-only candidate story. Fails soft — if X discovery is disabled or
  // the store read fails, this contributes nothing and the feed-only run is
  // unchanged.
  let xRaws: RawContent[] = [];
  try {
    const xResult = await collectXPosts({ log: opts.log, now: opts.now });
    xRaws = xResult.items;
    opts.log?.("x.collected", {
      items: xRaws.length,
      perAccount: xResult.perAccount,
    });
  } catch (err) {
    // Belt-and-braces: collectXPosts already fails soft, but never let an X
    // problem break the news pipeline.
    opts.log?.("x.collect.error", { error: err instanceof Error ? err.message : String(err) });
  }

  const raws = [...feedRaws, ...xRaws];
  const rawById = new Map(raws.map((r) => [r.id, r]));
  const rankItems = raws.map(rawToRankItem);

  const rankResult = await rankStories(rankItems, {
    generate: opts.rankGenerate,
    // Re-use judgements for articles already scored in a recent cycle.
    ...(cacheEnabled() && !opts.rankGenerate ? { scoreCache: createScoreCache() } : {}),
    now: opts.now,
    // Rank log is observability: persist it even in dry-run (decoupled from `persist`).
    persist: opts.persistRankLog ?? true,
    log: opts.log,
  });

  const selected = rankResult.selected[0] ?? null;
  const selectedRaw = selected ? rawById.get(selected.item.id) ?? null : null;
  const feedCandidateUrls = (selectedRaw?.imageCandidates ?? []).map((c) => c.url);

  return { rankResult, selected, feedCandidateUrls, selectedRaw, rawById, itemsConsidered: rankItems.length };
}

function itemToMinimalStory(item: RankInputItem, finalScore: number): Story {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    whatHappened: item.summary,
    whyItMatters: "",
    topics: item.rawCategories ?? [],
    entities: [],
    sources: [item.url],
    contentIds: [item.id],
    firstSeenAt: item.publishedAt,
    lastUpdatedAt: item.publishedAt,
    status: "stable",
    scores: { relevance: 0, novelty: 0, impact: 0, velocity: 0, authority: 0, audienceInterest: 0, contentPotential: 0, overall: finalScore },
    confidence: 0.5,
    possibleAngles: ["Why it matters"],
  };
}

export interface PreparedPost {
  payload: RasPayload;
  image: ImageResult;
  caps: GateResult;
  scoreOk: boolean;
}

export interface PostableCandidate {
  item: RankInputItem;
  finalScore: number;
  reason: string;
  prepared: PreparedPost;
}

/**
 * Walk down the ranked list (score >= threshold, one per cluster, best first)
 * and return the first story that ALSO has a validated image. RAS's story
 * template needs a hero image, so an image-less top story must not block the
 * run — we move to the next-best. Returns null when none qualifies (a valid
 * "nothing postable this run" outcome, not an error).
 */
export async function pickPostableCandidate(args: {
  rankResult: RankResult;
  rawById: Map<string, RawContent>;
  minScore: number;
  maxTries?: number;
  now?: Date;
  prepare?: typeof prepareForHandoff;
}): Promise<{ candidate: PostableCandidate | null; tried: number; skippedNoImage: string[] }> {
  const prepare = args.prepare ?? prepareForHandoff;
  const maxTries = args.maxTries ?? 5;
  const seenClusters = new Set<string>();
  const skippedNoImage: string[] = [];
  let tried = 0;

  for (const r of args.rankResult.ranked) {
    if (tried >= maxTries) break;
    if (r.finalScore < args.minScore) break; // ranked is sorted desc
    if (seenClusters.has(r.item.clusterId)) continue;
    seenClusters.add(r.item.clusterId);
    tried++;

    const raw = args.rawById.get(r.item.id) ?? null;
    const prepared = await prepare({
      item: r.item,
      finalScore: r.finalScore,
      raw,
      feedCandidateUrls: feedCandidatesFor(raw),
      now: args.now,
    });
    if (prepared.payload.imageLocalPath) {
      return { candidate: { item: r.item, finalScore: r.finalScore, reason: r.reason, prepared }, tried, skippedNoImage };
    }
    skippedNoImage.push(r.item.title.slice(0, 80));
  }
  return { candidate: null, tried, skippedNoImage };
}

export async function prepareForHandoff(args: {
  item: RankInputItem;
  finalScore: number;
  raw: RawContent | null;
  feedCandidateUrls: string[];
  now?: Date;
  /** Inject the copywriter's model (demos stub this offline). Omit = real Sarvam. */
  copyGenerate?: CopyGenerate;
  /** Override the copy config (demos disable Exa to stay fully offline). */
  copyConfig?: CopyConfig;
  log?: (ev: string, data: Record<string, unknown>) => void;
}): Promise<PreparedPost> {
  const log = args.log ?? ((ev, data) => console.log(JSON.stringify({ step: "copy", ev, ...data })));
  const limited = !!(args.raw?.paywalled || args.raw?.factPackLimited || args.raw?.viaFallback);
  const story = itemToMinimalStory(args.item, args.finalScore);
  const factPack = buildFactPack(story, { limited, sourceUrls: [args.item.url] });
  const image = await sourceImage({ headline: args.item.title, feedCandidateUrls: args.feedCandidateUrls });

  // LLM editorial copy (Exa-enriched). Fails open to the deterministic template.
  const { copy, enrichedSourceUrls } = await writeEditorialCopy({
    item: args.item,
    factPack,
    ...(args.copyGenerate ? { generate: args.copyGenerate } : {}),
    ...(args.copyConfig ? { config: args.copyConfig } : {}),
    log,
  });

  const payload = buildRasPayload({
    item: args.item,
    factPack,
    image,
    suggestedCaptionAngle: "Why it matters",
    llmCopy: copy,
    extraSourceUrls: enrichedSourceUrls,
  });
  const caps = await canPostNow({ now: args.now });
  const scoreOk = meetsScoreThreshold(args.finalScore);
  return { payload, image, caps, scoreOk };
}
