/**
 * feeds:verify — live health check of the RAS news/primary/signal feeds.
 *
 *   npx -y tsx src/mastra/demo/verifyFeeds.ts
 *
 * For every active RSS feed in config/newsFeeds.ts, fetches it and reports:
 * HTTP status, whether it parsed as a feed, item count, newest item age, and
 * a LIVE / STALE / DEAD verdict. Prints a table and a JSON summary. Read-only.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import { NEWS_FEED_SOURCES } from "../config/newsFeeds";
import { verifyFeeds, formatFeedTable, verdictOf, type FeedCandidate } from "../lib/feed-verify";

async function main(): Promise<void> {
  const candidates: FeedCandidate[] = NEWS_FEED_SOURCES.filter(
    (s) => s.type === "rss" && !!s.url && s.active !== false,
  ).map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url!,
    region: s.region,
    category: s.topics?.[0],
    paywalled: s.paywalled,
    signalOnly: s.signalOnly,
  }));

  console.log(`\nVerifying ${candidates.length} feeds...\n`);
  const checks = await verifyFeeds(candidates, { concurrency: 8, timeoutMs: 15000 });

  console.log(formatFeedTable(checks));

  const live = checks.filter((c) => verdictOf(c) === "LIVE");
  const stale = checks.filter((c) => verdictOf(c) === "STALE");
  const dead = checks.filter((c) => verdictOf(c) === "DEAD");

  console.log(`\nSummary: ${live.length} LIVE · ${stale.length} STALE · ${dead.length} DEAD (of ${checks.length})`);
  if (dead.length) {
    console.log(`\nDEAD (fix or drop):`);
    for (const c of dead) console.log(`  ${c.id}  ${c.url}  — ${c.note ?? c.error ?? ""}`);
  }
  if (stale.length) {
    console.log(`\nSTALE (newest > 7d):`);
    for (const c of stale) console.log(`  ${c.id}  newest ${c.ageDays}d  ${c.url}`);
  }
}

main().catch((err) => {
  console.error("feeds:verify failed:", err);
  process.exit(1);
});
