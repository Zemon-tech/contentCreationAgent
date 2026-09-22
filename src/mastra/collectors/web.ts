import type { RawContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import {
  fetchWithTimeout,
  makeBaseRaw,
  type SourceCollector,
} from "./types";

/** Generic web-page collector for pages we are allowed to fetch.
 *  Only fetches http(s), caps payload size, strips to readable text.
 *  For sites that forbid scraping, add them as inactive sources instead. */
export class WebCollector implements SourceCollector {
  readonly collectorId = "web";

  supports(source: Source): boolean {
    return (
      (source.type === "web" ||
        source.type === "blog" ||
        source.type === "news") &&
      !!source.url
    );
  }

  async collect(
    source: Source,
    opts?: { maxItems?: number },
  ): Promise<RawContent[]> {
    if (!source.url) throw new Error(`Web source ${source.id} has no URL`);
    if (!/^https?:\/\//i.test(source.url)) {
      throw new Error(`Refusing non-http(s) URL: ${source.url}`);
    }
    const extracted = await fetchWebPage(source.url);
    void opts;
    return [
      makeBaseRaw({
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        url: extracted.canonicalUrl ?? source.url,
        title: extracted.title,
        content: extracted.text,
        authorName: extracted.author,
        publishedAt: extracted.publishedAt,
        metadata: { collector: "web" },
      }),
    ];
  }
}

export interface ExtractedPage {
  title?: string;
  text: string;
  author?: string;
  publishedAt?: string;
  canonicalUrl?: string;
}

export async function fetchWebPage(url: string): Promise<ExtractedPage> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Web fetch failed (${res.status}) for ${url}`);
  const html = await res.text();
  if (html.length > 2_000_000) {
    throw new Error(`Web payload too large for ${url}`);
  }
  return extractArticleContent(html, url);
}

/** Deterministic HTML -> readable text extraction (no extra deps). */
export function extractArticleContent(
  html: string,
  url?: string,
): ExtractedPage {
  const title =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
    html
      .match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      )?.[1]
      ?.trim();

  const author = html
    .match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?.trim();

  const publishedRaw =
    html.match(
      /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    )?.[1] ??
    html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  let publishedAt: string | undefined;
  if (publishedRaw) {
    const d = new Date(publishedRaw);
    if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
  }

  const canonicalUrl = url
    ? (html
        .match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]
        ?.trim() ?? url)
    : undefined;

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");
  // Prefer <article> / <main> content when present.
  const article =
    body.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
    body.match(/<main[\s\S]*?<\/main>/i)?.[0];
  if (article) body = article;
  const text = body
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15000);

  return { title, text, author, publishedAt, canonicalUrl };
}
