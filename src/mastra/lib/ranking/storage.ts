import type { RankResult, Region } from "../../schemas/ranking";
import { createLibSqlRepository, type Repository } from "../../repositories/store";
import { getBlockedKeys, recentPostedRegions, recordAttempt } from "../../repositories/postedLedger";
import type { BlockState } from "./hardFilter";

/**
 * Storage gateway for the ranker. Stage A (already posted / rejected recently)
 * and the Stage C region-balance read through this interface; the run log is
 * persisted through it. Keeping it an interface lets tests and `rank:eval` run
 * with an in-memory stub and no database.
 *
 * Tables (via the project's generic LibSQL repository, JSON blobs keyed by id):
 *   - rank_runs   : one row per ranking run (the full RankResult).
 *   - rank_ledger : one row per cluster decision (posted / rejected + when),
 *                   written by the DOWNSTREAM publish/approval step and read
 *                   here. id = clusterId.
 */

export interface RankLedgerRow {
  id: string; // clusterId
  state: BlockState; // "posted" | "rejected"
  region: Region;
  at: string; // ISO timestamp of the decision
}

export interface RankStorageGateway {
  /** clusterId/id -> block state, honoring the rejected-within window. */
  getBlocked(opts: { rejectedWithinHours: number; now?: Date }): Promise<Map<string, BlockState>>;
  /** Regions of the last `n` POSTED items, most-recent first. */
  getRecentRegions(n: number): Promise<Region[]>;
  /** Persist a finished run for later inspection. */
  saveRunLog(result: RankResult): Promise<void>;
  /** Record a cluster decision (used by the downstream publish/approval step). */
  recordDecision(row: RankLedgerRow): Promise<void>;
}

// ---------- LibSQL-backed gateway (production) ----------
//
// Blocking + region balance are now backed by the canonical-keyed posted-ledger
// (repositories/postedLedger.ts). getBlocked returns CANONICAL KEYS (url +
// content hash), which rankStories translates to item ids. pending/failed map
// onto the BlockState the hard filter understands (posted/rejected).

const runRepo: Repository<RankResult & { id: string }> =
  createLibSqlRepository<RankResult & { id: string }>("rank_runs");

export const libSqlRankGateway: RankStorageGateway = {
  async getBlocked({ now }) {
    const keys = await getBlockedKeys({ now });
    const map = new Map<string, BlockState>();
    for (const [key, outcome] of keys) {
      map.set(key, outcome === "posted" || outcome === "pending" ? "posted" : "rejected");
    }
    return map;
  },

  async getRecentRegions(n) {
    return recentPostedRegions(n);
  },

  async saveRunLog(result) {
    await runRepo.save({ ...result, id: result.runId });
  },

  async recordDecision(row) {
    await recordAttempt({
      id: row.id,
      status: row.state === "posted" ? "posted" : "rejected",
      storyId: row.id,
      url: "",
      title: "",
      region: row.region,
      at: row.at,
    });
  },
};

// ---------- In-memory stub (tests / eval) ----------

export function createStubGateway(
  seed: { blocked?: Map<string, BlockState>; recentRegions?: Region[] } = {},
): RankStorageGateway {
  const runs: RankResult[] = [];
  const ledger: RankLedgerRow[] = [];
  return {
    async getBlocked() {
      return seed.blocked ?? new Map();
    },
    async getRecentRegions(n) {
      if (seed.recentRegions) return seed.recentRegions.slice(0, n);
      return ledger.filter((r) => r.state === "posted").slice(0, n).map((r) => r.region);
    },
    async saveRunLog(result) {
      runs.push(result);
    },
    async recordDecision(row) {
      ledger.unshift(row);
    },
  };
}
