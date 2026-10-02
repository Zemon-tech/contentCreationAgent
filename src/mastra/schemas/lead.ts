import { z } from "zod";

/**
 * Schemas for the ICP lead research pipeline (PRD lead_qualification).
 * Workflow step payloads stay SMALL (ids, statuses, costs); heavy research
 * output lives in the lead store and is loaded by cache key when needed.
 */

// ---------- Input rows ----------

export const SeedRowSchema = z.object({
  row_id: z.string(),
  /** 1-based data-row number inside the uploaded CSV (after the header). */
  row_number: z.number().int(),
  company_name: z.string(),
  sector: z.string().nullable(),
  profile: z.string().nullable(),
  contact_person: z.string().nullable(),
  designation: z.string().nullable(),
  mobile: z.string().nullable(),
  email: z.string().nullable(),
  website_raw: z.string().nullable(),
  website_domain: z.string().nullable(),
  address: z.string().nullable(),
  source_file: z.string().nullable(),
  source_line: z.string().nullable(),
});
export type SeedRow = z.infer<typeof SeedRowSchema>;

export const RejectedRowSchema = z.object({
  row_number: z.number().int(),
  reason: z.string(),
  company_name: z.string().nullable(),
});
export type RejectedRow = z.infer<typeof RejectedRowSchema>;

// ---------- Statuses ----------

export const ModuleStatusSchema = z.enum(["success", "partial", "failed", "skipped", "not_started"]);
export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;

export const ResearchStatusSchema = z.enum(["complete", "partial", "failed", "unresolved", "not_started"]);
export type ResearchStatus = z.infer<typeof ResearchStatusSchema>;

export const IcpStatusSchema = z.enum(["Qualified", "Not qualified", "Needs review", "Unresolved"]);
export type IcpStatus = z.infer<typeof IcpStatusSchema>;

export const AnalysisStatusSchema = z.enum(["success", "failed", "skipped"]);
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

export const ModuleSummarySchema = z.object({
  module_id: z.string(),
  status: ModuleStatusSchema,
  reason: z.string().nullable(),
  cache_keys: z.array(z.string()),
  run_ids: z.array(z.string()),
  /** Total cost attributed to this module's stored runs. */
  cost_usd: z.number(),
  /** Money spent during THIS execution (0 when served from cache). */
  new_cost_usd: z.number(),
  duration_ms: z.number(),
  from_cache: z.boolean(),
});
export type ModuleSummary = z.infer<typeof ModuleSummarySchema>;

// ---------- Contact planning (Stage 2) ----------

export const PlannedPersonSchema = z.object({
  key: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  function: z.string().nullable(),
  linkedin_url: z.string().nullable(),
  is_leader: z.boolean(),
  source: z.enum(["exa_m1", "seed_csv"]),
});
export type PlannedPerson = z.infer<typeof PlannedPersonSchema>;

export const ContactPlanSchema = z.object({
  leaders: z.array(PlannedPersonSchema),
  team_chunks: z.array(z.array(PlannedPersonSchema)),
  contacts_truncated: z.boolean(),
  truncation_reason: z.string().nullable(),
  estimated_worst_case_usd: z.number(),
});
export type ContactPlan = z.infer<typeof ContactPlanSchema>;

// ---------- Per-company workflow state ----------

export const CompanyInputSchema = z.object({
  batchId: z.string(),
  refresh: z.boolean(),
  row: SeedRowSchema,
});
export type CompanyInput = z.infer<typeof CompanyInputSchema>;

export const CompanyGateSchema = z.enum(["pending", "resolved", "unresolved", "failed", "aborted"]);

export const CompanyStateSchema = CompanyInputSchema.extend({
  startedAt: z.string(),
  gate: CompanyGateSchema,
  modules: z.record(z.string(), ModuleSummarySchema),
  contactPlan: ContactPlanSchema.nullable(),
  /** Founders/leaders chosen for the M6 social-activity check. */
  activityPeople: z.array(PlannedPersonSchema).nullable(),
  analysis: z
    .object({ status: AnalysisStatusSchema, reason: z.string().nullable(), cache_key: z.string().nullable() })
    .nullable(),
  errors: z.array(z.string()),
});
export type CompanyState = z.infer<typeof CompanyStateSchema>;

export const CompanyResultSchema = z.object({
  batchId: z.string(),
  row_id: z.string(),
  company_name: z.string(),
  research_status: ResearchStatusSchema,
  icp_status: IcpStatusSchema,
  analysis_status: AnalysisStatusSchema,
  cost_usd: z.number(),
  duration_ms: z.number(),
  errors: z.array(z.string()),
});
export type CompanyResult = z.infer<typeof CompanyResultSchema>;

// ---------- Sarvam ICP judgement (S1) ----------

export const CriterionResultSchema = z.object({
  result: z.enum(["met", "not_met", "unknown"]),
  reason: z.string(),
  evidence_refs: z.array(z.string()).max(8),
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

export const EpistemicSchema = z.enum(["observed", "hypothesis", "unknown"]);

export const IcpJudgementSchema = z.object({
  criteria: z.object({
    startup_tech_enabled: CriterionResultSchema,
    multiple_functional_teams: CriterionResultSchema,
    early_stage: CriterionResultSchema,
    problem_fit_signals: CriterionResultSchema,
    current_trigger: CriterionResultSchema,
  }),
  triggers: z
    .array(
      z.object({
        type: z.enum(["hiring_surge", "new_leader", "funding", "launch", "tool_complaint", "expansion", "other"]),
        text: z.string(),
        date: z.string().nullable(),
        evidence_refs: z.array(z.string()).max(8),
      }),
    )
    .max(10),
  pain_track: z.enum(["A_tool_sprawl", "B_operational_chaos", "none", "unknown"]),
  pain_hypothesis: z.string().nullable(),
  ops_summary: z.string().nullable(),
  claims: z
    .array(
      z.object({
        text: z.string(),
        epistemic: EpistemicSchema,
        evidence_refs: z.array(z.string()).max(8),
      }),
    )
    .max(25),
});
export type IcpJudgement = z.infer<typeof IcpJudgementSchema>;

// ---------- Persisted records ----------

/** Lifecycle of one Exa Agent run slot (one module or one M5 chunk). */
export type ModuleRunState =
  | "creating" // intent persisted, create call in flight
  | "running" // run_id persisted, polling
  | "timed_out" // our timeout hit; run may still finish on Exa -> resumable
  | "completed"
  | "failed"
  | "not_started"; // never created (batch aborted / budget)

export interface ModuleRunAttempt {
  attempt: number;
  attempt_id: string;
  run_id: string | null;
  status: string;
  error: string | null;
  cost_usd: number;
  created_at: string;
  finished_at: string | null;
}

export interface ModuleRunRecord {
  cache_key: string;
  batch_id: string;
  row_id: string;
  module_id: string;
  schema_version: string;
  input_hash: string;
  state: ModuleRunState;
  module_status: ModuleStatus | null;
  run_id: string | null;
  attempt_id: string | null;
  attempts: ModuleRunAttempt[];
  request_summary: { effort: string; budget_usd: number | null; query_preview: string };
  structured: unknown;
  grounding: unknown;
  text: string | null;
  stop_reason: string | null;
  cost_usd: number;
  cost_breakdown: unknown;
  usage: unknown;
  error: { message: string; status_code: number | null; code: string | null } | null;
  started_at: string | null;
  finished_at: string | null;
  latency_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface BatchRecord {
  batch_id: string;
  status: "running" | "completed" | "aborted";
  abort_reason: string | null;
  source_name: string | null;
  csv_sha256: string;
  total_rows: number;
  accepted_rows: number;
  rejected_rows: RejectedRow[];
  config_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_run_started_at: string;
  exports_dir: string | null;
}

export interface ContactValue {
  value: string;
  type: string | null;
  source_url: string | null;
  source_type: "exa_agent" | "seed_csv";
}

export interface CompanyPerson {
  key: string;
  name: string;
  title: string | null;
  function: string | null;
  linkedin_url: string | null;
  x_url: string | null;
  other_profiles: { platform: string | null; url: string }[];
  emails: ContactValue[];
  phones: ContactValue[];
  is_leader: boolean;
  is_founder: boolean | null;
  source_type: "exa_agent" | "seed_csv";
  source_urls: string[];
  conflict: boolean;
}

export interface CriterionOutcome {
  result: "met" | "not_met" | "unknown" | "borderline";
  reason: string;
  evidence_refs: string[];
  decided_by: "code" | "sarvam" | "code_downgrade";
}

// ---------- Social activity (M6) ----------

export type ActivityStatus = "active" | "low_activity" | "dormant" | "unknown";
export type SocialPlatform = "linkedin" | "x" | "instagram";

export interface PlatformActivitySummary {
  platform: SocialPlatform;
  profile_url: string | null;
  followers: number | null;
  total_posts: number | null;
  posts_last_90_days: number | null;
  last_post_date: string | null;
  days_since_last_post: number | null;
  status: ActivityStatus;
  /** False when Exa returned values without a citation (values are then ignored). */
  grounded: boolean;
  /** Evidence path, e.g. "M6.company.linkedin.last_post_date". */
  ref: string;
}

export interface EntityActivity {
  kind: "company" | "person";
  name: string;
  title: string | null;
  platforms: PlatformActivitySummary[];
  status: ActivityStatus;
}

export interface ActivitySummary {
  as_of: string;
  company: EntityActivity;
  founders: EntityActivity[];
  company_status: ActivityStatus;
  founders_status: ActivityStatus;
  overall: ActivityStatus;
}

export interface CompanyRecord {
  batch_id: string;
  row_id: string;
  seed: SeedRow;
  research_status: ResearchStatus;
  icp_status: IcpStatus;
  analysis_status: AnalysisStatus;
  analysis_reason: string | null;
  identity: Record<string, unknown> | null;
  identity_confidence: string | null;
  people: CompanyPerson[];
  company_contacts: { emails: ContactValue[]; phones: ContactValue[] };
  signals: Record<string, unknown> | null;
  tools: Record<string, unknown> | null;
  activity: ActivitySummary | null;
  team_size: { low: number | null; high: number | null; basis: string | null; confidence: string | null };
  criteria: Record<string, CriterionOutcome>;
  triggers: IcpJudgement["triggers"];
  pain_track: IcpJudgement["pain_track"];
  pain_hypothesis: string | null;
  ops_summary: string | null;
  claims: (IcpJudgement["claims"][number] & { downgraded: boolean })[];
  contacts_truncated: boolean;
  contact_conflict: boolean;
  module_statuses: Record<string, ModuleSummary>;
  cost_usd: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  errors: string[];
}
