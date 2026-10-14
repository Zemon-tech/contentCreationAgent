/**
 * ingest:dry — dry-run the health-aware feed ingestion and print a source
 * health table. Fetches live feeds, applies conditional GET / rate limiting /
 * robots / feed-health / paywall tagging / image-candidate extraction /
 * Google News fallback, but persists nothing and publishes nothing.
 *
 *   npx -y tsx src/mastra/demo/ingestDryRun.ts
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import { NEWS_FEED_SOURCES } from "../config/newsFeeds";
import { ingestFeeds, formatRunSummary, type PerSourceReport } from "../lib/ingest-feeds";

function table(rows: PerSourceReport[]): string {
  const cells = rows.map((r) => ({
    name: r.name.slice(0, 28),
    region: r.region,
    status: r.status,
    http: r.httpStatus === null ? "-" : String(r.httpStatus),
    items: String(r.items),
    newest: r.newestAgeDays === null ? "-" : `${r.newestAgeDays}d`,
    verdict: r.verdict,
    note: (r.note ?? "").slice(0, 36),
  }));
  const header = { name: "SOURCE", region: "REG", status: "HEALTH", http: "HTTP", items: "ITEMS", newest: "NEWEST", verdict: "VERDICT", note: "NOTE" };
  const all = [header, ...cells];
  const w: Record<string, number> = {};
  for (const k of Object.keys(header)) w[k] = Math.max(...all.map((r) => (r as Record<string, string>)[k]!.length));
  const line = (r: Record<string, string>) => Object.keys(header).map((k) => r[k]!.padEnd(w[k]!)).join("  ");
  return [line(header), ...cells.map(line)].join("\n");
}

async function main(): Promise<void> {
  const { items, summary } = await ingestFeeds({ sources: NEWS_FEED_SOURCES, dryRun: true });

  console.log(`\n=== INGEST DRY-RUN (nothing persisted, nothing published) ===`);
  console.log(`\n--- Run summary ---`);
  console.log(formatRunSummary(summary));

  console.log(`\n--- Source health ---`);
  console.log(table(summary.perSource));

  const withImages = items.filter((i) => i.imageCandidates?.length).length;
  const paywalled = items.filter((i) => i.paywalled).length;
  const signal = items.filter((i) => i.signalOnly).length;
  const fallback = items.filter((i) => i.viaFallback).length;
  console.log(
    `\nItems ingested: ${items.length} · with image candidates: ${withImages} · paywalled: ${paywalled} · signal-only: ${signal} · via fallback: ${fallback}`,
  );
  console.log(`(dry-run: feed-health NOT written to storage)`);
}

main().catch((err) => {
  console.error("ingest:dry failed:", err);
  process.exit(1);
});
