/**
 * LIVE tier-1 sweep benchmark (hits the real network).
 * Measures wall-clock time + per-source success/failure.
 * Run with: npx -y tsx src/mastra/demo/benchmarkSweep.ts
 */
import { sweepSources } from "../collectors/index.js";
import { getSourcesByTier } from "../config/sources.js";

async function main(): Promise<void> {
  const sources = getSourcesByTier(1);
  console.log(`Sweeping ${sources.length} tier-1 sources (concurrency 8, max 3 items each)...`);
  const started = Date.now();
  const results = await sweepSources(sources, {
    maxItems: 3,
    concurrency: 8,
    perSourceTimeoutMs: 20000,
  });
  const elapsed = Date.now() - started;
  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const items = results.reduce((n, r) => n + r.items.length, 0);
  console.log(`\nDone in ${(elapsed / 1000).toFixed(1)}s — ${ok.length} ok, ${failed.length} failed, ${items} items.`);
  console.log(`Sequential estimate would be ~${results.reduce((n, r) => n + r.durationMs, 0) / 1000}s single-threaded.`);
  console.log("\nSlowest 5:");
  for (const r of [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)) {
    console.log(`  ${r.durationMs}ms  ${r.sourceId}  ${r.error ? `ERROR: ${r.error.slice(0, 100)}` : `${r.items.length} items`}`);
  }
  if (failed.length > 0) {
    console.log("\nFailed sources (catalog URLs to fix or demote):");
    for (const r of failed) console.log(`  - ${r.sourceId}: ${r.error}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
