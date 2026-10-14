import { ingestionConfig, type IngestionConfig } from "../config/ingestion.config";
import type { RawContent } from "../schemas/rawContent";
import { makeBaseRaw } from "../collectors/types";
import { parseFeedXml } from "../collectors/rss";
import { politeFetch } from "./http-polite";
import { isPaywalledDomain } from "./article-body";

/**
 * Google News RSS fallback (Section A, item 5). Headline-level DISCOVERY only,
 * used when a source is dropped/blocked or auto-disabled by feed-health.
 *
 * Builds `news.google.com/rss/search?q=site:<domain>+<topic>+when:<window>`,
 * resolves the Google redirect to the real URL where possible, caps volume per
 * run, and marks every item `viaFallback:true` + `factPackLimited:true` (thin
 * material). Items resolving to a paywalled domain are marked `paywalled:true`.
 */

export function buildGoogleNewsUrl(
  domain: string,
  region: "US" | "IN" | "GLOBAL",
  topic: string | undefined,
  cfg: IngestionConfig = ingestionConfig,
): string {
  const loc = cfg.googleNews.localeByRegion[region] ?? cfg.googleNews.localeByRegion.GLOBAL;
  const q = [`site:${domain}`, topic?.trim(), `when:${cfg.googleNews.when}`].filter(Boolean).join(" ");
  const params = new URLSearchParams({ q, hl: loc.hl, gl: loc.gl, ceid: loc.ceid });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

/** Best-effort: pull the real publisher URL out of a Google News redirect link. */
export function resolveGoogleNewsLink(link: string): { url: string; resolved: boolean } {
  try {
    const u = new URL(link);
    if (!/(^|\.)news\.google\.com$/i.test(u.hostname)) return { url: link, resolved: true };
    const param = u.searchParams.get("url");
    if (param) return { url: param, resolved: true };
    return { url: link, resolved: false }; // modern GN encodes the target; can't decode server-side
  } catch {
    return { url: link, resolved: false };
  }
}

export async function fetchGoogleNewsFallback(args: {
  sourceId: string;
  sourceName: string;
  domain: string;
  region: "US" | "IN" | "GLOBAL";
  topic?: string;
  config?: IngestionConfig;
}): Promise<RawContent[]> {
  const cfg = args.config ?? ingestionConfig;
  if (!cfg.googleNews.enabled) return [];
  const url = buildGoogleNewsUrl(args.domain, args.region, args.topic, cfg);
  const res = await politeFetch(url, { mode: "feed", config: cfg });
  if (!res.ok || !res.body) return [];

  const items = parseFeedXml(res.body).slice(0, cfg.googleNews.maxItemsPerRun);
  return items
    .filter((i) => i.link && (i.title || i.description))
    .map((i) => {
      const { url: realUrl, resolved } = resolveGoogleNewsLink(i.link!);
      const paywalled = isPaywalledDomain(realUrl);
      return makeBaseRaw({
        sourceId: `${args.sourceId}:gnews`,
        sourceName: `${args.sourceName} (via Google News)`,
        sourceType: "news",
        url: realUrl,
        title: i.title,
        content: i.description ?? i.title ?? "",
        publishedAt: i.pubDate ? safeIso(i.pubDate) : undefined,
        metadata: { collector: "google-news-fallback", gnewsResolved: resolved, gnewsQueryDomain: args.domain },
      });
    })
    .map((raw) => ({
      ...raw,
      viaFallback: true as const,
      factPackLimited: true as const,
      ...(isPaywalledDomain(raw.url) ? { paywalled: true as const } : {}),
    }));
}

function safeIso(v: string): string | undefined {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
