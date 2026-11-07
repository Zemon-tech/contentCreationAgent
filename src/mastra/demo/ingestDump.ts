/**
 * ingest:dump — like ingest:dry, but DUMPS every ingested item's title + URL
 * grouped by source, so you can eyeball exactly what the current RSS feeds
 * give you on a run. ONLY the feed-fetch stage runs: no X merge, no ranking,
 * no copy, no publishing. Persists nothing.
 *
 *   npx -y tsx src/mastra/demo/ingestDump.ts
 *
 * By default it prints to the console AND writes a full report to
 *   workspace/ingest-dumps/ingest-dump-<timestamp>.(txt|json)
 * so you can diff later variants (current vs current+exa vs +firecrawl).
 *
 * Flags:
 *   --no-file        print only, don't write report files
 *   --json-only      write only the JSON report (skip the .txt)
 *   --max=<n>        cap items printed per source in the console (default: all)
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NEWS_FEED_SOURCES } from "../config/newsFeeds";
import { ingestFeeds, formatRunSummary } from "../lib/ingest-feeds";
import type { RawContent } from "../schemas/rawContent";

interface DumpItem {
  title: string;
  url: string;
  publishedAt: string | null;
  hasImage: boolean;
  paywalled: boolean;
  signalOnly: boolean;
  viaFallback: boolean;
}
interface SourceGroup {
  sourceId: string;
  sourceName: string;
  region: string;
  count: number;
  items: DumpItem[];
}

const argv = process.argv.slice(2);
const noFile = argv.includes("--no-file");
const jsonOnly = argv.includes("--json-only");
const maxArg = argv.find((a) => a.startsWith("--max="));
const maxPerSource = maxArg ? Math.max(0, parseInt(maxArg.split("=")[1] ?? "", 10) || 0) : 0; // 0 = all

function toDumpItem(r: RawContent): DumpItem {
  return {
    title: (r.title || "(no title)").replace(/\s+/g, " ").trim(),
    url: r.url,
    publishedAt: r.publishedAt ?? null,
    hasImage: !!r.imageCandidates?.length,
    paywalled: !!r.paywalled,
    signalOnly: !!r.signalOnly,
    viaFallback: !!r.viaFallback,
  };
}

/** Group items by source, preserving the order sources appear in the registry. */
function groupBySource(items: RawContent[]): SourceGroup[] {
  const order = new Map<string, number>();
  NEWS_FEED_SOURCES.forEach((s, i) => order.set(s.id, i));
  const groups = new Map<string, SourceGroup>();
  for (const r of items) {
    let g = groups.get(r.sourceId);
    if (!g) {
      g = {
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        region: (r.metadata?.["region"] as string) ?? "GLOBAL",
        count: 0,
        items: [],
      };
      groups.set(r.sourceId, g);
    }
    g.items.push(toDumpItem(r));
    g.count++;
  }
  return [...groups.values()].sort(
    (a, b) => (order.get(a.sourceId) ?? 999) - (order.get(b.sourceId) ?? 999),
  );
}

function flagStr(it: DumpItem): string {
  const f: string[] = [];
  if (it.hasImage) f.push("img");
  if (it.paywalled) f.push("paywall");
  if (it.signalOnly) f.push("signal");
  if (it.viaFallback) f.push("fallback");
  return f.length ? ` [${f.join(",")}]` : "";
}

/** Build the human-readable text report (full, no per-source cap). */
function buildTextReport(groups: SourceGroup[], summaryBlock: string, totals: string): string {
  const lines: string[] = [];
  lines.push("=== INGEST DUMP (feed fetch only — no X, no ranking, no publish) ===");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("--- Run summary ---");
  lines.push(summaryBlock);
  lines.push("");
  lines.push(totals);
  lines.push("");
  lines.push("--- Items by source ---");
  for (const g of groups) {
    lines.push("");
    lines.push(`### ${g.sourceName} (${g.region}) — ${g.count} items`);
    g.items.forEach((it, i) => {
      lines.push(`  ${String(i + 1).padStart(2, "0")}. ${it.title}${flagStr(it)}`);
      lines.push(`      ${it.url}`);
    });
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { items, summary } = await ingestFeeds({ sources: NEWS_FEED_SOURCES, dryRun: true });
  const groups = groupBySource(items);

  const withImages = items.filter((i) => i.imageCandidates?.length).length;
  const paywalled = items.filter((i) => i.paywalled).length;
  const signal = items.filter((i) => i.signalOnly).length;
  const fallback = items.filter((i) => i.viaFallback).length;
  const summaryBlock = formatRunSummary(summary);
  const totals =
    `Items ingested: ${items.length} · sources contributing: ${groups.length} · ` +
    `with image: ${withImages} · paywalled: ${paywalled} · signal-only: ${signal} · via fallback: ${fallback}`;

  // ---- Console output ----
  console.log(`\n=== INGEST DUMP (feed fetch only — no X, no ranking, no publish) ===`);
  console.log(`\n--- Run summary ---`);
  console.log(summaryBlock);
  console.log(`\n${totals}`);
  console.log(`\n--- Items by source ---`);
  for (const g of groups) {
    console.log(`\n### ${g.sourceName} (${g.region}) — ${g.count} items`);
    const shown = maxPerSource > 0 ? g.items.slice(0, maxPerSource) : g.items;
    shown.forEach((it, i) => {
      console.log(`  ${String(i + 1).padStart(2, "0")}. ${it.title}${flagStr(it)}`);
      console.log(`      ${it.url}`);
    });
    if (maxPerSource > 0 && g.items.length > maxPerSource) {
      console.log(`      … +${g.items.length - maxPerSource} more (see report file)`);
    }
  }

  // ---- Report files ----
  if (!noFile) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(process.cwd(), "workspace", "ingest-dumps");
    mkdirSync(dir, { recursive: true });

    const jsonPath = path.join(dir, `ingest-dump-${stamp}.json`);
    writeFileSync(
      jsonPath,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), summary, totals: { items: items.length, withImages, paywalled, signal, fallback }, groups },
        null,
        2,
      ),
    );
    console.log(`\nJSON report: ${jsonPath}`);

    if (!jsonOnly) {
      const txtPath = path.join(dir, `ingest-dump-${stamp}.txt`);
      writeFileSync(txtPath, buildTextReport(groups, summaryBlock, totals));
      console.log(`Text report: ${txtPath}`);
    }
  }
}

main().catch((err) => {
  console.error("ingest:dump failed:", err);
  process.exit(1);
});
