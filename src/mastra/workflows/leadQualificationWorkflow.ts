import fs from "node:fs";
import path from "node:path";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { loadLeadConfig, tryLoadLeadConfig, type LeadConfig } from "../config/leadConfig";
import { createLeadStore, resolveFromProjectRoot, resolveProjectRoot } from "../repositories/leadStore";
import {
  CompanyInputSchema,
  CompanyResultSchema,
  RejectedRowSchema,
  type BatchRecord,
  type CompanyInput,
} from "../schemas/lead";
import { batchControl } from "../lib/leads/control";
import { CsvFileError, parseLeadCsv } from "../lib/leads/csv";
import { writeBatchExports } from "../lib/leads/exporters";
import { sha256 } from "../lib/leads/hash";
import { errorMessage, leadLog } from "../lib/leads/log";
import { companyResearchWorkflow } from "./companyResearchWorkflow";

/**
 * leadQualificationWorkflow — KeilHQ ICP research over a CSV of startups
 * (PRD lead_qualification).
 *
 *   load-batch (validate config + CSV, persist rows)
 *     → foreach company: company-research-workflow (bounded concurrency)
 *     → aggregate + export (CSV / JSONL / run report)
 *
 * Resumable by design: re-running the SAME CSV (or passing the same batchId)
 * reuses every completed module, resumes in-flight Exa runs by run_id and
 * only pays for what is missing. `refresh: true` forces recompute (a failed
 * refresh never replaces a good stored result).
 */

const MAX_CSV_BYTES = 20 * 1024 * 1024;

const LeadWorkflowInputSchema = z.object({
  csvText: z.string().optional().describe("Paste the CSV content here (header row required)."),
  csvPath: z
    .string()
    .optional()
    .describe("OR a path to a .csv file (relative to the project root, or inside LEAD_INPUT_DIR)."),
  sourceName: z.string().optional().describe("Label for this upload, shown in reports."),
  batchId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{3,64}$/)
    .optional()
    .describe("Resume/label a batch. Default: derived from the CSV content, so re-running the same file resumes it."),
  refresh: z.boolean().default(false).describe("Recompute modules even when cached results exist (costs money)."),
  maxRows: z.number().int().min(1).optional().describe("Only process the first N accepted rows (Phase 0 / smoke tests)."),
});

const LoadBatchOutputSchema = z.object({
  batchId: z.string(),
  items: z.array(CompanyInputSchema),
  totalRows: z.number(),
  acceptedRows: z.number(),
  rejectedRows: z.array(RejectedRowSchema),
  exportDir: z.string(),
});

const LeadWorkflowOutputSchema = z.object({
  batchId: z.string(),
  status: z.enum(["completed", "aborted"]),
  abortReason: z.string().nullable(),
  exportsDir: z.string().nullable(),
  files: z.array(z.string()),
  counts: z.record(z.string(), z.record(z.string(), z.number())),
  totalCostUsd: z.number(),
  summary: z.string(),
  errors: z.array(z.string()),
});

/** Resolve csvPath safely: must be a .csv inside LEAD_INPUT_DIR (or the project root). */
function readCsvFromPath(csvPath: string, config: LeadConfig): { text: string; name: string } {
  const root = config.inputDir ? resolveFromProjectRoot(config.inputDir) : resolveProjectRoot();
  const abs = path.resolve(path.isAbsolute(csvPath) ? csvPath : path.join(root, csvPath));
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CsvFileError(`csvPath must be inside ${root}`);
  }
  if (path.extname(abs).toLowerCase() !== ".csv") throw new CsvFileError("csvPath must point to a .csv file");
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new CsvFileError(`CSV file not found: ${csvPath}`);
  if (stat.size > MAX_CSV_BYTES) throw new CsvFileError(`CSV file is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB`);
  return { text: fs.readFileSync(abs, "utf8"), name: path.basename(abs) };
}

const loadBatchStep = createStep({
  id: "lead-load-batch",
  description: "Validate LEAD_* config, parse + validate the CSV, persist the batch and its rows.",
  inputSchema: LeadWorkflowInputSchema,
  outputSchema: LoadBatchOutputSchema,
  execute: async ({ inputData }) => {
    // Config and input errors fail HERE, before any money is spent.
    const config = loadLeadConfig();
    const hasText = !!inputData.csvText?.trim();
    const hasPath = !!inputData.csvPath?.trim();
    if (hasText === hasPath) throw new CsvFileError("Provide exactly one of csvText or csvPath");
    const { text, name } = hasText
      ? { text: inputData.csvText!, name: inputData.sourceName ?? "pasted-csv" }
      : readCsvFromPath(inputData.csvPath!.trim(), config);
    if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) throw new CsvFileError("CSV text is larger than 20 MB");

    const parsed = parseLeadCsv(text);
    const csvSha = sha256(text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim());
    const batchId = inputData.batchId ?? `batch_${csvSha.slice(0, 16)}`;
    const store = createLeadStore(config.databaseUrl, config.databaseAuthToken);

    const existing = await store.getBatch(batchId);
    if (existing && existing.csv_sha256 !== csvSha) {
      throw new CsvFileError(`batchId ${batchId} already belongs to a different CSV; use a new batchId`);
    }
    const now = new Date().toISOString();
    const rows = inputData.maxRows ? parsed.rows.slice(0, inputData.maxRows) : parsed.rows;
    const batch: BatchRecord = {
      batch_id: batchId,
      status: "running",
      abort_reason: null,
      source_name: inputData.sourceName ?? name,
      csv_sha256: csvSha,
      total_rows: parsed.totalRows,
      accepted_rows: rows.length,
      rejected_rows: parsed.rejected,
      config_snapshot: {
        exaMaxConcurrentRuns: config.exaMaxConcurrentRuns,
        companyConcurrency: config.companyConcurrency,
        maxTeamContactsPerCompany: config.maxTeamContactsPerCompany,
        maxCostPerCompanyUsd: config.maxCostPerCompanyUsd,
        maxCostPerBatchUsd: config.maxCostPerBatchUsd,
        m1BudgetUsd: config.m1BudgetUsd,
        m5BudgetUsd: config.m5BudgetUsd,
        sarvamModel: config.sarvamModel,
        refresh: inputData.refresh,
        maxRows: inputData.maxRows ?? null,
      },
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_run_started_at: now,
      exports_dir: existing?.exports_dir ?? null,
    };
    await store.saveBatch(batch);
    for (const row of rows) await store.upsertRow(batchId, row, "pending");
    await batchControl.init(batchId, store, config.maxCostPerBatchUsd);

    leadLog("batch-start", {
      batchId,
      resumed: !!existing,
      totalRows: parsed.totalRows,
      accepted: rows.length,
      rejected: parsed.rejected.length,
      unknownHeaders: parsed.unknownHeaders,
      refresh: inputData.refresh,
    });

    const items: CompanyInput[] = rows.map((row) => ({ batchId, refresh: inputData.refresh, row }));
    return {
      batchId,
      items,
      totalRows: parsed.totalRows,
      acceptedRows: rows.length,
      rejectedRows: parsed.rejected,
      exportDir: config.exportDir,
    };
  },
});

const aggregateStep = createStep({
  id: "lead-aggregate-export",
  description: "Write companies.csv, team.csv, evidence.jsonl, run_report.json/.md from the lead store.",
  inputSchema: z.array(CompanyResultSchema),
  outputSchema: LeadWorkflowOutputSchema,
  execute: async ({ inputData, getStepResult }) => {
    const loaded = getStepResult(loadBatchStep);
    const batchId = loaded.batchId;
    const errors = inputData.flatMap((r) => r.errors.map((e) => `${r.company_name}: ${e}`));
    const abortReason = batchControl.abortReason(batchId);
    const status = abortReason ? ("aborted" as const) : ("completed" as const);
    try {
      const config = loadLeadConfig();
      const store = createLeadStore(config.databaseUrl, config.databaseAuthToken);
      const batch = await store.getBatch(batchId);
      if (batch) await store.saveBatch({ ...batch, status, abort_reason: abortReason, updated_at: new Date().toISOString() });
      const exp = await writeBatchExports(store, batchId, loaded.exportDir);
      if (batch) await store.saveBatch({ ...batch, status, abort_reason: abortReason, exports_dir: exp.dir, updated_at: new Date().toISOString() });
      const counts = (exp.report.counts ?? {}) as Record<string, unknown>;
      leadLog("batch-done", { batchId, status, abortReason, exportsDir: exp.dir, totalCostUsd: (exp.report.cost_usd as { total: number }).total });
      return {
        batchId,
        status,
        abortReason,
        exportsDir: exp.dir,
        files: exp.files,
        counts: Object.fromEntries(
          Object.entries(counts).filter(([, v]) => v && typeof v === "object") as [string, Record<string, number>][],
        ),
        totalCostUsd: (exp.report.cost_usd as { total: number }).total,
        summary: exp.summary,
        errors,
      };
    } catch (err) {
      // Exports can always be regenerated later from the store: `npm run leads -- export <batchId>`.
      const msg = `export failed: ${errorMessage(err)}`;
      leadLog("batch-export-failed", { batchId, error: msg });
      return {
        batchId,
        status,
        abortReason,
        exportsDir: null,
        files: [],
        counts: {},
        totalCostUsd: inputData.reduce((s, r) => s + r.cost_usd, 0),
        summary: `${msg}. Research data is safe in the lead store; re-run the export.`,
        errors: [...errors, msg],
      };
    }
  },
});

export const leadQualificationWorkflow = createWorkflow({
  id: "lead-qualification-workflow",
  description:
    "KeilHQ ICP lead research: CSV of startups -> per-company Exa Agent research modules (identity, team, funding/hiring, tools, contacts) -> Sarvam ICP verdict with evidence -> CSV/JSONL exports + run report. Resumable; separate LEAD_* keys.",
  inputSchema: LeadWorkflowInputSchema,
  outputSchema: LeadWorkflowOutputSchema,
})
  .then(loadBatchStep)
  .map(async ({ inputData }) => inputData.items)
  .foreach(companyResearchWorkflow, {
    // Resolved per run, so .env changes apply without rebuilding the graph.
    concurrency: () => tryLoadLeadConfig()?.companyConcurrency ?? 1,
  })
  .then(aggregateStep)
  .commit();
