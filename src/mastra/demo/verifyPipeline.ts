/**
 * End-to-end verification for the Industry Intelligence Aggregator.
 * Run with: npx -y tsx src/mastra/demo/verifyPipeline.ts
 * Covers: normalization, 3-level dedup, story clustering, relevance,
 * scoring math, failure isolation, and the full demo pipeline.
 */
import { getIndustryConfig } from "../config/industry.js";
import { collectFromSources } from "../collectors/index.js";
import { MOCK_RAW_ITEMS, MOCK_SOURCES } from "./mockData.js";
import { analyzeContent } from "../lib/analysis.js";
import { clusterIntoStories } from "../lib/clustering.js";
import { dedupePipeline } from "../lib/deduplicate.js";
import { computeOverallScore } from "../lib/scoring.js";
import { normalizeBatch, normalizeContent, normalizeUrl } from "../lib/normalize.js";
import { hardFilter, relevance01, semanticFilter } from "../lib/relevance.js";
import { applyOverrides, detectSignalClass, findContradictions, verifyStory } from "../lib/verify.js";
import { OPPORTUNITY_THRESHOLD_DEFAULT } from "../config/industry.js";
import { resetAllRepositories } from "../repositories/store.js";
import type { RawContent } from "../schemas/rawContent.js";

let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function htmlRaw(): RawContent {
  return {
    id: "t:html",
    sourceId: "rss:test",
    sourceName: "Test",
    sourceType: "rss",
    url: "https://example.com/a?utm_source=feed&fbclid=123&keep=1#frag",
    title: "<b>  Hello   World </b>",
    content:
      "<script>evil()</script><style>.x{}</style><p>Hello&nbsp;&amp;&nbsp;  world</p>",
    collectedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  await resetAllRepositories();
  const industry = getIndustryConfig("AI");

  console.log("[1] normalization");
  const n = normalizeContent(htmlRaw());
  check("strips tags/scripts/styles", !n.normalizedText.includes("<") && !n.normalizedText.includes("evil"));
  check("decodes entities + collapses whitespace", n.normalizedText === "Hello & world", `"${n.normalizedText}"`);
  check("strips tracking params, keeps legit ones", n.normalizedUrl === "https://example.com/a?keep=1", n.normalizedUrl);
  check("normalizes title", n.normalizedTitle === "Hello World", `"${n.normalizedTitle}"`);
  check("raw fields preserved", n.url.includes("utm_source") && n.content.includes("<script>"));
  void normalizeUrl;

  console.log("[2] deduplication (3 levels)");
  const normalized = normalizeBatch(MOCK_RAW_ITEMS);
  const deduped = dedupePipeline(normalized, 0.9);
  const urlDupe = deduped.groups.find((g) => g.reason === "url");
  const hashDupe = deduped.groups.find((g) => g.reason === "content-hash");
  check("same URL (tracking params ignored) -> url duplicate", !!urlDupe, JSON.stringify(deduped.stats));
  check("same content, different URL -> content-hash duplicate", !!hashDupe, JSON.stringify(deduped.stats));
  check("stats consistent", deduped.stats.input === 14 && deduped.stats.unique === deduped.unique.length);

  console.log("[3] relevance");
  const byId = new Map(normalized.map((x) => [x.id, x]));
  const sports = analyzeContent(byId.get("mock-g1")!, industry);
  const aiNews = analyzeContent(byId.get("mock-a2")!, industry);
  check("AI article is relevant", aiNews.relevance >= 7, `relevance=${aiNews.relevance}`);
  check("sports article is irrelevant", sports.relevance <= 2, `relevance=${sports.relevance}`);
  check("classification works", analyzeContent(byId.get("mock-d1")!, industry).classification === "funding");
  check("tutorial classified", analyzeContent(byId.get("mock-f1")!, industry).classification === "tutorial");

  console.log("[4] scoring math");
  const overall = computeOverallScore({
    relevance: 10, novelty: 10, impact: 10, velocity: 10,
    authority: 10, audienceInterest: 10, contentPotential: 10,
  });
  check("perfect inputs -> 100", overall === 100, `got ${overall}`);
  const zero = computeOverallScore({
    relevance: 0, novelty: 0, impact: 0, velocity: 0,
    authority: 0, audienceInterest: 0, contentPotential: 0,
  });
  check("zero inputs -> 0", zero === 0, `got ${zero}`);

  console.log("[5] failure isolation");
  const results = await collectFromSources([
    { id: "rss:broken", name: "Broken feed", type: "rss", url: "https://invalid.invalid/feed.xml", authorityScore: 10, active: true },
    { id: "x:ai-creators", name: "X stub", type: "social", authorityScore: 55, active: true },
  ]);
  check("both sources return results (no throw)", results.length === 2);
  check("failed sources record errors", results.every((r) => r.error && r.items.length === 0), JSON.stringify(results));

  console.log("[6] full demo pipeline");
  const analyses = new Map(
    deduped.unique.map((item) => [item.id, analyzeContent(item, industry)]),
  );
  const stories = clusterIntoStories({
    items: deduped.unique,
    analyses,
    sourcesById: new Map(MOCK_SOURCES.map((s) => [s.id, s])),
    duplicateGroups: deduped.groups,
    industry,
  });
  const gpt6 = stories.filter((s) => s.contentIds.includes("mock-a1"));
  check("GPT-6 coverage clustered into ONE story", gpt6.length === 1, `found ${gpt6.length}`);
  if (gpt6[0]) {
    const ids = gpt6[0].contentIds;
    check(
      "story keeps all supporting content incl. dupes",
      ["mock-a1", "mock-a2", "mock-a2b", "mock-a3", "mock-a5"].every((id) => ids.includes(id)),
      ids.join(","),
    );
    check("story preserves source URLs", gpt6[0].sources.length >= 3, gpt6[0].sources.join(","));
    check("story has overall score", gpt6[0].scores.overall >= 60, `overall=${gpt6[0].scores.overall}`);
  }
  const mistral = stories.filter((s) => s.contentIds.includes("mock-d1"));
  check("Mistral funding news+blog -> one story", mistral.length === 1 && mistral[0]!.contentIds.includes("mock-d2"));
  const sportsStories = stories.filter((s) => s.contentIds.includes("mock-g1"));
  check("sports item stays its own low-signal story", sportsStories.length === 1 && (sportsStories[0]?.scores.overall ?? 100) < 60);
  check("no fabricated sources", stories.every((s) => s.sources.every((u) => u.startsWith("http"))));

  console.log("[7] radar funnel (hard filter -> semantic gate -> verify)");
  check("opportunity threshold is 70", OPPORTUNITY_THRESHOLD_DEFAULT === 70);
  const sourcesById = new Map(MOCK_SOURCES.map((s) => [s.id, s]));
  const hf = hardFilter(normalized, { maxAgeHours: 168, industry, sourcesById });
  const staleIds = hf.discarded.filter((d) => d.reason.startsWith("stale")).map((d) => d.id);
  const offTopicIds = hf.discarded.filter((d) => d.reason.startsWith("off-topic")).map((d) => d.id);
  check("stale tutorial discarded by hard filter", staleIds.includes("mock-f1"), staleIds.join(","));
  check("sports item discarded as off-topic", offTopicIds.includes("mock-g1"), offTopicIds.join(","));
  check("AI items survive hard filter", hf.kept.some((i) => i.id === "mock-a1"));
  const relSports = relevance01(byId.get("mock-g1")!, industry);
  const relAi = relevance01(byId.get("mock-a2")!, industry);
  check("sports relevance below 0.65 gate", relSports.score < 0.65, `score=${relSports.score}`);
  check("AI relevance above 0.65 gate", relAi.score >= 0.65, `score=${relAi.score}`);
  const sf = semanticFilter(hf.kept, industry, 0.65);
  check("semantic gate drops sports remnants", !sf.kept.some((i) => i.id === "mock-g1"));

  const gpt = stories.find((s) => s.contentIds.includes("mock-a1"))!;
  const gptMembers = gpt.contentIds.flatMap((id) => {
    const m = normalized.find((n) => n.id === id);
    return m ? [m] : [];
  });
  const evidence = verifyStory(gpt, gptMembers, analyses, sourcesById);
  check("primary source attached (official blog)", evidence.primarySource === "https://openai.com/blog/introducing-gpt-6", evidence.primarySource);
  check("verification status strong or better", evidence.verificationStatus === "verified" || evidence.verificationStatus === "strong", evidence.verificationStatus);
  check("no contradictions in consistent story", evidence.contradictions.length === 0);

  // Synthetic contradiction: same event, conflicting raise figures.
  const mkItem = (id: string, url: string, text: string) =>
    normalizeContent(
      {
        id, sourceId: "rss:techcrunch-ai", sourceName: "TechCrunch AI", sourceType: "rss",
        url, title: "Mistral funding news", content: text, collectedAt: new Date().toISOString(),
      },
      128,
    );
  const conflictMembers = [
    mkItem("t:c1", "https://example.com/a", "Mistral raises $500M in a funding round led by top investors for open source AI."),
    mkItem("t:c2", "https://example.com/b", "Mistral raises $600M in a funding round led by top investors for open source AI."),
  ];
  const conflicts = findContradictions(conflictMembers);
  check(
    "conflicting money figures flagged",
    conflicts.length === 1 && conflicts[0]!.values.includes("500M") && conflicts[0]!.values.includes("600M"),
    JSON.stringify(conflicts),
  );

  // Overrides: breaking+verified floors at 85; viral-without-evidence caps at 45.
  const fakeBase = { ...gpt, scores: { ...gpt.scores, overall: 72 } };
  const floored = applyOverrides(fakeBase, { ...evidence, verificationStatus: "verified" as const }, gptMembers, "breaking");
  check("breaking+verified floors at 85", floored.story.scores.overall === 85 && floored.floored);
  const viralMembers = [{ engagement: { likes: 50000, shares: 20000 } }];
  const viralStory = { ...gpt, scores: { ...gpt.scores, overall: 80 } };
  const viralEvidence = { supportingSources: [] as string[], socialSignals: ["https://x.com/a"], independentSources: 1, verificationStatus: "signal" as const, contradictions: [] };
  const capped = applyOverrides(viralStory, viralEvidence, viralMembers, "emerging");
  check("viral rumor without evidence capped at 45", capped.story.scores.overall === 45 && capped.capped);
  const sig = detectSignalClass(gpt, evidence, 4);
  check("fresh multi-source story with primary is breaking or better", sig === "breaking" || sig === "important", sig);

  console.log(
    `\nDone: ${stories.length} stories from ${deduped.stats.unique} unique items ` +
      `(${deduped.stats.urlDuplicates} url + ${deduped.stats.hashDuplicates} hash + ${deduped.stats.semanticDuplicates} semantic dupes).`,
  );
  for (const s of [...stories].sort((a, b) => b.scores.overall - a.scores.overall)) {
    console.log(`  - [${s.scores.overall}] ${s.title} (${s.contentIds.length} items, ${s.sources.length} sources)`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
