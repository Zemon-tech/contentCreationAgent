/**
 * Verification run for the RAS Satori render engine.
 *
 *   npx -y tsx src/mastra/demo/verifyRasDesign.ts
 *
 * Renders a single story and a 4-slide carousel with mock payloads using a
 * generated local hero image, then asserts every output is a 1080x1350 PNG.
 * No network, no Instagram — this only exercises the in-process renderer.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderRasStoryTool } from "../tools/ras-render-tools.js";
import { renderRasCarouselTool } from "../tools/ras-render-tools.js";
import { getPngDimensions } from "../renderer/images.js";

/** Minimal valid solid-color PNG (1x1) — Satori scales it to fill the frame. */
const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function run() {
  const tmpDir = path.resolve(process.cwd(), "workspace", "output", "ras", "_verify_tmp");
  mkdirSync(tmpDir, { recursive: true });
  const heroPath = path.join(tmpDir, "hero.png");
  writeFileSync(heroPath, Buffer.from(ONE_PX_PNG_BASE64, "base64"));

  const failures: string[] = [];

  function assertPng(label: string, filePath: string) {
    const { width, height } = getPngDimensions(filePath);
    const bytes = readFileSync(filePath).length;
    const ok = width === 1080 && height === 1350 && bytes > 1000;
    console.log(`  ${ok ? "OK " : "FAIL"}  ${label}  ${width}x${height}  ${bytes} bytes  ${filePath}`);
    if (!ok) failures.push(`${label}: expected 1080x1350 PNG, got ${width}x${height} (${bytes} bytes)`);
  }

  // --- Single story ---
  console.log("\n[1/2] Rendering single story post...");
  const story = await (renderRasStoryTool.execute as any)({
    slug: "verify-story",
    heroImage: heroPath,
    categoryTag: "AI · STARTUPS · FUNDING",
    serifHeadline: "Cal AI's 19-year-old founder just raised $10M for a wearable AI assistant.",
    deckLead: "Fresh off selling Cal AI to MyFitnessPal, Zach Yadegari is back with",
    deckHighlight: "Persona, a privacy-first AI agent on a $179 band,",
    deckTail: "betting your daily apps collapse into one super app.",
    accentColor: "#2F7C74",
  });
  if (!story.success) failures.push("story render returned success=false");
  for (const a of story.assets) assertPng(`story ${a.file}`, a.path);

  // --- Carousel (cover + 3 slides = 4 total) ---
  console.log("\n[2/2] Rendering 4-slide carousel...");
  const carousel = await (renderRasCarouselTool.execute as any)({
    deckSlug: "verify-carousel",
    accentColor: "#E2A72E",
    cover: {
      heroImage: heroPath,
      categoryTag: "FUNDING · AI",
      datelineKicker: "09 OCT 2026",
      serifHeadline: "The $100M bet on who deploys AI, not who builds it.",
      deckLead: "A new kind of moat is forming around",
      deckHighlight: "deployment capability.",
    },
    slides: [
      {
        type: "body",
        badge: "THE SHIFT",
        title: "From model access to deployment muscle.",
        image: heroPath,
        kicker: "WHAT CHANGED",
        subtitleLead: "Access is commoditizing. The edge is now",
        subtitleHighlight: "operational know-how.",
      },
      {
        type: "text",
        badge: "WHY NOW",
        title: "Enterprises can't hire the talent fast enough.",
        kicker: "THE TENSION",
        subtitleLead: "So the labs are selling the capability itself —",
        subtitleHighlight: "training the workforce directly.",
      },
      {
        type: "body",
        badge: "THE TAKEAWAY",
        title: "Own deployment, own the decade.",
        image: heroPath,
        kicker: "SECOND-ORDER",
        subtitleLead: "The winners won't have the best model. They'll have the",
        subtitleHighlight: "best deployment engine.",
      },
    ],
  });
  if (!carousel.success) failures.push("carousel render returned success=false");
  for (const a of carousel.assets) assertPng(`carousel ${a.file}`, a.path);

  console.log("\n----------------------------------------");
  if (failures.length === 0) {
    console.log(`PASS — rendered ${story.assets.length + carousel.assets.length} PNG(s), all 1080x1350.`);
    console.log(`Story dir:    ${story.outputDir}`);
    console.log(`Carousel dir: ${carousel.outputDir}`);
  } else {
    console.error(`FAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("Verification crashed:", err);
  process.exitCode = 1;
});
