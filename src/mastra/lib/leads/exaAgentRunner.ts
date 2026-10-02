import { randomUUID } from "node:crypto";
import Exa, { type AgentRun, type CreateAgentRunParams, type ListAgentRunsResponse } from "exa-js";
import type { LeadConfig } from "../../config/leadConfig";
import type { LeadModuleDef, ModuleContext } from "../../config/leadModules";
import type { LeadStore } from "../../repositories/leadStore";
import type { ModuleRunRecord, ModuleStatus } from "../../schemas/lead";
import {
  BatchAbortedError,
  backoffDelayMs,
  batchControl,
  classifyExaError,
  getExaLimiter,
  sleep,
  type Reservation,
} from "./control";
import { hashOf } from "./hash";
import { errorMessage, leadLog } from "./log";

/**
 * Exa Agent run lifecycle for ONE module slot (PRD §6, R3, R4):
 *
 *   cache hit ──► return stored output (no spend)
 *   stored run_id, not terminal ──► resume polling that run (no new run)
 *   stored "creating" intent ──► adopt the orphan run via metadata, else create
 *   otherwise ──► reserve budget ─► persist intent ─► create (retry 429/5xx)
 *                 ─► persist run_id ─► poll ─► persist terminal output
 *
 * A completed result is NEVER overwritten by a failed refresh, and in-flight
 * runs are still collected after a batch abort (the money is already spent).
 */

export interface ExaAgentApi {
  create(params: CreateAgentRunParams): Promise<AgentRun>;
  get(runId: string): Promise<AgentRun>;
  list(options?: { cursor?: string; limit?: number }): Promise<ListAgentRunsResponse>;
}

let apiOverride: ExaAgentApi | null = null;
let cachedApi: { key: string; api: ExaAgentApi } | null = null;

/** Test hook: inject a fake Exa Agent API (pass null to restore the SDK). */
export function setExaAgentApiForTesting(api: ExaAgentApi | null): void {
  apiOverride = api;
}

export function getExaAgentApi(config: LeadConfig): ExaAgentApi {
  if (apiOverride) return apiOverride;
  if (!cachedApi || cachedApi.key !== config.exaApiKey) {
    // Explicit key: never falls back to the shared EXA_API_KEY env var.
    const exa = new Exa(config.exaApiKey);
    cachedApi = { key: config.exaApiKey, api: exa.agent.runs };
  }
  return cachedApi.api;
}

export interface RunModuleArgs {
  config: LeadConfig;
  store: LeadStore;
  batchId: string;
  rowId: string;
  module: LeadModuleDef;
  ctx: ModuleContext;
  refresh: boolean;
  /** Distinguishes chunks of the same module, e.g. "M5#0". Defaults to module.id. */
  slot?: string;
}

export interface RunModuleResult {
  status: ModuleStatus;
  reason: string | null;
  cacheKey: string;
  runIds: string[];
  costUsd: number;
  newCostUsd: number;
  fromCache: boolean;
  durationMs: number;
  record: ModuleRunRecord | null;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_RUN_ATTEMPTS = 2; // original + one retry when a run ends failed/cancelled (PRD §6)

export function buildModuleRequest(module: LeadModuleDef, ctx: ModuleContext, config: LeadConfig) {
  const params: CreateAgentRunParams = {
    query: module.buildQuery(ctx),
    systemPrompt: module.systemPrompt,
    input: { data: module.buildInputData(ctx) },
    outputSchema: module.outputSchema(ctx),
    effort: module.effort,
  };
  if (module.effort === "auto" && module.budgetKey) {
    params.budget = { maxCostDollars: config[module.budgetKey] };
  }
  const dataSources = module.dataSources?.(config) ?? [];
  if (dataSources.length) params.dataSources = dataSources.map((provider) => ({ provider }));
  // Budget is excluded from the hash: changing a cap must not invalidate good results.
  // Data sources ARE included: web-only and Fiber-backed answers are different results.
  const inputHash = hashOf({
    query: params.query,
    systemPrompt: params.systemPrompt,
    input: params.input,
    outputSchema: params.outputSchema,
    effort: params.effort,
    ...(dataSources.length ? { dataSources } : {}),
  });
  return { params, inputHash };
}

export function moduleCacheKey(rowId: string, slot: string, schemaVersion: string, inputHash: string): string {
  return `mr_${hashOf({ rowId, slot, schemaVersion, inputHash }, 40)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function summarize(
  rec: ModuleRunRecord,
  extra: { fromCache: boolean; newCostUsd: number; t0: number; reason?: string | null; status?: ModuleStatus },
): RunModuleResult {
  const runIds = [...new Set(rec.attempts.map((a) => a.run_id).filter((x): x is string => !!x))];
  return {
    status: extra.status ?? rec.module_status ?? "failed",
    reason: extra.reason ?? (rec.error ? rec.error.message : null),
    cacheKey: rec.cache_key,
    runIds,
    costUsd: rec.cost_usd,
    newCostUsd: extra.newCostUsd,
    fromCache: extra.fromCache,
    durationMs: Date.now() - extra.t0,
    record: rec,
  };
}

function moduleStatusFor(run: AgentRun): { status: ModuleStatus; reason: string | null } {
  const structured = run.output?.structured;
  if (!structured || typeof structured !== "object") return { status: "partial", reason: "no structured output returned" };
  if (run.stopReason && ["budget_reached", "time_limit_reached", "stopped"].includes(run.stopReason)) {
    return { status: "partial", reason: `stopReason=${run.stopReason}` };
  }
  return { status: "success", reason: null };
}

async function safeSave(store: LeadStore, rec: ModuleRunRecord, critical: boolean): Promise<void> {
  rec.updated_at = nowIso();
  try {
    await store.saveModuleRun(rec);
  } catch (err) {
    // The run carries metadata {cacheKey, attemptId}, so a later run can still adopt it.
    leadLog(critical ? "store-write-failed-critical" : "store-write-failed", {
      cacheKey: rec.cache_key,
      runId: rec.run_id,
      error: errorMessage(err),
    });
    if (critical) throw err;
  }
}

/** Look for a run we created but failed to record (crash / lost response). */
async function findOrphanRun(api: ExaAgentApi, match: { cacheKey: string; attemptId: string }): Promise<AgentRun | null> {
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const res = await api.list({ limit: 50, ...(cursor ? { cursor } : {}) });
      for (const run of res.data ?? []) {
        const meta = ((run as { metadata?: Record<string, unknown> }).metadata ??
          (run.request?.metadata as Record<string, unknown> | undefined)) as Record<string, unknown> | undefined;
        if (meta?.attemptId === match.attemptId && meta?.cacheKey === match.cacheKey) return run;
      }
      if (!res.hasMore || !res.nextCursor) break;
      cursor = res.nextCursor;
    }
  } catch (err) {
    leadLog("orphan-lookup-failed", { cacheKey: match.cacheKey, error: errorMessage(err) });
  }
  return null;
}

async function createWithRetry(
  api: ExaAgentApi,
  params: CreateAgentRunParams,
  args: RunModuleArgs,
  ids: { cacheKey: string; attemptId: string },
): Promise<AgentRun> {
  const { gate } = getExaLimiter(args.config.exaMaxConcurrentRuns, args.config.maxStartsPerSecond);
  let lastErr: unknown;
  for (let attempt = 0; attempt < args.config.maxCreateAttempts; attempt++) {
    const abortReason = batchControl.abortReason(args.batchId);
    if (abortReason) throw new BatchAbortedError(abortReason);
    await gate.wait();
    try {
      return await api.create(params);
    } catch (err) {
      lastErr = err;
      const c = classifyExaError(err);
      leadLog("exa-create-error", {
        batchId: args.batchId,
        rowId: args.rowId,
        slot: args.slot ?? args.module.id,
        attempt: attempt + 1,
        kind: c.kind,
        statusCode: c.statusCode,
        code: c.code,
      });
      if (c.kind === "abort") {
        batchControl.abort(args.batchId, c.abortReason!, `${c.statusCode} ${c.code ?? ""}`.trim());
        throw new BatchAbortedError(c.abortReason!, c.message);
      }
      if (c.kind === "fail") throw err;
      // Network error: the POST may have landed. Adopt instead of paying twice.
      if (c.statusCode === null) {
        const orphan = await findOrphanRun(api, ids);
        if (orphan) return orphan;
      }
      // exa-js does not expose Retry-After, so use exponential backoff with jitter.
      if (attempt + 1 < args.config.maxCreateAttempts) await sleep(backoffDelayMs(attempt, args.config.backoffBaseMs));
    }
  }
  throw lastErr;
}

async function pollRun(
  api: ExaAgentApi,
  runId: string,
  args: RunModuleArgs,
): Promise<{ kind: "terminal"; run: AgentRun } | { kind: "timeout" }> {
  const started = Date.now();
  let transientErrors = 0;
  while (true) {
    if (Date.now() - started > args.config.moduleTimeoutMs) return { kind: "timeout" };
    try {
      const run = await api.get(runId);
      transientErrors = 0;
      if (TERMINAL.has(run.status)) return { kind: "terminal", run };
    } catch (err) {
      const c = classifyExaError(err);
      if (c.kind !== "retry") throw err; // 404 / 401: cannot recover this run by polling
      transientErrors++;
      await sleep(Math.min(30_000, backoffDelayMs(Math.min(transientErrors, 6), args.config.backoffBaseMs)));
      continue;
    }
    await sleep(args.config.pollIntervalMs);
  }
}

/** Collect a terminal run into the record. Returns true when the slot is done (no retry). */
function applyTerminal(rec: ModuleRunRecord, run: AgentRun, startedAtMs: number): { done: boolean; cost: number } {
  const cost = Number(run.costDollars?.total ?? 0) || 0;
  const attempt = rec.attempts[rec.attempts.length - 1];
  if (attempt) {
    attempt.status = run.status;
    attempt.cost_usd = cost;
    attempt.finished_at = nowIso();
    attempt.error = run.error ? `${run.error.code ?? ""} ${run.error.message ?? ""}`.trim() || null : null;
  }
  rec.cost_usd = Number((rec.cost_usd + cost).toFixed(6));
  if (run.status === "completed") {
    const ms = moduleStatusFor(run);
    rec.state = "completed";
    rec.module_status = ms.status;
    rec.structured = run.output?.structured ?? null;
    rec.grounding = run.output?.grounding ?? null; // persisted untouched (PRD §5)
    rec.text = typeof run.output?.text === "string" ? run.output.text : null;
    rec.stop_reason = run.stopReason ?? null;
    rec.cost_breakdown = run.costDollars ?? null;
    rec.usage = run.usage ?? null;
    rec.error = ms.reason ? { message: ms.reason, status_code: null, code: null } : null;
    rec.finished_at = nowIso();
    rec.latency_ms = Date.now() - startedAtMs;
    return { done: true, cost };
  }
  rec.error = {
    message: `run ${run.status}${run.error?.message ? `: ${run.error.message}` : ""}`,
    status_code: null,
    code: run.error?.code ?? null,
  };
  return { done: false, cost };
}

export async function runExaModule(args: RunModuleArgs): Promise<RunModuleResult> {
  const t0 = Date.now();
  const { config, store, batchId, rowId, module, ctx } = args;
  const slot = args.slot ?? module.id;
  const api = getExaAgentApi(config);
  const { params, inputHash } = buildModuleRequest(module, ctx, config);
  const cacheKey = moduleCacheKey(rowId, slot, module.schemaVersion, inputHash);
  const logBase = { batchId, rowId, module: slot, cacheKey };

  const existing = await store.getModuleRun(cacheKey);
  const previousCompleted = existing?.state === "completed" ? structuredClone(existing) : null;

  // 1) Cache hit.
  if (previousCompleted && !args.refresh) {
    leadLog("module-cache-hit", { ...logBase, status: previousCompleted.module_status });
    return summarize(previousCompleted, { fromCache: true, newCostUsd: 0, t0 });
  }

  const rec: ModuleRunRecord =
    existing && existing.state !== "completed"
      ? existing
      : {
          cache_key: cacheKey,
          batch_id: batchId,
          row_id: rowId,
          module_id: slot,
          schema_version: module.schemaVersion,
          input_hash: inputHash,
          state: "creating",
          module_status: null,
          run_id: null,
          attempt_id: null,
          attempts: [],
          request_summary: {
            effort: module.effort,
            budget_usd: params.budget?.maxCostDollars ?? null,
            query_preview: params.query.slice(0, 300),
          },
          structured: null,
          grounding: null,
          text: null,
          stop_reason: null,
          cost_usd: 0,
          cost_breakdown: null,
          usage: null,
          error: null,
          started_at: null,
          finished_at: null,
          latency_ms: null,
          created_at: nowIso(),
          updated_at: nowIso(),
        };

  /** Never replace a good stored result with a failed refresh. */
  const finish = async (status: ModuleStatus, reason: string | null, newCostUsd: number): Promise<RunModuleResult> => {
    if (previousCompleted && status !== "success" && status !== "partial") {
      previousCompleted.cost_usd = Number((previousCompleted.cost_usd + newCostUsd).toFixed(6));
      await safeSave(store, previousCompleted, false);
      leadLog("module-refresh-kept-previous", { ...logBase, reason });
      return summarize(previousCompleted, {
        fromCache: true,
        newCostUsd,
        t0,
        reason: `refresh failed (${reason}); kept previous result`,
      });
    }
    return summarize(rec, { fromCache: false, newCostUsd, t0, status, reason });
  };

  const { slots } = getExaLimiter(config.exaMaxConcurrentRuns, config.maxStartsPerSecond);
  let reservation: Reservation | null = null;
  let newCost = 0;
  const settle = () => {
    if (reservation) batchControl.settle(reservation, newCost);
    else if (newCost > 0) batchControl.settle({ id: 0, batchId, rowId, amount: 0 }, newCost);
    reservation = null;
  };

  try {
    // 2) Resume an in-flight run (also after an abort: its cost is already committed).
    let runId: string | null = null;
    if (rec.run_id && (rec.state === "running" || rec.state === "timed_out")) {
      runId = rec.run_id;
      leadLog("module-resume", { ...logBase, runId, previousState: rec.state });
    } else if (rec.state === "creating" && rec.attempt_id) {
      const orphan = await findOrphanRun(api, { cacheKey, attemptId: rec.attempt_id });
      if (orphan) {
        runId = orphan.id;
        rec.run_id = orphan.id;
        rec.state = "running";
        const last = rec.attempts[rec.attempts.length - 1];
        if (last) last.run_id = orphan.id;
        await safeSave(store, rec, true);
        leadLog("module-orphan-adopted", { ...logBase, runId });
      }
    }

    // 3) Nothing to resume: we may need to create (subject to abort + budget).
    if (!runId) {
      const abortReason = batchControl.abortReason(batchId);
      if (abortReason) {
        rec.state = "not_started";
        rec.module_status = "not_started";
        rec.error = { message: `batch aborted: ${abortReason}`, status_code: null, code: null };
        if (!previousCompleted) await safeSave(store, rec, false);
        return await finish("not_started", `batch aborted: ${abortReason}`, 0);
      }
      const worst = module.worstCaseCostUsd(ctx, config);
      const res = await batchControl.reserve(batchId, rowId, worst, config.maxCostPerCompanyUsd, store);
      if (!res.ok) {
        rec.state = "not_started";
        rec.module_status = "skipped";
        rec.error = { message: res.reason, status_code: null, code: "BUDGET" };
        if (!previousCompleted) await safeSave(store, rec, false);
        leadLog("module-budget-skip", { ...logBase, reason: res.reason });
        return await finish("skipped", res.reason, 0);
      }
      reservation = res.reservation;
    }

    const release = await slots.acquire();
    try {
      let failedRuns = 0; // failed/cancelled runs in THIS invocation
      while (true) {
        const startedAtMs = Date.now();
        if (!runId) {
          const abortReason = batchControl.abortReason(batchId);
          if (abortReason) throw new BatchAbortedError(abortReason);
          const attemptId = randomUUID();
          rec.state = "creating";
          rec.attempt_id = attemptId;
          rec.run_id = null;
          rec.started_at = rec.started_at ?? nowIso();
          rec.attempts.push({
            attempt: rec.attempts.length + 1,
            attempt_id: attemptId,
            run_id: null,
            status: "creating",
            error: null,
            cost_usd: 0,
            created_at: nowIso(),
            finished_at: null,
          });
          await safeSave(store, rec, true); // intent BEFORE spending
          const run = await createWithRetry(
            api,
            { ...params, metadata: { cacheKey, attemptId, rowId, module: slot, batchId } },
            args,
            { cacheKey, attemptId },
          );
          runId = run.id;
          rec.run_id = run.id;
          rec.state = "running";
          rec.attempts[rec.attempts.length - 1]!.run_id = run.id;
          rec.attempts[rec.attempts.length - 1]!.status = run.status;
          await safeSave(store, rec, true); // R4: run_id persisted before polling
          leadLog("exa-run-created", { ...logBase, runId, effort: module.effort });
        }

        const polled = await pollRun(api, runId, args);
        if (polled.kind === "timeout") {
          rec.state = "timed_out"; // keep run_id: the next run resumes it instead of paying again
          rec.module_status = "failed";
          rec.error = { message: `timed out after ${config.moduleTimeoutMs}ms (resumable)`, status_code: null, code: "TIMEOUT" };
          await safeSave(store, rec, false);
          leadLog("module-timeout", { ...logBase, runId });
          return await finish("failed", rec.error.message, newCost);
        }

        const { done, cost } = applyTerminal(rec, polled.run, startedAtMs);
        newCost += cost;
        if (done) {
          await safeSave(store, rec, false);
          leadLog("module-completed", {
            ...logBase,
            runId,
            status: rec.module_status,
            costUsd: cost,
            latencyMs: rec.latency_ms,
            stopReason: rec.stop_reason,
          });
          return await finish(rec.module_status ?? "success", rec.error?.message ?? null, newCost);
        }

        leadLog("exa-run-not-completed", { ...logBase, runId, status: polled.run.status, attempts: rec.attempts.length });
        runId = null;
        failedRuns++;
        if (failedRuns >= MAX_RUN_ATTEMPTS) break;
        // Retrying costs another run: re-check the budget for it.
        const again = await batchControl.reserve(batchId, rowId, module.worstCaseCostUsd(ctx, config), config.maxCostPerCompanyUsd, store);
        if (!again.ok) {
          rec.error = { message: `${rec.error?.message ?? "run failed"}; retry skipped: ${again.reason}`, status_code: null, code: "BUDGET" };
          break;
        }
        if (reservation) batchControl.settle(reservation, 0);
        reservation = again.reservation;
      }
      rec.state = "failed";
      rec.module_status = "failed";
      await safeSave(store, rec, false);
      return await finish("failed", rec.error?.message ?? "run failed", newCost);
    } finally {
      release();
    }
  } catch (err) {
    if (err instanceof BatchAbortedError) {
      rec.state = rec.run_id ? rec.state : "not_started";
      rec.module_status = "not_started";
      rec.error = { message: err.message, status_code: null, code: err.reason };
      const last = rec.attempts[rec.attempts.length - 1];
      if (last && !last.run_id) last.status = "not_started";
      await safeSave(store, rec, false).catch(() => undefined);
      return await finish("not_started", err.message, newCost);
    }
    const c = classifyExaError(err);
    rec.state = rec.run_id && c.kind === "retry" ? "timed_out" : "failed";
    rec.module_status = "failed";
    rec.error = { message: errorMessage(err), status_code: c.statusCode, code: c.code };
    await safeSave(store, rec, false).catch(() => undefined);
    leadLog("module-failed", { ...logBase, runId: rec.run_id, statusCode: c.statusCode, code: c.code, error: rec.error.message });
    return await finish("failed", rec.error.message, newCost);
  } finally {
    settle();
  }
}
