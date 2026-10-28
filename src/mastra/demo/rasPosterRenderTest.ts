/**
 * ras:poster:test — prove the RAS POSTER template renders in-process, offline,
 * with NO logo binary present (text wordmark fallback) and NO network/model.
 *
 *   npx -y tsx --env-file=.env src/mastra/demo/rasPosterRenderTest.ts
 *
 * It builds a synthetic already-transparent hero PNG fully in memory with sharp
 * so makeHeroCutout takes the alreadyCutout branch and SKIPS the ~140MB
 * @imgly background-removal model. It then prepares poster props with the logo
 * omitted, strips the logo props (wordmark fallback), renders via
 * renderComponentToPng, and asserts a valid PNG signature + that the Anton
 * weight-400 font is loaded. Exits non-zero on any assertion failure.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import React from "react";
import sharp from "sharp";
import { preparePosterStory } from "../tools/Postertools";
import { RasPosterStoryTemplate } from "../templates/RasPosterStoryTemplate";
import { renderComponentToPng, RAS_CANVAS } from "../renderer/satori-renderer";
import { loadFonts } from "../renderer/fonts";

async function main(): Promise<void> {
  console.log("\n=== RAS POSTER RENDER TEST (in-process, offline, no logo) ===\n");

  // (a) synthetic transparent hero: an opaque red square on a transparent canvas.
  const square = await sharp({
    create: { width: 400, height: 400, channels: 4, background: { r: 225, g: 76, b: 50, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const hero = await sharp({
    create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: square, left: 200, top: 200 }])
    .png()
    .toBuffer();

  // (b) prepare poster props with the logo omitted, then strip logo props so
  // the template takes the text-wordmark fallback.
  const prepared = await preparePosterStory(
    {
      heroSource: hero,
      headlineTop: "AI MODELS GET",
      headlineMid: "A BIG UPGRADE",
      headlineHighlight: "SHIP IT NOW",
    },
    { logoBase64: "", logoWidth: 0, logoHeight: 0 },
  );
  const props = { ...prepared.props };
  delete props.logoBase64;
  delete props.logoWidth;
  delete props.logoHeight;

  console.log(`Hero cutout: alreadyCutout=${prepared.hero.alreadyCutout} · ready=${prepared.ready}`);
  if (prepared.problems.length) console.log(`Problems: ${prepared.problems.join("; ")}`);

  // (c) render.
  const component = React.createElement(RasPosterStoryTemplate, props);
  const png = await renderComponentToPng(component, RAS_CANVAS);

  // (d) assert a non-empty buffer with a valid PNG signature.
  if (!png || png.length === 0) throw new Error("render produced an empty buffer");
  const sig = [0x89, 0x50, 0x4e, 0x47];
  for (let i = 0; i < sig.length; i++) {
    if (png[i] !== sig[i]) {
      throw new Error(
        `bad PNG signature at byte ${i}: got 0x${png[i].toString(16)}, expected 0x${sig[i].toString(16)}`,
      );
    }
  }

  // (e) assert Anton weight-400 is loaded.
  const fonts = loadFonts();
  if (!fonts.some((f) => f.name === "Anton" && f.weight === 400)) {
    throw new Error("Anton weight-400 font is not registered in loadFonts()");
  }

  console.log(`\n✅ Rendered poster PNG: ${png.length} bytes · valid PNG signature`);
  console.log("✅ Anton present (weight 400)");
  console.log("✅ No logo binary present — text wordmark fallback used\n");
}

main().catch((err) => {
  console.error("ras:poster:test failed:", err);
  process.exit(1);
});
