/**
 * image:test — run the EXACT image-sourcing step for a given headline (and
 * optional article URL) so you can SEE which image the current system picks,
 * WITHOUT running ingest / rank / copy / publish.
 *
 * It calls sourceImage() the same way the workflow does, then prints the
 * outcome (which candidate source won, dimensions, how many were tried) and
 * copies the chosen file to workspace/image-tests/ with a readable name so you
 * can open it immediately.
 *
 * This is also the exact seam where a relevance/quality scorer (Liquid d1
 * decision model or a hosted VLM) would later plug in — run this first to
 * eyeball the baseline the current blind validator produces.
 *
 * Run (quote the headline):
 *   npx -y tsx --env-file=.env src/mastra/demo/imageSourceTest.ts "Your headline here"
 *   npx -y tsx --env-file=.env src/mastra/demo/imageSourceTest.ts "Headline" --url=https://example.com/article
 *   npx -y tsx --env-file=.env src/mastra/demo/imageSourceTest.ts "Headline" --feed=https://cdn/img.jpg
 *
 * Flags:
 *   --url=<articleUrl>   the story's own article page (its og:image is tried)
 *   --feed=<imageUrl>    a feed image candidate (tried first, like the workflow)
 *   --no-copy            don't copy the chosen file into workspace/image-tests/
 *
 * Needs EXA_API_KEY in .env for the Exa image-search fallback (feed/url still
 * work without it).
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
import { sourceImage } from "../lib/image/sourcing";

interface Args {
  headline: string;
  articleUrls: string[];
  feedUrls: string[];
  copy: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const articleUrls: string[] = [];
  const feedUrls: string[] = [];
  let copy = true;
  for (const a of argv) {
    if (a.startsWith("--url=")) articleUrls.push(a.slice("--url=".length));
    else if (a.startsWith("--feed=")) feedUrls.push(a.slice("--feed=".length));
    else if (a === "--no-copy") copy = false;
    else positional.push(a);
  }
  return { headline: positional.join(" ").trim(), articleUrls, feedUrls, copy };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "headline";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.headline) {
    console.error(
      'Usage: npx -y tsx --env-file=.env src/mastra/demo/imageSourceTest.ts "Your headline" [--url=<articleUrl>] [--feed=<imageUrl>] [--no-copy]',
    );
    process.exit(1);
  }

  console.log(`\n=== IMAGE SOURCE TEST (image sourcing only — no rank/copy/publish) ===`);
  console.log(`Headline : ${args.headline}`);
  if (args.articleUrls.length) console.log(`Article  : ${args.articleUrls.join(", ")}`);
  if (args.feedUrls.length) console.log(`Feed img : ${args.feedUrls.join(", ")}`);
  console.log(`Exa key  : ${process.env["EXA_API_KEY"] ? "present" : "MISSING (feed/url candidates only)"}`);
  console.log(`\nSourcing…\n`);

  const started = Date.now();
  const image = await sourceImage({
    headline: args.headline,
    ...(args.feedUrls.length ? { feedCandidateUrls: args.feedUrls } : {}),
    ...(args.articleUrls.length ? { articleUrls: args.articleUrls } : {}),
  });
  const elapsedMs = Date.now() - started;

  console.log(`--- Result ---`);
  console.log(`chosenFrom      : ${image.chosenFrom}`);
  console.log(`candidatesTried : ${image.candidatesTried}`);
  console.log(`sourceUrl       : ${image.imageSourceUrl ?? "(none)"}`);
  console.log(`attribution     : ${image.imageAttribution ?? "(none)"}`);
  console.log(`under1080       : ${image.under1080}`);
  console.log(`localPath       : ${image.imageLocalPath ?? "(none)"}`);
  if (image.reason) console.log(`reason          : ${image.reason}`);
  console.log(`elapsed         : ${elapsedMs} ms`);

  if (!image.imageLocalPath) {
    console.log(
      `\nNo image passed the (blind) validator. The current system would SKIP this story\n` +
        `(RAS needs a hero image). This is exactly the case a relevance/quality scorer\n` +
        `would NOT change — nothing was downloadable/valid to begin with.\n`,
    );
    return;
  }

  // Copy the chosen file somewhere easy to open, with a readable name.
  if (args.copy) {
    const outDir = path.join(process.cwd(), "workspace", "image-tests");
    fs.mkdirSync(outDir, { recursive: true });
    const ext = path.extname(image.imageLocalPath) || ".img";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(outDir, `${slugify(args.headline)}-${image.chosenFrom}-${stamp}${ext}`);
    try {
      fs.copyFileSync(image.imageLocalPath, outPath);
      console.log(`\nOpen this to view the chosen image:\n  ${outPath}`);
    } catch (err) {
      console.log(`\n(could not copy to workspace/image-tests: ${err instanceof Error ? err.message : String(err)})`);
      console.log(`View the original at: ${image.imageLocalPath}`);
    }
  } else {
    console.log(`\nView the chosen image at: ${image.imageLocalPath}`);
  }
}

main().catch((err) => {
  console.error("image:test failed:", err);
  process.exit(1);
});
