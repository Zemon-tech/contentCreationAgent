/**
 * Scheduled runner for autoNewsToRasWorkflow (Step 8).
 *
 *   npx -y tsx --env-file=.env src/mastra/cron/runAutoNewsRadar.ts          # daemon, every 30 min
 *   npx -y tsx --env-file=.env src/mastra/cron/runAutoNewsRadar.ts --once   # one cycle, exit
 *
 * Interval: AUTO_INTERVAL_MINUTES (default 30). DRY_RUN + REQUIRE_APPROVAL
 * default true, so a scheduled run posts nothing on its own: in dry-run it only
 * records what it would do; with REQUIRE_APPROVAL it suspends for approval in
 * Studio. "Nothing worth posting this run" is a valid outcome, not an error.
 *
 * On a VPS, run this under PM2/systemd (one instance — the in-process guard
 * prevents overlap only within a single process). For OS/platform cron, use
 * --once; add your own lock if two --once runs could overlap.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import { autoNewsToRasWorkflow } from "../workflows/autoNewsToRasWorkflow.js";

const isOnce = process.argv.includes("--once");
const intervalMin = Number(process.env.AUTO_INTERVAL_MINUTES) || 30;
const intervalMs = Math.max(1, intervalMin) * 60_000;

let running = false;

async function cycle(): Promise<void> {
  if (running) {
    console.log("[AutoNewsRadar] Previous cycle still running — skipping overlap.");
    return;
  }
  running = true;
  const started = Date.now();
  console.log(`\n[AutoNewsRadar] Cycle start ${new Date().toISOString()}`);
  try {
    const run = await autoNewsToRasWorkflow.createRun();
    const dryRun = !/^(0|false|no|off)$/i.test(process.env.INSTAGRAM_DRY_RUN?.trim() || "true");
    const requireApproval = !/^(0|false|no|off)$/i.test(process.env.REQUIRE_APPROVAL?.trim() || "true");
    const mp = parseInt(process.env.MAX_POSTS_PER_RUN?.trim() || "1", 10);
    const maxPosts = Number.isFinite(mp) && mp >= 1 ? mp : 1;
    const result = await run.start({ inputData: { dryRun, requireApproval, maxPosts } });
    if (result.status === "success") {
      const out = result.result;
      const batch = out.status === "batch" && out.posts ? ` · ${out.posts.filter((p) => p.status === "posted").length}/${out.posts.length} posted` : "";
      console.log(`[AutoNewsRadar] status=${out.status}${out.headline ? ` · "${out.headline}" (${out.score})` : ""}${batch}${out.reason ? ` · ${out.reason}` : ""}`);
    } else if (result.status === "suspended") {
      console.log(`[AutoNewsRadar] SUSPENDED for approval — approve/reject in Mastra Studio to continue.`);
    } else {
      console.error(`[AutoNewsRadar] run status: ${result.status}`);
    }
  } catch (err) {
    console.error(`[AutoNewsRadar] cycle error:`, err instanceof Error ? err.message : err);
  } finally {
    running = false;
    console.log(`[AutoNewsRadar] Cycle done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

async function main(): Promise<void> {
  await cycle();
  if (isOnce) process.exit(0);
  console.log(`[AutoNewsRadar] Daemon started — every ${intervalMin} min.`);
  const timer = setInterval(cycle, intervalMs);
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[AutoNewsRadar] fatal:", err);
  process.exit(1);
});
