# KeilHQ ICP Research Agent — PRD v1

**Scope:** implements the *research + ICP qualification* slice of the KeilHQ Sales & Lead Generation PRD (§3, §6, §7, §15, §18). No outreach, no CRM push.
**Stack:** Mastra (workflows + Studio), Exa Agent API (research/contacts), Sarvam 105B (judgement only).

**Tags used below**
- **[LOCKED]** decided by the owner.
- **[PROPOSED]** default chosen to unblock development; owner may change.
- **[VERIFY]** unverified assumption; confirm in Phase 0 before relying on it.

**Instruction to the coding agent:** before writing code, read the existing Mastra content-research pipeline in this repo and follow its conventions (project layout, storage, env handling, logging, testing). Its details were not provided to the PRD author.

---

## 1. Goal

Given a CSV of startups, produce for each one: a verified company profile, founders and full team map, funding/revenue/hiring signals, tools and platforms in use, maximum public contact details, and an **ICP verdict with evidence**, with every claim labelled *observed / hypothesis / unknown* (KeilHQ PRD §7, §18).

**Non-goals (v1):** outreach drafting, sending messages, CRM sync, email verification, LinkedIn scraping outside Exa, guessing emails by pattern.

## 2. Locked decisions

| # | Decision |
|---|---|
| D1 | Exa Agent does all web research and contact finding. Sarvam 105B only judges (ICP verdict, hypotheses) from collected evidence, with no tools. **[LOCKED]** |
| D2 | Research is split into **focused topic modules**, several Exa runs per company. Never one giant Exa call. Quality must not be traded for speed. **[LOCKED]** |
| D3 | ICP team size is **5–50** (overrides the 10–50 in KeilHQ PRD §3; update that PRD). **[LOCKED]** |
| D4 | Collect **maximum** public contact details (emails, phones, LinkedIn/socials) for founders/leaders **and** team members. **[LOCKED]** |
| D5 | **Full team mapping** (who does what) is in scope. **[LOCKED]** |
| D6 | Paid Exa account; Sarvam used directly via its own API key. **[LOCKED]** |

## 3. Input

CSV columns **[LOCKED]**: `company name, sector, profile, contact person, designation, mobile, email, website, address, source file, source line`

- Trim/normalise headers; tolerate BOM, quoting, blank lines. Reject the file only if `company name` is missing entirely; otherwise skip and report bad rows.
- `row_id` = hash(`source file` + `source line`), falling back to hash(normalised name + domain). Used as the idempotency key everywhere.
- Normalise `website` to a bare domain; `website` may be blank or wrong, so identity is re-resolved (module M0).
- The CSV's `contact person / mobile / email` are **seed data**: keep them in separate fields with `source_type = seed_csv`. Never overwrite them with researched values. If researched data conflicts, keep both and flag `conflict = true`.
- Pass each row to Exa via `input.data` (not pasted into the query text).

## 4. Pipeline

```
CSV → parse/validate
        │
        ▼  foreach company (bounded concurrency, isolated failures)
   ┌────────────────────────────────────────────────────────┐
   │ Stage 0  M0 Identity & profile           (gate)        │
   │ Stage 1  M1 Founders & team   ┐                        │
   │          M2 Funding/revenue/  ├ parallel               │
   │             hiring signals    │                        │
   │          M3 Tools & platforms ┘                        │
   │ Stage 2  M4 Leader contacts   ┐ parallel, needs M1     │
   │          M5 Team contacts     ┘ (chunked)              │
   │ Stage 3  S1 Sarvam ICP analysis (no tools)             │
   │ Stage 4  Assemble + persist                            │
   └────────────────────────────────────────────────────────┘
        ▼
   aggregate → CSV/JSONL exports + run report
```

- Model per company as a **nested workflow** used inside `.foreach(step, { concurrency })` so each company is visible in Mastra Studio. **Do not use `suspend()` inside the loop** (a recent Mastra bug affects `foreach` over nested workflows when an iteration suspends). **[VERIFY]** concurrency works in the installed version with a smoke test; fallback: one step per company that orchestrates modules in code with `Promise.allSettled`.
- A company step **never throws**; it returns a terminal status (§10).
- If M0 confidence is low → `research_status = unresolved`, skip all later modules (saves cost).

## 5. Research modules (Exa Agent runs)

All modules: JSON `outputSchema` with `additionalProperties: false`, unverifiable fields **nullable and not required** (return `null`, never invent), bounded `maxItems`, and a `systemPrompt` restricting evidence to the specified company and stating that absence of evidence is `null`, not a guess. Do **not** duplicate citations/confidence in the schema; persist Exa's `output.grounding` untouched.

| ID | Module | Depends on | Effort **[PROPOSED]** | Returns |
|---|---|---|---|---|
| M0 | Identity & profile | none | `low` | Confirmed official domain, legal/brand name, description, HQ/city, founded year, sector, company LinkedIn URL, X/Instagram/YouTube/other socials, `identity_confidence` (+ reason) |
| M1 | Founders & team | M0 | `auto` + `budget.maxCostDollars` | Founders/leaders (name, title, LinkedIn URL); **team members** (name, title, function/department, LinkedIn URL); functional-team list; `team_size_estimate {low, high, basis, confidence}` |
| M2 | Funding, revenue & hiring | M0 | `medium` | Funding rounds (date, stage, amount, investors, source), revenue estimate `{value, currency, period, basis, confidence}` (null if no basis), open roles count and departments hiring, careers-page URL, recent hiring/launch/expansion/new-exec news with dates |
| M3 | Tools & platforms | M0 | `medium` | Each tool/platform: name, category, `evidence_type` (`stated_by_company` \| `job_post` \| `site_or_docs` \| `third_party` \| `inferred`), source. Also public complaints/signals about tooling, docs, meetings, coordination, onboarding (KeilHQ PRD §3, §6) |
| M4 | Leader contacts | M1 (+ seed contact) | `medium` | For founders, COO/Head of Ops/Chief of Staff/product leaders: emails, phones, LinkedIn, X, other public profiles. Each value: `type` (work/personal/generic; mobile/direct/company), `source_url` if available |
| M5 | Team contacts | M1 | `auto` + budget | Same fields as M4 for every M1 team member, **in chunks** (§5.1) |

- Variable-scope modules (M1, M5) use `auto` with an explicit budget; single-entity modules use fixed effort for predictable cost. **[VERIFY]** whether `budget.maxCostDollars` also caps contact-enrichment charges.
- Modules live in a **declarative registry** (id, schema, prompt, effort, depends-on, chunking) so they can be split/merged after Phase 0 without code changes.

### 5.1 Team-contact chunking
M5 takes M1's team list and processes it in chunks of **10 people per run [PROPOSED]**, runs in parallel, merged by person. Order and priority when the cap in §11 bites: leaders → product/tech/ops → rest.

## 6. Exa integration requirements

- Use the official `exa-js` SDK (a version with Agent support). Create run → **persist `run_id` immediately** → poll (~4 s) → persist terminal output, `output.grounding`, `costDollars`, latency.
- **Resumable:** on restart, any module with a stored `run_id` and no terminal state is resumed by polling that ID instead of re-creating the run.
- **Global limiter** wrapping run creation, shared across all companies. Exa allows 50 concurrent Agent runs per team; default `EXA_MAX_CONCURRENT_RUNS = 40` **[PROPOSED]**.
- Error handling: `429 CONCURRENCY_LIMIT_REACHED / RATE_LIMIT_EXCEEDED` and `503 SERVICE_OVERLOADED` → exponential backoff with jitter (honour `Retry-After`), max 5 attempts. `402 NO_MORE_CREDITS / TEAM_BUDGET_EXCEEDED` → **stop the batch immediately**, mark remaining rows `not_started`, keep completed work. Run `failed/cancelled` → retry once, then mark module `failed`.
- Per-module timeout (default 10 min **[PROPOSED]**); on timeout mark `failed`, continue.

## 7. Sarvam analysis step (S1)

- Model `sarvam/sarvam-105b` via Mastra's Sarvam provider, `SARVAM_API_KEY`. **No tools.**
- Constraints from Sarvam's docs: reasoning is on by default and reasoning tokens consume the completion budget (default `max_tokens` 2048), so use **low reasoning effort** and a high `max_tokens` (start 8192 **[PROPOSED]**), and request schema-constrained JSON (`response_format: json_schema`). **[VERIFY]** Mastra forwards `reasoning_effort`, `max_tokens`, `response_format` to Sarvam; if not, use a custom model config or a thin OpenAI-compatible client for this one step. **[VERIFY]** effective context (Sarvam docs say 128K; one third party lists 66K).
- **Input** = compact evidence JSON built in code: profile, team roles/functions/counts, funding, hiring, tools, signals, seed row. **Exclude phone numbers/emails** (data minimisation, fewer tokens).
- Validate output with zod; on failure retry ≤2 with the validation error appended; then set `analysis_status = failed` and still export all evidence.
- **Output schema:** ICP criteria results (§8), `triggers[]`, `pain_track` (`A_tool_sprawl` \| `B_operational_chaos` \| `none` \| `unknown`), `pain_hypothesis` (short text), `ops_summary` (who does what, from M1 only), and `claims[]` each `{text, epistemic: observed|hypothesis|unknown, evidence_refs[]}`.
- **Epistemic rule enforced in code, not just prompt:** an `observed` claim must have ≥1 `evidence_ref` pointing to a real module field that has an Exa source. Otherwise it is auto-downgraded to `hypothesis`. Sarvam may not add facts absent from the evidence.

## 8. ICP classification

Criteria, each `met | not_met | unknown` with evidence refs (from KeilHQ PRD §3 and §6):

1. `team_size` in 5–50 **[LOCKED]**: `met` if the estimate range lies inside 5–50, `borderline` if it overlaps, `not_met` if disjoint, `unknown` if null **[PROPOSED]**
2. Startup / product / tech-enabled
3. Multiple functional teams (from M1)
4. Stage plausibly pre-seed to early Seed / early revenue
5. Problem-fit signals present (PRD §6 list)
6. ≥1 current trigger (hiring surge, new leader, funding, launch, tool complaints)
7. Decision-maker identified (founder/COO/CoS/Head of Ops)

**Verdict** `icp_status ∈ {Qualified, Not qualified, Needs review, Unresolved}`. Rule lives in one config file. **[PROPOSED, confirm: OPEN-1]** `Qualified` = criterion 1 `met` AND ≥2 of criteria 3/5/6 `met` AND criterion 7 `met`; `Not qualified` = criterion 1 `not_met` (or criterion 2 `not_met`); everything else `Needs review`. Never qualify on company size alone (PRD §6).

## 9. Outputs

Persist everything in the project's storage **and** export per batch:

- `companies.csv`: one row per company. Columns follow KeilHQ PRD §15 where available (Company, Website, Founder/contact, Role, Location, Team size, Industry, Source, Trigger, Current stack, Pain hypothesis, ICP status), plus `row_id`, `research_status`, `identity_confidence`, funding/revenue/hiring summary, socials, company-level contacts, `cost_usd`. Outreach/discovery/pipeline columns exist but are left blank. Multi-values joined with ` | `.
- `team.csv`: one row per person: `row_id`, name, title, function, LinkedIn, emails, phones, `is_leader`, `source_type`, source URLs.
- `evidence.jsonl`: per company, per module: raw structured output, `output.grounding`, `run_id`, cost, timing, statuses.
- `run_report.json` + human summary: counts by status; per-field coverage % (founders, team size, funding, revenue, tools, email, phone); cost total and per company; latency p50/p95; failures with reasons.

## 10. Robustness requirements

- **R1** Every input row reaches a terminal state: `complete | partial | failed | unresolved | not_started`. No silent drops.
- **R2** One row/module failure never aborts the batch. Module statuses: `success | partial | failed | skipped`.
- **R3** Idempotent and resumable: results cached by (`row_id`, `module_id`, `schema_version`, `input_hash`). Re-run skips completed modules; `--refresh` forces recompute.
- **R4** Exa run IDs persisted before polling (§6).
- **R5** Structured logging per company/module with `row_id`, `run_id`, status, duration, cost. Use Mastra tracing.
- **R6** Secrets only from env. Never log full contact values.

## 11. Cost and speed controls

- Read `costDollars` from each Exa run; aggregate per company and per batch.
- Config (all required, no hidden defaults): `EXA_MAX_CONCURRENT_RUNS`, `COMPANY_CONCURRENCY`, `MAX_TEAM_CONTACTS_PER_COMPANY`, `MAX_COST_PER_COMPANY_USD`, `MAX_COST_PER_BATCH_USD`.
- Before Stage 2, compute worst-case contact cost from Exa's rates (email $0.02, phone $0.07 per contact found; **[VERIFY]** current rates) and, if it would exceed `MAX_COST_PER_COMPANY_USD`, reduce the number of team members contacted by the §5.1 priority order and record `contacts_truncated = true`.
- Speed comes from parallelism across companies and across independent modules, bounded by the global limiter, not from reducing research depth.

## 12. Privacy and data handling

- The output contains personal data (names, phones, emails) of founders and employees. Collect only what is publicly available or returned by Exa's enrichment; store `source_type` per value; no email-pattern guessing (guessed data would present a hypothesis as fact).
- Send personal contact data to no LLM. Sarvam gets none (§7).
- Retention and access: make the storage location and a delete-by-`row_id` command explicit. India's DPDP Rules' core obligations take effect in May 2027, and cold calling has separate telecom rules. **The owner should take legal advice before outreach use.** The PRD author is not a lawyer.

## 12b. Repo structure guidance

Follow existing repo conventions. Logical parts, as separate modules with unit tests: CSV parser/validator, module registry + schemas (zod/JSON Schema), Exa client (limiter, retry, resume), Sarvam client/step, epistemic validator, ICP rule engine, exporters, workflow definitions.

## 13. Phase 0 — benchmark before scaling

1. Owner supplies **10–15 companies with known ground truth** (founders, team size, funding, at least some real contacts), including small, obscure ones.
2. Run the full pipeline; measure per-field coverage and accuracy vs ground truth, cost per company, latency p50/p95, failure rate.
3. Resolve all **[VERIFY]** items: Mastra→Sarvam parameter forwarding; `foreach`+nested workflow; budget vs contact charges; Exa coverage of small Indian startups (funding, headcount, phones); how Mastra Studio accepts the CSV (pasted text vs file path).
4. Tune module effort levels, chunk size, and split/merge modules based on results.

**Acceptance criteria (v1)**
- R1–R6 hold in an injected-failure test (kill mid-batch, simulate 429/503/402, malformed CSV, unresolved company).
- Zero `observed` claims without an evidence ref in exports.
- Seed CSV values are never overwritten.
- Numeric targets for coverage, accuracy, cost and latency are **set by the owner after Phase 0** (no benchmarks exist yet).

## 14. Open decisions (defaults above are not owner-approved)

| ID | Question | Current default |
|---|---|---|
| OPEN-1 | Exact `Qualified` rule beyond team size (KeilHQ PRD says "most of the following") | §8 rule |
| OPEN-2 | Handling of unknown team size | `Needs review` |
| OPEN-3 | `MAX_TEAM_CONTACTS_PER_COMPANY`, per-company and per-batch cost caps, batch size, speed target | none, must be set |
| OPEN-4 | Output destination beyond CSV/JSONL (Sheets, Airtable, CRM) | CSV/JSONL + project storage |
| OPEN-5 | Mastra version, storage backend, structure of existing pipeline | coding agent inspects repo |
| OPEN-6 | Whether to label pattern-guessed emails (`inferred_pattern`) instead of excluding them | excluded |

## 15. References (verified during PRD research)

- Exa Agent: https://exa.ai/docs/agent/quickstart · https://exa.ai/docs/agent/best-practices
- Exa pricing / limits / errors: https://exa.ai/docs/admin/pricing · https://exa.ai/docs/admin/billing · https://exa.ai/docs/admin/error-codes
- Mastra × Sarvam: https://mastra.ai/models/providers/sarvam
- Mastra `foreach`: https://mastra.ai/reference/workflows/workflow-methods/foreach · known issue: https://github.com/mastra-ai/mastra/issues/25046
- Mastra structured output: https://mastra.ai/docs/agents/structured-output
- Sarvam chat API: https://docs.sarvam.ai/api-reference/chat/chat-completions