/**
 * ras:render:test — exercise the REAL RAS render dep end-to-end, but with a
 * FAKE publish (nothing is posted, no credentials needed). Proves the render ->
 * viewUrls -> handoff control flow works on a real sourced image.
 *
 *   npx -y tsx --env-file=.env src/mastra/demo/rasRenderTest.ts
 *
 * It runs the true handoff with dryRun=false + approved=true so the default
 * render runs, but injects a fake publish that only logs what it WOULD send.
 * The real Instagram Graph API is never called.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { collectRankSelect, prepareForHandoff, feedCandidatesFor } from "../lib/workflow/autoNewsToRas";
import { runHandoff, defaultHandoffDeps } from "../lib/ras/handoff";
import { canonicalKeyForItem } from "../lib/safety/ledger-key";
import { getWorkspaceOutputRoot } from "../renderer/output";
import type { RankGenerate } from "../lib/ranking/llmScore";
import { offlineCopyStub, offlineCopyConfig } from "./offlineCopyStub";

const heuristic: RankGenerate = async (prompt) => {
  const arr = JSON.parse(prompt.slice(prompt.indexOf("[")));
  const scores = arr.map((it: { id: string; title: string; summary: string }) => {
    const t = `${it.title} ${it.summary}`.toLowerCase();
    const strong = /\braises?\b|\blaunch|\$\d|unveil|releases?\b|acquir/.test(t);
    return { id: it.id, topic: "ai", topicFit: 8, significance: strong ? 7 : 4, audienceInterest: strong ? 7 : 4, visualPotential: 7, isOpinionOrRumor: false, isClickbait: false, isDuplicateAngle: false, reason: "render-test" };
  });
  return { text: JSON.stringify({ scores }), usage: { totalTokens: 0 } };
};

async function main(): Promise<void> {
  console.log("\n=== RAS RENDER TEST (real render, FAKE publish — nothing posted) ===\n");
  const { rankResult, rawById } = await collectRankSelect({ rankGenerate: heuristic, persist: false, persistRankLog: false });

  // Find the first ranked story that yields a usable image, so render runs.
  let pick = null as (typeof rankResult.ranked)[number] | null;
  let prepared = null as Awaited<ReturnType<typeof prepareForHandoff>> | null;
  let scanned = 0;
  for (const r of rankResult.ranked.slice(0, 15)) {
    scanned++;
    const raw = rawById.get(r.item.id) ?? null;
    const p = await prepareForHandoff({ item: r.item, finalScore: r.finalScore, raw, feedCandidateUrls: feedCandidatesFor(raw), copyGenerate: offlineCopyStub, copyConfig: offlineCopyConfig });
    if (p.image.imageLocalPath) { pick = r; prepared = p; break; }
  }
  if (!pick || !prepared) {
    console.log(`Scanned ${scanned} top stories — none had a usable image (Exa is disabled without EXA_API_KEY, and these feeds carry no media). Can't exercise render on an image.`);
    console.log(`Restore EXA_API_KEY for the image fallback, or test with a feed that ships media:content (e.g. Entrackr).`);
    return;
  }

  console.log(`Story:  ${pick.item.title}`);
  console.log(`Image:  ${prepared.image.imageLocalPath} [${prepared.image.chosenFrom}]`);

  // --publish-dry exercises the REAL publish wiring (URL mapping + Graph-API
  // URL validation) but REFUSES unless INSTAGRAM_DRY_RUN is true, so nothing is
  // ever posted from this harness. A real post only happens via the normal
  // auto:radar flow with approval.
  const publishDry = process.argv.includes("--publish-dry");
  const igDryRun = /^(1|true|yes|on)$/i.test(process.env.INSTAGRAM_DRY_RUN?.trim() || "");
  if (publishDry && !igDryRun) {
    console.log("Refusing --publish-dry: set INSTAGRAM_DRY_RUN=true first. This harness never does a real post.");
    return;
  }

  let publishCalled = false;
  let capturedViewUrl = "";
  const res = await runHandoff({
    ledgerKey: canonicalKeyForItem(pick.item),
    payload: prepared.payload,
    storyId: pick.item.id,
    dryRun: false,
    approved: true,
    deps: {
      // Real render (default) always runs. Publish is FAKE by default; with
      // --publish-dry it uses the REAL publish dep (which, under
      // INSTAGRAM_DRY_RUN=true, validates URLs then short-circuits — no post).
      publish: publishDry
        ? async (a) => { publishCalled = true; capturedViewUrl = a.viewUrls[0] ?? ""; console.log(`\n[REAL publish dep, IG dry-run] validating ${a.viewUrls.length} url(s)...`); return defaultHandoffDeps.publish(a); }
        : async (a) => {
            publishCalled = true;
            capturedViewUrl = a.viewUrls[0] ?? "";
            console.log(`\n[FAKE publish] would send ${a.viewUrls.length} image(s):`);
            for (const u of a.viewUrls) console.log(`   ${u}`);
            console.log(`[FAKE publish] caption: ${a.caption.slice(0, 120)}...`);
            return { published: true, mediaId: "FAKE_MEDIA_ID", permalink: "https://instagram.com/p/FAKE" };
          },
      getRow: async () => undefined,
      record: async () => {}, // don't pollute the real ledger
    },
  });

  console.log(`\nHandoff status: ${res.status} · fake publish called: ${publishCalled}`);

  // Verify the EXACT PNG this render produced (from the captured publish/view URL).
  // Render hands back a publish path (/ras-publish/<slug>/01.jpg) or a view URL
  // (/ras-assets/<slug>/01.png); normalize either to the on-disk PNG sibling.
  const pathname = (() => { try { return new URL(capturedViewUrl).pathname; } catch { return capturedViewUrl; } })();
  const rel = pathname.replace(/^\/(ras-assets|ras-publish)\//, "").replace(/\.jpe?g$/i, ".png");
  const pngPath = path.join(getWorkspaceOutputRoot(), "ras", rel);
  if (fs.existsSync(pngPath)) {
    const meta = await sharp(pngPath).metadata();
    const bytes = fs.statSync(pngPath).size;
    console.log(`\nRendered PNG: ${pngPath}`);
    console.log(`  ${meta.width}x${meta.height} · ${meta.format} · ${(bytes / 1024).toFixed(0)} KB`);
    console.log(meta.width === 1080 && meta.height === 1350 ? "  ✅ correct 1080x1350 RAS canvas" : "  ⚠️ unexpected dimensions");
  } else {
    console.log(`\n⚠️ Could not locate rendered file at ${pngPath}`);
  }
  console.log(`\nNo Instagram post was created. To exercise a REAL publish, see the steps in chat.\n`);
}

main().catch((err) => {
  console.error("ras:render:test failed:", err);
  process.exit(1);
});
