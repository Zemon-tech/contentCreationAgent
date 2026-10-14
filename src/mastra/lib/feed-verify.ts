import { fetchWithTimeout } from "../collectors/types";
import { parseFeedXml } from "../collectors/rss";

/**
 * Live feed verification. Fetches a feed, confirms it parses as RSS/Atom,
 * counts items, finds the newest item date, and flags staleness. Used by the
 * one-off `feeds:verify` report and reusable for ongoing feed-health checks.
 *
 * Network only — never throws; every outcome is captured in the result.
 */

export interface FeedCandidate {
  id: string;
  name: string;
  url: string;
  region?: "US" | "IN" | "GLOBAL";
  category?: string;
  paywalled?: boolean;
  signalOnly?: boolean;
}

export interface FeedCheck extends FeedCandidate {
  status: number | null;
  ok: boolean;
  parsed: boolean;
  itemCount: number;
  newestItem: string | null;
  ageDays: number | null;
  stale: boolean;
  note?: string;
  error?: string;
}

const STALE_DAYS = 7;

function newestDate(pubDates: (string | undefined)[]): { iso: string | null; ageDays: number | null } {
  let newest = -Infinity;
  for (const d of pubDates) {
    if (!d) continue;
    const t = Date.parse(d);
    if (!Number.isNaN(t) && t > newest) newest = t;
  }
  if (newest === -Infinity) return { iso: null, ageDays: null };
  return {
    iso: new Date(newest).toISOString(),
    ageDays: Math.round(((Date.now() - newest) / 86_400_000) * 10) / 10,
  };
}

export async function verifyFeed(entry: FeedCandidate, timeoutMs = 15000): Promise<FeedCheck> {
  const baseFail = (patch: Partial<FeedCheck>): FeedCheck => ({
    ...entry,
    status: null,
    ok: false,
    parsed: false,
    itemCount: 0,
    newestItem: null,
    ageDays: null,
    stale: false,
    ...patch,
  });

  try {
    const res = await fetchWithTimeout(entry.url, {}, timeoutMs);
    const status = res.status;
    if (!res.ok) {
      return baseFail({ status, note: `HTTP ${status}` });
    }
    const body = await res.text();
    const looksHtml = /^\s*<!doctype html|<html[\s>]/i.test(body) && !/<rss|<feed|<rdf/i.test(body);
    const items = parseFeedXml(body);
    const { iso, ageDays } = newestDate(items.map((i) => i.pubDate));
    const parsed = items.length > 0 && !looksHtml;
    return {
      ...entry,
      status,
      ok: true,
      parsed,
      itemCount: items.length,
      newestItem: iso,
      ageDays,
      stale: parsed && ageDays !== null && ageDays > STALE_DAYS,
      note: looksHtml
        ? "returned HTML, not a feed"
        : items.length === 0
          ? "fetched but no items parsed"
          : ageDays === null
            ? "items have no parseable dates"
            : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return baseFail({ error: msg, note: /timed out/i.test(msg) ? "timeout" : "fetch error" });
  }
}

export async function verifyFeeds(
  entries: FeedCandidate[],
  opts: { concurrency?: number; timeoutMs?: number } = {},
): Promise<FeedCheck[]> {
  const concurrency = opts.concurrency ?? 8;
  const results: FeedCheck[] = new Array(entries.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= entries.length) return;
      results[i] = await verifyFeed(entries[i]!, opts.timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return results;
}

/** Render a result set as a fixed-width table string. */
export function formatFeedTable(checks: FeedCheck[]): string {
  const rows = checks.map((c) => ({
    name: c.name.slice(0, 26),
    region: c.region ?? "-",
    status: c.ok ? String(c.status) : c.error ? "ERR" : String(c.status ?? "-"),
    parsed: c.parsed ? "yes" : "no",
    items: String(c.itemCount),
    newest: c.ageDays === null ? "-" : `${c.ageDays}d`,
    verdict: verdictOf(c),
    note: (c.note ?? c.error ?? "").slice(0, 40),
  }));
  const header = { name: "SOURCE", region: "REG", status: "HTTP", parsed: "PARSE", items: "ITEMS", newest: "NEWEST", verdict: "VERDICT", note: "NOTE" };
  const all = [header, ...rows];
  const widths: Record<string, number> = {};
  for (const k of Object.keys(header)) widths[k] = Math.max(...all.map((r) => (r as Record<string, string>)[k]!.length));
  const line = (r: Record<string, string>) => Object.keys(header).map((k) => r[k]!.padEnd(widths[k]!)).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

export function verdictOf(c: FeedCheck): string {
  if (!c.ok) return "DEAD";
  if (!c.parsed) return "DEAD";
  if (c.stale) return "STALE";
  return "LIVE";
}
