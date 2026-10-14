import { ingestionConfig, type IngestionConfig } from "../config/ingestion.config";
import type { RawContent, ImageCandidate } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import { getSourceRegistry } from "../config/sources";
import { parseFeedXml, type FeedImage } from "../collectors/rss";
import { makeBaseRaw } from "../collectors/types";
import { politeFetch } from "./http-polite";
import { fetchGoogleNewsFallback } from "./google-news-fallback";
import { hostOf } from "./article-body";
import {
  applyOutcome,
  getOrInit,
  isProbeDue,
  saveHealth,
  type FeedHealthRow,
} from "../repositories/feedHealth";

/**
 * Health-aware feed ingestion (Section A). For each RSS source it:
 *  - respects feed-health (skips auto-disabled unless a probe is due),
 *  - fetches via politeFetch (conditional GET + rate limit + robots),
 *  - treats 304 as success, zero-items/parse/non-2xx as failure, stale as a
 *    warning (not a failure),
 *  - tags items: paywalled / factPackLimited / signalOnly / imageCandidates
 *    (cleared:false) / viaFallback,
 *  - auto-activates the Google News fallback for dropped/auto-disabled sources,
 *  - records health and never lets one bad feed fail the run.
 *
 * This is additive: the legacy collectors/workflow are untouched.
 */

export type Verdict = "LIVE" | "STALE" | "NOT_MODIFIED" | "DEAD" | "BLOCKED" | "SKIPPED" | "FALLBACK";

export interface PerSourceReport {
  id: string;
  name: string;
  region: string;
  status: FeedHealthRow["status"];
  httpStatus: number | null;
  items: number;
  newestAgeDays: number | null;
  verdict: Verdict;
  note?: string;
}

export interface IngestRunSummary {
  startedAt: string;
  finishedAt: string;
  attempted: number;
  succeeded: number;
  failed: number;
  notModified: number;
  stale: string[];
  newlyDisabled: string[];
  reEnabled: string[];
  fallbackActivated: string[];
  perSource: PerSourceReport[];
}

export interface IngestResult {
  items: RawContent[];
  summary: IngestRunSummary;
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round(((Date.now() - t) / 86_400_000) * 10) / 10;
}

function toImageCandidates(images: FeedImage[] | undefined): ImageCandidate[] | undefined {
  if (!images?.length) return undefined;
  return images.map((im) => ({
    url: im.url,
    origin: im.origin,
    ...(im.width ? { width: im.width } : {}),
    ...(im.height ? { height: im.height } : {}),
    cleared: false as const,
  }));
}

function buildItems(source: Source, xml: string, cfg: IngestionConfig): { items: RawContent[]; newestIso: string | null } {
  const feedItems = parseFeedXml(xml).slice(0, 25);
  let newest = -Infinity;
  const items: RawContent[] = [];
  for (const i of feedItems) {
    if (!i.link || !(i.title || i.description)) continue;
    const publishedAt = i.pubDate ? safeIso(i.pubDate) : undefined;
    if (publishedAt) {
      const t = Date.parse(publishedAt);
      if (!Number.isNaN(t) && t > newest) newest = t;
    }
    const raw = makeBaseRaw({
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      url: i.link,
      title: i.title,
      content: i.description ?? i.content ?? i.title ?? "",
      authorName: i.author,
      publishedAt,
      metadata: { collector: "ingest-feeds", region: source.region },
    });
    const candidates = toImageCandidates(i.images);
    items.push({
      ...raw,
      ...(source.paywalled ? { paywalled: true, factPackLimited: true } : {}),
      ...(source.signalOnly ? { signalOnly: true } : {}),
      ...(candidates ? { imageCandidates: candidates } : {}),
    });
  }
  void cfg;
  return { items, newestIso: newest === -Infinity ? null : new Date(newest).toISOString() };
}

function safeIso(v: string): string | undefined {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

async function runFallback(source: Source, out: RawContent[], summary: IngestRunSummary, cfg: IngestionConfig): Promise<void> {
  if (!cfg.googleNews.enabled || !source.url) return;
  const domain = hostOf(source.url);
  if (!domain) return;
  try {
    const fb = await fetchGoogleNewsFallback({
      sourceId: source.id,
      sourceName: source.name,
      domain: deriveArticleDomain(source),
      region: source.region ?? "GLOBAL",
      topic: source.topics?.[0],
      config: cfg,
    });
    if (fb.length) {
      out.push(...fb);
      summary.fallbackActivated.push(source.id);
    }
  } catch {
    /* fallback is best-effort; never fail the run */
  }
}

/** The outlet's article domain (not the feed host) for a good site: query. */
function deriveArticleDomain(source: Source): string {
  // Prefer an explicit note-free article domain; else the feed host.
  const host = source.url ? hostOf(source.url) : null;
  if (!host) return source.name.toLowerCase().replace(/\s+/g, "");
  // Feed infra hosts -> their real outlet domain.
  if (host.includes("dowjones")) return "wsj.com";
  if (host.includes("cnn.com")) return "cnn.com";
  return host;
}

export async function ingestFeeds(opts: {
  sources?: Source[];
  dryRun?: boolean;
  now?: Date;
  config?: IngestionConfig;
} = {}): Promise<IngestResult> {
  const cfg = opts.config ?? ingestionConfig;
  const now = opts.now ?? new Date();
  const persist = !opts.dryRun;
  const registry = opts.sources ?? getSourceRegistry();
  const candidates = registry.filter((s) => s.type === "rss" && !!s.url);

  const items: RawContent[] = [];
  const summary: IngestRunSummary = {
    startedAt: now.toISOString(),
    finishedAt: "",
    attempted: 0,
    succeeded: 0,
    failed: 0,
    notModified: 0,
    stale: [],
    newlyDisabled: [],
    reEnabled: [],
    fallbackActivated: [],
    perSource: [],
  };

  for (const source of candidates) {
    try {
      const manual = source.active === false;
      const health = await getOrInit(source.id, manual);
      const region = source.region ?? "GLOBAL";

      // Manually-disabled (dropped) sources: never fetch; use fallback.
      if (manual) {
        await runFallback(source, items, summary, cfg);
        summary.perSource.push({ id: source.id, name: source.name, region, status: health.status, httpStatus: null, items: 0, newestAgeDays: null, verdict: "FALLBACK", note: source.note });
        continue;
      }

      // Auto-disabled: skip unless a probe is due.
      if (health.status === "disabled_auto" && !isProbeDue(health, now)) {
        await runFallback(source, items, summary, cfg);
        summary.perSource.push({ id: source.id, name: source.name, region, status: health.status, httpStatus: null, items: 0, newestAgeDays: null, verdict: "FALLBACK", note: "auto-disabled; probe not due" });
        continue;
      }

      summary.attempted++;
      const res = await politeFetch(source.url!, {
        mode: "feed",
        etag: health.etag,
        lastModified: health.lastModified,
        config: cfg,
      });

      // A robots.txt disallow is a policy decision, not a transient failure:
      // retrying won't help and the GN fallback is often disallowed too. Mark
      // BLOCKED, don't count it toward auto-disable, don't churn a fallback.
      if (res.blockedByRobots) {
        summary.attempted--;
        summary.perSource.push({
          id: source.id, name: source.name, region, status: health.status,
          httpStatus: null, items: 0, newestAgeDays: null, verdict: "BLOCKED",
          note: "disallowed by robots.txt for our User-Agent",
        });
        continue;
      }

      let verdict: Verdict;
      let note: string | undefined;
      let newestIso: string | null = health.lastItemAt;
      let itemCount = 0;

      if (res.notModified) {
        const t = applyOutcome(health, { kind: "success", now });
        await maybeSave(t.row, persist);
        summary.succeeded++;
        summary.notModified++;
        verdict = "NOT_MODIFIED";
      } else if (res.ok && res.body) {
        const built = buildItems(source, res.body, cfg);
        itemCount = built.items.length;
        if (itemCount === 0) {
          const t = applyOutcome(health, { kind: "failure", error: "zero items / parse error", now });
          if (t.event === "auto_disabled") { summary.newlyDisabled.push(source.id); await runFallback(source, items, summary, cfg); }
          await maybeSave({ ...t.row }, persist);
          summary.failed++;
          verdict = "DEAD";
          note = "zero items parsed";
        } else {
          items.push(...built.items);
          newestIso = built.newestIso;
          const stale = ageDays(newestIso) !== null && ageDays(newestIso)! > cfg.health.staleDays;
          const t = applyOutcome(health, { kind: "success", itemAt: newestIso, now });
          const row = { ...t.row, etag: res.etag ?? null, lastModified: res.lastModified ?? null };
          await maybeSave(row, persist);
          summary.succeeded++;
          if (t.event === "reenabled") summary.reEnabled.push(source.id);
          if (stale) { summary.stale.push(source.id); verdict = "STALE"; note = `newest ${ageDays(newestIso)}d > ${cfg.health.staleDays}d`; }
          else verdict = "LIVE";
        }
      } else {
        const reason = res.blockedByRobots ? "blocked by robots.txt" : res.error ?? `HTTP ${res.status}`;
        const t = applyOutcome(health, { kind: "failure", error: reason, now });
        if (t.event === "auto_disabled") { summary.newlyDisabled.push(source.id); await runFallback(source, items, summary, cfg); }
        await maybeSave(t.row, persist);
        summary.failed++;
        verdict = res.blockedByRobots ? "BLOCKED" : "DEAD";
        note = reason;
      }

      summary.perSource.push({
        id: source.id,
        name: source.name,
        region,
        status: (await getOrInit(source.id, false)).status,
        httpStatus: res.status,
        items: itemCount,
        newestAgeDays: ageDays(newestIso),
        verdict,
        note,
      });
    } catch (err) {
      // A single source must never fail the whole run.
      summary.perSource.push({
        id: source.id,
        name: source.name,
        region: source.region ?? "GLOBAL",
        status: "active",
        httpStatus: null,
        items: 0,
        newestAgeDays: null,
        verdict: "DEAD",
        note: `unexpected: ${err instanceof Error ? err.message : String(err)}`,
      });
      summary.failed++;
    }
  }

  summary.finishedAt = new Date().toISOString();
  return { items, summary };
}

async function maybeSave(row: FeedHealthRow, persist: boolean): Promise<void> {
  if (persist) await saveHealth(row).catch(() => undefined);
}

/** Short run-log summary block for the top of each run's output. */
export function formatRunSummary(s: IngestRunSummary): string {
  const lines = [
    `fetched ${s.attempted} · ok ${s.succeeded} (304: ${s.notModified}) · failed ${s.failed}`,
    `newly disabled: ${s.newlyDisabled.join(", ") || "none"}`,
    `re-enabled: ${s.reEnabled.join(", ") || "none"}`,
    `stale (warning): ${s.stale.join(", ") || "none"}`,
    `fallback active: ${s.fallbackActivated.join(", ") || "none"}`,
  ];
  return lines.join("\n");
}
