import type { RankResult, Region } from "../../schemas/ranking";
import { createLibSqlRepository, type Repository } from "../../repositories/store";
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

const runRepo: Repository<RankResult & { id: string }> =
  createLibSqlRepository<RankResult & { id: string }>("rank_runs");
const ledgerRepo: Repository<RankLedgerRow> =
  createLibSqlRepository<RankLedgerRow>("rank_ledger");

export const libSqlRankGateway: RankStorageGateway = {
  async getBlocked({ rejectedWithinHours, now }) {
    const rows = await ledgerRepo.list();
    const cutoff = (now ?? new Date()).getTime() - rejectedWithinHours * 3_600_000;
    const map = new Map<string, BlockState>();
    for (const r of rows) {
      if (r.state === "posted") {
        map.set(r.id, "posted");
      } else if (r.state === "rejected") {
        const t = Date.parse(r.at);
        if (!Number.isNaN(t) && t >= cutoff && map.get(r.id) !== "posted") {
          map.set(r.id, "rejected");
        }
      }
    }
    return map;
  },

  async getRecentRegions(n) {
    const rows = await ledgerRepo.list(); // created_at DESC
    return rows
      .filter((r) => r.state === "posted")
      .slice(0, n)
      .map((r) => r.region);
  },

  async saveRunLog(result) {
    await runRepo.save({ ...result, id: result.runId });
  },

  async recordDecision(row) {
    // createdAt drives ordering in list(); stamp it from the decision time.
    await ledgerRepo.save({ ...row, createdAt: row.at } as RankLedgerRow & { createdAt: string });
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
