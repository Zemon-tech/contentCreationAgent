/**
 * auto:dry — full DRY-RUN of the auto news -> RAS pipeline. Ingest -> rank ->
 * select -> fact pack -> image -> payload -> handoff(DRY_RUN). Nothing is
 * persisted or published. Shows the top 5 ranked stories, the chosen story, the
 * image chosen and why, and the exact payload that would go to RAS.
 *
 *   npx -y tsx --env-file=.env src/mastra/demo/autoNewsDryRun.ts
 *
 * Stage B uses a keyword HEURISTIC stand-in (no model) so this runs offline;
 * restore LOCAL_MODEL_* and the workflow uses the real Sarvam ranker.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import { collectRankSelect, prepareForHandoff } from "../lib/workflow/autoNewsToRas";
import { runHandoff } from "../lib/ras/handoff";
import { canonicalKeyForItem } from "../lib/safety/ledger-key";
import type { RankGenerate } from "../lib/ranking/llmScore";
import { offlineCopyStub, offlineCopyConfig } from "./offlineCopyStub";

const heuristic: RankGenerate = async (prompt) => {
  const arr = JSON.parse(prompt.slice(prompt.indexOf("[")));
  const scores = arr.map((it: { id: string; title: string; summary: string }) => {
    const t = `${it.title} ${it.summary}`.toLowerCase();
    const strong = /\braises?\b|\blaunch|\$\d|unveil|releases?\b|acquir|open-sources?/.test(t);
    const rumor = /\breport:|may be|sources say|could|rumou?r|reportedly/.test(t);
    const clickbait = /you won'?t believe|shocking|destroy/.test(t);
    const deeptech = /chip|semiconductor|space|robot|quantum|biotech|satellite/.test(t);
    return {
      id: it.id, topic: deeptech ? "deeptech" : /startup|funding|raises?/.test(t) ? "startups" : "ai",
      topicFit: /\bai\b|model|llm|openai|anthropic|nvidia|google/.test(t) || deeptech ? 8 : 5,
      significance: strong ? 7 : 4, audienceInterest: strong ? 7 : 4, visualPotential: deeptech ? 7 : 5,
      isOpinionOrRumor: rumor, isClickbait: clickbait, isDuplicateAngle: false, reason: "heuristic preview",
    };
  });
  return { text: JSON.stringify({ scores }), usage: { totalTokens: 0 } };
};

async function main(): Promise<void> {
  console.log("\n=== AUTO NEWS -> RAS : DRY RUN (nothing persisted or published) ===\n");
  const { rankResult, selected, feedCandidateUrls, selectedRaw, itemsConsidered } = await collectRankSelect({ rankGenerate: heuristic, persist: false, persistRankLog: false });

  console.log(`Items ingested & ranked: ${itemsConsidered} · dropped ${JSON.stringify(rankResult.droppedByReason)} · scored ${rankResult.scoredCount} · unscored ${rankResult.unscoredCount}`);
  console.log(`\n-- Top 5 ranked --`);
  for (const [i, r] of rankResult.ranked.slice(0, 5).entries()) {
    console.log(`${i + 1}. [${r.finalScore.toFixed(1)}] (${r.item.region}) ${r.item.title.slice(0, 72)}`);
    console.log(`      reason: ${r.reason}${r.appliedPenalties.length ? ` · penalties: ${r.appliedPenalties.join(",")}` : ""}`);
  }

  if (!selected) {
    console.log(`\nNo story cleared MIN_SCORE this run — "${rankResult.note ?? "no story worthy this run"}". Valid outcome; nothing to post.\n`);
    return;
  }

  console.log(`\n-- Chosen story --`);
  console.log(`  "${selected.item.title}"  [score ${selected.finalScore.toFixed(1)}, ${selected.item.region}]`);
  console.log(`  why: ${selected.reason}`);
  console.log(`  source: ${selected.item.url}`);

  const prepared = await prepareForHandoff({ item: selected.item, finalScore: selected.finalScore, raw: selectedRaw, feedCandidateUrls, copyGenerate: offlineCopyStub, copyConfig: offlineCopyConfig });

  console.log(`\n-- Image --`);
  console.log(`  from: ${prepared.image.chosenFrom} · tried: ${prepared.image.candidatesTried} · feed candidates offered: ${feedCandidateUrls.length}`);
  if (prepared.image.imageLocalPath) {
    console.log(`  localPath: ${prepared.image.imageLocalPath}`);
    console.log(`  source: ${prepared.image.imageSourceUrl} · attribution: ${prepared.image.imageAttribution} · rights: ${prepared.image.rightsStatus}${prepared.image.under1080 ? " · UNDER 1080 (flagged)" : ""}`);
  } else {
    console.log(`  TEXT-ONLY (no candidate passed validation: ${prepared.image.reason}). NB: RAS story template needs a hero — flagged.`);
  }

  console.log(`\n-- Safety gate --`);
  console.log(`  score >= MIN_SCORE: ${prepared.scoreOk} · caps: ${prepared.caps.ok ? "ok" : "BLOCKED — " + prepared.caps.reason} (posts 24h: ${prepared.caps.postsLast24h})`);

  console.log(`\n-- Payload that WOULD go to RAS --`);
  console.log(JSON.stringify({
    headline: prepared.payload.headline,
    region: prepared.payload.region,
    suggestedFormat: prepared.payload.suggestedFormat,
    serifHeadline: prepared.payload.serifHeadline,
    categoryTag: prepared.payload.categoryTag,
    deck: [prepared.payload.deckLead, prepared.payload.deckHighlight, prepared.payload.deckTail],
    accentColor: prepared.payload.accentColor,
    imageLocalPath: prepared.payload.imageLocalPath,
    imageAttribution: prepared.payload.imageAttribution,
    rightsStatus: prepared.payload.rightsStatus,
    caption: prepared.payload.caption,
    hashtags: prepared.payload.hashtags,
    sourceUrls: prepared.payload.sourceUrls,
    factPack: prepared.payload.factPack,
    factPackLimited: prepared.payload.factPackLimited,
  }, null, 2));

  // Handoff in DRY_RUN with no-op ledger (demo persists nothing).
  const res = await runHandoff({
    ledgerKey: canonicalKeyForItem(selected.item),
    payload: prepared.payload,
    storyId: selected.item.id,
    dryRun: true,
    approved: false,
    deps: { getRow: async () => undefined, record: async () => {} },
  });
  console.log(`\n-- Handoff --  status: ${res.status} (DRY_RUN — render/publish NOT called)`);
  console.log(`\nStopping. No approval-mode / real publish will run until you say so.\n`);
}

main().catch((err) => {
  console.error("auto:dry failed:", err);
  process.exit(1);
});
