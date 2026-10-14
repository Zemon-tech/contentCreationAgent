/**
 * rank:preview — demonstrate the ingest -> rankStories path on the REAL
 * headlines in fixtures/ranking-golden.json, WITHOUT a live model.
 *
 * Stage B normally calls the configured scoring model; here we inject a simple
 * keyword HEURISTIC so the deterministic Stages A/C/D can be shown end-to-end
 * on real data. This is NOT the real ranker's judgement — it only proves the
 * wiring (and that rankStories, not the legacy opportunityStep, is the RAS-path
 * selector). Run `npm run rank:eval` with a real model for genuine scoring.
 *
 *   npx -y tsx src/mastra/demo/rankPreview.ts
 */

import { rankStories } from "../lib/ranking/rankStories";
import { createStubGateway } from "../lib/ranking/storage";
import { loadFixtures } from "../eval/fixtures";
import type { RankGenerate } from "../lib/ranking/llmScore";

const heuristic: RankGenerate = async (prompt) => {
  const arr = JSON.parse(prompt.slice(prompt.indexOf("[")));
  const scores = arr.map((it: { id: string; title: string; summary: string }) => {
    const t = `${it.title} ${it.summary}`.toLowerCase();
    const strong = /\braises?\b|\blaunch|\$\d|unveil|releases?\b|acquir|open-sources?/.test(t);
    const rumor = /\breport:|may be|sources say|could|rumou?r|reportedly/.test(t);
    const clickbait = /you won'?t believe|shocking|destroy|\bmind-?blow|insane/.test(t);
    const deeptech = /chip|semiconductor|space|robot|quantum|biotech|satellite/.test(t);
    const startups = /startup|funding|seed|series [a-e]\b|raises?/.test(t);
    return {
      id: it.id,
      topic: deeptech ? "deeptech" : startups ? "startups" : "ai",
      topicFit: /\bai\b|model|llm|openai|anthropic|google|nvidia/.test(t) || deeptech || startups ? 8 : 5,
      significance: strong ? 7 : 4,
      audienceInterest: strong ? 7 : 4,
      visualPotential: deeptech ? 7 : 5,
      isOpinionOrRumor: rumor,
      isClickbait: clickbait,
      isDuplicateAngle: false,
      reason: "heuristic preview score (not the real model)",
    };
  });
  return { text: JSON.stringify({ scores }), usage: { totalTokens: 0 } };
};

async function main(): Promise<void> {
  const now = new Date();
  const fixtures = loadFixtures(now);
  const res = await rankStories(
    fixtures.map((f) => f.item),
    { gateway: createStubGateway({ recentRegions: ["US", "US", "US"] }), generate: heuristic, persist: false, now, log: () => {} },
  );

  console.log(`\n=== rank:preview (heuristic Stage B — wiring demo only) ===`);
  console.log(`input ${res.inputCount} · dropped ${res.droppedCount} ${JSON.stringify(res.droppedByReason)} · ranked ${res.ranked.length}`);
  console.log(`\nTop 8 by final score:`);
  for (const [i, r] of res.ranked.slice(0, 8).entries()) {
    console.log(
      `${i + 1}. [${r.finalScore.toFixed(1)}] (${r.item.region}) ${r.item.title.slice(0, 70)}` +
        (r.appliedPenalties.length ? `  penalties:${r.appliedPenalties.join(",")}` : ""),
    );
  }
  console.log(`\nSelected (top ${res.selected.length}): ${res.selected.map((s) => s.item.title.slice(0, 60)).join(" | ") || "(none cleared MIN_SCORE)"}`);
  console.log(res.note ? `note: ${res.note}` : "");
}

main().catch((err) => {
  console.error("rank:preview failed:", err);
  process.exit(1);
});
