/**
 * saved_x_posts gateway — the storage boundary between the X discovery run
 * (writer) and the main news workflow (reader). The discovery cron SAVES
 * normalized RawContent here; the main workflow's collectXPosts READS from
 * here and never triggers a live scrape.
 *
 * FIX #7: recentWithin is a STORE-WINDOW filter only. It drops rows older than
 * now - maxAgeHours using each item's publishedAt (falling back to collectedAt)
 * so the reader doesn't haul the whole table. It is NOT the ranker's 24h drop —
 * the ranker's `too_old` hard filter remains the single source of truth for the
 * real max-age decision.
 *
 * Dedupe is by URL at save time: the row id is hashString(url), matching the
 * id postToRaw stamps, so re-saving the same post overwrites in place.
 *
 * Mirrors lib/ranking/storage.ts: interface + libSQL impl + in-memory stub.
 */

import type { RawContent } from "../../../schemas/rawContent";
import { hashString } from "../../../collectors/types";
import { createLibSqlRepository, type Repository } from "../../../repositories/store";

type SavedRow = RawContent & { id: string };

export interface SavedXPostsGateway {
  saveMany(items: RawContent[]): Promise<void>;
  recentWithin(maxAgeHours: number, now: Date): Promise<RawContent[]>;
}

/** Best timestamp for the window filter: publishedAt, else collectedAt. */
function effectiveTime(item: RawContent): number {
  const raw = item.publishedAt ?? item.collectedAt;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : NaN;
}

function withinWindow(item: RawContent, cutoffMs: number): boolean {
  const t = effectiveTime(item);
  // Undated rows are kept (the ranker's too_old owns the real drop decision).
  if (Number.isNaN(t)) return true;
  return t >= cutoffMs;
}

/** Stable row id from the post URL (dedupe key). Falls back to existing id. */
function rowId(item: RawContent): string {
  return item.url ? hashString(item.url) : item.id;
}

// ---------- LibSQL-backed gateway (production) ----------

export function createLibSqlSavedXPostsGateway(): SavedXPostsGateway {
  const repo: Repository<SavedRow> = createLibSqlRepository<SavedRow>("saved_x_posts");
  return {
    async saveMany(items) {
      for (const item of items) {
        await repo.save({ ...item, id: rowId(item) });
      }
    },
    async recentWithin(maxAgeHours, now) {
      const cutoff = now.getTime() - maxAgeHours * 3_600_000;
      const all = await repo.list();
      return all.filter((it) => withinWindow(it, cutoff));
    },
  };
}

export const libSqlSavedXPostsGateway = createLibSqlSavedXPostsGateway;

// ---------- In-memory stub (tests / demo) ----------

export function createSavedXPostsStubGateway(seed: RawContent[] = []): SavedXPostsGateway {
  const store = new Map<string, SavedRow>();
  for (const it of seed) store.set(rowId(it), { ...it, id: rowId(it) });
  return {
    async saveMany(items) {
      for (const it of items) store.set(rowId(it), { ...it, id: rowId(it) });
    },
    async recentWithin(maxAgeHours, now) {
      const cutoff = now.getTime() - maxAgeHours * 3_600_000;
      return [...store.values()].filter((it) => withinWindow(it, cutoff));
    },
  };
}
