import type { RankingConfig } from "../../config/ranking.config";
import { rankingConfig } from "../../config/ranking.config";
import type { DropRecord, RankInputItem } from "../../schemas/ranking";

/**
 * Stage A — hard filters. Pure code, no LLM. Drops items that should never
 * reach scoring and records exactly one reason per drop (first match wins),
 * so the run log can group drops by reason.
 *
 * Storage-dependent checks (already posted / already rejected recently) are
 * injected as a pre-resolved `blocked` map, keyed by BOTH the item id and its
 * clusterId, so this function stays pure and testable without a database.
 */

export type BlockState = "posted" | "rejected";

export interface HardFilterInput {
  items: RankInputItem[];
  config?: RankingConfig;
  /** Current time (injectable for tests). */
  now?: Date;
  /** clusterId OR id -> block state, from storage. */
  blocked?: Map<string, BlockState>;
}

export interface HardFilterResult {
  kept: RankInputItem[];
  drops: DropRecord[];
  droppedByReason: Record<string, number>;
}

/** Reasons, as stable slugs used in logs and the drop records. */
export const DROP_REASONS = {
  SOURCE_DISABLED: "source_disabled",
  ALREADY_POSTED: "already_posted",
  ALREADY_REJECTED: "already_rejected_recently",
  TOO_OLD: "too_old",
  SUMMARY_TOO_SHORT: "summary_too_short",
  BLOCKLIST: "blocklist",
  // X-only hard-filter reasons.
  X_IS_REPLY_OR_REPOST: "x_is_reply_or_repost",
  X_BELOW_ENGAGEMENT_FLOOR: "x_below_engagement_floor",
  X_NO_SOURCE_SHORT: "x_no_source_short",
} as const;

export function hardFilter(input: HardFilterInput): HardFilterResult {
  const config = input.config ?? rankingConfig;
  const now = input.now ?? new Date();
  const blocked = input.blocked ?? new Map<string, BlockState>();
  const disabled = new Set(config.disabledSources.map((s) => s.toLowerCase()));

  const kept: RankInputItem[] = [];
  const drops: DropRecord[] = [];

  const drop = (item: RankInputItem, reason: string, detail?: string): void => {
    drops.push({ id: item.id, clusterId: item.clusterId, reason, detail });
  };

  for (const item of input.items) {
    // 1. Source disabled (upstream flag or config list).
    if (item.sourceDisabled === true || disabled.has(item.source.trim().toLowerCase())) {
      drop(item, DROP_REASONS.SOURCE_DISABLED, item.source);
      continue;
    }

    // 2. Already posted / 3. already rejected within the window.
    const state = blocked.get(item.clusterId) ?? blocked.get(item.id);
    if (state === "posted") {
      drop(item, DROP_REASONS.ALREADY_POSTED, item.clusterId);
      continue;
    }
    if (state === "rejected") {
      drop(item, DROP_REASONS.ALREADY_REJECTED, item.clusterId);
      continue;
    }

    // 4. Too old.
    const ageHours = ageInHours(item.publishedAt, now);
    if (ageHours === null || ageHours > config.maxAgeHours) {
      drop(
        item,
        DROP_REASONS.TOO_OLD,
        ageHours === null ? "unparseable publishedAt" : `${ageHours.toFixed(1)}h > ${config.maxAgeHours}h`,
      );
      continue;
    }

    const summary = (item.summary ?? "").trim();

    // 5. X-specific hard filters. X items SKIP the RSS summary-length rule
    //    (SUMMARY_TOO_SHORT) and use the X knobs instead. too_old above already
    //    applied to them — it stays the single source of truth for the 24h drop.
    if (item.isX === true) {
      if (item.isReply === true || item.isRepost === true) {
        drop(item, DROP_REASONS.X_IS_REPLY_OR_REPOST, item.isReply ? "reply" : "repost");
        continue;
      }
      const eng = item.engagementRaw;
      const engagementTotal = eng ? eng.likes + eng.reposts + eng.replies : 0;
      if (engagementTotal < config.x.minEngagementFloor) {
        drop(item, DROP_REASONS.X_BELOW_ENGAGEMENT_FLOOR, `${engagementTotal} < ${config.x.minEngagementFloor}`);
        continue;
      }
      const hasOutbound = (item.outboundUrls?.length ?? 0) > 0;
      const textLen = Math.max(summary.length, (item.title ?? "").trim().length);
      if (!hasOutbound && textLen < config.x.minTextLength) {
        drop(item, DROP_REASONS.X_NO_SOURCE_SHORT, `no outbound & ${textLen} < ${config.x.minTextLength}`);
        continue;
      }
      // X blocklist check still applies (title + summary).
      const xHay = `${item.title} ${summary}`.toLowerCase();
      const xHit = config.blocklist.find((term) => xHay.includes(term.toLowerCase()));
      if (xHit) {
        drop(item, DROP_REASONS.BLOCKLIST, xHit);
        continue;
      }
      kept.push(item);
      continue;
    }

    // 6. (RSS) Empty / too-short summary.
    if (summary.length < config.minSummaryLength) {
      drop(item, DROP_REASONS.SUMMARY_TOO_SHORT, `${summary.length} < ${config.minSummaryLength}`);
      continue;
    }

    // 7. (RSS) Blocklist (title or summary).
    const hay = `${item.title} ${summary}`.toLowerCase();
    const hit = config.blocklist.find((term) => hay.includes(term.toLowerCase()));
    if (hit) {
      drop(item, DROP_REASONS.BLOCKLIST, hit);
      continue;
    }

    kept.push(item);
  }

  const droppedByReason: Record<string, number> = {};
  for (const d of drops) {
    droppedByReason[d.reason] = (droppedByReason[d.reason] ?? 0) + 1;
  }

  return { kept, drops, droppedByReason };
}

/** Age in hours from an ISO timestamp to `now`; null if unparseable. */
export function ageInHours(publishedAt: string, now: Date): number | null {
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}
