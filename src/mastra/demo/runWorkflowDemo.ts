/**
 * Executes the REAL industryAggregationWorkflow end-to-end (demo mode:
 * no network, no credentials) and asserts the acceptance criteria.
 * Run with: npx -y tsx src/mastra/demo/runWorkflowDemo.ts
 */
import { industryAggregationWorkflow } from "../workflows/industryAggregationWorkflow.js";
import { resetAllRepositories } from "../repositories/store.js";

async function main(): Promise<void> {
  await resetAllRepositories();
  const run = await industryAggregationWorkflow.createRun();
  const result = await run.start({
    inputData: {
      demoMode: true,
      minScore: 70,
      similarityThreshold: 0.9,
      maxItemsPerSource: 20,
      concurrency: 8,
      perSourceTimeoutMs: 20000,
      maxAgeHours: 168,
      relevanceThreshold: 0.65,
      // Mock data spans 3-80h; evaluate against the same 7-day window so
      // freshness reflects event time, not the default live 24h window.
      windowHours: 168,
      maxOpportunities: 5,
    },
  });

  if (result.status !== "success") {
    console.error("Workflow failed:", JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const out = result.result;
  console.log(`runId: ${out.runId} industry: ${out.industryName}`);
  console.log("stats:", JSON.stringify(out.stats, null, 2));
  if (out.errors.length > 0) console.log("errors:", out.errors);

  const failures: string[] = [];
  const expect = (name: string, cond: boolean) => {
    console.log(`  ${cond ? "PASS" : "FAIL"} ${name}`);
    if (!cond) failures.push(name);
  };

  expect("collected demo items", out.stats.collected === 14);
  expect("duplicates associated, not lost", out.stats.duplicatesAssociated === 2);
  expect("stories created from related content", out.stats.stories >= 5);
  expect(
    "every story keeps source attribution",
    out.stories.every((s) => s.sources.length > 0 && s.contentIds.length > 0),
  );
  expect(
    "stories carry full score breakdowns + overall",
    out.stories.every(
      (s) =>
        s.scores.overall >= 0 &&
        s.scores.overall <= 100 &&
        s.confidence >= 0 &&
        s.confidence <= 1 &&
        s.whyItMatters.length > 0,
    ),
  );
  expect("high-value opportunities produced", out.opportunities.length >= 2);
  expect(
    "opportunities explain selection + formats + angles",
    out.opportunities.every(
      (o) =>
        o.reason.length > 0 &&
        o.recommendedFormats.length > 0 &&
        o.recommendedAngles.length > 0 &&
        o.sources.length > 0,
    ),
  );
  expect(
    "opportunities reference real stories",
    out.opportunities.every((o) => out.stories.some((s) => s.id === o.storyId)),
  );
  expect("no fabricated sources", out.stories.every((s) => s.sources.every((u) => u.startsWith("http"))));

  console.log("\nOpportunities:");
  for (const o of out.opportunities) {
    const story = out.stories.find((s) => s.id === o.storyId)!;
    console.log(
      `  - [${o.priority}] ${story.title} (score ${story.scores.overall}) -> ${o.recommendedFormats.join(", ")}`,
    );
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} acceptance check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nWorkflow run verified end-to-end.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
