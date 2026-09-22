import type { RawContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import { ArXivCollector } from "./arxiv";
import { GitHubCollector } from "./github";
import { RssCollector } from "./rss";
import {
  CommunityStubCollector,
  GenericSocialStubCollector,
  InstagramCollector,
  LinkedInCollector,
  NewsletterCollector,
  PodcastStubCollector,
  ProductHuntCollector,
  VideoStubCollector,
  XCollector,
} from "./stubs";
import { WebCollector } from "./web";
import type { CollectResult, SourceCollector } from "./types";

/** Ordered: specific collectors first, generic stubs last. */
export const COLLECTORS: SourceCollector[] = [
  new RssCollector(),
  new ArXivCollector(),
  new GitHubCollector(),
  new WebCollector(),
  new XCollector(),
  new LinkedInCollector(),
  new InstagramCollector(),
  new NewsletterCollector(),
  new ProductHuntCollector(),
  new PodcastStubCollector(),
  new VideoStubCollector(),
  new CommunityStubCollector(),
  new GenericSocialStubCollector(),
];

export function collectorFor(source: Source): SourceCollector | undefined {
  return COLLECTORS.find((c) => c.supports(source));
}

export interface SweepOptions {
  maxItems?: number;
  /** Max concurrent in-flight sources. Default 8. */
  concurrency?: number;
  /** Per-source circuit breaker. Default 20000ms. */
  perSourceTimeoutMs?: number;
}

export interface SweepResult extends CollectResult {
  durationMs: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer!));
}

export async function collectFromSource(
  source: Source,
  opts?: { maxItems?: number; timeoutMs?: number },
): Promise<CollectResult> {
  const collector = collectorFor(source);
  if (!collector) {
    return {
      sourceId: source.id,
      sourceName: source.name,
      items: [],
      skipped: `no collector supports type "${source.type}"`,
    };
  }
  const run = async () => collector.collect(source, { maxItems: opts?.maxItems });
  try {
    const items = opts?.timeoutMs ? await withTimeout(run(), opts.timeoutMs, source.id) : await run();
    return { sourceId: source.id, sourceName: source.name, items };
  } catch (err) {
    return {
      sourceId: source.id,
      sourceName: source.name,
      items: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Parallel sweep over sources with a bounded concurrency pool.
 * - Independent sources run concurrently (concurrency-limited).
 * - Each source has its own timeout; failures/timeouts are recorded,
 *   never thrown — the sweep always completes.
 * - Per-source durations are returned for observability (find slow sources).
 */
export async function sweepSources(
  sources: Source[],
  opts?: SweepOptions,
): Promise<SweepResult[]> {
  const active = sources.filter((s) => s.active);
  const concurrency = Math.min(Math.max(opts?.concurrency ?? 8, 1), 32);
  const timeoutMs = opts?.perSourceTimeoutMs ?? 20000;
  const results: SweepResult[] = new Array(active.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= active.length) return;
      const source = active[i]!;
      const started = Date.now();
      const r = await collectFromSource(source, {
        maxItems: opts?.maxItems,
        timeoutMs,
      });
      results[i] = { ...r, durationMs: Date.now() - started };
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, active.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/** Backwards-compatible: unbounded parallel collect with timing. */
export async function collectFromSources(
  sources: Source[],
  opts?: { maxItems?: number },
): Promise<CollectResult[]> {
  const swept = await sweepSources(sources, {
    maxItems: opts?.maxItems,
    concurrency: 32,
  });
  return swept.map(({ durationMs: _d, ...rest }) => rest);
}

export type { CollectResult, RawContent };
