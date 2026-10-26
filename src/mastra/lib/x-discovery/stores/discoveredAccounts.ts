/**
 * discovered_accounts gateway — the learned roster of X accounts the discovery
 * run has seen. A handle is written ONLY here, and ONLY from a real scrape
 * result (NFR-2: the LLM never invents a handle). upsertFromScrape is where the
 * code-side learning happens: it folds new engagement samples in, recomputes
 * the medians, and re-derives credibility + status via the pure functions in
 * learning.ts.
 *
 * Mirrors the gateway pattern in lib/ranking/storage.ts:
 *   interface + libSQL impl (createLibSqlRepository) + in-memory stub factory.
 */

import { createLibSqlRepository, type Repository } from "../../../repositories/store";
import { getXDiscoveryConfig, type XDiscoveryConfig } from "../../../config/xDiscovery";
import { credibilityOf, median, statusFor } from "../learning";

/** Rolling sample cap so a long-lived account doesn't grow unbounded. */
const SAMPLE_CAP = 20;

export type DiscoveredAccountStatus = "candidate" | "promoted" | "demoted";

export interface DiscoveredAccount {
  /** id = handle.toLowerCase() (stable primary key). */
  id: string;
  handle: string;
  firstSeen: string;
  timesSeen: number;
  medianLikes: number;
  medianReposts: number;
  /** 0..10, computed in code (never from the LLM). */
  credibilityScore: number;
  status: DiscoveredAccountStatus;
  /** Rolling samples (capped) used to recompute medians + spam penalty. */
  recentLikes: number[];
  recentReposts: number[];
  recentTexts: string[];
  /** YYYY-MM-DD of the last profile visit, to cap one visit/account/day. */
  lastProfileVisitDay?: string;
}

/** One post's engagement + text, as scraped. */
export interface AccountSample {
  likes?: number | null;
  reposts?: number | null;
  text?: string;
}

export interface DiscoveredAccountsGateway {
  get(handle: string): Promise<DiscoveredAccount | undefined>;
  /** Fold new samples in, recompute medians + credibility + status (learning). */
  upsertFromScrape(
    handle: string,
    samples: AccountSample[],
    now: Date,
  ): Promise<DiscoveredAccount>;
  list(): Promise<DiscoveredAccount[]>;
  markProfileVisited(handle: string, day: string): Promise<void>;
}

function keyFor(handle: string): string {
  return handle.replace(/^@/, "").toLowerCase();
}

function capTail<T>(arr: T[], cap: number): T[] {
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}

/**
 * Pure learning step shared by the libSQL impl and the stub: given the existing
 * (or fresh) account and new samples, produce the updated account snapshot.
 */
function applyScrape(
  existing: DiscoveredAccount | undefined,
  handle: string,
  samples: AccountSample[],
  now: Date,
  config: XDiscoveryConfig,
): DiscoveredAccount {
  const id = keyFor(handle);
  const nowIso = now.toISOString();
  const base: DiscoveredAccount =
    existing ?? {
      id,
      handle: handle.replace(/^@/, ""),
      firstSeen: nowIso,
      timesSeen: 0,
      medianLikes: 0,
      medianReposts: 0,
      credibilityScore: 0,
      status: "candidate",
      recentLikes: [],
      recentReposts: [],
      recentTexts: [],
    };

  const newLikes = samples.map((s) => Number(s.likes ?? 0)).filter((n) => Number.isFinite(n));
  const newReposts = samples.map((s) => Number(s.reposts ?? 0)).filter((n) => Number.isFinite(n));
  const newTexts = samples.map((s) => (s.text ?? "").trim()).filter((t) => t);

  const recentLikes = capTail([...base.recentLikes, ...newLikes], SAMPLE_CAP);
  const recentReposts = capTail([...base.recentReposts, ...newReposts], SAMPLE_CAP);
  const recentTexts = capTail([...base.recentTexts, ...newTexts], SAMPLE_CAP);

  const updated: DiscoveredAccount = {
    ...base,
    timesSeen: base.timesSeen + 1,
    recentLikes,
    recentReposts,
    recentTexts,
    medianLikes: median(recentLikes),
    medianReposts: median(recentReposts),
  };

  // credibility first (depends on medians), then status (depends on credibility).
  updated.credibilityScore = credibilityOf(updated, config);
  updated.status = statusFor(updated, config);
  return updated;
}

// ---------- LibSQL-backed gateway (production) ----------

export function createLibSqlDiscoveredAccountsGateway(
  config: XDiscoveryConfig = getXDiscoveryConfig(),
): DiscoveredAccountsGateway {
  const repo: Repository<DiscoveredAccount> =
    createLibSqlRepository<DiscoveredAccount>("discovered_accounts");
  return {
    async get(handle) {
      return repo.get(keyFor(handle));
    },
    async upsertFromScrape(handle, samples, now) {
      const existing = await repo.get(keyFor(handle));
      const updated = applyScrape(existing, handle, samples, now, config);
      await repo.save(updated);
      return updated;
    },
    async list() {
      return repo.list();
    },
    async markProfileVisited(handle, day) {
      const existing = await repo.get(keyFor(handle));
      if (!existing) return;
      await repo.save({ ...existing, lastProfileVisitDay: day });
    },
  };
}

/** Back-compat alias used by the cron wiring. */
export const libSqlDiscoveredAccountsGateway = createLibSqlDiscoveredAccountsGateway;

// ---------- In-memory stub (tests / demo) ----------

export function createDiscoveredAccountsStubGateway(
  seed: DiscoveredAccount[] = [],
  config: XDiscoveryConfig = getXDiscoveryConfig(),
): DiscoveredAccountsGateway {
  const store = new Map<string, DiscoveredAccount>();
  for (const a of seed) store.set(a.id, { ...a });
  return {
    async get(handle) {
      return store.get(keyFor(handle));
    },
    async upsertFromScrape(handle, samples, now) {
      const existing = store.get(keyFor(handle));
      const updated = applyScrape(existing, handle, samples, now, config);
      store.set(updated.id, updated);
      return updated;
    },
    async list() {
      return [...store.values()];
    },
    async markProfileVisited(handle, day) {
      const existing = store.get(keyFor(handle));
      if (existing) store.set(existing.id, { ...existing, lastProfileVisitDay: day });
    },
  };
}
