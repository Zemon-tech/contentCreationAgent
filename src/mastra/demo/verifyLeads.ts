/**
 * Lead research pipeline verification (simple test, no framework, no network).
 * Run with: npm run verify:leads
 *
 * Uses a fake Exa Agent API and a fake Sarvam judge, a temp LibSQL file and a
 * temp export folder. Covers PRD acceptance criteria: R1–R6 with injected
 * 429/503/402, resume by run_id, orphan adoption, timeouts, malformed CSV,
 * unresolved company, zero unreferenced "observed" claims, seed values kept.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExaError, type AgentRun, type CreateAgentRunParams } from "exa-js";

// ---- env BEFORE anything reads config (config is read lazily) ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lead-verify-"));
const BASE_ENV: Record<string, string> = {
  LEAD_EXA_API_KEY: "test-exa-key",
  LEAD_SARVAM_API_KEY: "test-sarvam-key",
  LEAD_DATABASE_URL: `file:${path.join(TMP, "leads.db").replace(/\\/g, "/")}`,
  LEAD_EXPORT_DIR: path.join(TMP, "exports"),
  LEAD_INPUT_DIR: TMP,
  LEAD_EXA_MAX_CONCURRENT_RUNS: "40",
  LEAD_COMPANY_CONCURRENCY: "2",
  LEAD_MAX_TEAM_CONTACTS_PER_COMPANY: "20",
  LEAD_MAX_COST_PER_COMPANY_USD: "8",
  LEAD_MAX_COST_PER_BATCH_USD: "100",
  LEAD_M1_BUDGET_USD: "2",
  LEAD_M5_BUDGET_USD: "1",
  LEAD_EXA_POLL_INTERVAL_MS: "1",
  LEAD_EXA_BACKOFF_BASE_MS: "1",
  LEAD_EXA_MAX_STARTS_PER_SECOND: "12",
  LEAD_MODULE_TIMEOUT_MS: "1000",
};
for (const k of Object.keys(process.env)) if (k.startsWith("LEAD_")) delete process.env[k];
Object.assign(process.env, BASE_ENV);

const { loadLeadConfig, LeadConfigError } = await import("../config/leadConfig");
const { LEAD_MODULES } = await import("../config/leadModules");
const { createLeadStore, closeLeadDb } = await import("../repositories/leadStore");
const { parseLeadCsv, normalizeDomain, csvCell, CsvFileError } = await import("../lib/leads/csv");
const { teamSizeCriterion, computeIcpStatus } = await import("../lib/leads/icp");
const { enforceEpistemics } = await import("../lib/leads/epistemic");
const { planContacts } = await import("../lib/leads/contacts");
const { batchControl } = await import("../lib/leads/control");
const { redact } = await import("../lib/leads/log");
const { runExaModule, setExaAgentApiForTesting, moduleCacheKey, buildModuleRequest } = await import("../lib/leads/exaAgentRunner");
const { setIcpJudgeForTesting } = await import("../lib/leads/judge");
const { leadQualificationWorkflow } = await import("../workflows/leadQualificationWorkflow");

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// ---------------- fake Exa Agent API ----------------

type FakeRun = { run: AgentRun; params: CreateAgentRunParams; polls: number; mode: "ok" | "fail" | "hang" };

const g = (field: string) => ({ field, citations: [{ url: `https://example.org/${field}` }], confidence: "high" });

function fixture(module: string, params: CreateAgentRunParams): { structured: unknown; grounding: unknown[]; cost: number } {
  const data = (params.input?.data ?? []) as Record<string, any>[];
  const first = data[0] ?? {};
  const name = String(first.company_name ?? "Company");
  const domain = String(first.official_domain ?? first.website_domain ?? `${name.toLowerCase().replace(/\W+/g, "")}.com`);
  switch (module.split("#")[0]) {
    case "M0":
      return {
        structured: {
          official_domain: domain,
          legal_name: `${name} Pvt Ltd`,
          brand_name: name,
          description: `${name} builds workflow software.`,
          hq_city: "Bengaluru",
          hq_country: "India",
          founded_year: 2024,
          sector: "SaaS",
          company_linkedin_url: `https://linkedin.com/company/${domain}`,
          socials: { x_url: null, instagram_url: null, youtube_url: null, facebook_url: null, other_urls: [] },
          input_website_matches: true,
          identity_confidence: /ghost/i.test(name) ? "low" : "high",
          identity_confidence_reason: /ghost/i.test(name) ? "no matching company found" : "site + registry agree",
        },
        grounding: [g("official_domain"), g("description"), g("founded_year")],
        cost: 0.025,
      };
    case "M1":
      return {
        structured: {
          leaders: [
            { name: "Asha Rao", title: "Co-founder & CEO", is_founder: true, linkedin_url: "https://linkedin.com/in/asha" },
            { name: "Vikram Iyer", title: "COO", is_founder: false, linkedin_url: null },
          ],
          team_members: Array.from({ length: 12 }, (_, i) => ({
            name: `Member ${i + 1}`,
            title: i % 2 ? "Software Engineer" : "Account Executive",
            function: i % 2 ? "engineering" : "sales",
            linkedin_url: null,
          })),
          functional_teams: [{ name: "Engineering", headcount_estimate: 6 }, { name: "Sales", headcount_estimate: 6 }],
          team_size_estimate: { low: 12, high: 20, basis: "LinkedIn employee count", confidence: "medium" },
        },
        grounding: [g("leaders"), g("team_members"), g("functional_teams"), g("team_size_estimate")],
        cost: 1.2,
      };
    case "M2":
      return {
        structured: {
          funding_rounds: [{ date: "2026-03", stage: "Seed", amount_value: 2000000, amount_currency: "USD", investors: ["Fund A"], source_url: "https://news.example/seed" }],
          revenue_estimate: null,
          hiring: { open_roles_count: 6, departments_hiring: ["engineering"], careers_page_url: `https://${domain}/careers`, job_board_urls: [] },
          recent_news: [{ date: "2026-08", type: "hiring", headline: "Hiring 6 engineers", source_url: "https://news.example/hiring" }],
        },
        grounding: [g("funding_rounds[0].stage"), g("hiring.open_roles_count"), g("recent_news")],
        cost: 0.1,
      };
    case "M3":
      return {
        structured: {
          tools: [
            { name: "Slack", category: "communication", evidence_type: "job_post", source_url: null },
            { name: "Notion", category: "docs/wiki", evidence_type: "stated_by_company", source_url: null },
          ],
          tooling_signals: [{ signal_type: "coordination_pain", text: "Founder post about handoffs breaking", date: "2026-07", source_url: null }],
        },
        grounding: [g("tools"), g("tooling_signals[0].text")],
        cost: 0.1,
      };
    default: {
      // M4 / M5 contacts
      const people = data.map((p) => ({
        input_name: p.name,
        emails: [{ value: `${String(p.name).split(" ")[0]!.toLowerCase()}@${p.company_domain}`, type: "work", source_url: null }],
        phones: module === "M4" ? [{ value: "+91 98450 00000", type: "mobile", source_url: null }] : [],
        linkedin_url: null,
        x_url: null,
        other_profiles: [],
      }));
      return {
        structured:
          module === "M4"
            ? { people, company_contacts: { emails: [{ value: `hello@${first.company_domain}`, type: "generic", source_url: null }], phones: [] } }
            : { people },
        grounding: [g("people")],
        cost: module === "M4" ? 0.1 + people.length * 0.09 : 0.3 + people.length * 0.02,
      };
    }
  }
}

class FakeExa {
  runs = new Map<string, FakeRun>();
  creates: { module: string; cacheKey: string }[] = [];
  createErrors: Error[] = [];
  /** Throw 402 once this many creates have succeeded (simulates credits running out mid-batch). */
  creditsLeft = Infinity;
  mode: (module: string) => FakeRun["mode"] = () => "ok";
  runIdPersistedBeforePoll = true;
  store = createLeadStore(process.env.LEAD_DATABASE_URL!);
  private seq = 0;

  async create(params: CreateAgentRunParams): Promise<AgentRun> {
    const err = this.createErrors.shift();
    if (err) throw err;
    if (this.creditsLeft <= 0) throw new ExaError("No more credits", 402, undefined, "/agent/runs", { code: "NO_MORE_CREDITS" });
    this.creditsLeft--;
    const meta = (params.metadata ?? {}) as Record<string, string>;
    const id = `agent_run_fake_${++this.seq}`;
    this.creates.push({ module: meta.module ?? "?", cacheKey: meta.cacheKey ?? "?" });
    const run: AgentRun = { id, status: "queued", metadata: meta } as AgentRun;
    this.runs.set(id, { run, params, polls: 0, mode: this.mode(meta.module ?? "") });
    return { ...run };
  }

  async get(id: string): Promise<AgentRun> {
    const r = this.runs.get(id);
    if (!r) throw new ExaError("not found", 404);
    const meta = (r.params.metadata ?? {}) as Record<string, string>;
    if (r.polls === 0 && meta.cacheKey) {
      const rec = await this.store.getModuleRun(meta.cacheKey);
      if (rec?.run_id !== id) this.runIdPersistedBeforePoll = false;
    }
    r.polls++;
    if (r.mode === "hang" || r.polls < 2) return { ...r.run, status: "running" };
    if (r.mode === "fail") return { ...r.run, status: "failed", error: { code: "INTERNAL", message: "boom" }, costDollars: { total: 0.01 } };
    const f = fixture(meta.module ?? "", r.params);
    return {
      ...r.run,
      status: "completed",
      stopReason: "schema_satisfied",
      output: { structured: f.structured, grounding: f.grounding as never, text: null },
      costDollars: { total: f.cost },
    };
  }

  async list() {
    return { data: [...this.runs.values()].map((r) => ({ ...r.run })), hasMore: false, nextCursor: null };
  }
}

// ---------------- fake Sarvam judge ----------------

const goodJudgement = {
  criteria: {
    startup_tech_enabled: { result: "met", reason: "workflow software", evidence_refs: ["M0.description"] },
    multiple_functional_teams: { result: "met", reason: "eng + sales", evidence_refs: ["M1.functional_teams[1].name"] },
    early_stage: { result: "met", reason: "Seed 2026", evidence_refs: ["M2.funding_rounds[0].stage"] },
    problem_fit_signals: { result: "met", reason: "handoff pain", evidence_refs: ["M3.tooling_signals[0].text"] },
    current_trigger: { result: "met", reason: "hiring 6", evidence_refs: ["M2.hiring.open_roles_count"] },
  },
  triggers: [
    { type: "hiring_surge", text: "6 open roles", date: "2026-08", evidence_refs: ["M2.hiring.open_roles_count"] },
    { type: "launch", text: "Invented launch", date: null, evidence_refs: ["M2.launches[0]"] },
  ],
  pain_track: "B_operational_chaos",
  pain_hypothesis: "Hiring fast while handoffs break suggests coordination pain.",
  ops_summary: "CEO leads sales; COO runs ops; 6 engineers.",
  claims: [
    { text: "Raised a Seed round in 2026", epistemic: "observed", evidence_refs: ["M2.funding_rounds[0].stage"] },
    { text: "Uses Jira", epistemic: "observed", evidence_refs: ["M3.tools[9].name"] },
    { text: "Revenue is about $1M", epistemic: "observed", evidence_refs: [] },
    { text: "Likely to buy", epistemic: "hypothesis", evidence_refs: [] },
  ],
};
let judgeCalls = 0;
let judgeSawContactData = false;
setIcpJudgeForTesting(async (prompt) => {
  judgeCalls++;
  if (/@|\+91|98450|linkedin\.com\/in/i.test(prompt)) judgeSawContactData = true;
  // First call for each company returns an invalid object to exercise the zod retry.
  if (judgeCalls % 5 === 1) return { object: { criteria: {} } };
  return { object: structuredClone(goodJudgement), usage: { totalTokens: 1 } };
});

// Exercise the real text -> JSON parse + partial-output tolerance seen in production.
const { extractJson, normalizeJudgement } = await import("../lib/leads/judge");
const { IcpJudgementSchema } = await import("../schemas/lead");

// ---------------- helpers ----------------

const HEADER = "Company Name,Sector,Profile,Contact Person,Designation,Mobile,Email,Website,Address,Source File,Source Line";
function csvOf(rows: string[]): string {
  return `\uFEFF${HEADER}\r\n${rows.join("\r\n")}\r\n`;
}
async function runBatch(input: Record<string, unknown>) {
  const run = await leadQualificationWorkflow.createRun();
  return run.start({ inputData: input as never });
}

async function main(): Promise<void> {
  const config = loadLeadConfig();
  const store = createLeadStore(config.databaseUrl);

  console.log("[1] CSV parsing + validation");
  const parsed = parseLeadCsv(
    csvOf([
      `"Acme, Inc",SaaS,"Line1\nLine2",Asha Rao,CEO,+91 90000 11111,asha@acme.io,https://www.Acme.io/about,"Addr ""A""",list.xlsx,2`,
      ``,
      `,SaaS,,,,,,,,list.xlsx,3`,
      `"Acme, Inc",SaaS,,,,,,,,list.xlsx,2`,
      `Beta Labs,,,,,,,beta,,,`,
    ]),
  );
  check("accepts valid rows, skips blank lines", parsed.rows.length === 2, `${parsed.rows.length} rows`);
  check("rejects missing company name + duplicate", parsed.rejected.length === 2, parsed.rejected.map((r) => r.reason).join("; "));
  const acme = parsed.rows[0]!;
  check("quoted comma/newline/escaped quote", acme.company_name === "Acme, Inc" && acme.profile === "Line1\nLine2" && acme.address === 'Addr "A"');
  check("website -> bare domain", acme.website_domain === "acme.io" && normalizeDomain("beta") === null);
  check("row_id stable from source file+line", acme.row_id === parseLeadCsv(csvOf([`X,,,,,,,,,list.xlsx,2`])).rows[0]!.row_id);
  let threw = false;
  try {
    parseLeadCsv("name,website\nA,a.com\n");
  } catch (e) {
    threw = e instanceof CsvFileError;
  }
  check("file without 'company name' column is rejected", threw);
  check("formula injection neutralised in exports", csvCell("=HYPERLINK(1)") === "'=HYPERLINK(1)" && csvCell("-5") === "-5");

  console.log("[2] config + separate keys");
  let problems: string[] = [];
  try {
    loadLeadConfig({ EXA_API_KEY: "shared", SARVAM_API_KEY: "shared" } as NodeJS.ProcessEnv);
  } catch (e) {
    problems = e instanceof LeadConfigError ? e.problems : [];
  }
  check("shared EXA/SARVAM keys are NOT used; missing LEAD_* keys listed", problems.some((p) => p.includes("LEAD_EXA_API_KEY")) && problems.some((p) => p.includes("LEAD_MAX_COST_PER_BATCH_USD")), `${problems.length} problems`);
  check("logs never contain contact values", !JSON.stringify(redact({ email: "a@b.com", note: "call +91 98450 12345 or a@b.com", at: "2026-09-30" })).match(/a@b\.com|98450/));

  console.log("[3] ICP rules");
  check("team size 12-20 met", teamSizeCriterion({ low: 12, high: 20, basis: null, confidence: null }).result === "met");
  check("team size 30-80 borderline", teamSizeCriterion({ low: 30, high: 80, basis: null, confidence: null }).result === "borderline");
  check("team size 60-90 not_met", teamSizeCriterion({ low: 60, high: 90, basis: null, confidence: null }).result === "not_met");
  const met = { result: "met" as const, reason: "", evidence_refs: [], decided_by: "code" as const };
  const unk = { ...met, result: "unknown" as const };
  check(
    "Qualified needs team_size + decision_maker + 2 of 3",
    computeIcpStatus({ team_size: met, decision_maker: met, multiple_functional_teams: met, current_trigger: met }, "complete") === "Qualified" &&
      computeIcpStatus({ team_size: met, decision_maker: met, multiple_functional_teams: met }, "complete") === "Needs review" &&
      computeIcpStatus({ team_size: unk, decision_maker: met, multiple_functional_teams: met, current_trigger: met }, "complete") === "Needs review" &&
      computeIcpStatus({ team_size: { ...met, result: "not_met" } }, "complete") === "Not qualified",
  );

  console.log("[4] epistemic enforcement");
  const m = {
    M2: { status: "success", structured: fixture("M2", { query: "" }).structured, grounding: fixture("M2", { query: "" }).grounding },
    M3: { status: "success", structured: fixture("M3", { query: "" }).structured, grounding: fixture("M3", { query: "" }).grounding },
  };
  const enforced = enforceEpistemics(goodJudgement as never, m);
  check("grounded observed claim kept", enforced.claims[0]!.epistemic === "observed");
  check("bad-path / no-ref observed claims -> hypothesis", enforced.claims[1]!.epistemic === "hypothesis" && enforced.claims[2]!.epistemic === "hypothesis");
  check("trigger without real evidence dropped to hypothesis", enforced.triggers.length === 1 && enforced.claims.some((c) => c.text.includes("Invented launch")));
  check("criterion with ungrounded ref -> unknown", enforced.criteria.startup_tech_enabled!.result === "unknown");

  console.log("[5] contact planning under budget");
  const m1 = fixture("M1", { query: "" }).structured;
  const tight = planContacts({ row: acme, m1, config, remainingUsd: 1.5 });
  check("leaders (+ seed contact) kept first", tight.leaders.length >= 2 && tight.leaders[0]!.name === "Asha Rao");
  check("team dropped + contacts_truncated when budget bites", tight.team_chunks.length === 0 && tight.contacts_truncated);
  const roomy = planContacts({ row: acme, m1, config, remainingUsd: 50 });
  check("team chunked by LEAD_TEAM_CHUNK_SIZE", roomy.team_chunks.length === 2 && roomy.team_chunks[0]!.length === 10);

  console.log("[6] Exa runner: persist, retry, resume, abort");
  const fake = new FakeExa();
  setExaAgentApiForTesting(fake);
  await batchControl.init("b-runner", store, 100);
  const base = { config, store, batchId: "b-runner", refresh: false };
  const r1 = await runExaModule({ ...base, rowId: "row-1", module: LEAD_MODULES.M0, ctx: { row: acme } });
  check("success + run_id persisted before polling", r1.status === "success" && fake.runIdPersistedBeforePoll);
  const r1b = await runExaModule({ ...base, rowId: "row-1", module: LEAD_MODULES.M0, ctx: { row: acme } });
  check("cache hit: no new run, no cost", r1b.fromCache && fake.creates.length === 1 && r1b.newCostUsd === 0);

  fake.createErrors.push(new ExaError("rate", 429), new ExaError("overloaded", 503));
  const r2 = await runExaModule({ ...base, rowId: "row-2", module: LEAD_MODULES.M0, ctx: { row: acme } });
  check("429 + 503 retried with backoff", r2.status === "success" && fake.creates.length === 2);

  fake.mode = (mod) => (mod === "M2" ? "fail" : "ok");
  const r3 = await runExaModule({ ...base, rowId: "row-3", module: LEAD_MODULES.M2, ctx: { row: acme } });
  check("failed run retried once, then module failed", r3.status === "failed" && r3.runIds.length === 2);
  fake.mode = () => "ok";

  // Resume: a run_id stored in "running" state is polled, never re-created.
  const resumeRun = await fake.create({ query: "x", metadata: { module: "M3" } });
  const { params: p3, inputHash: h3 } = buildModuleRequest(LEAD_MODULES.M3, { row: acme }, config);
  const key3 = moduleCacheKey("row-4", "M3", LEAD_MODULES.M3.schemaVersion, h3);
  fake.runs.get(resumeRun.id)!.params = { ...p3, metadata: { module: "M3", cacheKey: key3 } };
  const now = new Date().toISOString();
  await store.saveModuleRun({
    cache_key: key3, batch_id: "b-runner", row_id: "row-4", module_id: "M3", schema_version: LEAD_MODULES.M3.schemaVersion,
    input_hash: h3, state: "running", module_status: null, run_id: resumeRun.id, attempt_id: "a1",
    attempts: [{ attempt: 1, attempt_id: "a1", run_id: resumeRun.id, status: "running", error: null, cost_usd: 0, created_at: now, finished_at: null }],
    request_summary: { effort: "medium", budget_usd: null, query_preview: "" }, structured: null, grounding: null, text: null,
    stop_reason: null, cost_usd: 0, cost_breakdown: null, usage: null, error: null, started_at: now, finished_at: null,
    latency_ms: null, created_at: now, updated_at: now,
  });
  const createsBefore = fake.creates.length;
  const r4 = await runExaModule({ ...base, rowId: "row-4", module: LEAD_MODULES.M3, ctx: { row: acme } });
  check("resume by stored run_id (no new run)", r4.status === "success" && fake.creates.length === createsBefore && r4.runIds[0] === resumeRun.id);

  // Orphan: intent persisted ("creating") but run_id never saved -> adopted via metadata.
  const { inputHash: h0 } = buildModuleRequest(LEAD_MODULES.M0, { row: acme }, config);
  const key0 = moduleCacheKey("row-5", "M0", LEAD_MODULES.M0.schemaVersion, h0);
  const orphan = await fake.create({ query: "x", metadata: { module: "M0", cacheKey: key0, attemptId: "att-9" } });
  fake.runs.get(orphan.id)!.params = { ...buildModuleRequest(LEAD_MODULES.M0, { row: acme }, config).params, metadata: { module: "M0", cacheKey: key0, attemptId: "att-9" } };
  await store.saveModuleRun({
    ...(await store.getModuleRun(key3))!, cache_key: key0, row_id: "row-5", module_id: "M0", input_hash: h0,
    schema_version: LEAD_MODULES.M0.schemaVersion, state: "creating", run_id: null, attempt_id: "att-9",
    attempts: [{ attempt: 1, attempt_id: "att-9", run_id: null, status: "creating", error: null, cost_usd: 0, created_at: now, finished_at: null }],
    structured: null, grounding: null, cost_usd: 0,
  });
  const createsBefore2 = fake.creates.length;
  const r5 = await runExaModule({ ...base, rowId: "row-5", module: LEAD_MODULES.M0, ctx: { row: acme } });
  check("orphan run adopted after crash between create and persist", r5.status === "success" && fake.creates.length === createsBefore2 && r5.runIds[0] === orphan.id);

  // Timeout keeps run_id; the next call resumes it.
  fake.mode = (mod) => (mod === "M1" ? "hang" : "ok");
  const r6 = await runExaModule({ ...base, rowId: "row-6", module: LEAD_MODULES.M1, ctx: { row: acme } });
  const stored6 = await store.getModuleRun(r6.cacheKey);
  check("timeout -> failed but resumable (run_id kept)", r6.status === "failed" && stored6?.state === "timed_out" && !!stored6.run_id);
  const hung = fake.runs.get(stored6!.run_id!)!;
  hung.mode = "ok";
  const createsBefore3 = fake.creates.length;
  const r6b = await runExaModule({ ...base, rowId: "row-6", module: LEAD_MODULES.M1, ctx: { row: acme } });
  check("timed-out run collected on re-run without paying again", r6b.status === "success" && fake.creates.length === createsBefore3);
  fake.mode = () => "ok";

  // Refresh that fails keeps the previous good result.
  fake.mode = () => "fail";
  const r7 = await runExaModule({ ...base, refresh: true, rowId: "row-1", module: LEAD_MODULES.M0, ctx: { row: acme } });
  const stored7 = await store.getModuleRun(r7.cacheKey);
  check("failed refresh never overwrites a completed result", r7.status === "success" && stored7?.state === "completed" && !!stored7.structured);
  fake.mode = () => "ok";

  // 402 aborts the batch; later modules are not_started and nothing new is created.
  fake.createErrors.push(new ExaError("No more credits", 402, undefined, "/agent/runs", { code: "NO_MORE_CREDITS" }));
  const r8 = await runExaModule({ ...base, rowId: "row-7", module: LEAD_MODULES.M2, ctx: { row: acme } });
  const createsBefore4 = fake.creates.length;
  const r9 = await runExaModule({ ...base, rowId: "row-8", module: LEAD_MODULES.M2, ctx: { row: acme } });
  check("402 stops the batch immediately", r8.status === "not_started" && batchControl.abortReason("b-runner") === "exa_no_credits");
  check("after abort: no new runs, row not_started", r9.status === "not_started" && fake.creates.length === createsBefore4);

  console.log("[7] end-to-end workflow (foreach + nested workflow, concurrency 2)");
  const fake2 = new FakeExa();
  setExaAgentApiForTesting(fake2);
  const csv1 = csvOf([
    `Acme,SaaS,Ops tool,Asha Rao,CEO,+91 90000 11111,asha.seed@acme.io,acme.io,Bengaluru,list.xlsx,2`,
    `Beta Labs,Fintech,,Ravi K,Founder,,,https://betalabs.in,,list.xlsx,3`,
    `Ghost Labs,,,,,,,,,list.xlsx,4`,
    `Gamma AI,AI,,,,,,gamma.ai,,list.xlsx,5`,
    `,missing name,,,,,,,,list.xlsx,6`,
  ]);
  const csvPath = path.join(TMP, "batch1.csv");
  fs.writeFileSync(csvPath, csv1);
  const res1 = await runBatch({ csvPath: "batch1.csv" });
  check("workflow succeeded", res1.status === "success", res1.status);
  const out1 = res1.status === "success" ? res1.result : null;
  const companies1 = out1 ? await store.listCompanies(out1.batchId) : [];
  const rows1 = out1 ? await store.listRows(out1.batchId) : [];
  check("R1: every accepted row reached a terminal state", rows1.length === 4 && rows1.every((r) => ["complete", "partial", "failed", "unresolved", "not_started"].includes(r.status)), rows1.map((r) => r.status).join(","));
  const byName = new Map(companies1.map((c) => [c.seed.company_name, c]));
  check("low identity confidence -> Unresolved, later modules skipped", byName.get("Ghost Labs")?.research_status === "unresolved" && byName.get("Ghost Labs")?.icp_status === "Unresolved" && ["M1", "M2", "M3", "M4", "M5"].every((id) => byName.get("Ghost Labs")?.module_statuses[id]?.status === "skipped" && byName.get("Ghost Labs")?.module_statuses[id]?.run_ids.length === 0));
  const acmeRec = byName.get("Acme");
  check("full research completes", acmeRec?.research_status === "complete", acmeRec?.research_status);
  check("verdict from rules (Qualified)", acmeRec?.icp_status === "Qualified", `${acmeRec?.icp_status} ${JSON.stringify(Object.fromEntries(Object.entries(acmeRec?.criteria ?? {}).map(([k, v]) => [k, v.result])))}`);
  check("zod-invalid Sarvam output retried", judgeCalls >= 4);
  check("Sarvam never saw emails/phones/profile URLs", !judgeSawContactData);
  const seedPerson = acmeRec?.people.find((p) => p.source_type === "seed_csv");
  check("seed contact kept verbatim (source_type seed_csv)", seedPerson?.emails[0]?.value === "asha.seed@acme.io" && seedPerson?.phones[0]?.value === "+91 90000 11111");
  check("seed vs researched mismatch flagged conflict", acmeRec?.contact_conflict === true);
  const allObserved = companies1.flatMap((c) => c.claims.filter((cl) => cl.epistemic === "observed"));
  check("zero observed claims without a real evidence ref", allObserved.length > 0 && allObserved.every((cl) => cl.evidence_refs.length > 0 && !cl.text.includes("Jira")));
  const exportDir = out1?.exportsDir ?? "";
  const files = ["companies.csv", "team.csv", "evidence.jsonl", "run_report.json", "run_report.md"];
  check("all exports written", files.every((f) => fs.existsSync(path.join(exportDir, f))));
  const companiesCsv = fs.existsSync(path.join(exportDir, "companies.csv")) ? fs.readFileSync(path.join(exportDir, "companies.csv"), "utf8") : "";
  check("companies.csv keeps seed values + ICP status", companiesCsv.includes("asha.seed@acme.io") && companiesCsv.includes("Qualified"));
  const report = exportDir ? JSON.parse(fs.readFileSync(path.join(exportDir, "run_report.json"), "utf8")) : {};
  check("run report: rejected row + zero unreferenced observed claims", report.input?.rejected_rows?.length === 1 && report.counts?.observed_claims_without_ref === 0);
  const createsRun1 = fake2.creates.length;
  const res1b = await runBatch({ csvPath: "batch1.csv" });
  check("re-running the same CSV costs nothing (all cached)", res1b.status === "success" && fake2.creates.length === createsRun1, `${fake2.creates.length - createsRun1} new runs`);

  console.log("[8] credits run out mid-batch, then resume");
  const fake3 = new FakeExa();
  fake3.creditsLeft = 7;
  setExaAgentApiForTesting(fake3);
  const csv2 = csvOf([
    `Delta,SaaS,,,,,,delta.io,,list2.xlsx,2`,
    `Epsilon,SaaS,,,,,,epsilon.io,,list2.xlsx,3`,
    `Zeta,SaaS,,,,,,zeta.io,,list2.xlsx,4`,
  ]);
  const res2 = await runBatch({ csvText: csv2, sourceName: "list2" });
  const out2 = res2.status === "success" ? res2.result : null;
  check("batch marked aborted (402), exports still written", out2?.status === "aborted" && out2.abortReason === "exa_no_credits" && !!out2.exportsDir);
  const rows2 = out2 ? await store.listRows(out2.batchId) : [];
  check("every row still terminal (partial / not_started)", rows2.length === 3 && rows2.every((r) => ["complete", "partial", "not_started"].includes(r.status)), rows2.map((r) => r.status).join(","));
  const completedKeys = new Set<string>();
  for (const r of rows2) for (const rec of await store.listModuleRunsForRow(r.row.row_id)) if (rec.state === "completed") completedKeys.add(rec.cache_key);
  const fake4 = new FakeExa();
  setExaAgentApiForTesting(fake4);
  const res3 = await runBatch({ csvText: csv2, sourceName: "list2" });
  const out3 = res3.status === "success" ? res3.result : null;
  const rows3 = out3 ? await store.listRows(out3.batchId) : [];
  check("resume completes the batch", out3?.status === "completed" && rows3.every((r) => r.status === "complete"), rows3.map((r) => r.status).join(","));
  check("already-paid research was NOT re-run", completedKeys.size > 0 && fake4.creates.every((c) => !completedKeys.has(c.cacheKey)), `${completedKeys.size} reused, ${fake4.creates.length} new`);

  console.log("[9] Sarvam output parsing + partial-output tolerance");
  check("extractJson strips code fences and prose", JSON.stringify(extractJson('Here you go:\n```json\n{"a":1,"b":{"c":2}}\n```')) === '{"a":1,"b":{"c":2}}');
  check("extractJson handles braces inside strings", JSON.stringify(extractJson('{"text":"a } b","n":1}')) === '{"text":"a } b","n":1}');
  check("truncated JSON -> undefined (triggers a retry, not a crash)", extractJson('{"criteria":{"x":') === undefined);
  // Real production shape: criteria present, optional fields omitted entirely.
  const partial = { criteria: { startup_tech_enabled: { result: "met", reason: "sw", evidence_refs: ["M0.description"] } }, triggers: [] };
  check("partial judgement (missing pain_track/claims/...) normalizes + validates", IcpJudgementSchema.safeParse(normalizeJudgement(partial)).success);
  const norm = normalizeJudgement(partial) as any;
  check("normalizer fills all 5 criteria + null optionals, invents nothing", Object.keys(norm.criteria).length === 5 && norm.criteria.early_stage.result === "unknown" && norm.pain_hypothesis === null && Array.isArray(norm.claims));

  console.log("[10] malformed input fails before any spend");
  const fake5 = new FakeExa();
  setExaAgentApiForTesting(fake5);
  const bad = await runBatch({ csvText: "name,website\nA,a.com\n" });
  check("CSV without company name column -> workflow fails, 0 Exa runs", bad.status === "failed" && fake5.creates.length === 0);
  const outside = await runBatch({ csvPath: "../../etc/passwd.csv" });
  check("csvPath outside LEAD_INPUT_DIR rejected", outside.status === "failed");
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    setExaAgentApiForTesting(null);
    setIcpJudgeForTesting(null);
    closeLeadDb();
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort (Windows file locks) */
    }
    console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll lead pipeline checks passed.");
    process.exit(failures ? 1 : 0);
  });
