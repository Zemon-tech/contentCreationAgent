/**
 * One-off: build + publish a single RAS Instagram post for a user-supplied
 * headline, reusing the EXACT autoNewsToRas tail (no ingest / no rank / no
 * scrape — the headline is given). Pipeline:
 *
 *   minimal Story -> buildFactPack -> sourceImage (Exa image search, RAS needs
 *   a hero) -> writeEditorialCopy (Sarvam, Exa-enriched) -> buildRasPayload ->
 *   publishPreflight -> renderRasPost -> runHandoff(dryRun=false, approved=true)
 *
 * Live publish. Requires: Mastra dev server up + cloudflared tunnel
 * (PUBLIC_BASE_URL) pointed at it so Instagram can fetch /ras-publish/<slug>/01.jpg.
 *
 * Run: npx -y tsx --env-file=.env src/mastra/demo/malaysiaChipsPublish.ts
 */

import type { Story } from "../schemas/story";
import type { RankInputItem } from "../schemas/ranking";
import { buildFactPack } from "../lib/fact-pack";
import { sourceImage } from "../lib/image/sourcing";
import { writeEditorialCopy } from "../lib/ras/copywriter";
import { buildRasPayload } from "../lib/ras/payload";
import { publishPreflight } from "../lib/ras/preflight";
import { renderRasPost, runHandoff } from "../lib/ras/handoff";
import { checkInstagramConnection } from "../lib/instagram-client";
import { canonicalKeyForItem } from "../lib/safety/ledger-key";

// ---- The story (user-provided headline; nothing invented beyond it) ----
const HEADLINE = "Malaysia seizes $12.1M of AI chips at Kuala Lumpur airport";
const SUMMARY =
  "Malaysian authorities seized AI chips worth an estimated $12.1 million at " +
  "Kuala Lumpur International Airport, part of a crackdown on the illicit " +
  "movement of advanced semiconductors through the country.";
const STORY_ID = "malaysia-ai-chips-kul-seizure";
const SOURCE_URL = ""; // none supplied; copywriter Exa-enriches + attributes.
// User-supplied hero image. Passed as a feed candidate so it runs through the
// SAME downloadAndValidate gate the workflow uses (size / dimensions / aspect).
const HERO_IMAGE_URL = "https://media.thenextweb.com/2026/10/circuit-board-processor-chip-macro.jpg";

async function main() {
  const live = String(process.env.INSTAGRAM_DRY_RUN).toLowerCase();
  console.log(`\n=== Malaysia AI chips -> Instagram (INSTAGRAM_DRY_RUN=${live}) ===\n`);

  // 0) IG connectivity (fail fast with a clear message).
  const conn = await checkInstagramConnection();
  console.log(
    `[ig] connected=${conn.connected} account=@${conn.username ?? "?"} (${conn.accountId ?? "?"}) ` +
      `dryRun=${conn.dryRun}${conn.error ? ` error=${conn.error}` : ""}`,
  );
  if (!conn.connected) throw new Error(`Instagram not reachable: ${conn.error ?? "unknown"}`);

  // 1) Minimal Story -> fact pack (pure extraction; limited=true since we only
  //    have headline + summary, so no detail is invented).
  const story: Story = {
    id: STORY_ID,
    title: HEADLINE,
    summary: SUMMARY,
    whatHappened: SUMMARY,
    whyItMatters: "",
    topics: ["AI", "chips", "semiconductors"],
    entities: ["Malaysia", "Kuala Lumpur International Airport"],
    sources: SOURCE_URL ? [SOURCE_URL] : [],
    contentIds: [STORY_ID],
    firstSeenAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    status: "stable",
    scores: { relevance: 0, novelty: 0, impact: 0, velocity: 0, authority: 0, audienceInterest: 0, contentPotential: 0, overall: 80 },
    confidence: 0.5,
    possibleAngles: ["Why it matters"],
  };
  const factPack = buildFactPack(story, { limited: true, sourceUrls: SOURCE_URL ? [SOURCE_URL] : [] });
  console.log(`[factpack] keyFacts=${factPack.keyFacts.length} figures=${JSON.stringify(factPack.figures)} limited=${factPack.factPackLimited}`);

  // Rank item shape the payload builder expects.
  const item: RankInputItem = {
    id: STORY_ID,
    clusterId: STORY_ID,
    title: HEADLINE,
    summary: SUMMARY,
    url: SOURCE_URL,
    source: "user-provided",
    region: "GLOBAL",
    publishedAt: new Date().toISOString(),
    rawCategories: ["AI", "chips", "semiconductors"],
    clusterSourceCount: 1,
  };

  // 2) Hero image — RAS story template REQUIRES one. Exa image search on the
  //    headline (same as the workflow; no feed candidates since no scrape).
  console.log(`[image] validating user-supplied hero: ${HERO_IMAGE_URL}`);
  const image = await sourceImage({ headline: HEADLINE, feedCandidateUrls: [HERO_IMAGE_URL] });
  console.log(`[image] chosenFrom=${image.chosenFrom} localPath=${image.imageLocalPath ?? "(none)"} tried=${image.candidatesTried}`);
  if (!image.imageLocalPath) {
    throw new Error(
      "No hero image could be sourced for the headline (Exa image search returned nothing that passed validation). " +
        "RAS's story template requires a hero image, so the post cannot be rendered. Try again or supply an image URL.",
    );
  }

  // 3) Editorial copy — Sarvam LLM, Exa-enriched. Fails open to template copy.
  console.log(`[copy] writing editorial copy (Sarvam, Exa-enriched)...`);
  const { copy, path: copyPath, enrichedSourceUrls } = await writeEditorialCopy({ item, factPack });
  console.log(`[copy] path=${copyPath} enrichedSources=${enrichedSourceUrls.length}`);

  // 4) Assemble the RAS payload.
  const payload = buildRasPayload({
    item,
    factPack,
    image,
    suggestedCaptionAngle: "Why it matters",
    llmCopy: copy,
    extraSourceUrls: enrichedSourceUrls,
  });
  console.log(`\n[payload] serifHeadline: ${payload.serifHeadline}`);
  console.log(`[payload] deckLead: ${payload.deckLead}`);
  console.log(`[payload] deckHighlight: ${payload.deckHighlight}`);
  console.log(`[payload] deckTail: ${payload.deckTail}`);
  console.log(`[payload] hashtags: ${payload.hashtags.join(" ")}`);
  console.log(`[payload] caption:\n${payload.caption}\n`);

  // 5) Preflight — must pass for a live publish (token + public URL + env off).
  const pre = publishPreflight();
  if (!pre.ok) {
    throw new Error(
      `Live publishing is NOT configured: ${pre.missing.join("; ")}. ` +
        `The post was built but not published.`,
    );
  }
  console.log(`[preflight] ok — live publishing is configured.`);

  // 6) Render the graphic (PNG for preview + JPEG for Instagram).
  console.log(`[render] rendering RAS story graphic...`);
  const rendered = await renderRasPost(payload);
  console.log(`[render] filePath=${rendered.filePath}`);
  console.log(`[render] viewUrl=${rendered.viewUrls[0]}`);
  console.log(`[render] publishPath=${rendered.publishPaths[0]}`);

  // 7) Hand off to publish. dryRun=false + approved=true => real post. Reuse the
  //    already-rendered graphic so we don't render twice.
  console.log(`\n[handoff] publishing to Instagram...`);
  const result = await runHandoff({
    ledgerKey: canonicalKeyForItem(item),
    payload,
    storyId: STORY_ID,
    dryRun: false,
    approved: true,
    deps: { render: async () => rendered },
  });

  console.log(`\n=== RESULT ===`);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "posted") {
    console.log(`\n✅ POSTED. permalink=${result.permalink ?? "(not returned)"}`);
  } else {
    console.log(`\n⚠️  status=${result.status} reason=${result.reason ?? ""} error=${result.error ?? ""}`);
  }
}

main().catch((err) => {
  console.error(`\n❌ FAILED:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
