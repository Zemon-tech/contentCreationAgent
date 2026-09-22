import type { RawContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import {
  fetchWithTimeout,
  makeBaseRaw,
  type SourceCollector,
} from "./types";

/**
 * Collector for arXiv API queries (type "paper").
 * Source URL must be an export.arxiv.org/api/query URL (see RESEARCH_SOURCES).
 * Uses the official API — no scraping.
 */
export class ArXivCollector implements SourceCollector {
  readonly collectorId = "arxiv";

  supports(source: Source): boolean {
    return (
      source.type === "paper" &&
      !!source.url &&
      source.url.includes("export.arxiv.org/api/query")
    );
  }

  async collect(
    source: Source,
    opts?: { maxItems?: number },
  ): Promise<RawContent[]> {
    if (!source.url) throw new Error(`arXiv source ${source.id} has no URL`);
    const url = capMaxResults(source.url, opts?.maxItems ?? 15);
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "application/atom+xml" },
    });
    if (!res.ok) {
      throw new Error(`arXiv query failed (${res.status}) for ${source.id}`);
    }
    const xml = await res.text();
    if (xml.length > 5_000_000) throw new Error(`arXiv payload too large`);
    const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
    return entries.slice(0, opts?.maxItems ?? 15).flatMap((entry) => {
      const id = tag(entry, "id");
      const title = tag(entry, "title");
      const summary = tag(entry, "summary");
      const published = tag(entry, "published");
      if (!id || !title) return [];
      const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)]
        .map((m) => m[1]?.trim())
        .filter(Boolean)
        .slice(0, 5);
      // Prefer the abs page over the export API URL for attribution.
      const abs = id.replace("export.arxiv.org/api/", "arxiv.org/abs/");
      return [
        makeBaseRaw({
          sourceId: source.id,
          sourceName: source.name,
          sourceType: source.type,
          url: abs,
          title: title.replace(/\s+/g, " ").trim(),
          content: (summary ?? title).replace(/\s+/g, " ").trim().slice(0, 4000),
          authorName: authors.length > 0 ? authors.join(", ") : undefined,
          publishedAt: safeDate(published),
          metadata: { collector: "arxiv", arxivId: abs },
        }),
      ];
    });
  }
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m?.[1]?.trim() || undefined;
}

function capMaxResults(url: string, max: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set("max_results", String(Math.min(Math.max(max, 1), 50)));
    return u.toString();
  } catch {
    return url;
  }
}

function safeDate(v?: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
