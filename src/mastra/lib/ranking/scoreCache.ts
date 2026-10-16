import type { LlmScore, RankInputItem } from "../../schemas/ranking";
import { createLibSqlRepository, type Repository } from "../../repositories/store";
import { canonicalKeyForItem } from "../safety/ledger-key";
import type { ScoreCache } from "./llmScore";

/**
 * Persistent Stage-B score cache (LibSQL, same DB as the ledger).
 *
 * Key = model tag + cache version + canonical URL/content hash, so a different
 * model or an edited prompt/few-shot (bump RANK_CACHE_VERSION) never reuses a
 * stale judgement. Entries expire after RANK_CACHE_TTL_HOURS (default 24).
 * Used by the scheduled workflow only — `rank:eval` never uses it, so
 * calibration always reflects the live model.
 */

interface CacheRow {
  id: string;
  score: LlmScore;
  at: string;
  createdAt: string;
}

const repo: Repository<CacheRow> = createLibSqlRepository<CacheRow>("rank_score_cache");

function modelTag(): string {
  return process.env["RANK_MODEL_NAME"] || process.env["LOCAL_MODEL_NAME"] || "default";
}

export function cacheKeyFor(item: RankInputItem): string {
  const version = process.env["RANK_CACHE_VERSION"] || "1";
  return `${modelTag()}::v${version}::${canonicalKeyForItem(item)}`;
}

export function createScoreCache(opts: { ttlHours?: number; now?: () => Date } = {}): ScoreCache {
  const ttlMs = (opts.ttlHours ?? (Number(process.env["RANK_CACHE_TTL_HOURS"]) || 24)) * 3_600_000;
  const now = opts.now ?? (() => new Date());
  return {
    async get(item) {
      const row = await repo.get(cacheKeyFor(item));
      if (!row) return undefined;
      const age = now().getTime() - Date.parse(row.at);
      return Number.isFinite(age) && age <= ttlMs ? row.score : undefined;
    },
    async set(item, score) {
      const at = now().toISOString();
      await repo.save({ id: cacheKeyFor(item), score, at, createdAt: at });
    },
  };
}

/** Disabled with RANK_CACHE_ENABLED=false. */
export function cacheEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env["RANK_CACHE_ENABLED"]?.trim() || "true");
}
