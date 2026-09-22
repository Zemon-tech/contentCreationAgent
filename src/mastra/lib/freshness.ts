import type { Freshness } from "../schemas/story";

/**
 * Freshness (§4-5): event time vs discovery time are NOT interchangeable.
 * Classification uses event_at OR latest_update_at — NEVER discovered_at.
 */

export interface EventTimestamps {
  event_at?: string;
  first_reported_at?: string;
  latest_update_at?: string;
  discovered_at: string;
}

const HOUR_MS = 3_600_000;

/** Extract the freshest meaningful timestamp: latest_update_at ?? event_at. */
export function freshnessReferenceTs(t: EventTimestamps): number | undefined {
  const latest = t.latest_update_at ?? t.event_at;
  if (!latest) return undefined;
  const ts = Date.parse(latest);
  return Number.isNaN(ts) ? undefined : ts;
}

/**
 * Classify freshness against a requested window (default 24h):
 * - BREAKING: event_at within window (or genuinely new development within window).
 * - DEVELOPING: event older than window BUT latest_update_at within window
 *   AND materially different from the original event (>1h apart).
 * - BACKGROUND: event/update older than window but potentially useful context.
 * - STALE: old with no meaningful recent development.
 */
export function classifyFreshness(
  t: EventTimestamps,
  now: Date = new Date(),
  windowHours = 24,
): { freshness: Freshness; reason: string } {
  const nowMs = now.getTime();
  const eventMs = t.event_at ? Date.parse(t.event_at) : NaN;
  const latestMs = t.latest_update_at ? Date.parse(t.latest_update_at) : NaN;
  const firstMs = t.first_reported_at ? Date.parse(t.first_reported_at) : NaN;

  const ageHours = (ms: number) => (nowMs - ms) / HOUR_MS;

  // Event within window → BREAKING (even if discovered later).
  if (!Number.isNaN(eventMs) && ageHours(eventMs) <= windowHours) {
    return {
      freshness: "BREAKING",
      reason: `Original event occurred ${relHours(ageHours(eventMs))}.`,
    };
  }
  // Genuinely new development within window → BREAKING or DEVELOPING.
  if (!Number.isNaN(latestMs) && ageHours(latestMs) <= windowHours) {
    const materiallyNew =
      Number.isNaN(eventMs) || Math.abs(latestMs - eventMs) > HOUR_MS;
    if (!Number.isNaN(eventMs) && ageHours(eventMs) > windowHours && materiallyNew) {
      return {
        freshness: "DEVELOPING",
        reason:
          `Original event occurred ${relHours(ageHours(eventMs))}, ` +
          `but meaningful new information appeared ${relHours(ageHours(latestMs))}.`,
      };
    }
    if (Number.isNaN(eventMs) && materiallyNew) {
      return {
        freshness: "BREAKING",
        reason: `New development reported ${relHours(ageHours(latestMs))}.`,
      };
    }
    // latest == event but event check above missed (e.g. missing event_at).
    return {
      freshness: "BREAKING",
      reason: `Latest update occurred ${relHours(ageHours(latestMs))}.`,
    };
  }
  // Outside the window: BACKGROUND vs STALE.
  void firstMs;
  if (!Number.isNaN(eventMs) || !Number.isNaN(latestMs)) {
    const refMs = Number.isNaN(latestMs) ? eventMs : latestMs;
    return {
      freshness: "STALE",
      reason:
        `Event/update occurred ${relHours(ageHours(refMs))} ago with ` +
        `no meaningful development in the last ${windowHours}h; discovered recently does not make it fresh.`,
    };
  }
  return {
    freshness: "BACKGROUND",
    reason: "No reliable event timestamp; treating as background context.",
  };
}

/** Explain why a story qualifies (or not) for the requested collection window. */
export function freshnessJustification(
  t: EventTimestamps,
  windowHours = 24,
  now: Date = new Date(),
): string {
  const { freshness, reason } = classifyFreshness(t, now, windowHours);
  return `[${freshness}] ${reason}`;
}

function relHours(h: number): string {
  if (h < 1) return `${Math.max(0, Math.round(h * 60))} minutes ago`;
  if (h < 48) return `${Math.round(h)} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** A story qualifies as "fresh" for the window only via event/latest timestamps. */
export function qualifiesForWindow(
  t: EventTimestamps,
  windowHours = 24,
  now: Date = new Date(),
): boolean {
  const { freshness } = classifyFreshness(t, now, windowHours);
  return freshness === "BREAKING" || freshness === "DEVELOPING";
}
