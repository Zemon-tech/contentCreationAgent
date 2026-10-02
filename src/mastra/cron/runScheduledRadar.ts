/**
 * Automated 6-Hour Scheduled Industry Radar & Content Creation Runner
 *
 * Runs the unified industryAggregationWorkflow every 6 hours (configurable via RADAR_INTERVAL_HOURS):
 * 1. Sweeps all configured industry sources (RSS, arXiv, GitHub releases, etc.)
 * 2. Concurrently conducts live Exa web news search for breaking announcements
 * 3. Normalizes, deduplicates, and clusters items into canonical stories
 * 4. Verifies stories with tiered evidence and Exa fact-checking
 * 5. Generates visual post drafts formatted with template slots (e.g., news-brief)
 * 6. Persists drafts to SQLite with editorialStatus: "PENDING_REVIEW"
 * 7. Leaves drafts awaiting human verification before publishing
 *
 * Usage:
 *   npx -y tsx src/mastra/cron/runScheduledRadar.ts         # Starts 6-hour daemon
 *   npx -y tsx src/mastra/cron/runScheduledRadar.ts --once  # Runs one cycle and exits
 *   npx -y tsx src/mastra/cron/runScheduledRadar.ts --demo  # Runs in demo mode (offline mock data)
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    // .env already loaded or missing
  }
}

import { industryAggregationWorkflow } from "../workflows/industryAggregationWorkflow.js";

const DEFAULT_INTERVAL_HOURS = 6;
const isOnce = process.argv.includes("--once");
const isDemo = process.argv.includes("--demo");
const industryArg = process.argv.find((a) => a.startsWith("--industry="))?.split("=")[1];
const industryName = industryArg || process.env.RADAR_INDUSTRY || "AI";
const intervalHours = Number(process.env.RADAR_INTERVAL_HOURS) || DEFAULT_INTERVAL_HOURS;
const intervalMs = intervalHours * 60 * 60 * 1000;

let isRunning = false;

export async function executeScheduledSweep(): Promise<void> {
  if (isRunning) {
    console.log(`[ScheduledRadar] Sweep already in progress. Skipping overlapping run.`);
    return;
  }

  isRunning = true;
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  console.log(`\n============================================================`);
  console.log(`[ScheduledRadar] Starting Radar Cycle at ${timestamp}`);
  console.log(`Industry: ${industryName}`);
  console.log(`Mode: ${isDemo ? "DEMO (offline mock data)" : "LIVE (Feeds + Exa Parallel Search)"}`);
  console.log(`Post Generation: Enabled (news-brief test template)`);
  console.log(`Review Gate: Editorial status set to PENDING_REVIEW in SQLite`);
  console.log(`============================================================\n`);

  try {
    const run = await industryAggregationWorkflow.createRun();
    const result = await run.start({
      inputData: {
        industryName,
        demoMode: isDemo,
        useExaEnrichment: true,
        autoRenderPosts: true,
        maxOpportunities: 5,
        minScore: 70,
        similarityThreshold: 0.9,
        maxItemsPerSource: 25,
        concurrency: 8,
        perSourceTimeoutMs: 25000,
        maxAgeHours: 24,
        relevanceThreshold: 0.65,
        windowHours: 24,
      },
    });

    if (result.status !== "success") {
      console.error(`[ScheduledRadar] Pipeline execution failed:`, result);
      return;
    }

    const out = result.result;
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n--- Radar Cycle Completed in ${durationSec}s ---`);
    console.log(`Run ID: ${out.runId}`);
    console.log(`Sources Processed: ${out.stats.sourcesChecked} (${out.stats.sourcesSucceeded} ok, ${out.stats.sourcesFailed} failed)`);
    console.log(`Items Collected: ${out.stats.collected} raw items`);
    console.log(`Deduplicated: ${out.stats.uniqueItems} unique items (${out.stats.duplicatesAssociated} duplicates clustered)`);
    console.log(`Stories Formed: ${out.stats.stories} stories`);
    console.log(`Top Opportunities: ${out.stats.opportunities} qualified (score >= 70)`);
    console.log(`Drafts Created: ${out.postDrafts?.length || 0} visual post drafts`);

    if (out.postDrafts && out.postDrafts.length > 0) {
      console.log(`\n--- Visual Post Drafts Awaiting Human Verification (PENDING_REVIEW) ---`);
      out.postDrafts.forEach((draft, idx) => {
        console.log(`\n[Draft #${idx + 1}] Story ID: ${draft.storyId}`);
        console.log(`  Headline: "${draft.headline}"`);
        console.log(`  Template: ${draft.templateId}`);
        console.log(`  Render Status: ${draft.renderStatus}`);
        if (draft.slides && draft.slides.length > 0) {
          console.log(`  Slides: ${draft.slides.map((s) => s.file).join(", ")}`);
        }
        if (draft.workspaceDir) {
          console.log(`  Workspace Directory: ${draft.workspaceDir}`);
        }
        console.log(`  Caption: ${draft.caption.slice(0, 120)}...`);
        console.log(`  Hashtags: ${draft.hashtags.join(" ")}`);
        console.log(`  Editorial Status: ${draft.editorialStatus} (Safe: Won't post until approved)`);
      });
    } else {
      console.log(`\nNo post drafts generated for this cycle (no stories met high-signal threshold >= 70).`);
    }

    console.log(`\n✓ Stories and drafts persisted to SQLite database (mastra.db).`);
    console.log(`✓ Human review required before publishing.`);
  } catch (error) {
    console.error(`[ScheduledRadar] Unexpected error during scheduled sweep:`, error);
  } finally {
    isRunning = false;
  }
}

async function startDaemon(): Promise<void> {
  console.log(`[ScheduledRadar] Automated daemon starting up...`);
  console.log(`[ScheduledRadar] Schedule interval: every ${intervalHours} hours.`);

  // 1. Initial run on startup
  await executeScheduledSweep();

  if (isOnce) {
    console.log(`[ScheduledRadar] '--once' specified. Exiting after 1 cycle.`);
    process.exit(0);
  }

  // 2. Schedule recurring execution
  const scheduleNext = () => {
    const nextRunDate = new Date(Date.now() + intervalMs);
    console.log(`\n[ScheduledRadar] Next automated sweep scheduled for: ${nextRunDate.toLocaleString()}`);
  };

  scheduleNext();

  const timer = setInterval(async () => {
    await executeScheduledSweep();
    scheduleNext();
  }, intervalMs);

  const shutdown = () => {
    console.log(`\n[ScheduledRadar] Shutting down scheduler daemon...`);
    clearInterval(timer);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startDaemon().catch((err) => {
  console.error(`[ScheduledRadar] Fatal error starting daemon:`, err);
  process.exit(1);
});
