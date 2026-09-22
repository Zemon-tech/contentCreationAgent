import type { RawContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";

/** Per-source outcome: items on success, error/skipped reason otherwise. */
export interface CollectResult {
  sourceId: string;
  sourceName: string;
  items: RawContent[];
  error?: string;
  skipped?: string;
}

export interface SourceCollector {
  readonly collectorId: string;
  supports(source: Source): boolean;
  collect(source: Source, opts?: { maxItems?: number }): Promise<RawContent[]>;
}

export function makeBaseRaw(fields: {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  url: string;
  title?: string;
  content: string;
  authorName?: string;
  authorHandle?: string;
  authorUrl?: string;
  publishedAt?: string;
  metadata?: Record<string, unknown>;
}): RawContent {
  const { authorName, authorHandle, authorUrl, ...rest } = fields;
  return {
    id: `${fields.sourceId}:${hashString(fields.url)}`,
    collectedAt: new Date().toISOString(),
    author:
      authorName || authorHandle || authorUrl
        ? { name: authorName, handle: authorHandle, url: authorUrl }
        : undefined,
    ...rest,
  };
}

/** Small deterministic FNV-1a hash for stable raw ids (not for security). */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        // Identify as a bot and respect access restrictions.
        "User-Agent":
          "IndustryIntelligenceAggregator/1.0 (+research bot; respects robots.txt)",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
