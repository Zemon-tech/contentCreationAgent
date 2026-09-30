import type { LeadStore } from "../../repositories/leadStore";
import type {
  CompanyRecord,
  CompanyState,
  CriterionOutcome,
  ModuleRunRecord,
  ModuleSummary,
  ResearchStatus,
} from "../../schemas/lead";
import type { RunModuleResult } from "./exaAgentRunner";
import type { EvidenceModuleId, ModuleEvidence } from "./evidence";
import { mergePeople } from "./contacts";
import { computeIcpStatus, decisionMakerCriterion, readTeamSize, SARVAM_CRITERIA, teamSizeCriterion, unknownCriterion } from "./icp";
import type { JudgeResult } from "./judge";

/** Reasons prefixed with this are "not applicable" skips, not gaps in research. */
export const NA_PREFIX = "n/a:";

export function toSummary(moduleId: string, results: RunModuleResult[], t0: number): ModuleSummary {
  if (results.length === 0) {
    return skippedSummary(moduleId, `${NA_PREFIX} nothing to research`);
  }
  const statuses = results.map((r) => r.status);
  let status: ModuleSummary["status"];
  if (statuses.every((s) => s === "success")) status = "success";
  else if (statuses.every((s) => s === "not_started")) status = "not_started";
  else if (statuses.every((s) => s === "skipped")) status = "skipped";
  else if (statuses.some((s) => s === "success" || s === "partial")) status = "partial";
  else status = "failed";
  const reasons = [...new Set(results.map((r) => r.reason).filter((x): x is string => !!x))];
  return {
    module_id: moduleId,
    status,
    reason: reasons.length ? reasons.join(" | ").slice(0, 800) : null,
    cache_keys: results.map((r) => r.cacheKey),
    run_ids: results.flatMap((r) => r.runIds),
    cost_usd: Number(results.reduce((s, r) => s + r.costUsd, 0).toFixed(6)),
    new_cost_usd: Number(results.reduce((s, r) => s + r.newCostUsd, 0).toFixed(6)),
    duration_ms: Date.now() - t0,
    from_cache: results.every((r) => r.fromCache),
  };
}

export function skippedSummary(moduleId: string, reason: string, status: ModuleSummary["status"] = "skipped"): ModuleSummary {
  return {
    module_id: moduleId,
    status,
    reason,
    cache_keys: [],
    run_ids: [],
    cost_usd: 0,
    new_cost_usd: 0,
    duration_ms: 0,
    from_cache: false,
  };
}

export async function loadRecords(store: LeadStore, summary: ModuleSummary | undefined): Promise<ModuleRunRecord[]> {
  if (!summary) return [];
  const out: ModuleRunRecord[] = [];
  for (const key of summary.cache_keys) {
    const rec = await store.getModuleRun(key);
    if (rec) out.push(rec);
  }
  return out;
}

export async function loadStructured(store: LeadStore, summary: ModuleSummary | undefined): Promise<unknown> {
  const [rec] = await loadRecords(store, summary);
  return rec?.state === "completed" ? rec.structured : null;
}

export async function loadEvidenceModules(
  store: LeadStore,
  state: CompanyState,
): Promise<Partial<Record<EvidenceModuleId, ModuleEvidence | null>>> {
  const out: Partial<Record<EvidenceModuleId, ModuleEvidence | null>> = {};
  for (const id of ["M0", "M1", "M2", "M3"] as EvidenceModuleId[]) {
    const summary = state.modules[id];
    const [rec] = await loadRecords(store, summary);
    out[id] = rec
      ? { status: summary?.status ?? "missing", structured: rec.state === "completed" ? rec.structured : null, grounding: rec.grounding }
      : summary
        ? { status: summary.status, structured: null, grounding: null }
        : null;
  }
  return out;
}

function researchStatusFor(state: CompanyState, judge: JudgeResult | null): ResearchStatus {
  if (state.gate === "unresolved") return "unresolved";
  if (state.gate === "failed") return "failed";
  const mods = Object.values(state.modules);
  if (state.gate === "aborted" || state.gate === "pending") {
    return mods.some((m) => m.status === "success" || m.status === "partial") ? "partial" : "not_started";
  }
  const gap = mods.some(
    (m) => m.status === "failed" || m.status === "partial" || m.status === "not_started" || (m.status === "skipped" && !m.reason?.startsWith(NA_PREFIX)),
  );
  if (gap || state.contactPlan?.contacts_truncated || judge?.status !== "success") return "partial";
  return "complete";
}

export async function assembleCompany(store: LeadStore, state: CompanyState, judge: JudgeResult | null): Promise<CompanyRecord> {
  const row = state.row;
  const m0 = (await loadStructured(store, state.modules.M0)) as Record<string, unknown> | null;
  const m1 = await loadStructured(store, state.modules.M1);
  const m2 = (await loadStructured(store, state.modules.M2)) as Record<string, unknown> | null;
  const m3 = (await loadStructured(store, state.modules.M3)) as Record<string, unknown> | null;
  const contactOutputs: unknown[] = [];
  for (const id of ["M4", "M5"]) {
    for (const rec of await loadRecords(store, state.modules[id])) if (rec.state === "completed") contactOutputs.push(rec.structured);
  }

  const research_status = researchStatusFor(state, judge);
  const teamSize = readTeamSize(m1);
  const m1Status = state.modules.M1?.status ?? "missing";

  const criteria: Record<string, CriterionOutcome> = {};
  if (research_status === "unresolved" || research_status === "not_started" || research_status === "failed") {
    for (const id of ["team_size", ...SARVAM_CRITERIA, "decision_maker"]) criteria[id] = unknownCriterion(`research ${research_status}`);
  } else {
    criteria.team_size = teamSizeCriterion(teamSize);
    for (const id of SARVAM_CRITERIA) {
      criteria[id] = judge?.judgement?.criteria[id] ?? unknownCriterion(`analysis ${judge?.status ?? "skipped"}`);
    }
    criteria.decision_maker = decisionMakerCriterion(m1, m1Status, row);
  }

  const merged = mergePeople({ row, m1, contactOutputs });
  const finished = new Date();
  const j = judge?.judgement ?? null;
  const cost = Object.values(state.modules).reduce((s, m) => s + m.cost_usd, 0);

  return {
    batch_id: state.batchId,
    row_id: row.row_id,
    seed: row,
    research_status,
    icp_status: computeIcpStatus(criteria, research_status),
    analysis_status: judge?.status ?? "skipped",
    analysis_reason: judge?.reason ?? (state.analysis?.reason ?? null),
    identity: m0,
    identity_confidence: typeof m0?.identity_confidence === "string" ? m0.identity_confidence : null,
    people: merged.people,
    company_contacts: merged.companyContacts,
    signals: m2,
    tools: m3,
    team_size: teamSize,
    criteria,
    triggers: j?.triggers ?? [],
    pain_track: j?.pain_track ?? "unknown",
    pain_hypothesis: j?.pain_hypothesis ?? null,
    ops_summary: j?.ops_summary ?? null,
    claims: j?.claims ?? [],
    contacts_truncated: state.contactPlan?.contacts_truncated ?? false,
    contact_conflict: merged.conflict,
    module_statuses: state.modules,
    cost_usd: Number(cost.toFixed(6)),
    started_at: state.startedAt,
    finished_at: finished.toISOString(),
    duration_ms: finished.getTime() - Date.parse(state.startedAt),
    errors: state.errors,
  };
}
