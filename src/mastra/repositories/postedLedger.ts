import { postingConfig, type PostingConfig } from "../config/posting.config";
import type { Region } from "../schemas/ranking";
import { createLibSqlRepository, type Repository } from "./store";

/**
 * Posted-ledger (Step 7) — the record of every publish attempt, keyed on the
 * canonical URL + content hash (see lib/safety/ledger-key.ts). It is the single
 * source of truth for idempotency and "never post twice".
 *
 * Status lifecycle:
 *   pending  -> written BEFORE publish, so a crash mid-publish cannot repost
 *   posted   -> published successfully (blocks forever)
 *   rejected -> not chosen / declined at approval (blocks for a window)
 *   failed   -> publish failed after the one retry (blocks for a window)
 *   dry_run  -> simulated only; does NOT block a future real post
 */

export type PostOutcome = "pending" | "posted" | "rejected" | "failed" | "dry_run";

export interface PostedLedgerRow {
  id: string; // canonicalKey
  status: PostOutcome;
  storyId: string;
  url: string;
  title: string;
  region: Region;
  at: string; // ISO decision/attempt time
  permalink?: string;
  mediaId?: string;
  error?: string;
  /** Local image file used (so cleanup never deletes a pending/publishing image). */
  imageLocalPath?: string | null;
  createdAt: string; // drives list() ordering
}

export const postedLedgerRepository: Repository<PostedLedgerRow> =
  createLibSqlRepository<PostedLedgerRow>("posted_ledger");

export async function recordAttempt(row: Omit<PostedLedgerRow, "createdAt"> & { createdAt?: string }): Promise<void> {
  await postedLedgerRepository.save({ ...row, createdAt: row.createdAt ?? row.at });
}

export async function getRow(key: string): Promise<PostedLedgerRow | undefined> {
  return postedLedgerRepository.get(key);
}

/**
 * Canonical keys that must NOT be re-selected: posted/pending always, and
 * rejected/failed within the configured window. dry_run never blocks.
 */
/** Pure blocking rule (testable without a DB). dry_run never blocks. */
export function computeBlocked(
  rows: PostedLedgerRow[],
  opts: { now?: Date; blockRejectedForHours: number },
): Map<string, PostOutcome> {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - opts.blockRejectedForHours * 3_600_000;
  const map = new Map<string, PostOutcome>();
  for (const r of rows) {
    if (r.status === "posted" || r.status === "pending") {
      map.set(r.id, r.status);
    } else if (r.status === "rejected" || r.status === "failed") {
      const t = Date.parse(r.at);
      if (!Number.isNaN(t) && t >= cutoff && !map.has(r.id)) map.set(r.id, r.status);
    }
  }
  return map;
}

export async function getBlockedKeys(opts: { now?: Date; config?: PostingConfig } = {}): Promise<Map<string, PostOutcome>> {
  const cfg = opts.config ?? postingConfig;
  const rows = await postedLedgerRepository.list();
  return computeBlocked(rows, { now: opts.now, blockRejectedForHours: cfg.blockRejectedForHours });
}

/** Regions of the last `n` POSTED items, most-recent first (region balance). */
export async function recentPostedRegions(n: number): Promise<Region[]> {
  const rows = await postedLedgerRepository.list(); // created_at DESC
  return rows.filter((r) => r.status === "posted").slice(0, n).map((r) => r.region);
}

/** Count of real posts in the last 24h (for the daily cap). */
export async function countPostedLast24h(now: Date = new Date()): Promise<number> {
  const cutoff = now.getTime() - 24 * 3_600_000;
  const rows = await postedLedgerRepository.list();
  return rows.filter((r) => r.status === "posted" && Date.parse(r.at) >= cutoff).length;
}

/** ISO timestamp of the most recent real post, or null. */
export async function lastPostedAt(): Promise<string | null> {
  const rows = await postedLedgerRepository.list();
  const posted = rows.filter((r) => r.status === "posted");
  return posted.length ? posted[0]!.at : null;
}

/** Image paths belonging to stories currently pending/publishing — never delete these. */
export async function pendingImagePaths(): Promise<Set<string>> {
  const rows = await postedLedgerRepository.list();
  const set = new Set<string>();
  for (const r of rows) {
    if (r.status === "pending" && r.imageLocalPath) set.add(r.imageLocalPath);
  }
  return set;
}
