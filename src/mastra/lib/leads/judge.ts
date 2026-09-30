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
  const res = await icpJudgeAgent.generate(prompt, {
    structuredOutput: { schema: IcpJudgementSchema },
    modelSettings: { maxOutputTokens: config.sarvamMaxTokens, temperature: 0.1, maxRetries: 2 },
    providerOptions: { sarvam: { reasoningEffort: config.sarvamReasoningEffort } },
    ...(tracingContext ? { tracingContext: tracingContext as never } : {}),
  });
  return { object: res.object, usage: res.usage };
};

let judgeOverride: JudgeCall | null = null;
export function setIcpJudgeForTesting(fn: JudgeCall | null): void {
  judgeOverride = fn;
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
      const parsed = IcpJudgementSchema.safeParse(res.object);
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
