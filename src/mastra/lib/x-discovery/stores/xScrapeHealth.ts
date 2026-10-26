/**
 * x_scrape_health gateway — the single persisted health record for the X
 * discovery branch. It carries the escalating stop-cooldown ladder index, the
 * consecutive-empty counter, the active cooldownUntil, and the per-query
 * last-run map used to enforce the per-query cooldown across runs.
 *
 * Only one row ('health') ever exists. Mirrors lib/ranking/storage.ts:
 *   interface + libSQL impl (createLibSqlRepository) + in-memory stub factory.
 */

import { createLibSqlRepository, type Repository } from "../../../repositories/store";

export const HEALTH_ID = "health";

export interface XScrapeHealth {
  id: string; // always HEALTH_ID
  lastRunAt?: string;
  lastStopReason?: string;
  cooldownUntil?: string;
  /** Index into config.stopCooldownHoursLadder for the NEXT stop. */
  cooldownLadderIndex: number;
  /** Consecutive empty-result count; a stop triggers at the configured limit. */
  consecutiveEmpty: number;
  /** query -> ISO timestamp of its last run (per-query cooldown). */
  lastQueryRunAt: Record<string, string>;
}

export interface XScrapeHealthGateway {
  load(): Promise<XScrapeHealth>;
  save(health: XScrapeHealth): Promise<void>;
}

export function freshHealth(): XScrapeHealth {
  return {
    id: HEALTH_ID,
    cooldownLadderIndex: 0,
    consecutiveEmpty: 0,
    lastQueryRunAt: {},
  };
}

function normalize(h: Partial<XScrapeHealth> | undefined): XScrapeHealth {
  return {
    id: HEALTH_ID,
    lastRunAt: h?.lastRunAt,
    lastStopReason: h?.lastStopReason,
    cooldownUntil: h?.cooldownUntil,
    cooldownLadderIndex: h?.cooldownLadderIndex ?? 0,
    consecutiveEmpty: h?.consecutiveEmpty ?? 0,
    lastQueryRunAt: h?.lastQueryRunAt ?? {},
  };
}

// ---------- LibSQL-backed gateway (production) ----------

export function createLibSqlXScrapeHealthGateway(): XScrapeHealthGateway {
  const repo: Repository<XScrapeHealth> =
    createLibSqlRepository<XScrapeHealth>("x_scrape_health");
  return {
    async load() {
      const row = await repo.get(HEALTH_ID);
      return normalize(row);
    },
    async save(health) {
      await repo.save({ ...normalize(health), id: HEALTH_ID });
    },
  };
}

export const libSqlXScrapeHealthGateway = createLibSqlXScrapeHealthGateway;

// ---------- In-memory stub (tests / demo) ----------

export function createXScrapeHealthStubGateway(seed?: Partial<XScrapeHealth>): XScrapeHealthGateway {
  let state = normalize(seed);
  return {
    async load() {
      return { ...state, lastQueryRunAt: { ...state.lastQueryRunAt } };
    },
    async save(health) {
      state = { ...normalize(health), lastQueryRunAt: { ...health.lastQueryRunAt } };
    },
  };
}
