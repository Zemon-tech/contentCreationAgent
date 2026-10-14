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
  "amp",
  "outputtype",
  "__twitter_impression",
  "guccounter",
]);

/**
 * Canonicalize a URL for dedup: resolve Google News redirects, strip tracking
 * (utm_*, fbclid, amp flags, …), drop the hash, strip AMP path segments, and
 * remove trailing slashes. Best-effort and lossless for identity.
 */
export function normalizeUrl(url: string): string {
  try {
    let u = new URL(url.trim());

    // Google News redirect -> embedded real URL when present.
    if (/(^|\.)news\.google\.com$/i.test(u.hostname)) {
      const real = u.searchParams.get("url");
      if (real) {
        try {
          u = new URL(real);
        } catch {
          /* keep GN url */
        }
      }
    }

    for (const key of [...u.searchParams.keys()]) {
      const k = key.toLowerCase();
      if (TRACKING_PARAMS.has(k) || k.startsWith("utm_")) u.searchParams.delete(key);
    }
    u.hash = "";

    // AMP path segments: /amp, /amp/ (trailing or mid-path).
    let path = u.pathname.replace(/\/amp(?=\/|$)/i, "");
    // Trailing slash (keep root "/").
    if (path.length > 1) path = path.replace(/\/+$/, "");
    u.pathname = path || "/";

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
