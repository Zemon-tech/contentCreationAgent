/**
 * x_daily_budget gateway — the persisted per-day budget for search-page loads
 * and profile visits. Counters key on the day string (YYYY-MM-DD in the
 * configured tz) so they reset automatically at the day boundary and survive
 * process restarts.
 *
 * Mirrors lib/ranking/storage.ts: interface + libSQL impl + in-memory stub.
 */

import { createLibSqlRepository, type Repository } from "../../../repositories/store";

export interface XDailyBudget {
  /** id = YYYY-MM-DD in config.dayBoundaryTz. */
  id: string;
  searchLoads: number;
  profileVisits: number;
}

export interface XBudgetGateway {
  today(day: string): Promise<XDailyBudget>;
  incSearch(day: string, n?: number): Promise<XDailyBudget>;
  incProfile(day: string, n?: number): Promise<XDailyBudget>;
}

/** YYYY-MM-DD for `now` in the given IANA tz (budget day boundary). */
export function dayKey(now: Date, tz: string): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function fresh(day: string): XDailyBudget {
  return { id: day, searchLoads: 0, profileVisits: 0 };
}

// ---------- LibSQL-backed gateway (production) ----------

export function createLibSqlXBudgetGateway(): XBudgetGateway {
  const repo: Repository<XDailyBudget> =
    createLibSqlRepository<XDailyBudget>("x_daily_budget");
  return {
    async today(day) {
      return (await repo.get(day)) ?? fresh(day);
    },
    async incSearch(day, n = 1) {
      const cur = (await repo.get(day)) ?? fresh(day);
      const next = { ...cur, searchLoads: cur.searchLoads + n };
      await repo.save(next);
      return next;
    },
    async incProfile(day, n = 1) {
      const cur = (await repo.get(day)) ?? fresh(day);
      const next = { ...cur, profileVisits: cur.profileVisits + n };
      await repo.save(next);
      return next;
    },
  };
}

export const libSqlXBudgetGateway = createLibSqlXBudgetGateway;

// ---------- In-memory stub (tests / demo) ----------

export function createXBudgetStubGateway(seed: XDailyBudget[] = []): XBudgetGateway {
  const store = new Map<string, XDailyBudget>();
  for (const b of seed) store.set(b.id, { ...b });
  return {
    async today(day) {
      return store.get(day) ?? fresh(day);
    },
    async incSearch(day, n = 1) {
      const cur = store.get(day) ?? fresh(day);
      const next = { ...cur, searchLoads: cur.searchLoads + n };
      store.set(day, next);
      return next;
    },
    async incProfile(day, n = 1) {
      const cur = store.get(day) ?? fresh(day);
      const next = { ...cur, profileVisits: cur.profileVisits + n };
      store.set(day, next);
      return next;
    },
  };
}
