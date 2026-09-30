import { z } from "zod";

/**
 * ICP lead research configuration (PRD lead_qualification §11).
 *
 * Every key is LEAD_-prefixed so this pipeline never shares credentials or
 * limits with the content pipeline (EXA_API_KEY, SARVAM_API_KEY, ...).
 * Cost/speed controls are REQUIRED — there are no hidden defaults for money.
 * Config is read lazily (at workflow start), so a missing key never breaks
 * Studio boot; it fails the run up-front, before anything is spent.
 */

const num = (name: string, opts: { min?: number; max?: number; int?: boolean } = {}) => {
  let s = z.coerce.number({ message: `${name} must be a number` });
  if (opts.int) s = s.int(`${name} must be an integer`);
  if (opts.min !== undefined) s = s.min(opts.min, `${name} must be >= ${opts.min}`);
  if (opts.max !== undefined) s = s.max(opts.max, `${name} must be <= ${opts.max}`);
  return s;
};

const LeadEnvSchema = z.object({
  // --- credentials (required, never shared with other pipelines) ---
  LEAD_EXA_API_KEY: z.string().min(1, "LEAD_EXA_API_KEY is required"),
  LEAD_SARVAM_API_KEY: z.string().min(1, "LEAD_SARVAM_API_KEY is required"),

  // --- storage + exports (required) ---
  LEAD_DATABASE_URL: z.string().min(1, "LEAD_DATABASE_URL is required (e.g. file:./leads.db)"),
  LEAD_DATABASE_AUTH_TOKEN: z.string().optional(),
  LEAD_EXPORT_DIR: z.string().min(1, "LEAD_EXPORT_DIR is required (e.g. ./workspace/leads)"),
  LEAD_INPUT_DIR: z.string().optional(),

  // --- cost + speed controls (required, PRD §11) ---
  LEAD_EXA_MAX_CONCURRENT_RUNS: num("LEAD_EXA_MAX_CONCURRENT_RUNS", { int: true, min: 1, max: 50 }),
  LEAD_COMPANY_CONCURRENCY: num("LEAD_COMPANY_CONCURRENCY", { int: true, min: 1, max: 50 }),
  LEAD_MAX_TEAM_CONTACTS_PER_COMPANY: num("LEAD_MAX_TEAM_CONTACTS_PER_COMPANY", { int: true, min: 0, max: 60 }),
  LEAD_MAX_COST_PER_COMPANY_USD: num("LEAD_MAX_COST_PER_COMPANY_USD", { min: 0.05 }),
  LEAD_MAX_COST_PER_BATCH_USD: num("LEAD_MAX_COST_PER_BATCH_USD", { min: 0.05 }),
  /** budget.maxCostDollars for M1 (auto effort). Exa accepts 1–100. */
  LEAD_M1_BUDGET_USD: num("LEAD_M1_BUDGET_USD", { min: 1, max: 100 }),
  /** budget.maxCostDollars per M5 chunk (auto effort). Exa accepts 1–100. */
  LEAD_M5_BUDGET_USD: num("LEAD_M5_BUDGET_USD", { min: 1, max: 100 }),

  // --- tuning (optional; defaults documented in .env.example) ---
  LEAD_SARVAM_MODEL: z.string().default("sarvam/sarvam-105b"),
  LEAD_SARVAM_MAX_TOKENS: num("LEAD_SARVAM_MAX_TOKENS", { int: true, min: 1024 }).default(8192),
  LEAD_SARVAM_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  LEAD_EXA_POLL_INTERVAL_MS: num("LEAD_EXA_POLL_INTERVAL_MS", { int: true, min: 1 }).default(4000),
  LEAD_MODULE_TIMEOUT_MS: num("LEAD_MODULE_TIMEOUT_MS", { int: true, min: 1000 }).default(600_000),
  LEAD_EXA_MAX_CREATE_ATTEMPTS: num("LEAD_EXA_MAX_CREATE_ATTEMPTS", { int: true, min: 1, max: 10 }).default(5),
  LEAD_EXA_BACKOFF_BASE_MS: num("LEAD_EXA_BACKOFF_BASE_MS", { int: true, min: 1 }).default(2000),
  LEAD_EXA_MAX_STARTS_PER_SECOND: num("LEAD_EXA_MAX_STARTS_PER_SECOND", { min: 0.1, max: 12 }).default(4),
  LEAD_TEAM_CHUNK_SIZE: num("LEAD_TEAM_CHUNK_SIZE", { int: true, min: 1, max: 25 }).default(10),
  /** Exa contact-enrichment rates (verified on exa.ai/docs/admin/pricing, 2026-09-30). */
  LEAD_EXA_EMAIL_RATE_USD: num("LEAD_EXA_EMAIL_RATE_USD", { min: 0 }).default(0.02),
  LEAD_EXA_PHONE_RATE_USD: num("LEAD_EXA_PHONE_RATE_USD", { min: 0 }).default(0.07),
});

export interface LeadConfig {
  exaApiKey: string;
  sarvamApiKey: string;
  databaseUrl: string;
  databaseAuthToken?: string;
  exportDir: string;
  inputDir?: string;
  exaMaxConcurrentRuns: number;
  companyConcurrency: number;
  maxTeamContactsPerCompany: number;
  maxCostPerCompanyUsd: number;
  maxCostPerBatchUsd: number;
  m1BudgetUsd: number;
  m5BudgetUsd: number;
  sarvamModel: string;
  sarvamMaxTokens: number;
  sarvamReasoningEffort: "low" | "medium" | "high";
  pollIntervalMs: number;
  moduleTimeoutMs: number;
  maxCreateAttempts: number;
  backoffBaseMs: number;
  maxStartsPerSecond: number;
  teamChunkSize: number;
  emailRateUsd: number;
  phoneRateUsd: number;
}

export class LeadConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Lead research config is invalid:\n  - ${problems.join("\n  - ")}\n` +
        `Set these in .env (see .env.example, section "ICP lead research") and restart.`,
    );
    this.name = "LeadConfigError";
  }
}

/** Parse + validate LEAD_* env. Throws LeadConfigError listing every problem. */
export function loadLeadConfig(env: NodeJS.ProcessEnv = process.env): LeadConfig {
  // Treat empty strings as "unset" so optional keys fall back to their defaults.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("LEAD_") && typeof v === "string" && v.trim() !== "") cleaned[k] = v.trim();
  }
  const parsed = LeadEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new LeadConfigError(
      parsed.error.issues.map((i) => {
        const key = String(i.path[0] ?? "");
        if (/received undefined/i.test(i.message)) return `${key} is required`;
        return i.message.includes(key) ? i.message : `${key}: ${i.message}`;
      }),
    );
  }
  const e = parsed.data;
  const problems: string[] = [];
  if (e.LEAD_MAX_COST_PER_BATCH_USD < e.LEAD_MAX_COST_PER_COMPANY_USD) {
    problems.push("LEAD_MAX_COST_PER_BATCH_USD must be >= LEAD_MAX_COST_PER_COMPANY_USD");
  }
  if (!e.LEAD_SARVAM_MODEL.startsWith("sarvam/")) {
    problems.push(`LEAD_SARVAM_MODEL must be a Mastra router id like "sarvam/sarvam-105b"`);
  }
  if (problems.length) throw new LeadConfigError(problems);

  return {
    exaApiKey: e.LEAD_EXA_API_KEY,
    sarvamApiKey: e.LEAD_SARVAM_API_KEY,
    databaseUrl: e.LEAD_DATABASE_URL,
    databaseAuthToken: e.LEAD_DATABASE_AUTH_TOKEN,
    exportDir: e.LEAD_EXPORT_DIR,
    inputDir: e.LEAD_INPUT_DIR,
    exaMaxConcurrentRuns: e.LEAD_EXA_MAX_CONCURRENT_RUNS,
    companyConcurrency: e.LEAD_COMPANY_CONCURRENCY,
    maxTeamContactsPerCompany: e.LEAD_MAX_TEAM_CONTACTS_PER_COMPANY,
    maxCostPerCompanyUsd: e.LEAD_MAX_COST_PER_COMPANY_USD,
    maxCostPerBatchUsd: e.LEAD_MAX_COST_PER_BATCH_USD,
    m1BudgetUsd: e.LEAD_M1_BUDGET_USD,
    m5BudgetUsd: e.LEAD_M5_BUDGET_USD,
    sarvamModel: e.LEAD_SARVAM_MODEL,
    sarvamMaxTokens: e.LEAD_SARVAM_MAX_TOKENS,
    sarvamReasoningEffort: e.LEAD_SARVAM_REASONING_EFFORT,
    pollIntervalMs: e.LEAD_EXA_POLL_INTERVAL_MS,
    moduleTimeoutMs: e.LEAD_MODULE_TIMEOUT_MS,
    maxCreateAttempts: e.LEAD_EXA_MAX_CREATE_ATTEMPTS,
    backoffBaseMs: e.LEAD_EXA_BACKOFF_BASE_MS,
    maxStartsPerSecond: e.LEAD_EXA_MAX_STARTS_PER_SECOND,
    teamChunkSize: e.LEAD_TEAM_CHUNK_SIZE,
    emailRateUsd: e.LEAD_EXA_EMAIL_RATE_USD,
    phoneRateUsd: e.LEAD_EXA_PHONE_RATE_USD,
  };
}

/** Non-throwing variant for places that must never crash (e.g. foreach concurrency resolver). */
export function tryLoadLeadConfig(): LeadConfig | undefined {
  try {
    return loadLeadConfig();
  } catch {
    return undefined;
  }
}

/** Public names of the sensitive keys, for redaction in logs. */
export const LEAD_SECRET_KEYS = ["LEAD_EXA_API_KEY", "LEAD_SARVAM_API_KEY", "LEAD_DATABASE_AUTH_TOKEN"] as const;
