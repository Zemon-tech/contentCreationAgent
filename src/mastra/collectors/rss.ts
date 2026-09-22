import type { RawContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import {
  fetchWithTimeout,
  makeBaseRaw,
  type SourceCollector,
} from "./types";

interface RssItem {
  title?: string;
  link?: string;
  description?: string;
  content?: string;
  pubDate?: string;
  author?: string;
}

function tagValue(block: string, tag: string): string | undefined {
  const re = new RegExp(
    `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>|<${tag}[^>]*\\/ >|<${tag}[^>]*\\/>`,
    "i",
  );
  const m = block.match(re);
  if (!m) return undefined;
  let v = (m[1] ?? "").trim();
  // strip CDATA wrapper
  v = v.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim();
  return v || undefined;
}

function attrValue(block: string, attr: string): string | undefined {
  const m = block.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m?.[1];
}

/** Minimal RSS 2.0 + Atom parser (no extra deps). Best-effort. */
export function parseFeedXml(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const rssBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const b of rssBlocks) {
    items.push({
      title: tagValue(b, "title"),
      link: tagValue(b, "link"),
      description:
        tagValue(b, "description") ?? tagValue(b, "content:encoded"),
      pubDate: tagValue(b, "pubDate") ?? tagValue(b, "dc:date"),
      author: tagValue(b, "author") ?? tagValue(b, "dc:creator"),
    });
  }
  if (items.length === 0) {
    const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
    for (const b of entryBlocks) {
      const linkBlock = b.match(/<link[^>]*>/i)?.[0];
      items.push({
        title: tagValue(b, "title"),
        link:
          (linkBlock ? attrValue(linkBlock, "href") : undefined) ??
          tagValue(b, "link"),
        description: tagValue(b, "summary") ?? tagValue(b, "content"),
        pubDate: tagValue(b, "published") ?? tagValue(b, "updated"),
        author:
          b.match(/<author[\s\S]*?<name>([\s\S]*?)<\/name>/i)?.[1]?.trim() ??
          tagValue(b, "author"),
      });
    }
  }
  return items;
}

export class RssCollector implements SourceCollector {
  readonly collectorId = "rss";

  supports(source: Source): boolean {
    return source.type === "rss" && !!source.url;
  }

  async collect(source: Source, opts?: { maxItems?: number }): Promise<RawContent[]> {
    if (!source.url) throw new Error(`RSS source ${source.id} has no URL`);
    const res = await fetchWithTimeout(source.url);
    if (!res.ok) {
      throw new Error(`RSS fetch failed (${res.status}) for ${source.url}`);
    }
    const xml = await res.text();
    if (xml.length > 5_000_000) {
      throw new Error(`RSS payload too large for ${source.url}`);
    }
    const items = parseFeedXml(xml).slice(0, opts?.maxItems ?? 20);
    return items
      .filter((i) => i.link && (i.title || i.description))
      .map((i) =>
        makeBaseRaw({
          sourceId: source.id,
          sourceName: source.name,
          sourceType: source.type,
          url: i.link!,
          title: i.title,
          content: i.description ?? i.content ?? i.title ?? "",
          authorName: i.author,
          publishedAt: safeDate(i.pubDate),
          metadata: { collector: "rss" },
        }),
      );
  }
}

function safeDate(v?: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
