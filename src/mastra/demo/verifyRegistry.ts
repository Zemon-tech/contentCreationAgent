/**
 * Registry audit + parallelism verification.
 * Run with: npx -y tsx src/mastra/demo/verifyRegistry.ts
 * No network required (uses stub sources for the sweep test).
 */
import {
  getCollectableSources,
  getSourceRegistry,
  getSourcesByTier,
  registryStats,
} from "../config/sources.js";
import { collectorFor, sweepSources } from "../collectors/index.js";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

async function main(): Promise<void> {
  const all = getSourceRegistry();
  const stats = registryStats();
  console.log("REGISTRY:", JSON.stringify(stats));

  console.log("[1] catalog integrity");
  check("registry is substantial", all.length >= 150, `${all.length} sources`);
  const ids = new Set(all.map((s) => s.id));
  check("all ids unique", ids.size === all.length);
  const badType = all.filter(
    (s) =>
      !["rss", "blog", "news", "social", "newsletter", "launch", "github", "web", "podcast", "video", "paper", "community"].includes(s.type),
  );
  check("all types valid", badType.length === 0, badType.map((s) => s.id).join(","));
  const badRole = all.filter(
    (s) => s.role && !["official", "news", "signal_creator", "community", "academic", "launch", "other"].includes(s.role),
  );
  check("all roles valid", badRole.length === 0);
  const activeNoUrl = all.filter(
    (s) => s.active && ["rss", "github", "web", "blog", "paper"].includes(s.type) && !s.url,
  );
  check("every active collectable source has a URL", activeNoUrl.length === 0, activeNoUrl.map((s) => s.id).join(","));
  const socialActive = all.filter((s) => s.active && (s.type === "social" || s.type === "video" || s.type === "podcast"));
  check("no social/video/podcast source is actively polled", socialActive.length === 0, socialActive.map((s) => s.id).slice(0, 5).join(","));
  const everyCollectableHasCollector = getCollectableSources().filter((s) => !collectorFor(s));
  check("every collectable source resolves to a collector", everyCollectableHasCollector.length === 0);

  console.log("[2] tiers");
  const t1 = getSourcesByTier(1);
  check("tier-1 set is selective", t1.length > 0 && t1.length < all.length, `${t1.length} sources`);

  console.log("[3] parallel sweep (offline: synthetic active stubs)");
  const stubs = Array.from({ length: 12 }, (_, i) => ({
    id: `test:stub-${i}`,
    name: `Test stub ${i}`,
    type: "social" as const,
    authorityScore: 10,
    active: true as const,
  }));
  const started = Date.now();
  const results = await sweepSources(stubs, { concurrency: 6, perSourceTimeoutMs: 10000 });
  const elapsed = Date.now() - started;
  check("sweep returns one result per source", results.length === stubs.length);
  check("stub failures recorded, not thrown", results.every((r) => r.error && r.items.length === 0));
  check("every result carries timing", results.every((r) => typeof r.durationMs === "number"));
  check("bounded pool completes fast", elapsed < 15000, `${elapsed}ms for ${stubs.length} sources`);

  console.log("[4] sweep tool wiring");
  const mod = await import("../tools/sweep-tools.js");
  check("sweepSourcesTool registered", mod.sweepSourcesTool.id === "sweepSources");

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nRegistry + parallelism checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
