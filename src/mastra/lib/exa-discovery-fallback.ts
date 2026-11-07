import { ingestionConfig, type IngestionConfig } from "../config/ingestion.config";
import type { RawContent, ImageCandidate } from "../schemas/rawContent";
import { makeBaseRaw } from "../collectors/types";
import { searchExa } from "../tools/exa-tools";
import { isPaywalledDomain } from "./article-body";
import { stripHtml, normalizeWhitespace } from "./normalize";

/**
 * Exa DISCOVERY fallback — finds fresh article URLs for a source that has no
 * working RSS (manually dropped, auto-disabled, or whose feed fetch failed).
 *
 * This is the real "reach sources RSS can't" mechanism: it uses `exaSearch`
 * scoped to the outlet's own domain to DISCOVER article URLs, then keeps only
 * title + URL + published date (+ a representative image URL when Exa returns
 * one). The full article body is intentionally NOT fetched here — the pipeline
 * ranks on title+summary and only enriches the few stories that win, so
 * fetching bodies for every discovered item would waste Exa credits.
 *
 * Every item is tagged `viaFallback:true` + `factPackLimited:true` (thin
 * material — the fact pack must not invent beyond it). Items on a known
 * paywalled domain are additionally tagged `paywalled:true`, which blocks any
 * later body fetch (paywall policy lives in code, see article-body.ts).
 *
 * Best-effort: never throws. Returns [] when disabled, no API key, no domain,
 * or Exa yields nothing — the caller treats that as "fallback contributed 0".
 */
export async function fetchExaDiscoveryFallback(args: {
  sourceId: string;
  sourceName: string;
  /** Outlet article domain to scope the search to, e.g. "techcircle.in". */
  domain: string;
  /** Free-text topic hint (e.g. the source's primary topic) to focus the query. */
  topic?: string;
  config?: IngestionConfig;
}): Promise<RawContent[]> {
  const cfg = args.config ?? ingestionConfig;
  const ex = cfg.exaDiscovery;
  if (!ex.enabled) return [];
  if (!process.env["EXA_API_KEY"]) return []; // no key -> silently skip
  const domain = args.domain.trim().toLowerCase();
  if (!domain) return [];

  const startPublishedDate = new Date(
    Date.now() - ex.startWithinHours * 3_600_000,
  ).toISOString();

  // Domain-scoped query: let Exa surface recent articles from this outlet.
  // A topic hint sharpens relevance; the outlet name keeps it on-brand.
  const query = [args.topic?.trim(), `latest news from ${args.sourceName}`]
    .filter(Boolean)
    .join(" ");

  let results: Awaited<ReturnType<typeof searchExa>>["results"];
  try {
    const out = await searchExa({
      query,
      numResults: ex.numResults,
      searchType: "auto",
      category: "news",
      startPublishedDate,
      includeDomains: [domain],
      includeImages: true, // free for the first 10 results; feeds image sourcing
    });
    results = out.results;
  } catch {
    // Network / auth / rate-limit: fallback is best-effort, never fail the run.
    return [];
  }

  const seen = new Set<string>();
  const items: RawContent[] = [];
  for (const r of results) {
    if (items.length >= ex.maxItemsPerRun) break;
    if (!r.url || !/^https?:\/\//i.test(r.url)) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);

    const title = normalizeWhitespace(stripHtml(r.title ?? ""));
    if (!title) continue; // discovery needs at least a headline

    const raw = makeBaseRaw({
      sourceId: `${args.sourceId}:exa`,
      sourceName: `${args.sourceName} (via Exa)`,
      sourceType: "news",
      url: r.url,
      title,
      // Discover-only: the summary stays the headline. Body comes later, for
      // winners only. Never synthesize content here.
      content: title,
      ...(r.publishedDate ? { publishedAt: safeIso(r.publishedDate) } : {}),
      metadata: {
        collector: "exa-discovery-fallback",
        exaQueryDomain: domain,
        ...(r.score != null ? { exaScore: r.score } : {}),
      },
    });

    const imageCandidates = toExaImageCandidate(r.image);
    items.push({
      ...raw,
      viaFallback: true as const,
      factPackLimited: true as const,
      ...(imageCandidates ? { imageCandidates } : {}),
      ...(isPaywalledDomain(r.url) ? { paywalled: true as const } : {}),
    });
  }

  return items;
}

/** Wrap Exa's representative image URL as an uncleared feed-style candidate. */
function toExaImageCandidate(image: string | null | undefined): ImageCandidate[] | undefined {
  if (!image || !/^https?:\/\//i.test(image)) return undefined;
  return [{ url: image, origin: "media:content", cleared: false as const }];
}

function safeIso(v: string): string | undefined {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
