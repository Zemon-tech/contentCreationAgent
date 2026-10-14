import { ingestionConfig, type IngestionConfig } from "../config/ingestion.config";
import { createLibSqlRepository, type Repository } from "./store";

/**
 * Feed-health store + state machine (Section A, item 3).
 *
 * Status: active | disabled_auto | disabled_manual.
 * - failure (network/timeout/non-2xx except 304/parse error/zero items) ++;
 *   at AUTO_DISABLE_AFTER -> disabled_auto, schedule nextProbeAt.
 * - success (incl. 304) resets failures; a disabled_auto source that succeeds
 *   (via a due probe) returns to active.
 * - stale (newest item older than STALE_DAYS) is a WARNING, NOT a failure.
 * - disabled_manual is NEVER auto-enabled by a probe.
 * Every transition is wrapped by callers in try/catch; health never fails a run.
 */

export type FeedStatus = "active" | "disabled_auto" | "disabled_manual";

export interface FeedHealthRow {
  id: string; // sourceId
  status: FeedStatus;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastItemAt: string | null;
  disabledAt: string | null;
  nextProbeAt: string | null;
  /** Conditional-GET validators from the last successful fetch. */
  etag: string | null;
  lastModified: string | null;
  updatedAt: string;
}

export const feedHealthRepository: Repository<FeedHealthRow> =
  createLibSqlRepository<FeedHealthRow>("feed_health");

function blankRow(id: string): FeedHealthRow {
  return {
    id,
    status: "active",
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    lastItemAt: null,
    disabledAt: null,
    nextProbeAt: null,
    etag: null,
    lastModified: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function getHealth(id: string): Promise<FeedHealthRow | undefined> {
  return feedHealthRepository.get(id);
}

export async function getOrInit(id: string, manualDisabled: boolean): Promise<FeedHealthRow> {
  const existing = await feedHealthRepository.get(id);
  if (existing) return existing;
  const row = blankRow(id);
  if (manualDisabled) row.status = "disabled_manual";
  return row;
}

export type Outcome =
  | { kind: "success"; itemAt?: string | null; stale?: boolean; now?: Date }
  | { kind: "failure"; error: string; now?: Date };

export interface HealthTransition {
  row: FeedHealthRow;
  /** "reenabled" | "auto_disabled" | null */
  event: "reenabled" | "auto_disabled" | null;
}

export function applyOutcome(
  row: FeedHealthRow,
  outcome: Outcome,
  cfg: IngestionConfig = ingestionConfig,
): HealthTransition {
  const now = (outcome.now ?? new Date()).toISOString();
  const next: FeedHealthRow = { ...row, updatedAt: now };
  let event: HealthTransition["event"] = null;

  if (row.status === "disabled_manual") {
    // Manual stays manual; still record observations, never auto-enable.
    if (outcome.kind === "success") {
      next.lastSuccessAt = now;
      if (outcome.itemAt !== undefined) next.lastItemAt = outcome.itemAt;
    } else {
      next.lastFailureAt = now;
      next.lastError = outcome.error;
    }
    return { row: next, event };
  }

  if (outcome.kind === "success") {
    next.consecutiveFailures = 0;
    next.lastSuccessAt = now;
    next.lastError = null;
    if (outcome.itemAt !== undefined) next.lastItemAt = outcome.itemAt;
    if (row.status === "disabled_auto") {
      next.status = "active";
      next.disabledAt = null;
      next.nextProbeAt = null;
      event = "reenabled";
    }
    return { row: next, event };
  }

  // failure
  next.consecutiveFailures = row.consecutiveFailures + 1;
  next.lastFailureAt = now;
  next.lastError = outcome.error;
  if (next.status !== "disabled_auto" && next.consecutiveFailures >= cfg.health.autoDisableAfter) {
    next.status = "disabled_auto";
    next.disabledAt = now;
    next.nextProbeAt = new Date((outcome.now ?? new Date()).getTime() + cfg.health.reprobeHours * 3_600_000).toISOString();
    event = "auto_disabled";
  } else if (next.status === "disabled_auto") {
    // Failed probe: push nextProbeAt out again.
    next.nextProbeAt = new Date((outcome.now ?? new Date()).getTime() + cfg.health.reprobeHours * 3_600_000).toISOString();
  }
  return { row: next, event };
}

/** A disabled_auto source whose nextProbeAt has passed should be probed once. */
export function isProbeDue(row: FeedHealthRow, now: Date = new Date()): boolean {
  return row.status === "disabled_auto" && !!row.nextProbeAt && now.getTime() >= Date.parse(row.nextProbeAt);
}

export async function saveHealth(row: FeedHealthRow): Promise<void> {
  await feedHealthRepository.save(row);
}
