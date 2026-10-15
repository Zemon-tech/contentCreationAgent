import { normalizeUrl, contentHash } from "../normalize";

/**
 * Stable idempotency key for the posted-ledger.
 *
 * Keyed on the CANONICAL URL + a content hash of title+summary — NEVER on
 * cluster or story IDs, which are regenerated randomly every run. Two runs that
 * rediscover the same article therefore produce the same key, so a story is
 * never posted twice.
 */
export function canonicalKey(url: string, title: string, summary: string): string {
  const u = normalizeUrl(url || "");
  const h = contentHash((title || "").trim(), (summary || "").trim()).slice(0, 16);
  return `${u}::${h}`;
}

export interface KeyableItem {
  url: string;
  title: string;
  summary: string;
}

export function canonicalKeyForItem(item: KeyableItem): string {
  return canonicalKey(item.url, item.title, item.summary);
}
