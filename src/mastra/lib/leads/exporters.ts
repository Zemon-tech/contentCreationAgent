import fs from "node:fs";
import path from "node:path";
import type { LeadStore } from "../../repositories/leadStore";
import { resolveFromProjectRoot } from "../../repositories/leadStore";
import type { BatchRecord, CompanyPerson, CompanyRecord, ContactValue, SeedRow } from "../../schemas/lead";
import { toCsv } from "./csv";
import { formatEntityActivity } from "./activity";
import { personKey } from "./contacts";

/**
 * Batch exports (PRD §9): companies.csv, team.csv, evidence.jsonl,
 * run_report.json, run_report.md under <LEAD_EXPORT_DIR>/<batchId>/.
 * Built entirely from the lead store, so they can be regenerated at any time
 * (e.g. after a crash) with `npm run leads -- export <batchId>`.
 */

const J = " | ";

const COMPANY_COLUMNS = [
  // KeilHQ PRD §15 columns
  "Company",
  "Website",
  "Founder/contact",
  "Role",
  "Location",
  "Team size",
  "Industry",
  "Source",
  "Trigger",
  "Current stack",
  "Pain hypothesis",
  "ICP status",
  // Outreach / discovery / pipeline columns: present, intentionally blank in v1
  "Outreach channel",
  "Outreach status",
  "Discovery call",
  "Pipeline stage",
  // Research columns
  "row_id",
  "research_status",
  "analysis_status",
  "identity_confidence",
  "pain_track",
  "criteria",
  "activity_status",
  "company_activity_status",
  "founders_activity_status",
  "company_social_activity",
  "founders_social_activity",
  "funding_summary",
  "revenue_summary",
  "hiring_summary",
  "socials",
  "company_emails",
  "company_phones",
  "contacts_truncated",
  "contact_conflict",
  "seed_contact_person",
  "seed_designation",
  "seed_mobile",
  "seed_email",
  "cost_usd",
  "errors",
];

const TEAM_COLUMNS = [
  "row_id",
  "company",
  "name",
  "title",
  "function",
  "is_leader",
  "is_founder",
  "linkedin",
  "x",
  "emails",
  "phones",
  "source_type",
  "conflict",
  "activity_status",
  "social_activity",
  "source_urls",
];

const s = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const fmtContacts = (list: ContactValue[]) => list.map((c) => (c.type ? `${c.value} (${c.type})` : c.value)).join(J);

function fundingSummary(signals: Record<string, unknown> | null): string {
  const rounds = (signals?.funding_rounds as Record<string, unknown>[] | undefined) ?? [];
  return rounds
    .map((r) => [s(r.date), s(r.stage), r.amount_value != null ? `${s(r.amount_currency)} ${s(r.amount_value)}`.trim() : ""].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(J);
}

function revenueSummary(signals: Record<string, unknown> | null): string {
  const r = signals?.revenue_estimate as Record<string, unknown> | null | undefined;
  if (!r || r.value == null) return "";
  return `${s(r.currency)} ${s(r.value)} ${s(r.period)} (${s(r.confidence) || "?"})`.replace(/\s+/g, " ").trim();
}

function hiringSummary(signals: Record<string, unknown> | null): string {
  const h = signals?.hiring as Record<string, unknown> | undefined;
  if (!h) return "";
  const parts = [];
  if (h.open_roles_count != null) parts.push(`${s(h.open_roles_count)} open roles`);
  const d = (h.departments_hiring as string[] | undefined) ?? [];
  if (d.length) parts.push(`hiring: ${d.join(", ")}`);
  if (h.careers_page_url) parts.push(s(h.careers_page_url));
  return parts.join(J);
}

function socials(identity: Record<string, unknown> | null): string {
  if (!identity) return "";
  const soc = (identity.socials as Record<string, unknown> | undefined) ?? {};
  return [identity.company_linkedin_url, soc.x_url, soc.instagram_url, soc.youtube_url, soc.facebook_url, ...((soc.other_urls as string[]) ?? [])]
    .map(s)
    .filter(Boolean)
    .join(J);
}

function primaryContact(c: CompanyRecord): { name: string; role: string } {
  const researched = c.people.filter((p) => p.source_type === "exa_agent");
  const founder = researched.find((p) => p.is_founder) ?? researched.find((p) => p.is_leader);
  if (founder) return { name: founder.name, role: s(founder.title) };
  return { name: s(c.seed.contact_person), role: s(c.seed.designation) };
}

function companyRow(c: CompanyRecord): Record<string, unknown> {
  const id = c.identity;
  const pc = primaryContact(c);
  const teamSize =
    c.team_size.low !== null || c.team_size.high !== null
      ? c.team_size.low === c.team_size.high
        ? s(c.team_size.low)
        : `${s(c.team_size.low)}-${s(c.team_size.high)}`
      : "";
  const tools = ((c.tools?.tools as { name?: string; evidence_type?: string }[] | undefined) ?? [])
    .map((t) => `${s(t.name)}${t.evidence_type ? ` [${t.evidence_type}]` : ""}`)
    .join(J);
  return {
    Company: s(id?.brand_name) || s(id?.legal_name) || c.seed.company_name,
    Website: s(id?.official_domain) || s(c.seed.website_domain) || s(c.seed.website_raw),
    "Founder/contact": pc.name,
    Role: pc.role,
    Location: [s(id?.hq_city), s(id?.hq_country)].filter(Boolean).join(", ") || s(c.seed.address),
    "Team size": teamSize,
    Industry: s(id?.sector) || s(c.seed.sector),
    Source: [s(c.seed.source_file), s(c.seed.source_line)].filter(Boolean).join(":"),
    Trigger: c.triggers.map((t) => `${t.type}: ${t.text}${t.date ? ` (${t.date})` : ""}`).join(J),
    "Current stack": tools,
    "Pain hypothesis": c.pain_hypothesis ?? "",
    "ICP status": c.icp_status,
    "Outreach channel": "",
    "Outreach status": "",
    "Discovery call": "",
    "Pipeline stage": "",
    row_id: c.row_id,
    research_status: c.research_status,
    analysis_status: c.analysis_status,
    identity_confidence: c.identity_confidence ?? "",
    pain_track: c.pain_track,
    criteria: Object.entries(c.criteria)
      .map(([k, v]) => `${k}=${v.result}`)
      .join(J),
    activity_status: c.activity?.overall ?? "unknown",
    company_activity_status: c.activity?.company_status ?? "unknown",
    founders_activity_status: c.activity?.founders_status ?? "unknown",
    company_social_activity: c.activity ? formatEntityActivity(c.activity.company) : "",
    founders_social_activity: (c.activity?.founders ?? [])
      .map((f) => {
        const line = formatEntityActivity(f);
        return line ? `${f.name}: ${line}` : "";
      })
      .filter(Boolean)
      .join(" || "),
    funding_summary: fundingSummary(c.signals),
    revenue_summary: revenueSummary(c.signals),
    hiring_summary: hiringSummary(c.signals),
    socials: socials(id),
    company_emails: fmtContacts(c.company_contacts.emails),
    company_phones: fmtContacts(c.company_contacts.phones),
    contacts_truncated: c.contacts_truncated,
    contact_conflict: c.contact_conflict,
    seed_contact_person: c.seed.contact_person ?? "",
    seed_designation: c.seed.designation ?? "",
    seed_mobile: c.seed.mobile ?? "",
    seed_email: c.seed.email ?? "",
    cost_usd: c.cost_usd.toFixed(4),
    errors: c.errors.join(J),
  };
}

function teamRow(c: CompanyRecord, p: CompanyPerson): Record<string, unknown> {
  const act = p.source_type === "exa_agent" ? c.activity?.founders.find((f) => personKey(f.name) === p.key) : undefined;
  return {
    row_id: c.row_id,
    company: s(c.identity?.brand_name) || c.seed.company_name,
    name: p.name,
    title: p.title ?? "",
    function: p.function ?? "",
    is_leader: p.is_leader,
    is_founder: p.is_founder ?? "",
    linkedin: p.linkedin_url ?? "",
    x: p.x_url ?? "",
    emails: fmtContacts(p.emails),
    phones: fmtContacts(p.phones),
    source_type: p.source_type,
    conflict: p.conflict,
    activity_status: act?.status ?? "",
    social_activity: act ? formatEntityActivity(act) : "",
    source_urls: p.source_urls.join(J),
  };
}

/** Placeholder for rows that never produced a company record (R1: no silent drops). */
function placeholderCompany(batchId: string, row: SeedRow, status: string): CompanyRecord {
  const now = new Date().toISOString();
  return {
    batch_id: batchId,
    row_id: row.row_id,
    seed: row,
    research_status: "not_started",
    icp_status: "Unresolved",
    analysis_status: "skipped",
    analysis_reason: null,
    identity: null,
    identity_confidence: null,
    people: [],
    company_contacts: { emails: [], phones: [] },
    signals: null,
    tools: null,
    activity: null,
    team_size: { low: null, high: null, basis: null, confidence: null },
    criteria: {},
    triggers: [],
    pain_track: "unknown",
    pain_hypothesis: null,
    ops_summary: null,
    claims: [],
    contacts_truncated: false,
    contact_conflict: false,
    module_statuses: {},
    cost_usd: 0,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    errors: [`row did not run in this batch (row status: ${status})`],
  };
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

export interface ExportResult {
  dir: string;
  files: string[];
  report: Record<string, unknown>;
  summary: string;
}

export async function writeBatchExports(store: LeadStore, batchId: string, exportDir: string): Promise<ExportResult> {
  const batch = await store.getBatch(batchId);
  const rows = await store.listRows(batchId);
  const stored = new Map((await store.listCompanies(batchId)).map((c) => [c.row_id, c]));
  const companies: CompanyRecord[] = rows.map(({ row, status }) => stored.get(row.row_id) ?? placeholderCompany(batchId, row, status));

  const dir = path.join(resolveFromProjectRoot(exportDir), batchId);
  fs.mkdirSync(dir, { recursive: true });

  // companies.csv / team.csv
  writeAtomic(path.join(dir, "companies.csv"), toCsv(COMPANY_COLUMNS, companies.map(companyRow)));
  writeAtomic(path.join(dir, "team.csv"), toCsv(TEAM_COLUMNS, companies.flatMap((c) => c.people.map((p) => teamRow(c, p)))));

  // evidence.jsonl: every stored module run that belongs to each company's latest state
  const lines: string[] = [];
  const moduleLatencies: Record<string, number[]> = {};
  for (const c of companies) {
    const keys = new Set(Object.values(c.module_statuses).flatMap((m) => m.cache_keys));
    const recs = (await store.listModuleRunsForRow(c.row_id)).filter((r) => keys.has(r.cache_key));
    for (const r of recs) {
      if (r.latency_ms != null) (moduleLatencies[r.module_id.split("#")[0]!] ??= []).push(r.latency_ms);
      lines.push(
        JSON.stringify({
          row_id: c.row_id,
          company: c.seed.company_name,
          module_id: r.module_id,
          cache_key: r.cache_key,
          state: r.state,
          module_status: r.module_status,
          run_id: r.run_id,
          attempts: r.attempts,
          structured: r.structured,
          grounding: r.grounding,
          stop_reason: r.stop_reason,
          cost_usd: r.cost_usd,
          cost_breakdown: r.cost_breakdown,
          usage: r.usage,
          latency_ms: r.latency_ms,
          started_at: r.started_at,
          finished_at: r.finished_at,
          error: r.error,
        }),
      );
    }
  }
  writeAtomic(path.join(dir, "evidence.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""));

  // run_report.json
  const count = <K extends string>(vals: K[]) => vals.reduce<Record<string, number>>((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});
  const researched = companies.filter((c) => c.research_status !== "not_started" && c.research_status !== "unresolved");
  const pct = (n: number) => (researched.length ? Number(((100 * n) / researched.length).toFixed(1)) : 0);
  const has = (pred: (c: CompanyRecord) => boolean) => pct(researched.filter(pred).length);
  const exaPeople = (c: CompanyRecord) => c.people.filter((p) => p.source_type === "exa_agent");
  const coverage = {
    founders: has((c) => exaPeople(c).some((p) => p.is_founder || p.is_leader)),
    team_size: has((c) => c.team_size.low !== null || c.team_size.high !== null),
    funding: has((c) => (((c.signals?.funding_rounds as unknown[]) ?? []).length > 0)),
    revenue: has((c) => (c.signals?.revenue_estimate as { value?: unknown } | null)?.value != null),
    tools: has((c) => (((c.tools?.tools as unknown[]) ?? []).length > 0)),
    email: has((c) => exaPeople(c).some((p) => p.emails.length > 0) || c.company_contacts.emails.length > 0),
    phone: has((c) => exaPeople(c).some((p) => p.phones.length > 0) || c.company_contacts.phones.length > 0),
    social_activity: has((c) => !!c.activity && c.activity.overall !== "unknown"),
  };
  const durations = companies.filter((c) => c.duration_ms > 0).map((c) => c.duration_ms);
  const totalCost = companies.reduce((s2, c) => s2 + c.cost_usd, 0);
  const observedWithoutRef = companies.reduce(
    (n, c) => n + c.claims.filter((cl) => cl.epistemic === "observed" && cl.evidence_refs.length === 0).length,
    0,
  );
  const failures = companies.flatMap((c) =>
    Object.values(c.module_statuses)
      .filter((m) => m.status === "failed" || m.status === "not_started" || (m.status === "skipped" && !m.reason?.startsWith("n/a:")))
      .map((m) => ({ row_id: c.row_id, company: c.seed.company_name, module: m.module_id, status: m.status, reason: m.reason })),
  );

  const report = {
    batch_id: batchId,
    generated_at: new Date().toISOString(),
    batch_status: batch?.status ?? "unknown",
    abort_reason: batch?.abort_reason ?? null,
    input: {
      source: batch?.source_name ?? null,
      total_rows: batch?.total_rows ?? rows.length,
      accepted_rows: rows.length,
      rejected_rows: batch?.rejected_rows ?? [],
    },
    counts: {
      research_status: count(companies.map((c) => c.research_status)),
      icp_status: count(companies.map((c) => c.icp_status)),
      analysis_status: count(companies.map((c) => c.analysis_status)),
      activity_status: count(companies.map((c) => c.activity?.overall ?? "unknown")),
      contacts_truncated: companies.filter((c) => c.contacts_truncated).length,
      contact_conflicts: companies.filter((c) => c.contact_conflict).length,
      observed_claims_without_ref: observedWithoutRef,
    },
    coverage_pct_of_researched: coverage,
    cost_usd: {
      total: Number(totalCost.toFixed(4)),
      per_company_avg: companies.length ? Number((totalCost / companies.length).toFixed(4)) : 0,
      per_company: companies.map((c) => ({ row_id: c.row_id, company: c.seed.company_name, cost_usd: c.cost_usd })),
    },
    latency_ms: {
      company_p50: percentile(durations, 50),
      company_p95: percentile(durations, 95),
      module: Object.fromEntries(
        Object.entries(moduleLatencies).map(([k, v]) => [k, { p50: percentile(v, 50), p95: percentile(v, 95), n: v.length }]),
      ),
    },
    failures,
  };
  writeAtomic(path.join(dir, "run_report.json"), JSON.stringify(report, null, 2));

  const summary = renderSummary(report, batch);
  writeAtomic(path.join(dir, "run_report.md"), summary);

  return {
    dir,
    files: ["companies.csv", "team.csv", "evidence.jsonl", "run_report.json", "run_report.md"].map((f) => path.join(dir, f)),
    report,
    summary,
  };
}

function renderSummary(r: Record<string, any>, batch: BatchRecord | undefined): string {
  const kv = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ") || "none";
  const lines = [
    `# Lead research run report: ${r.batch_id}`,
    "",
    `Generated ${r.generated_at}. Batch status: ${r.batch_status}${r.abort_reason ? ` (aborted: ${r.abort_reason})` : ""}.`,
    `Input: ${r.input.total_rows} rows, ${r.input.accepted_rows} accepted, ${r.input.rejected_rows.length} rejected${batch?.source_name ? ` (${batch.source_name})` : ""}.`,
    "",
    `- Research status: ${kv(r.counts.research_status)}`,
    `- ICP status: ${kv(r.counts.icp_status)}`,
    `- Analysis status: ${kv(r.counts.analysis_status)}`,
    `- Social activity: ${kv(r.counts.activity_status ?? {})}`,
    `- Coverage (% of researched): ${kv(r.coverage_pct_of_researched)}`,
    `- Cost: $${r.cost_usd.total} total, $${r.cost_usd.per_company_avg} per company`,
    `- Company latency: p50 ${r.latency_ms.company_p50 ?? "-"} ms, p95 ${r.latency_ms.company_p95 ?? "-"} ms`,
    `- Contacts truncated by caps: ${r.counts.contacts_truncated}; seed/researched conflicts: ${r.counts.contact_conflicts}`,
    "",
  ];
  if (r.input.rejected_rows.length) {
    lines.push("## Rejected rows", "", ...r.input.rejected_rows.map((x: any) => `- row ${x.row_number}: ${x.reason}`), "");
  }
  if (r.failures.length) {
    lines.push("## Module gaps", "", ...r.failures.slice(0, 200).map((f: any) => `- ${f.company} ${f.module}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`), "");
  }
  return lines.join("\n");
}
