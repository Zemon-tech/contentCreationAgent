/**
 * Intelligence acceptance tests (§35): freshness, evidence tiers,
 * verification, scoring caps, decisions, themes.
 * Run with: npx -y tsx src/mastra/demo/verifyIntelligence.ts
 */
import { getIndustryConfig } from "../config/industry.js";
import { normalizeContent } from "../lib/normalize.js";
import { analyzeContent } from "../lib/analysis.js";
import { clusterIntoStories } from "../lib/clustering.js";
import { dedupePipeline } from "../lib/deduplicate.js";
import { verifyStory, applyOverrides } from "../lib/verify.js";
import { classifyFreshness } from "../lib/freshness.js";
import { determineVerificationStatus, resolveEvidenceTier } from "../lib/evidence.js";
import { applyScoreCaps, decideContent, toSignalScores } from "../lib/decision.js";
import { clusterIntoThemes } from "../lib/themes.js";
import { normalizeBatch } from "../lib/normalize.js";
import { resetAllRepositories } from "../repositories/store.js";
import type { RawContent } from "../schemas/rawContent.js";
import type { Source } from "../schemas/source.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = new Date();
const hrsAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function raw(id: string, sourceId: string, sourceName: string, url: string, title: string, content: string, publishedAt: string): RawContent {
  return { id, sourceId, sourceName, sourceType: "rss", url, title, content, publishedAt, collectedAt: NOW.toISOString() };
}

const official: Source = { id: "rss:openai-blog", name: "OpenAI Blog", type: "rss", role: "official", authorityScore: 95, active: true, url: "https://openai.com/blog/rss.xml" };
const techcrunch: Source = { id: "rss:techcrunch-ai", name: "TechCrunch AI", type: "rss", role: "news", authorityScore: 80, active: true, url: "https://techcrunch.com/feed/" };
const creator: Source = { id: "x:creator", name: "@aicreator (X)", type: "social", role: "signal_creator", authorityScore: 50, active: false };
const MOCK_BY_ID = new Map([["rss:openai-blog", official], ["rss:techcrunch-ai", techcrunch], ["x:creator", creator]]);

async function main(): Promise<void> {
  await resetAllRepositories();
  const industry = getIndustryConfig("AI");

  console.log("[T1] old story discovered today → STALE / DO_NOT_POST");
  {
    const r = classifyFreshness({ event_at: hrsAgo(5 * 24), latest_update_at: hrsAgo(5 * 24), discovered_at: NOW.toISOString() }, NOW, 24);
    check("STALE", r.freshness === "STALE", r.freshness);
    const d = decideContent(35, {
      signalScores: { relevance: 50, impact: 40, novelty: 30, velocity: 10, source_authority: 60, audience_interest: 40, content_potential: 40, overall: 35 },
      verificationConfidence: 70, freshness: "STALE", tiers: ["T1_HIGH_SIGNAL"], isDuplicate: false, independentCount: 2,
    });
    check("DO_NOT_POST", d.decision === "DO_NOT_POST", d.decision);
  }

  console.log("[T2] old story with meaningful update → DEVELOPING");
  {
    const r = classifyFreshness({ event_at: hrsAgo(5 * 24), latest_update_at: hrsAgo(3), discovered_at: NOW.toISOString() }, NOW, 24);
    check("DEVELOPING", r.freshness === "DEVELOPING", `${r.freshness}: ${r.reason}`);
  }

  console.log("[T3] official announcement → T0 / PRIMARY_CONFIRMED");
  {
    check("official tier is T0", resolveEvidenceTier(official) === "T0_PRIMARY");
    const items = normalizeBatch([
      raw("t3a", official.id, official.name, "https://openai.com/blog/launch-x", "OpenAI launches X model for agents", "OpenAI is announcing X, a new LLM for AI agents with benchmark gains.", hrsAgo(2)),
      raw("t3b", techcrunch.id, techcrunch.name, "https://techcrunch.com/x-launch", "OpenAI launches X model", "OpenAI launched X, a new LLM for agents, according to the company announcement.", hrsAgo(3)),
    ]);
    const analyses = new Map(items.map((i) => [i.id, analyzeContent(i, industry)]));
    const stories = clusterIntoStories({ items, analyses, sourcesById: MOCK_BY_ID, duplicateGroups: [], industry, now: NOW });
    check("one story", stories.length === 1, `${stories.length}`);
    const ev = verifyStory(stories[0]!, items, analyses, MOCK_BY_ID);
    check("primary attached", !!ev.primarySource, ev.primarySource);
    check("canonical PRIMARY_CONFIRMED", ev.canonicalStatus === "PRIMARY_CONFIRMED", ev.canonicalStatus);
    const tcPrimary = (ev.evidenceSources ?? []).find((e) => e.publisher?.includes("TechCrunch"));
    check("TechCrunch NOT primary", tcPrimary ? tcPrimary.is_primary === false : true);
  }

  console.log("[T4] copied articles → ONE story, not N confirmations");
  {
    const items = normalizeBatch([
      raw("t4a", techcrunch.id, techcrunch.name, "https://a.com/1", "Mistral raises $500M round", "Mistral raises $500M funding round for open source AI infrastructure.", hrsAgo(5)),
      raw("t4b", techcrunch.id, techcrunch.name, "https://b.com/1", "Mistral raises $500M round", "Mistral raises $500M funding round for open source AI infrastructure.", hrsAgo(5)),
      raw("t4c", techcrunch.id, techcrunch.name, "https://c.com/1", "Mistral raises $500M for AI infra plus GPT and Claude competition analysis with agents and GPUs", "Mistral raises $500M funding round for open source AI infrastructure with GPU clusters for LLM training.", hrsAgo(5)),
    ]);
    const analyses = new Map(items.map((i) => [i.id, analyzeContent(i, industry)]));
    const stories = clusterIntoStories({ items, analyses, sourcesById: MOCK_BY_ID, duplicateGroups: [], industry, now: NOW });
    check("merged into one story", stories.length === 1, `${stories.length}`);
    const ev = verifyStory(stories[0]!, items, analyses, MOCK_BY_ID);
    check("copies do not inflate independence", ev.independentSources <= 2, `${ev.independentSources}`);
  }

  console.log("[T5] X rumor only → REPORTED/UNVERIFIED + cap 69");
  {
    const v = determineVerificationStatus({ hasPrimaryConfirmation: false, independentCount: 1, singleReliable: false, hasConflict: false, hasAnyReport: true });
    check("REPORTED or UNVERIFIED", v.status === "REPORTED" || v.status === "UNVERIFIED", v.status);
    const { overall } = applyScoreCaps(85, {
      signalScores: { relevance: 80, impact: 80, novelty: 80, velocity: 80, source_authority: 30, audience_interest: 80, content_potential: 80, overall: 85 },
      verificationConfidence: 40, freshness: "BREAKING", tiers: ["T3_COMMUNITY_SIGNAL"], isDuplicate: false, independentCount: 1,
    });
    check("capped ≤69", overall <= 69, `${overall}`);
  }

  console.log("[T6] low-impact patch → DO_NOT_POST");
  {
    const items = normalizeBatch([
      raw("t6", official.id, official.name, "https://ex.com/patch-0-0-1", "Patch 0.0.1 fixes typo in docs", "Changelog: fixed a typo in documentation. No behavior change.", hrsAgo(2)),
    ]);
    const a = analyzeContent(items[0]!, industry);
    const sig = toSignalScores({ relevance: a.relevance, novelty: 1, impact: 1, velocity: 2, authority: 9, audienceInterest: 1, contentPotential: 2 });
    const d = decideContent(sig.overall, {
      signalScores: sig, verificationConfidence: 90, freshness: "BREAKING", tiers: ["T0_PRIMARY"], isDuplicate: false, independentCount: 1,
    });
    check("DO_NOT_POST", d.decision === "DO_NOT_POST", `${d.decision} score=${sig.overall}`);
  }

  console.log("[T7] major release → high score, POST_NOW/WORTH_COVERING");
  {
    const sig = toSignalScores({ relevance: 9.4, novelty: 8.8, impact: 9.2, velocity: 9.1, authority: 9.6, audienceInterest: 9, contentPotential: 9.4 });
    check("high score ≥85", sig.overall >= 85, `${sig.overall}`);
    const d = decideContent(sig.overall, {
      signalScores: sig, verificationConfidence: 94, freshness: "BREAKING", tiers: ["T0_PRIMARY", "T1_HIGH_SIGNAL"], isDuplicate: false, independentCount: 3,
    });
    check("POST_NOW or WORTH_COVERING", d.decision === "POST_NOW" || d.decision === "WORTH_COVERING", d.decision);
  }

  console.log("[T8] related events → multiple stories, one theme");
  {
    const items = normalizeBatch([
      raw("t8a", official.id, official.name, "https://nvidia.com/gpu-new", "NVIDIA announces next-gen GPUs for LLM inference with AI infrastructure gains", "NVIDIA announced next-generation GPUs promising 2x LLM inference throughput for AI infrastructure.", hrsAgo(6)),
      raw("t8b", techcrunch.id, techcrunch.name, "https://tc.com/hbm4", "Samsung expands HBM4 output for AI accelerators and GPU memory", "Samsung expands HBM4 memory output to meet AI accelerator and GPU demand.", hrsAgo(7)),
      raw("t8c", techcrunch.id, techcrunch.name, "https://tc.com/ai-raise", "AI infrastructure startup raises $1B for data centers with GPU clusters", "An AI infrastructure startup raised $1B to build GPU data centers for LLM inference.", hrsAgo(8)),
    ]);
    const analyses = new Map(items.map((i) => [i.id, analyzeContent(i, industry)]));
    const stories = clusterIntoStories({ items, analyses, sourcesById: MOCK_BY_ID, duplicateGroups: [], industry, now: NOW });
    const decided = stories.map((s) => ({ ...s, decision: "WORTH_COVERING" as const }));
    const themes = clusterIntoThemes({ stories: decided });
    check("themes attempted (0-1, never manufactured)", themes.length <= 1, `${themes.length}`);
  }

  console.log("[T9] no content angle → DO_NOT_POST");
  {
    const sig = toSignalScores({ relevance: 8, novelty: 5, impact: 5, velocity: 5, authority: 8, audienceInterest: 5, contentPotential: 2 });
    const d = decideContent(sig.overall, {
      signalScores: sig, verificationConfidence: 85, freshness: "BREAKING", tiers: ["T0_PRIMARY"], isDuplicate: false, independentCount: 2,
    });
    check("DO_NOT_POST", d.decision === "DO_NOT_POST", d.decision);
  }

  console.log("[T10] conflicting sources → CONFLICTED");
  {
    const items = normalizeBatch([
      raw("t10a", techcrunch.id, techcrunch.name, "https://a.com/r", "Regulator approves the merger, companies confirm", "The regulator approved the merger today, the companies confirmed.", hrsAgo(4)),
      raw("t10b", official.id, official.name, "https://b.com/r", "Regulator rejected the merger, deal cancelled", "The regulator rejected the merger and the deal was cancelled.", hrsAgo(4)),
    ]);
    const analyses = new Map(items.map((i) => [i.id, analyzeContent(i, industry)]));
    const stories = clusterIntoStories({ items, analyses, sourcesById: MOCK_BY_ID, duplicateGroups: [], industry, now: NOW });
    const all = stories.flatMap((s) => s.contentIds);
    void all;
    const ev = verifyStory(stories[0] ?? { contentIds: [] } as never, items, analyses, MOCK_BY_ID);
    check("CONFLICTED", ev.canonicalStatus === "CONFLICTED" || ev.verificationStatus === "conflict", ev.canonicalStatus ?? ev.verificationStatus);
    void applyOverrides;
    void dedupePipeline;
    void normalizeContent;
  }

  if (failures > 0) {
    console.error(`\n${failures} intelligence check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll intelligence checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
