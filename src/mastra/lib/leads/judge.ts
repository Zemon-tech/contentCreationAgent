import { icpJudgeAgent } from "../../agents/icpJudgeAgent";
import type { LeadConfig } from "../../config/leadConfig";
import { S1_SCHEMA_VERSION } from "../../config/leadModules";
import type { LeadStore } from "../../repositories/leadStore";
import { IcpJudgementSchema, type IcpJudgement, type ModuleRunRecord, type SeedRow } from "../../schemas/lead";
import { batchControl } from "./control";
import { enforceEpistemics, type EnforcedJudgement } from "./epistemic";
import { buildJudgeEvidence, type EvidenceModuleId, type ModuleEvidence } from "./evidence";
import { hashOf } from "./hash";
import { errorMessage, leadLog } from "./log";

/**
 * S1: Sarvam ICP judgement (PRD §7). Evidence in, validated JSON out.
 * - cached by (row, schema version, model, evidence hash): re-runs are free;
 * - zod-validated; on failure retried <= 2 times with the error appended;
 * - epistemic rule applied in code afterwards (enforceEpistemics);
 * - a failure never throws: analysis_status = failed, evidence still exported.
 */

export type JudgeCall = (
  prompt: string,
  options: { config: LeadConfig; tracingContext?: unknown },
) => Promise<{ object: unknown; usage?: unknown }>;

const defaultJudge: JudgeCall = async (prompt, { config, tracingContext }) => {
  // We DON'T use Mastra structuredOutput here: on Sarvam it truncates under the
  // reasoning budget and then throws, discarding the partial JSON. Instead we
  // ask for plain JSON text and parse it ourselves, so the retry loop can see
  // what came back and re-prompt with the exact validation error.
  // Sarvam disables reasoning when reasoning_effort is null; low/medium/high otherwise.
  const reasoningEffort = config.sarvamReasoningEffort === "none" ? null : config.sarvamReasoningEffort;
  const res = await icpJudgeAgent.generate(prompt, {
    modelSettings: { maxOutputTokens: config.sarvamMaxTokens, temperature: 0.1, maxRetries: 2 },
    providerOptions: { sarvam: { reasoningEffort, reasoning_effort: reasoningEffort } },
    ...(tracingContext ? { tracingContext: tracingContext as never } : {}),
  });
  return { object: extractJson(res.text ?? ""), usage: res.usage };
};

/** Pull the first JSON object out of a model response (handles ```json fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  // Walk braces (ignoring those inside strings) to find the matching close.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (esc) esc = false;
    else if (ch === "\\") esc = true;
    else if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === "{") depth++;
    else if (!inStr && ch === "}" && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

let judgeOverride: JudgeCall | null = null;
export function setIcpJudgeForTesting(fn: JudgeCall | null): void {
  judgeOverride = fn;
}

const CRITERION_IDS = [
  "startup_tech_enabled",
  "multiple_functional_teams",
  "early_stage",
  "problem_fit_signals",
  "current_trigger",
] as const;

/**
 * Fill in the OPTIONAL parts of the judgement that Sarvam sometimes omits when
 * it runs short on tokens, so a well-formed-but-incomplete answer still
 * validates. The two things we truly need — per-criterion results and any
 * triggers — are left exactly as the model produced them (only defensively
 * shaped), never invented.
 */
export function normalizeJudgement(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = { ...(raw as Record<string, unknown>) };
  const rawCriteria = (o.criteria && typeof o.criteria === "object" ? (o.criteria as Record<string, unknown>) : {}) as Record<string, unknown>;
  // Rescue only a genuinely PARTIAL answer. If the model returned no usable
  // criterion at all, leave it invalid so the loop retries with the error.
  const usable = CRITERION_IDS.filter((id) => rawCriteria[id] && typeof rawCriteria[id] === "object").length;
  if (usable === 0) return raw;
  const criteria = { ...rawCriteria };
  for (const id of CRITERION_IDS) {
    const c = criteria[id] as Record<string, unknown> | undefined;
    if (!c || typeof c !== "object") {
      criteria[id] = { result: "unknown", reason: "not returned by the model", evidence_refs: [] };
    } else {
      criteria[id] = {
        result: ["met", "not_met", "unknown"].includes(String(c.result)) ? c.result : "unknown",
        reason: typeof c.reason === "string" ? c.reason : "",
        evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs.filter((r) => typeof r === "string") : [],
      };
    }
  }
  o.criteria = criteria;
  o.triggers = Array.isArray(o.triggers)
    ? (o.triggers as Record<string, unknown>[]).map((t) => ({
        type: typeof t?.type === "string" ? t.type : "other",
        text: typeof t?.text === "string" ? t.text : "",
        date: typeof t?.date === "string" ? t.date : null,
        evidence_refs: Array.isArray(t?.evidence_refs) ? t.evidence_refs.filter((r) => typeof r === "string") : [],
      }))
    : [];
  const track = String(o.pain_track);
  o.pain_track = ["A_tool_sprawl", "B_operational_chaos", "none", "unknown"].includes(track) ? o.pain_track : "unknown";
  o.pain_hypothesis = typeof o.pain_hypothesis === "string" ? o.pain_hypothesis : null;
  o.ops_summary = typeof o.ops_summary === "string" ? o.ops_summary : null;
  o.claims = Array.isArray(o.claims)
    ? (o.claims as Record<string, unknown>[])
        .filter((c) => c && typeof c.text === "string")
        .map((c) => ({
          text: c.text,
          epistemic: ["observed", "hypothesis", "unknown"].includes(String(c.epistemic)) ? c.epistemic : "hypothesis",
          evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs.filter((r) => typeof r === "string") : [],
        }))
    : [];
  return o;
}

export interface JudgeResult {
  status: "success" | "failed" | "skipped";
  reason: string | null;
  cacheKey: string;
  judgement: EnforcedJudgement | null;
  fromCache: boolean;
}

function httpStatusOf(err: unknown): number | null {
  const e = err as { statusCode?: unknown; status?: unknown; cause?: { statusCode?: unknown } };
  const v = e?.statusCode ?? e?.status ?? e?.cause?.statusCode;
  return typeof v === "number" ? v : null;
}

export async function runIcpJudge(args: {
  config: LeadConfig;
  store: LeadStore;
  batchId: string;
  row: SeedRow;
  modules: Partial<Record<EvidenceModuleId, ModuleEvidence | null>>;
  refresh: boolean;
  tracingContext?: unknown;
}): Promise<JudgeResult> {
  const { config, store, batchId, row, modules } = args;
  const evidence = buildJudgeEvidence(row, modules);
  const inputHash = hashOf({ evidence, model: config.sarvamModel, effort: config.sarvamReasoningEffort });
  const cacheKey = `s1_${hashOf({ rowId: row.row_id, v: S1_SCHEMA_VERSION, inputHash }, 40)}`;
  const logBase = { batchId, rowId: row.row_id, module: "S1", cacheKey };

  const existing = await store.getModuleRun(cacheKey);
  if (existing?.state === "completed" && !args.refresh) {
    const parsed = IcpJudgementSchema.safeParse(existing.structured);
    if (parsed.success) {
      leadLog("module-cache-hit", { ...logBase });
      return { status: "success", reason: null, cacheKey, judgement: enforceEpistemics(parsed.data, modules), fromCache: true };
    }
  }

  const disabled = batchControl.judgeDisabledReason(batchId);
  if (disabled) return { status: "failed", reason: `judge disabled for batch: ${disabled}`, cacheKey, judgement: null, fromCache: false };

  const now = new Date().toISOString();
  const rec: ModuleRunRecord = {
    cache_key: cacheKey,
    batch_id: batchId,
    row_id: row.row_id,
    module_id: "S1",
    schema_version: S1_SCHEMA_VERSION,
    input_hash: inputHash,
    state: "running",
    module_status: null,
    run_id: null,
    attempt_id: null,
    attempts: [],
    request_summary: { effort: config.sarvamReasoningEffort, budget_usd: null, query_preview: config.sarvamModel },
    structured: null,
    grounding: null,
    text: null,
    stop_reason: null,
    cost_usd: 0, // Sarvam cost is not reported per call; token usage is stored instead
    cost_breakdown: null,
    usage: null,
    error: null,
    started_at: now,
    finished_at: null,
    latency_ms: null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  const call = judgeOverride ?? defaultJudge;
  const basePrompt =
    "Judge this startup against the KeilHQ ICP. Evidence JSON follows.\n\n" + JSON.stringify(evidence);
  let prompt = basePrompt;
  let lastError = "unknown error";
  const t0 = Date.now();

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await call(prompt, { config, tracingContext: args.tracingContext });
      const parsed = IcpJudgementSchema.safeParse(normalizeJudgement(res.object));
      if (!parsed.success) {
        lastError = `schema validation failed: ${parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`;
        prompt = `${basePrompt}\n\nYour previous answer was rejected (${lastError}). Return JSON that matches the schema exactly.`;
        leadLog("judge-invalid-output", { ...logBase, attempt, error: lastError });
        continue;
      }
      const judgement: IcpJudgement = parsed.data;
      rec.state = "completed";
      rec.module_status = "success";
      rec.structured = judgement;
      rec.usage = res.usage ?? null;
      rec.finished_at = new Date().toISOString();
      rec.latency_ms = Date.now() - t0;
      rec.updated_at = rec.finished_at;
      await store.saveModuleRun(rec).catch((err) => leadLog("store-write-failed", { ...logBase, error: errorMessage(err) }));
      const enforced = enforceEpistemics(judgement, modules);
      leadLog("judge-completed", { ...logBase, attempt, downgrades: enforced.downgrades, latencyMs: rec.latency_ms });
      return { status: "success", reason: null, cacheKey, judgement: enforced, fromCache: false };
    } catch (err) {
      lastError = errorMessage(err);
      const status = httpStatusOf(err);
      leadLog("judge-error", { ...logBase, attempt, statusCode: status, error: lastError });
      if (status === 401 || status === 403) {
        batchControl.disableJudge(batchId, `Sarvam auth error ${status}`);
        break;
      }
      if (status === 402) {
        batchControl.disableJudge(batchId, "Sarvam credits exhausted (402)");
        break;
      }
      const isValidation = /schema|validat|parse|json/i.test(lastError);
      prompt = isValidation
        ? `${basePrompt}\n\nYour previous answer was rejected (${lastError}). Return JSON that matches the schema exactly.`
        : basePrompt;
    }
  }

  // A failed refresh never replaces a good stored judgement.
  if (existing?.state === "completed") {
    const prev = IcpJudgementSchema.safeParse(existing.structured);
    if (prev.success) {
      return {
        status: "success",
        reason: `refresh failed (${lastError}); kept previous judgement`,
        cacheKey,
        judgement: enforceEpistemics(prev.data, modules),
        fromCache: true,
      };
    }
  }
  rec.state = "failed";
  rec.module_status = "failed";
  rec.error = { message: lastError, status_code: null, code: null };
  rec.finished_at = new Date().toISOString();
  rec.latency_ms = Date.now() - t0;
  rec.updated_at = rec.finished_at;
  await store.saveModuleRun(rec).catch(() => undefined);
  return { status: "failed", reason: lastError, cacheKey, judgement: null, fromCache: false };
}
