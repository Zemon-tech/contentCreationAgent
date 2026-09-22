import { z } from "zod";
import type { IndustryConfig } from "../config/industry";
import { cosineSimilarity, hashEmbedding, tokenize } from "./embeddings";
import { PRODUCT_ENTITIES, topicMatches } from "./analysis";
import type { NormalizedContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";

/**
 * RADAR STAGE 1+2 — zero-LLM filters. The funnel starts here:
 * tens of thousands of signals → only fresh, on-topic items survive.
 * The LLM never sees what these filters discard.
 */

export const RELEVANCE_THRESHOLD_DEFAULT = 0.65;
export const FRESHNESS_HOURS_DEFAULT = 168; // 7 days; 5-min loop passes smaller

export const FilterDiscardSchema = z.object({
  id: z.string(),
  stage: z.enum(["hard-filter", "semantic-filter"]),
  reason: z.string(),
});

export type FilterDiscard = z.infer<typeof FilterDiscardSchema>;

export interface HardFilterOptions {
  maxAgeHours?: number;
  industry: IndustryConfig;
  sourcesById: Map<string, Source>;
  now?: Date;
}

export interface HardFilterResult {
  kept: NormalizedContent[];
  discarded: FilterDiscard[];
}

/**
 * Hard filter: freshness cutoff + cheap keyword/topic/entity prefilter.
 * Official/academic sources always pass the topic gate (primary evidence
 * must reach clustering even when worded unusually).
 */
export function hardFilter(
  items: NormalizedContent[],
  opts: HardFilterOptions,
): HardFilterResult {
  const maxAgeHours = opts.maxAgeHours ?? FRESHNESS_HOURS_DEFAULT;
  const now = (opts.now ?? new Date()).getTime();
  const kept: NormalizedContent[] = [];
  const discarded: FilterDiscard[] = [];

  for (const item of items) {
    const ref = item.eventAt ?? item.latestUpdateAt ?? item.firstReportedAt ?? item.publishedAt; const ts = ref ? Date.parse(ref) : NaN;
    const ageHours = Number.isNaN(ts) ? 0 : (now - ts) / 3_600_000;
    if (ageHours > maxAgeHours) {
      discarded.push({
        id: item.id,
        stage: "hard-filter",
        reason: `stale: ${ageHours.toFixed(1)}h old (cutoff ${maxAgeHours}h)`,
      });
      continue;
    }
    const role = opts.sourcesById.get(item.sourceId)?.role;
    const hits = countIndustryHits(item, opts.industry);
    if (hits === 0 && role !== "official" && role !== "academic") {
      discarded.push({
        id: item.id,
        stage: "hard-filter",
        reason: "off-topic: no industry keyword/topic/entity hit",
      });
      continue;
    }
    kept.push(item);
  }
  return { kept, discarded };
}

/** Analysis-grade hits: keywords + companies/products + token-matched topics. */
export function countIndustryHits(
  item: NormalizedContent,
  industry: IndustryConfig,
): number {
  const hay = `${item.normalizedTitle}\n${item.normalizedText}`;
  const lower = hay.toLowerCase();
  const tokens = new Set(tokenize(hay));
  let hits = 0;
  for (const k of industry.keywords) {
    if (k.length > 2 && lower.includes(k.toLowerCase())) hits++;
  }
  for (const e of [...industry.entities, ...PRODUCT_ENTITIES]) {
    if (lower.includes(e.toLowerCase())) hits++;
  }
  for (const t of industry.topics) {
    if (topicMatches(t, lower, tokens)) hits++;
  }
  return hits;
}

/**Deterministic industry centroid for the semantic gate (swap in a real
 * embedder later — same interface). */
export function industryCentroid(
  industry: IndustryConfig,
  dims = 128,
): number[] {
  const text = [
    ...industry.topics,
    ...industry.keywords,
    ...industry.entities,
  ].join(" ");
  return hashEmbedding(text, dims);
}

export interface RelevanceScore {
  score: number;
  hits: number;
  cosine: number;
}

/**
 * Semantic relevance 0-1: vocabulary density (85%) + embedding cosine to
 * the industry centroid (15%). Calibrated so that genuinely on-topic items
 * (≥4 vocabulary hits) clear the 0.65 gate even with hash embeddings;
 * wiring a real embedding model raises the cosine contribution's meaning
 * without changing this interface. Threshold default 0.65 (configurable).
 */
export function relevance01(
  item: NormalizedContent,
  industry: IndustryConfig,
  centroid?: number[],
): RelevanceScore {
  const hits = countIndustryHits(item, industry);
  const density = Math.min(1, hits / 4);
  const c = centroid ?? industryCentroid(industry, item.embedding.length);
  const raw = cosineSimilarity(item.embedding, c);
  const cosine = Math.max(0, Math.min(1, raw));
  const score = Math.round((0.85 * density + 0.15 * cosine) * 100) / 100;
  return { score, hits, cosine: Math.round(cosine * 100) / 100 };
}

export interface SemanticFilterResult {
  kept: NormalizedContent[];
  discarded: FilterDiscard[];
  scores: Map<string, RelevanceScore>;
}

export function semanticFilter(
  items: NormalizedContent[],
  industry: IndustryConfig,
  threshold = RELEVANCE_THRESHOLD_DEFAULT,
): SemanticFilterResult {
  const centroid = industryCentroid(
    industry,
    items[0]?.embedding.length ?? 128,
  );
  const kept: NormalizedContent[] = [];
  const discarded: FilterDiscard[] = [];
  const scores = new Map<string, RelevanceScore>();
  for (const item of items) {
    const r = relevance01(item, industry, centroid);
    scores.set(item.id, r);
    if (r.score < threshold) {
      discarded.push({
        id: item.id,
        stage: "semantic-filter",
        reason: `relevance ${r.score} < ${threshold} (hits=${r.hits}, cosine=${r.cosine})`,
      });
    } else {
      kept.push(item);
    }
  }
  return { kept, discarded, scores };
}
