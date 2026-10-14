/**
 * rank:seed:feeds — pull ~40 real, recent headlines from the LIVE feeds into
 * fixtures/ranking-golden.json with empty labels, for you to label
 * (post | maybe | skip). Balanced across US/IN. Existing (labeled) fixtures are
 * preserved; new rows are appended, de-duplicated by canonical URL.
 *
 *   npx -y tsx src/mastra/demo/seedGoldenFromFeeds.ts [--count=40]
 *
 * Reuses the health-aware ingestion (dry-run; nothing persisted/published).
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import fs from "node:fs";
import { NEWS_FEED_SOURCES } from "../config/newsFeeds";
import { getSourceRegistry } from "../config/sources";
import { ingestFeeds } from "../lib/ingest-feeds";
import { normalizeUrl } from "../lib/normalize";
import { makeId } from "../lib/ids";
import { GOLDEN_PATH, loadGoldenFile, type GoldenFixture } from "../eval/fixtures";

const countArg = process.argv.find((a) => a.startsWith("--count="));
const TARGET = Math.max(10, Number(countArg?.split("=")[1] ?? 40) || 40);
const PER_REGION_CAP = Math.ceil(TARGET * 0.6);

function categoryOf(sourceId: string): string[] {
  const src = getSourceRegistry().find((s) => s.id === sourceId);
  return src?.topics?.slice(0, 2) ?? [];
}

function ageHours(iso: string | undefined): number {
  if (!iso) return 2;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 2;
  return Math.max(0, Math.round(((Date.now() - t) / 3_600_000) * 10) / 10);
}

async function main(): Promise<void> {
  const { items } = await ingestFeeds({ sources: NEWS_FEED_SOURCES, dryRun: true });

  const golden = loadGoldenFile();
  const seen = new Set(golden.fixtures.map((f) => normalizeUrl(String(f.item.url ?? ""))));
  const regionCount: Record<string, number> = { US: 0, IN: 0, GLOBAL: 0 };
  const fresh: GoldenFixture[] = [];

  // Prefer fresher, non-signal, non-fallback items; interleave regions.
  const pool = items
    .filter((i) => !i.signalOnly && !i.viaFallback && (i.title ?? "").length > 10)
    .sort((a, b) => Date.parse(b.publishedAt ?? "0") - Date.parse(a.publishedAt ?? "0"));

  for (const it of pool) {
    if (fresh.length >= TARGET) break;
    const url = normalizeUrl(it.url);
    if (seen.has(url)) continue;
    const region = (it.metadata?.["region"] as string) ?? "GLOBAL";
    if ((regionCount[region] ?? 0) >= PER_REGION_CAP) continue;
    seen.add(url);
    regionCount[region] = (regionCount[region] ?? 0) + 1;
    const summary = (it.content ?? it.title ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    fresh.push({
      label: "",
      ageHours: ageHours(it.publishedAt),
      item: {
        id: makeId("gold"),
        clusterId: makeId("c-gold"),
        title: it.title ?? "",
        summary,
        url,
        source: it.sourceName,
        region,
        rawCategories: categoryOf(it.sourceId),
        clusterSourceCount: 1,
      },
    });
  }

  golden.fixtures.push(...fresh);
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + "\n", "utf8");
  console.log(`Appended ${fresh.length} real headlines (US:${regionCount.US} IN:${regionCount.IN} GLOBAL:${regionCount.GLOBAL}).`);
  console.log(`Total fixtures now: ${golden.fixtures.length}. File: ${GOLDEN_PATH}`);
  console.log(`Set each new "label" to post | maybe | skip, then run: npm run rank:eval`);
}

main().catch((err) => {
  console.error("rank:seed:feeds failed:", err);
  process.exit(1);
});
