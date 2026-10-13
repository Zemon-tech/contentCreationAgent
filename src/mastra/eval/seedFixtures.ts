/**
 * rank:seed — append ~30 real recent headlines to fixtures/ranking-golden.json
 * for you to label (post | maybe | skip).
 *
 *   npx -y tsx --env-file=.env src/mastra/eval/seedFixtures.ts            # ~30 items
 *   npx -y tsx --env-file=.env src/mastra/eval/seedFixtures.ts --count=40
 *
 * Needs EXA_API_KEY. Existing fixtures (your labeled starter) are preserved;
 * new rows are appended with an empty `label` and the item's real `ageHours`.
 * Fill in each `label`, then run `npm run rank:eval`.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import fs from "node:fs";
import { searchExa } from "../tools/exa-tools";
import { makeId } from "../lib/ids";
import type { Region } from "../schemas/ranking";
import { GOLDEN_PATH, loadGoldenFile, type GoldenFixture } from "./fixtures";

const countArg = process.argv.find((a) => a.startsWith("--count="));
const TARGET = Math.max(5, Number(countArg?.split("=")[1] ?? 30) || 30);

const QUERIES: { query: string; region: Region; categories: string[] }[] = [
  { query: "AI model launch OR research breakthrough announcement", region: "US", categories: ["ai"] },
  { query: "AI startup funding round raises Series", region: "US", categories: ["startups", "ai"] },
  { query: "deeptech semiconductor OR robotics OR space startup", region: "US", categories: ["deeptech"] },
  { query: "India AI startup funding OR launch", region: "IN", categories: ["startups", "ai"] },
  { query: "India deeptech OR semiconductor OR space news", region: "IN", categories: ["deeptech"] },
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function ageHoursOf(publishedDate: string | null | undefined, now: number): number {
  if (!publishedDate) return 2;
  const t = Date.parse(publishedDate);
  if (Number.isNaN(t)) return 2;
  return Math.max(0, Math.round(((now - t) / 3_600_000) * 10) / 10);
}

async function main(): Promise<void> {
  if (!process.env.EXA_API_KEY) {
    console.error("rank:seed needs EXA_API_KEY in your environment (.env).");
    process.exit(1);
  }
  const now = Date.now();
  const since = new Date(now - 24 * 3_600_000).toISOString();
  const seen = new Set<string>();
  const golden = loadGoldenFile();
  for (const f of golden.fixtures) seen.add(String(f.item.url ?? "").toLowerCase());

  const fresh: GoldenFixture[] = [];
  const perQuery = Math.ceil(TARGET / QUERIES.length) + 2;

  for (const q of QUERIES) {
    if (fresh.length >= TARGET) break;
    let res;
    try {
      res = await searchExa({
        query: q.query,
        category: "news",
        numResults: perQuery,
        startPublishedDate: since,
        includeText: true,
      });
    } catch (err) {
      console.warn(`  query failed (${q.query}):`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const r of res?.results ?? []) {
      if (fresh.length >= TARGET) break;
      const url = (r.url ?? "").trim();
      const key = url.toLowerCase();
      if (!url || seen.has(key)) continue;
      seen.add(key);
      const summary = (r.text ?? r.title ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      if (!r.title || summary.length < 40) continue;
      fresh.push({
        label: "",
        ageHours: ageHoursOf(r.publishedDate, now),
        item: {
          id: makeId("gold"),
          clusterId: makeId("c-gold"),
          title: r.title.trim(),
          summary,
          url,
          source: hostOf(url),
          region: q.region,
          rawCategories: q.categories,
          clusterSourceCount: 1,
        },
      });
    }
  }

  golden.fixtures.push(...fresh);
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + "\n", "utf8");
  console.log(`Appended ${fresh.length} unlabeled headline(s) to ${GOLDEN_PATH}.`);
  console.log(`Now open the file and set each new "label" to post | maybe | skip, then run: npm run rank:eval`);
}

main().catch((err) => {
  console.error("rank:seed failed:", err);
  process.exit(1);
});
