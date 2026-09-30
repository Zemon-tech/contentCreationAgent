import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { loadLeadConfig, type LeadConfig } from "../config/leadConfig";
import { LEAD_MODULES, type LeadModuleId } from "../config/leadModules";
import { createLeadStore, type LeadStore } from "../repositories/leadStore";
import {
  CompanyInputSchema,
  CompanyResultSchema,
  CompanyStateSchema,
  IcpJudgementSchema,
  type CompanyResult,
  type CompanyState,
  type ModuleSummary,
} from "../schemas/lead";
import {
  NA_PREFIX,
  assembleCompany,
  loadEvidenceModules,
  loadRecords,
  loadStructured,
  skippedSummary,
  toSummary,
} from "../lib/leads/assemble";
import { planContacts } from "../lib/leads/contacts";
import { batchControl } from "../lib/leads/control";
import { enforceEpistemics } from "../lib/leads/epistemic";
import { runExaModule, type RunModuleResult } from "../lib/leads/exaAgentRunner";
import { runIcpJudge, type JudgeResult } from "../lib/leads/judge";
import { errorMessage, leadLog } from "../lib/leads/log";

/**
 * companyResearchWorkflow — one company, visible step-by-step in Studio
 * (PRD §4). Used by lead-qualification-workflow inside .foreach().
 *
 *   init → M0 identity (gate) → [M1 team | M2 signals | M3 tools]
 *        → plan contacts (budget) → [M4 leader contacts | M5 team contacts]
 *        → S1 Sarvam judge → assemble + persist
 *
 * No step throws: every failure becomes a module status, so one company
 * can never abort the batch (R1/R2). No suspend() anywhere (see
 * mastra-ai/mastra#25046). All research is persisted by the runner as it
 * happens, so an interrupted run loses nothing already paid for.
 */

interface Ctx {
  config: LeadConfig;
  store: LeadStore;
}

async function leadCtx(batchId: string): Promise<Ctx> {
  const config = loadLeadConfig();
  const store = createLeadStore(config.databaseUrl, config.databaseAuthToken);
  // A resumed/restarted nested run may land in a fresh process: re-init from the store.
  if (!batchControl.state(batchId)) await batchControl.init(batchId, store, config.maxCostPerBatchUsd);
  return { config, store };
}

const withModule = (state: CompanyState, s: ModuleSummary): CompanyState => ({
  ...state,
  modules: { ...state.modules, [s.module_id]: s },
});

const withError = (state: CompanyState, where: string, err: unknown): CompanyState => {
  const msg = `${where}: ${errorMessage(err)}`;
  leadLog("company-step-error", { batchId: state.batchId, rowId: state.row.row_id, where, error: msg });
  return { ...state, errors: [...state.errors, msg] };
};

function failedResult(moduleId: string, err: unknown): RunModuleResult {
  return {
    status: "failed",
    reason: errorMessage(err),
    cacheKey: "",
    runIds: [],
    costUsd: 0,
    newCostUsd: 0,
    fromCache: false,
    durationMs: 0,
    record: null,
  };
}

function cleanSummary(s: ModuleSummary): ModuleSummary {
  return { ...s, cache_keys: s.cache_keys.filter(Boolean) };
}

// ---------- steps ----------

const initStep = createStep({
  id: "lead-company-init",
  description: "Start one company: mark the row running.",
  inputSchema: CompanyInputSchema,
  outputSchema: CompanyStateSchema,
  execute: async ({ inputData }) => {
    const state: CompanyState = {
      ...inputData,
      startedAt: new Date().toISOString(),
      gate: "pending",
      modules: {},
      contactPlan: null,
      analysis: null,
      errors: [],
    };
    try {
      const { store } = await leadCtx(inputData.batchId);
      await store.setRowStatus(inputData.batchId, inputData.row.row_id, "running");
    } catch (err) {
      return withError(state, "init", err);
    }
    leadLog("company-start", { batchId: state.batchId, rowId: state.row.row_id, company: state.row.company_name });
    return state;
  },
});

const m0Step = createStep({
  id: LEAD_MODULES.M0.stepId,
  description: "M0 Identity & profile (Exa Agent, low effort). Gate: low confidence -> unresolved, later modules skipped.",
  inputSchema: CompanyStateSchema,
  outputSchema: CompanyStateSchema,
  execute: async ({ inputData }) => {
    const state = inputData;
    const t0 = Date.now();
    try {
      const { config, store } = await leadCtx(state.batchId);
      const res = await runExaModule({
        config,
        store,
        batchId: state.batchId,
        rowId: state.row.row_id,
        module: LEAD_MODULES.M0,
        ctx: { row: state.row },
        refresh: state.refresh,
      });
      const summary = cleanSummary(toSummary("M0", [res], t0));
      let gate: CompanyState["gate"];
      if (res.status === "success" || res.status === "partial") {
        const conf = (res.record?.structured as { identity_confidence?: string } | null)?.identity_confidence;
        gate = conf === "high" || conf === "medium" ? "resolved" : "unresolved";
      } else if (res.status === "not_started" || batchControl.abortReason(state.batchId)) {
        gate = "aborted";
      } else {
        gate = "failed";
      }
      return { ...withModule(state, summary), gate };
    } catch (err) {
      return { ...withError(withModule(state, cleanSummary(toSummary("M0", [failedResult("M0", err)], t0))), "M0", err), gate: "failed" as const };
    }
  },
});

function researchStep(moduleId: Extract<LeadModuleId, "M1" | "M2" | "M3">) {
  const def = LEAD_MODULES[moduleId];
  return createStep({
    id: def.stepId,
    description: `${moduleId} ${def.title} (Exa Agent, effort ${def.effort}).`,
    inputSchema: CompanyStateSchema,
    outputSchema: CompanyStateSchema,
    execute: async ({ inputData }) => {
      const state = inputData;
      if (state.gate !== "resolved") {
        const status = state.gate === "aborted" || state.gate === "pending" ? "not_started" : "skipped";
        return withModule(state, skippedSummary(moduleId, `${NA_PREFIX} identity gate ${state.gate}`, status));
      }
      const t0 = Date.now();
      try {
        const { config, store } = await leadCtx(state.batchId);
        const identity = (await loadStructured(store, state.modules.M0)) as Record<string, unknown> | null;
        const res = await runExaModule({
          config,
          store,
          batchId: state.batchId,
          rowId: state.row.row_id,
          module: def,
          ctx: { row: state.row, identity },
          refresh: state.refresh,
        });
        return withModule(state, cleanSummary(toSummary(moduleId, [res], t0)));
      } catch (err) {
        return withError(withModule(state, cleanSummary(toSummary(moduleId, [failedResult(moduleId, err)], t0))), moduleId, err);
      }
    },
  });
}

const m1Step = researchStep("M1");
const m2Step = researchStep("M2");
const m3Step = researchStep("M3");

function mergeStates(states: CompanyState[]): CompanyState {
  const [first, ...rest] = states;
  const merged: CompanyState = { ...first!, modules: { ...first!.modules }, errors: [...first!.errors] };
  for (const s of rest) {
    Object.assign(merged.modules, s.modules);
    for (const e of s.errors) if (!merged.errors.includes(e)) merged.errors.push(e);
    merged.contactPlan = merged.contactPlan ?? s.contactPlan;
  }
  return merged;
}

const mergeStage1Step = createStep({
  id: "lead-merge-stage-1",
  description: "Merge the parallel M1/M2/M3 results.",
  inputSchema: z.object({
    [m1Step.id]: CompanyStateSchema,
    [m2Step.id]: CompanyStateSchema,
    [m3Step.id]: CompanyStateSchema,
  }),
  outputSchema: CompanyStateSchema,
  execute: async ({ inputData }) => mergeStates(Object.values(inputData) as CompanyState[]),
});

const planContactsStep = createStep({
  id: "lead-plan-contacts",
  description: "Pick leaders/team members for contact enrichment within the company budget (PRD §5.1, §11).",
  inputSchema: CompanyStateSchema,
  outputSchema: CompanyStateSchema,
  execute: async ({ inputData }) => {
    const state = inputData;
    if (state.gate !== "resolved") return state;
    try {
      const { config, store } = await leadCtx(state.batchId);
      const m1 = await loadStructured(store, state.modules.M1);
      const remainingUsd = await batchControl.companyRemainingUsd(state.batchId, state.row.row_id, config.maxCostPerCompanyUsd, store);
      const plan = planContacts({ row: state.row, m1, config, remainingUsd });
      leadLog("contact-plan", {
        batchId: state.batchId,
        rowId: state.row.row_id,
        leaders: plan.leaders.length,
        team: plan.team_chunks.flat().length,
        chunks: plan.team_chunks.length,
        truncated: plan.contacts_truncated,
        reason: plan.truncation_reason,
        remainingUsd,
        worstCaseUsd: plan.estimated_worst_case_usd,
      });
      return { ...state, contactPlan: plan };
    } catch (err) {
      return withError(state, "plan-contacts", err);
    }
  },
});

const m4Step = createStep({
  id: LEAD_MODULES.M4.stepId,
  description: "M4 Leader contacts (Exa Agent, medium effort).",
  inputSchema: CompanyStateSchema,
  outputSchema: CompanyStateSchema,
  execute: async ({ inputData }) => {
    const state = inputData;
    if (state.gate !== "resolved") return withModule(state, skippedSummary("M4", `${NA_PREFIX} identity gate ${state.gate}`, state.gate === "aborted" ? "not_started" : "skipped"));
    const leaders = state.contactPlan?.leaders ?? [];
    if (leaders.length === 0) {
      const truncated = state.contactPlan?.contacts_truncated;
      return withModule(
        state,
        skippedSummary("M4", truncated ? `budget: ${state.contactPlan?.truncation_reason}` : state.contactPlan ? `${NA_PREFIX} no leaders or seed contact` : "contact planning failed"),
      );
    }
    const t0 = Date.now();
    try {
      const { config, store } = await leadCtx(state.batchId);
      const identity = (await loadStructured(store, state.modules.M0)) as Record<string, unknown> | null;
      const res = await runExaModule({
        config,
        store,
        batchId: state.batchId,
        rowId: state.row.row_id,
        module: LEAD_MODULES.M4,
        ctx: { row: state.row, identity, people: leaders },
        refresh: state.refresh,
      });
      return withModule(state, cleanSummary(toSummary("M4", [res], t0)));
    } catch (err) {
      return withError(withModule(state, cleanSummary(toSummary("M4", [failedResult("M4", err)], t0))), "M4", err);
    }
  },
});

const m5Step = createStep({
  id: LEAD_MODULES.M5.stepId,
  description: "M5 Team contacts (Exa Agent, auto effort + budget), chunked and run in parallel.",
  inputSchema: CompanyStateSchema,
  outputSchema: CompanyStateSchema,
  execute: async ({ inputData }) => {
    const state = inputData;
    if (state.gate !== "resolved") return withModule(state, skippedSummary("M5", `${NA_PREFIX} identity gate ${state.gate}`, state.gate === "aborted" ? "not_started" : "skipped"));
    const chunks = state.contactPlan?.team_chunks ?? [];
    if (chunks.length === 0) {
      const truncated = state.contactPlan?.contacts_truncated && /team/.test(state.contactPlan?.truncation_reason ?? "");
      return withModule(
        state,
        skippedSummary("M5", truncated ? `budget: ${state.contactPlan?.truncation_reason}` : state.contactPlan ? `${NA_PREFIX} no team members found` : "contact planning failed"),
      );
    }
    const t0 = Date.now();
    try {
      const { config, store } = await leadCtx(state.batchId);
      const identity = (await loadStructured(store, state.modules.M0)) as Record<string, unknown> | null;
      const settled = await Promise.allSettled(
        chunks.map((people, i) =>
          runExaModule({
            config,
            store,
            batchId: state.batchId,
            rowId: state.row.row_id,
            module: LEAD_MODULES.M5,
            ctx: { row: state.row, identity, people },
            refresh: state.refresh,
            slot: `M5#${i}`,
          }),
        ),
      );
      const results = settled.map((s) => (s.status === "fulfilled" ? s.value : failedResult("M5", s.reason)));
      return withModule(state, cleanSummary(toSummary("M5", results, t0)));
    } catch (err) {
      return withError(withModule(state, cleanSummary(toSummary("M5", [failedResult("M5", err)], t0))), "M5", err);
    }
  },
});

const mergeStage2Step = createStep({
  id: "lead-merge-stage-2",
  description: "Merge the parallel M4/M5 results.",
  inputSchema: z.object({ [m4Step.id]: CompanyStateSchema, [m5Step.id]: CompanyStateSchema }),
  outputSchema: CompanyStateSchema,
  execute: async ({ inputData }) => mergeStates(Object.values(inputData) as CompanyState[]),
});

const judgeStep = createStep({
  id: "lead-s1-icp-judge",
  description: "S1 Sarvam ICP judgement from M0-M3 evidence (no tools, no contact data).",
  inputSchema: CompanyStateSchema,
  outputSchema: CompanyStateSchema,
  execute: async ({ inputData }) => {
    const state = inputData;
    if (state.gate !== "resolved") {
      return { ...state, analysis: { status: "skipped" as const, reason: `identity gate ${state.gate}`, cache_key: null } };
    }
    const t0 = Date.now();
    try {
      const { config, store } = await leadCtx(state.batchId);
      const modules = await loadEvidenceModules(store, state);
      const res = await runIcpJudge({ config, store, batchId: state.batchId, row: state.row, modules, refresh: state.refresh });
      const summary: ModuleSummary = {
        module_id: "S1",
        status: res.status,
        reason: res.reason,
        cache_keys: [res.cacheKey],
        run_ids: [],
        cost_usd: 0,
        new_cost_usd: 0,
        duration_ms: Date.now() - t0,
        from_cache: res.fromCache,
      };
      return { ...withModule(state, summary), analysis: { status: res.status, reason: res.reason, cache_key: res.cacheKey } };
    } catch (err) {
      return { ...withError(state, "S1", err), analysis: { status: "failed" as const, reason: errorMessage(err), cache_key: null } };
    }
  },
});

async function loadJudge(store: LeadStore, state: CompanyState): Promise<JudgeResult | null> {
  if (!state.analysis) return null;
  if (state.analysis.status !== "success" || !state.analysis.cache_key) {
    return { status: state.analysis.status, reason: state.analysis.reason, cacheKey: state.analysis.cache_key ?? "", judgement: null, fromCache: false };
  }
  const [rec] = await loadRecords(store, state.modules.S1);
  const parsed = IcpJudgementSchema.safeParse(rec?.structured);
  if (!parsed.success) return { status: "failed", reason: "stored judgement unreadable", cacheKey: state.analysis.cache_key, judgement: null, fromCache: true };
  const modules = await loadEvidenceModules(store, state);
  return { status: "success", reason: state.analysis.reason, cacheKey: state.analysis.cache_key, judgement: enforceEpistemics(parsed.data, modules), fromCache: true };
}

const assembleStep = createStep({
  id: "lead-assemble",
  description: "Apply ICP rules, merge contacts with seed data, persist the company record.",
  inputSchema: CompanyStateSchema,
  outputSchema: CompanyResultSchema,
  execute: async ({ inputData }) => {
    const state = inputData;
    const base: CompanyResult = {
      batchId: state.batchId,
      row_id: state.row.row_id,
      company_name: state.row.company_name,
      research_status: "failed",
      icp_status: "Unresolved",
      analysis_status: state.analysis?.status ?? "skipped",
      cost_usd: Object.values(state.modules).reduce((s, m) => s + m.cost_usd, 0),
      duration_ms: Date.now() - Date.parse(state.startedAt),
      errors: state.errors,
    };
    try {
      const { store } = await leadCtx(state.batchId);
      const judge = await loadJudge(store, state);
      const record = await assembleCompany(store, state, judge);
      await store.saveCompany(record);
      await store.setRowStatus(state.batchId, state.row.row_id, record.research_status);
      leadLog("company-done", {
        batchId: state.batchId,
        rowId: state.row.row_id,
        researchStatus: record.research_status,
        icpStatus: record.icp_status,
        costUsd: record.cost_usd,
        durationMs: record.duration_ms,
      });
      return {
        ...base,
        research_status: record.research_status,
        icp_status: record.icp_status,
        analysis_status: record.analysis_status,
        cost_usd: record.cost_usd,
        duration_ms: record.duration_ms,
      };
    } catch (err) {
      const msg = `assemble: ${errorMessage(err)}`;
      leadLog("company-assemble-failed", { batchId: state.batchId, rowId: state.row.row_id, error: msg });
      return { ...base, errors: [...state.errors, msg] };
    }
  },
});

export const companyResearchWorkflow = createWorkflow({
  id: "company-research-workflow",
  description:
    "ICP research for ONE company: M0 identity gate -> M1/M2/M3 in parallel -> contact plan -> M4/M5 in parallel -> Sarvam ICP judge -> assemble. Never throws; results persisted as they arrive.",
  inputSchema: CompanyInputSchema,
  outputSchema: CompanyResultSchema,
})
  .then(initStep)
  .then(m0Step)
  .parallel([m1Step, m2Step, m3Step])
  .then(mergeStage1Step)
  .then(planContactsStep)
  .parallel([m4Step, m5Step])
  .then(mergeStage2Step)
  .then(judgeStep)
  .then(assembleStep)
  .commit();
