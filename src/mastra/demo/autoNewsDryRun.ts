/**
 * auto:dry — full DRY-RUN of the auto news -> RAS pipeline. Ingest -> rank ->
 * select -> fact pack -> image -> payload -> handoff(DRY_RUN). Nothing is
 * persisted or published. Shows the top 5 ranked stories, the chosen story, the
 * image chosen and why, and the exact payload that would go to RAS.
 *
 *   npx -y tsx --env-file=.env src/mastra/demo/autoNewsDryRun.ts
 *   npx -y tsx --env-file=.env src/mastra/demo/autoNewsDryRun.ts --mock-x   # inject synthetic saved X posts (offline)
 *
 * Stage B uses a keyword HEURISTIC stand-in (no model) so this runs offline;
 * restore LOCAL_MODEL_* and the workflow uses the real Sarvam ranker.
 *
 * The X signal is still governed by the SINGLE switch X_DISCOVERY_ENABLED:
 *   - X_DISCOVERY_ENABLED=false  -> feed-only (collectXPosts reads nothing);
 *   - --mock-x (and enabled)     -> reads a stub SavedXPostsGateway seeded here,
 *                                   so the mock-X path runs fully offline.
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
import { createSavedXPostsStubGateway, type SavedXPostsGateway } from "../lib/x-discovery/stores/savedXPosts";
import { postToRaw } from "../lib/collect-x-posts";
import type { ScrapedXPost } from "../lib/x-publisher";

const MOCK_X = process.argv.includes("--mock-x");

/**
 * Seed a stub SavedXPostsGateway with synthetic, clearly-fictional X posts so
 * the mock-X path exercises the X-signal merge fully offline. Returns undefined
 * unless --mock-x is passed (feed-only otherwise).
 */
function buildMockSavedPosts(): SavedXPostsGateway | undefined {
  if (!MOCK_X) return undefined;
  const now = new Date();
  const mk = (handle: string, n: number, likes: number): ScrapedXPost => ({
    text: `Synthetic X post #${n} from @${handle}: fictional "Nimbus Robotics" ships a demo widget. Offline mock content only. https://nimbus-robotics.example/${handle}/${n}`,
    url: `https://x.com/${handle}/status/${2000 + n}`,
    author_handle: handle,
    at: now.toISOString(),
    is_reply: false,
    is_repost: false,
    replies: 4,
    reposts: Math.round(likes / 10),
    likes,
    views: likes * 25,
    dom_index: n,
    outbound_urls: [`https://nimbus-robotics.example/${handle}/${n}`],
    text_truncated: false,
    quoted: null,
    thread_texts: [],
  });
  const raws = [
    postToRaw("nimbus_labs", mk("nimbus_labs", 1, 420), { accountMedianLikes: 200, accountStatus: "promoted", accountCredibilityScore: 8, isOfficialAccount: true }),
    postToRaw("orbit_founder", mk("orbit_founder", 2, 260), { accountMedianLikes: 150, accountStatus: "candidate" }),
  ].filter((r): r is NonNullable<typeof r> => r !== null);
  for (const r of raws) r.collectedAt = now.toISOString();
  return createSavedXPostsStubGateway(raws);
}

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
      isOpinionOrRumor: rumor, isClickbait: clickbait, isDuplicateAngle: false,
      // The 8 quality-first LlmScore fields (FEAT-003 schema) so items validate.
      isNewInformation: !rumor,
      isPrimarySource: strong,
      specificity: strong ? 7 : 4,
      hookPotential: strong ? 7 : 4,
      claimRisk: rumor ? "medium" : "low",
      flags: { engagementBait: clickbait, selfPromotion: false, giveaway: false, hotTakeThread: rumor },
      derivedHeadline: (it.title || "").slice(0, 200),
      headlineDerived: true,
      reason: "heuristic preview",
    };
  });
  return { text: JSON.stringify({ scores }), usage: { totalTokens: 0 } };
};

async function main(): Promise<void> {
  console.log(`\n=== AUTO NEWS -> RAS : DRY RUN (nothing persisted or published)${MOCK_X ? " [mock-X]" : ""} ===\n`);
  const mockSavedPosts = buildMockSavedPosts();
  const { rankResult, selected, feedCandidateUrls, selectedRaw, itemsConsidered } = await collectRankSelect({
    rankGenerate: heuristic,
    persist: false,
    persistRankLog: false,
    ...(mockSavedPosts ? { savedPosts: mockSavedPosts } : {}),
  });
  if (MOCK_X) {
    const xCount = rankResult.ranked.filter((r) => r.item.isX).length;
    console.log(`Mock-X path: ${xCount} X item(s) merged into the ranking (offline, from the stub store).`);
  }

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
