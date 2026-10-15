import type { RawContent } from "../../schemas/rawContent";
import type { RankInputItem, RankResult, Region } from "../../schemas/ranking";
import type { Story } from "../../schemas/story";
import type { RasPayload } from "../../schemas/handoff";
import { NEWS_FEED_SOURCES } from "../../config/newsFeeds";
import { ingestFeeds } from "../ingest-feeds";
import { rankStories } from "../ranking/rankStories";
import type { RankGenerate } from "../ranking/llmScore";
import { canonicalKey } from "../safety/ledger-key";
import { buildFactPack } from "../fact-pack";
import { sourceImage, type ImageResult } from "../image/sourcing";
import { buildRasPayload } from "../ras/payload";
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
  persist?: boolean;
  log?: (ev: string, data: Record<string, unknown>) => void;
}): Promise<CollectRankSelect> {
  const { items: raws } = await ingestFeeds({ sources: NEWS_FEED_SOURCES, dryRun: !(opts.persist ?? false), now: opts.now });
  const rawById = new Map(raws.map((r) => [r.id, r]));
  const rankItems = raws.map(rawToRankItem);

  const rankResult = await rankStories(rankItems, {
    generate: opts.rankGenerate,
    now: opts.now,
    persist: opts.persist ?? false,
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

export async function prepareForHandoff(args: {
  item: RankInputItem;
  finalScore: number;
  raw: RawContent | null;
  feedCandidateUrls: string[];
  now?: Date;
}): Promise<PreparedPost> {
  const limited = !!(args.raw?.paywalled || args.raw?.factPackLimited || args.raw?.viaFallback);
  const story = itemToMinimalStory(args.item, args.finalScore);
  const factPack = buildFactPack(story, { limited, sourceUrls: [args.item.url] });
  const image = await sourceImage({ headline: args.item.title, feedCandidateUrls: args.feedCandidateUrls });
  const payload = buildRasPayload({ item: args.item, factPack, image, suggestedCaptionAngle: "Why it matters" });
  const caps = await canPostNow({ now: args.now });
  const scoreOk = meetsScoreThreshold(args.finalScore);
  return { payload, image, caps, scoreOk };
}
