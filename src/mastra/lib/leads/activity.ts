import { ICP_RULES } from "../../config/icpRules";
import type {
  ActivityStatus,
  ActivitySummary,
  CriterionOutcome,
  EntityActivity,
  PlannedPerson,
  PlatformActivitySummary,
  SeedRow,
  SocialPlatform,
} from "../../schemas/lead";
import { personKey } from "./contacts";
import { groundingSupports } from "./evidence";
import { isDecisionMakerTitle } from "./icp";

/**
 * Social activity (M6): who to check, and how "active" they are.
 * Status is computed in CODE from the most recent post date. A value only
 * counts when Exa's output.grounding cites that platform entry, so a date the
 * model made up can never make a company look active.
 */

const PLATFORMS: SocialPlatform[] = ["linkedin", "x", "instagram"];
const RANK: Record<ActivityStatus, number> = { active: 3, low_activity: 2, dormant: 1, unknown: 0 };
const DAY_MS = 86_400_000;

type M1Leader = { name?: unknown; title?: unknown; is_founder?: unknown; linkedin_url?: unknown };
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Founders first, then other decision-makers, then remaining leaders; plus the seed contact. */
export function selectActivityPeople(row: SeedRow, m1: unknown, max: number): PlannedPerson[] {
  if (max <= 0) return [];
  const leaders = ((m1 as { leaders?: M1Leader[] } | null)?.leaders ?? []) as M1Leader[];
  const rank = (l: M1Leader) => (l.is_founder === true ? 0 : isDecisionMakerTitle(str(l.title)) ? 1 : 2);
  const seen = new Set<string>();
  const out: PlannedPerson[] = [];
  for (const l of [...leaders].sort((a, b) => rank(a) - rank(b))) {
    const name = str(l.name);
    if (!name || seen.has(personKey(name))) continue;
    seen.add(personKey(name));
    out.push({
      key: personKey(name),
      name,
      title: str(l.title),
      function: "leadership",
      linkedin_url: str(l.linkedin_url),
      is_leader: true,
      source: "exa_m1",
    });
  }
  if (row.contact_person && isDecisionMakerTitle(row.designation) && !seen.has(personKey(row.contact_person))) {
    out.push({
      key: personKey(row.contact_person),
      name: row.contact_person,
      title: row.designation,
      function: null,
      linkedin_url: null,
      is_leader: true,
      source: "seed_csv",
    });
  }
  return out.slice(0, max);
}

/** YYYY-MM-DD / YYYY-MM / ISO timestamp -> Date (month-only dates use the 1st). */
export function parsePostDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function statusFromDays(days: number | null, postsLast90: number | null): ActivityStatus {
  const { activeWithinDays, dormantAfterDays } = ICP_RULES.activity;
  if (days !== null) {
    if (days <= activeWithinDays) return "active";
    if (days <= dormantAfterDays) return "low_activity";
    return "dormant";
  }
  // No date, but a 90-day count: posted within 90 days -> at least low activity.
  if (postsLast90 !== null && postsLast90 > 0) return "low_activity";
  return "unknown";
}

function summarizePlatform(
  raw: unknown,
  platform: SocialPlatform,
  path: (string | number)[],
  grounding: unknown,
  now: Date,
): PlatformActivitySummary {
  const ref = `M6.${[...path, platform].join(".")}`;
  const empty: PlatformActivitySummary = {
    platform,
    profile_url: null,
    followers: null,
    total_posts: null,
    posts_last_90_days: null,
    last_post_date: null,
    days_since_last_post: null,
    status: "unknown",
    grounded: false,
    ref,
  };
  if (!raw || typeof raw !== "object") return empty;
  const p = raw as Record<string, unknown>;
  const segs = [...path.map(String), platform];
  const grounded = groundingSupports(grounding, segs);
  if (!grounded) return { ...empty, profile_url: str(p.profile_url) };

  const date = parsePostDate(p.last_post_date);
  let days: number | null = null;
  if (date) {
    days = Math.floor((now.getTime() - date.getTime()) / DAY_MS);
    if (days < -2) days = null; // a future date is not evidence of activity
    else days = Math.max(0, days);
  }
  const postsLast90 = int(p.posts_last_90_days);
  return {
    platform,
    profile_url: str(p.profile_url),
    followers: int(p.followers),
    total_posts: int(p.total_posts),
    posts_last_90_days: postsLast90,
    last_post_date: days !== null ? str(p.last_post_date) : null,
    days_since_last_post: days,
    status: statusFromDays(days, postsLast90),
    grounded: true,
    ref,
  };
}

const best = (statuses: ActivityStatus[]): ActivityStatus =>
  statuses.reduce<ActivityStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "unknown");

function entity(
  kind: EntityActivity["kind"],
  name: string,
  title: string | null,
  block: unknown,
  path: (string | number)[],
  grounding: unknown,
  now: Date,
): EntityActivity {
  const b = (block ?? {}) as Record<string, unknown>;
  const platforms = PLATFORMS.map((pl) => summarizePlatform(b[pl], pl, path, grounding, now));
  return { kind, name, title, platforms, status: best(platforms.map((p) => p.status)) };
}

export function summarizeActivity(input: {
  structured: unknown;
  grounding: unknown;
  companyName: string;
  people: PlannedPerson[];
  now?: Date;
}): ActivitySummary {
  const now = input.now ?? new Date();
  const s = (input.structured ?? {}) as { company?: unknown; people?: Record<string, unknown>[] };
  const company = entity("company", input.companyName, null, s.company, ["company"], input.grounding, now);
  const rawPeople = Array.isArray(s.people) ? s.people : [];
  const founders: EntityActivity[] = input.people.map((p) => {
    const idx = rawPeople.findIndex((rp) => personKey(String(rp?.input_name ?? "")) === p.key);
    return idx >= 0
      ? entity("person", p.name, p.title, rawPeople[idx], ["people", idx], input.grounding, now)
      : entity("person", p.name, p.title, null, ["people", -1], input.grounding, now);
  });
  const founders_status = best(founders.map((f) => f.status));
  return {
    as_of: now.toISOString().slice(0, 10),
    company,
    founders,
    company_status: company.status,
    founders_status,
    overall: best([company.status, founders_status]),
  };
}

/** Criterion "social_activity" (decided in code). */
export function activityCriterion(summary: ActivitySummary | null, m6Status: string): CriterionOutcome {
  if (!summary) {
    return { result: "unknown", reason: `social activity research ${m6Status}`, evidence_refs: [], decided_by: "code" };
  }
  const all = [summary.company, ...summary.founders];
  const activeRefs = all.flatMap((e) =>
    e.platforms.filter((p) => p.status === "active").map((p) => `${p.ref}.last_post_date`),
  );
  if (activeRefs.length) {
    const who = all.filter((e) => e.status === "active").map((e) => (e.kind === "company" ? "company" : e.name));
    return { result: "met", reason: `active in the last ${ICP_RULES.activity.activeWithinDays} days: ${who.join(", ")}`, evidence_refs: activeRefs.slice(0, 8), decided_by: "code" };
  }
  const known = all.filter((e) => e.status !== "unknown");
  if (known.length && known.every((e) => e.status === "dormant")) {
    return {
      result: "not_met",
      reason: `no posts in ${ICP_RULES.activity.dormantAfterDays}+ days on any account found`,
      evidence_refs: known.flatMap((e) => e.platforms.filter((p) => p.status === "dormant").map((p) => `${p.ref}.last_post_date`)).slice(0, 8),
      decided_by: "code",
    };
  }
  return {
    result: "unknown",
    reason: known.length ? "only low activity found (no post in the last 30 days)" : "no verifiable social activity found",
    evidence_refs: [],
    decided_by: "code",
  };
}

/** Compact one-line summary for CSV exports. */
export function formatEntityActivity(e: EntityActivity): string {
  return e.platforms
    .filter((p) => p.grounded && (p.last_post_date || p.total_posts !== null || p.posts_last_90_days !== null || p.followers !== null))
    .map((p) => {
      const bits = [
        p.total_posts !== null ? `${p.total_posts} posts` : null,
        p.posts_last_90_days !== null ? `${p.posts_last_90_days}/90d` : null,
        p.last_post_date ? `last ${p.last_post_date}` : null,
        p.followers !== null ? `${p.followers} followers` : null,
      ].filter(Boolean);
      return `${p.platform}: ${bits.join(", ")} (${p.status})`;
    })
    .join(" | ");
}
