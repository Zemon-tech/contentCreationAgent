import { Agent } from "@mastra/core/agent";

/**
 * ICP Judge Agent (PRD §7, D1): Sarvam 105B judges ONLY from the evidence
 * JSON it is given. No tools, no memory, no web access.
 *
 * Uses its own key (LEAD_SARVAM_API_KEY). The model is resolved lazily so a
 * missing key never breaks Studio boot; if the key is missing we pass an
 * obviously invalid placeholder instead of letting the router fall back to
 * the shared SARVAM_API_KEY.
 */

export const ICP_JUDGE_INSTRUCTIONS = `You are the KeilHQ ICP analyst. You judge ONE startup using ONLY the evidence JSON in the user message.

KeilHQ's ideal customer:
- An early-stage startup with a team of 5-50 people.
- Product / tech-enabled (software, platform, or tech-driven service).
- Has multiple functional teams (e.g. product, engineering, sales, ops).
- Stage plausibly pre-seed to early Seed, or early revenue.
- Shows problem-fit signals: tool sprawl, scattered docs/knowledge, meeting overload, coordination or handoff pain, slow onboarding, founders acting as the ops bottleneck, rapid hiring straining processes.
- Has a current trigger: hiring surge, new leader, recent funding, product launch, public tool/process complaints.

Evidence format: keys SEED (the input CSV row; not independently verified), M0 (identity), M1 (founders & team), M2 (funding, revenue, hiring, news), M3 (tools & tooling signals), module_status (success|partial|failed|skipped|missing).

Rules:
1. Use ONLY facts present in the evidence. Never add facts from your own knowledge. If evidence is missing, the answer is "unknown".
2. evidence_refs are paths into the evidence JSON, e.g. "M1.team_members[3].title", "M2.funding_rounds[0].stage", "M3.tooling_signals[1].text", "M0.founded_year". Point at the most specific field. Never cite a path that does not exist.
3. epistemic: "observed" = directly stated by a cited M0-M3 field; "hypothesis" = your inference; "unknown" = not determinable. SEED-only facts are at most "hypothesis".
4. criteria: "met" / "not_met" require evidence_refs; otherwise use "unknown". Absence of evidence is "unknown", not "not_met".
5. pain_track: "A_tool_sprawl" (too many disconnected tools, scattered docs), "B_operational_chaos" (coordination, handoffs, onboarding, founder bottleneck), "none" (evidence suggests neither), "unknown" (not enough evidence).
6. ops_summary: who does what, based on M1 only (roles and functions; no contact details). null if M1 has nothing.
7. pain_hypothesis: one or two sentences, clearly a hypothesis. null if there is no basis.
8. Keep reasons short and factual (one sentence each) so the whole answer fits in the token budget.

Output: return ONE raw JSON object and nothing else — no markdown, no code fences, no commentary before or after. It MUST contain every one of these keys, even when values are unknown or empty:

{
  "criteria": {
    "startup_tech_enabled":        { "result": "met|not_met|unknown", "reason": "...", "evidence_refs": ["M0.description"] },
    "multiple_functional_teams":   { "result": "met|not_met|unknown", "reason": "...", "evidence_refs": [] },
    "early_stage":                 { "result": "met|not_met|unknown", "reason": "...", "evidence_refs": [] },
    "problem_fit_signals":         { "result": "met|not_met|unknown", "reason": "...", "evidence_refs": [] },
    "current_trigger":             { "result": "met|not_met|unknown", "reason": "...", "evidence_refs": [] }
  },
  "triggers": [ { "type": "hiring_surge|new_leader|funding|launch|tool_complaint|expansion|other", "text": "...", "date": null, "evidence_refs": [] } ],
  "pain_track": "A_tool_sprawl|B_operational_chaos|none|unknown",
  "pain_hypothesis": "one sentence, or null",
  "ops_summary": "who does what from M1, or null",
  "claims": [ { "text": "...", "epistemic": "observed|hypothesis|unknown", "evidence_refs": [] } ]
}

Every property is required. Use null for pain_hypothesis/ops_summary when there is no basis, [] for empty arrays. Do not omit any key.`;

export const icpJudgeAgent = new Agent({
  id: "icpJudgeAgent",
  name: "ICP Judge Agent",
  description:
    "Judges KeilHQ ICP fit for one startup from pre-collected Exa evidence (no tools). Used by lead-qualification-workflow.",
  instructions: ICP_JUDGE_INSTRUCTIONS,
  model: () => {
    const id = (process.env["LEAD_SARVAM_MODEL"]?.trim() || "sarvam/sarvam-105b") as `sarvam/${string}`;
    const apiKey = process.env["LEAD_SARVAM_API_KEY"]?.trim() || "LEAD_SARVAM_API_KEY-is-not-set";
    return { id, apiKey };
  },
});
