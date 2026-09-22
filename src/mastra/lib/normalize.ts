import { createHash } from "node:crypto";
import type {
  NormalizedContent,
  RawContent,
} from "../schemas/rawContent";
import { hashEmbedding } from "./embeddings";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "source",
]);

/** Remove tracking query params where safe; drop the hash fragment. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.hash = "";
    // Trailing-slash canonicalization for bare origins.
    return u.toString();
  } catch {
    return url.trim();
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function contentHash(title: string, text: string): string {
  return createHash("sha256")
    .update(`${title}\n${text}`, "utf8")
    .digest("hex");
}

/**
 * normalizeContent: HTML noise removal, whitespace + timestamp + URL
 * normalization, tracking-param stripping. Original raw fields preserved.
 *
 * Freshness fix (§4): populate the four distinct timestamps —
 * event_at (best estimate of when the event happened; defaults to the
 * published date), first_reported_at (= published date when known),
 * latest_update_at (= published date initially; clustering advances it when
 * newer member items arrive), discovered_at (= collectedAt, when WE found it).
 */
export function normalizeContent(
  raw: RawContent,
  embeddingDims = 128,
): NormalizedContent {
  const normalizedTitle = normalizeWhitespace(stripHtml(raw.title ?? ""));
  const normalizedText = normalizeWhitespace(stripHtml(raw.content)).slice(
    0,
    20000,
  );
  const normalizedUrl = normalizeUrl(raw.url);
  const hash = contentHash(normalizedTitle, normalizedText);
  const published = normalizeTimestamp(raw.publishedAt);
  const collected = normalizeTimestamp(raw.collectedAt) ?? raw.collectedAt;
  // Best-effort event time: explicit metadata override wins, else published.
  const metaEvent =
    typeof raw.metadata?.["event_at"] === "string"
      ? normalizeTimestamp(raw.metadata["event_at"] as string)
      : undefined;
  const eventAt = metaEvent ?? published;
  return {
    ...raw,
    publishedAt: normalizeTimestamp(raw.publishedAt) ?? raw.publishedAt,
    normalizedTitle: normalizedTitle || "(untitled)",
    normalizedText,
    contentHash: hash,
    embedding: hashEmbedding(
      `${normalizedTitle}\n${normalizedText}`,
      embeddingDims,
    ),
    normalizedUrl,
    eventAt,
    firstReportedAt: published,
    latestUpdateAt: published,
    discoveredAt: collected,
  };
}

export function normalizeBatch(
  items: RawContent[],
  embeddingDims = 128,
): NormalizedContent[] {
  return items.map((i) => normalizeContent(i, embeddingDims));
}
