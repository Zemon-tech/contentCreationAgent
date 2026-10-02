import { ICP_RULES, type CriterionId } from "../../config/icpRules";
import type { CriterionOutcome, IcpStatus, ResearchStatus, SeedRow } from "../../schemas/lead";

/**
 * ICP rule engine (PRD §8). Criteria 1 (team size) and 7 (decision-maker)
 * are decided deterministically in code; criteria 2–6 come from Sarvam after
 * epistemic enforcement. The verdict rule lives in config/icpRules.ts.
 */

export interface TeamSizeEstimate {
  low: number | null;
  high: number | null;
  basis: string | null;
  confidence: string | null;
}

export function readTeamSize(m1: unknown): TeamSizeEstimate {
  const t = (m1 as { team_size_estimate?: Record<string, unknown> } | null)?.team_size_estimate ?? {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  let low = n(t.low);
  let high = n(t.high);
  if (low !== null && high !== null && low > high) [low, high] = [high, low];
  return {
    low,
    high,
    basis: typeof t.basis === "string" ? t.basis : null,
    confidence: typeof t.confidence === "string" ? t.confidence : null,
  };
}

export function teamSizeCriterion(est: TeamSizeEstimate): CriterionOutcome {
  const { min, max } = ICP_RULES.teamSize;
  const refs = ["M1.team_size_estimate"];
  if (est.low === null && est.high === null) {
    return { result: "unknown", reason: "no team size estimate", evidence_refs: [], decided_by: "code" };
  }
  const low = est.low ?? est.high!;
  const high = est.high ?? est.low!;
  const range = `${low}-${high}`;
  if (low >= min && high <= max) return { result: "met", reason: `estimate ${range} within ${min}-${max}`, evidence_refs: refs, decided_by: "code" };
  if (high < min || low > max) return { result: "not_met", reason: `estimate ${range} outside ${min}-${max}`, evidence_refs: refs, decided_by: "code" };
  return { result: "borderline", reason: `estimate ${range} overlaps ${min}-${max}`, evidence_refs: refs, decided_by: "code" };
}

export function isDecisionMakerTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return ICP_RULES.decisionMakerTitlePatterns.some((re) => re.test(title));
}

export function decisionMakerCriterion(m1: unknown, m1Status: string, row: SeedRow): CriterionOutcome {
  const leaders = ((m1 as { leaders?: unknown[] } | null)?.leaders ?? []) as { name?: string; title?: string | null; is_founder?: boolean | null }[];
  const idx = leaders.findIndex((l) => l?.is_founder === true || isDecisionMakerTitle(l?.title));
  if (idx >= 0) {
    const l = leaders[idx]!;
    return {
      result: "met",
      reason: `${l.name ?? "leader"} (${l.title ?? (l.is_founder ? "founder" : "leader")})`,
      evidence_refs: [`M1.leaders[${idx}]`],
      decided_by: "code",
    };
  }
  if (row.contact_person && isDecisionMakerTitle(row.designation)) {
    return {
      result: "met",
      reason: `seed contact ${row.contact_person} (${row.designation}) from input CSV`,
      evidence_refs: ["SEED.designation"],
      decided_by: "code",
    };
  }
  if (m1Status === "success" || m1Status === "partial") {
    return { result: "not_met", reason: "no founder/COO/CoS/Head of Ops identified", evidence_refs: [], decided_by: "code" };
  }
  return { result: "unknown", reason: `team research ${m1Status}`, evidence_refs: [], decided_by: "code" };
}

export function unknownCriterion(reason: string): CriterionOutcome {
  return { result: "unknown", reason, evidence_refs: [], decided_by: "code" };
}

export const SARVAM_CRITERIA: CriterionId[] = [
  "startup_tech_enabled",
  "multiple_functional_teams",
  "early_stage",
  "problem_fit_signals",
  "current_trigger",
];

export function computeIcpStatus(criteria: Record<string, CriterionOutcome>, researchStatus: ResearchStatus): IcpStatus {
  if (researchStatus === "unresolved") return "Unresolved";
  if (researchStatus === "not_started") return "Unresolved";
  const r = (id: CriterionId) => criteria[id]?.result ?? "unknown";

  if (ICP_RULES.disqualifyIfNotMet.some((id) => r(id) === "not_met")) return "Not qualified";

  const requiredOk = ICP_RULES.qualified.requireMet.every((id) => r(id) === "met");
  const anyOfMet = ICP_RULES.qualified.anyOf.filter((id) => r(id) === "met").length;
  const blocked = ICP_RULES.blockQualifiedIfNotMet.some((id) => r(id) === "not_met");
  if (requiredOk && anyOfMet >= ICP_RULES.qualified.minMet && !blocked) return "Qualified";
  return "Needs review"; // incl. unknown/borderline team size (OPEN-2)
}
