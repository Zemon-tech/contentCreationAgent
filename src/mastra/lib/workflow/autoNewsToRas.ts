import type { RawContent } from "../../schemas/rawContent";
import type { RankInputItem, RankResult, RankedStory, Region } from "../../schemas/ranking";
import type { Story } from "../../schemas/story";
import type { RasPayload } from "../../schemas/handoff";
import { NEWS_FEED_SOURCES } from "../../config/newsFeeds";
import { ingestFeeds } from "../ingest-feeds";
import { collectXPosts } from "../collect-x-posts";
import { rankStories, urlKey, matchOutboundToRss } from "../ranking/rankStories";
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

/**
 * True when an X-sourced ranked story stands alone — no RSS item in the same
 * run corroborates it (its outbound links don't match any RSS source URL).
 * Drives the 'per @handle on X' attribution line: shown ONLY when X-only.
 * Non-X stories are never X-only.
 */
function isXOnlyStory(r: RankedStory, rawById: Map<string, RawContent>): boolean {
  if (r.item.isX !== true) return false;
  const rssUrlSet = new Set<string>();
  for (const raw of rawById.values()) {
    if (raw.sourceType === "x") continue;
    rssUrlSet.add(urlKey(raw.url));
  }
  // Corroborated (not X-only) when an outbound link matches an RSS source.
  return !matchOutboundToRss(r.item.outboundUrls, rssUrlSet);
}

function rawToRankItem(raw: RawContent): RankInputItem {
  const summary = (raw.content || raw.title || "").replace(/\s+/g, " ").trim().slice(0, 800);
  const md = raw.metadata ?? {};
  const base: RankInputItem = {
    id: raw.id,
    clusterId: canonicalKey(raw.url, raw.title || "", summary),
    title: (raw.title || "").trim(),
    summary,
    url: raw.url,
    source: raw.sourceName,
    region: ((md["region"] as Region) ?? "GLOBAL"),
    publishedAt: raw.publishedAt ?? raw.collectedAt,
    rawCategories: [],
    clusterSourceCount: 1,
  };

  // RSS items carry no X signal — leave the X fields empty/default.
  if (raw.sourceType !== "x") return base;

  // X items: map the fields postToRaw stamped onto metadata (FEAT-002) onto the
  // RankInputItem X-signal fields. The ranker reads these; code owns every
  // number, so we only carry values, never invent them.
  const quoted = (md["quoted"] as RankInputItem["quoted"]) ?? null;
  const engagementRaw = md["engagementRaw"] as
    | { likes?: number; reposts?: number; replies?: number; views?: number }
    | undefined;
  return {
    ...base,
    isX: true,
    isReply: !!md["isReply"],
    isRepost: !!md["isRepost"],
    outboundUrls: Array.isArray(md["outboundUrls"]) ? (md["outboundUrls"] as string[]) : [],
    quoted,
    authorHandle: typeof md["authorHandle"] === "string" ? (md["authorHandle"] as string) : undefined,
    ...(engagementRaw
      ? {
          engagementRaw: {
            likes: engagementRaw.likes ?? 0,
            reposts: engagementRaw.reposts ?? 0,
            replies: engagementRaw.replies ?? 0,
            views: engagementRaw.views ?? 0,
          },
        }
      : {}),
    accountMedianLikes: typeof md["accountMedianLikes"] === "number" ? (md["accountMedianLikes"] as number) : 0,
    accountMedianReposts: typeof md["accountMedianReposts"] === "number" ? (md["accountMedianReposts"] as number) : 0,
    accountStatus: typeof md["accountStatus"] === "string" ? (md["accountStatus"] as string) : "candidate",
    isOfficialAccount: !!md["isOfficialAccount"],
    accountCredibilityScore:
      typeof md["accountCredibilityScore"] === "number" ? (md["accountCredibilityScore"] as number) : 0,
    // Carried LLM meaning fields where a prior X-discovery judgement stamped them.
    ...(typeof md["isPrimarySource"] === "boolean" ? { isPrimarySource: md["isPrimarySource"] as boolean } : {}),
    ...(md["claimRisk"] === "low" || md["claimRisk"] === "medium" || md["claimRisk"] === "high"
      ? { claimRisk: md["claimRisk"] as "low" | "medium" | "high" }
      : {}),
    ...(typeof md["derivedHeadline"] === "string" ? { derivedHeadline: md["derivedHeadline"] as string } : {}),
    ...(typeof md["hookPotential"] === "number" ? { hookPotential: md["hookPotential"] as number } : {}),
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
      rankedStory: r,
      isXOnly: isXOnlyStory(r, args.rawById),
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
  /**
   * The selected ranked story. Carries the X-signal/quality fields
   * (derivedHeadline, verified, claimRisk, outboundUrls, quoted, hookPotential)
   * that flow into the payload. Optional so existing callers/tests still work.
   */
  rankedStory?: RankedStory | null;
  /** True when the story is X-only (no corroborating RSS) — drives attribution. */
  isXOnly?: boolean;
  /** Inject the copywriter's model (demos stub this offline). Omit = real Sarvam. */
  copyGenerate?: CopyGenerate;
  /** Override the copy config (demos disable Exa to stay fully offline). */
  copyConfig?: CopyConfig;
  log?: (ev: string, data: Record<string, unknown>) => void;
}): Promise<PreparedPost> {
  const log = args.log ?? ((ev, data) => console.log(JSON.stringify({ step: "copy", ev, ...data })));
  // FIX #2: trust is carried by verified/claimRisk, NOT by collapsing X into
  // factPackLimited. Keep `limited` exactly the RSS thinness signal — do NOT
  // add `|| raw.signalOnly` here.
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
    story: args.rankedStory ?? null,
    authorHandle: args.rankedStory?.item?.authorHandle ?? args.item.authorHandle ?? null,
    isXOnly: args.isXOnly,
  });
  const caps = await canPostNow({ now: args.now });
  const scoreOk = meetsScoreThreshold(args.finalScore);
  return { payload, image, caps, scoreOk };
}
