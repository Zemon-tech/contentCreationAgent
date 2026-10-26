/**
 * Scheduled runner for the X discovery subsystem (Part B) — SEPARATE from the
 * 30-60min news workflow (runAutoNewsRadar.ts).
 *
 *   npx -y tsx --env-file=.env src/mastra/cron/runXDiscovery.ts            # daemon, every 6h (jittered)
 *   npx -y tsx --env-file=.env src/mastra/cron/runXDiscovery.ts --once     # one session, exit
 *   npx -y tsx --env-file=.env src/mastra/cron/runXDiscovery.ts --demo --once  # OFFLINE smoke run
 *
 * Interval: X_DISCOVERY_INTERVAL_HOURS (default 6), with +/- X_DISCOVERY_START_JITTER_PCT
 * applied to each fire time. The run SAVES posts to storage; it NEVER publishes.
 * --demo injects in-memory stubs + a mock search so the whole flow runs with
 * no network and no scraper subprocess.
 *
 * Run one instance under PM2/systemd (the in-process guard prevents overlap
 * only within a single process).
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import { getXDiscoveryConfig } from "../config/xDiscovery";
import { runDiscovery, type RunDiscoveryDeps, type DiscoveryReport } from "../lib/x-discovery/runDiscovery";
import { generateQueries } from "../lib/x-discovery/queryGen";
import {
  createLibSqlDiscoveredAccountsGateway,
  createDiscoveredAccountsStubGateway,
} from "../lib/x-discovery/stores/discoveredAccounts";
import {
  createLibSqlXScrapeHealthGateway,
  createXScrapeHealthStubGateway,
} from "../lib/x-discovery/stores/xScrapeHealth";
import {
  createLibSqlXBudgetGateway,
  createXBudgetStubGateway,
} from "../lib/x-discovery/stores/xBudget";
import {
  createLibSqlSavedXPostsGateway,
  createSavedXPostsStubGateway,
} from "../lib/x-discovery/stores/savedXPosts";

const isOnce = process.argv.includes("--once");
const isDemo = process.argv.includes("--demo");

const config = getXDiscoveryConfig();
const intervalHours = Math.max(0.1, config.intervalHours);
const baseIntervalMs = intervalHours * 3_600_000;

let running = false;

/** A deterministic, offline demo build: stub gateways + a canned mock search. */
function buildDemoDeps(): RunDiscoveryDeps {
  const accounts = createDiscoveredAccountsStubGateway();
  const health = createXScrapeHealthStubGateway();
  const budget = createXBudgetStubGateway();
  const savedPosts = createSavedXPostsStubGateway();

  let seq = 0;
  const mockSearch: RunDiscoveryDeps["search"] = async ({ query, tab }) => {
    // Two synthetic, clearly-fictional posts per query — no network.
    seq++;
    const mk = (handle: string, n: number, likes: number) => ({
      text: `Synthetic ${query.split(" ")[0]} update #${n} from @${handle} — fictional demo content for the offline smoke run. https://example.com/${handle}/${seq}-${n}`,
      url: `https://x.com/${handle}/status/${1000 + seq * 10 + n}`,
      author_handle: handle,
      at: new Date().toISOString(),
      is_reply: false,
      is_repost: false,
      replies: 3,
      reposts: Math.round(likes / 10),
      likes,
      views: likes * 20,
      dom_index: n,
      outbound_urls: [`https://example.com/${handle}/${seq}-${n}`],
      text_truncated: false,
      quoted: null,
      thread_texts: [],
    });
    return {
      success: true,
      query,
      tab,
      count: 2,
      posts: [mk("demo_labs", 1, 420), mk("demo_founder", 2, 260)],
    };
  };

  // Offline query generation: force the deterministic fallback (no LLM call).
  const offlineGenerateQueries: RunDiscoveryDeps["generateQueries"] = (topics, opts) =>
    generateQueries(topics, {
      ...opts,
      generate: async () => {
        throw new Error("offline-demo: no model");
      },
    });

  return {
    accounts,
    health,
    budget,
    savedPosts,
    search: mockSearch,
    // No profile scrape in demo; keep it offline.
    generateQueries: offlineGenerateQueries,
    now: new Date(),
    sleep: async () => {},
    rng: () => 0.5,
    log: (ev, data) => console.log(`[XDiscovery:demo] ${ev}`, JSON.stringify(data)),
  };
}

/** The real, networked build: libSQL gateways + real search/profile/queryGen. */
async function buildRealDeps(): Promise<RunDiscoveryDeps> {
  // Import the scraper lazily so --demo never pulls it into the graph.
  const { searchXPosts, scrapeXPosts } = await import("../lib/x-publisher");
  return {
    accounts: createLibSqlDiscoveredAccountsGateway(config),
    health: createLibSqlXScrapeHealthGateway(),
    budget: createLibSqlXBudgetGateway(),
    savedPosts: createLibSqlSavedXPostsGateway(),
    search: ({ query, tab, maxScrolls, limit }) => searchXPosts({ query, tab, maxScrolls, limit }),
    scrapeProfile: ({ handle, limit, maxScrolls }) => scrapeXPosts({ handle, limit, maxScrolls, includeReplies: false }),
    generateQueries,
    log: (ev, data) => console.log(`[XDiscovery] ${ev}`, JSON.stringify(data)),
  };
}

async function cycle(): Promise<DiscoveryReport | null> {
  if (running) {
    console.log("[XDiscovery] Previous session still running — skipping overlap.");
    return null;
  }
  running = true;
  const started = Date.now();
  console.log(`\n[XDiscovery] Session start ${new Date().toISOString()}${isDemo ? " (demo)" : ""}`);
  try {
    const deps = isDemo ? buildDemoDeps() : await buildRealDeps();
    const report = await runDiscovery(deps);
    console.log(
      `[XDiscovery] queries=${report.queries.length} posts=${report.postsScraped} accounts=${report.accountsTouched} promoted=${report.promoted.length}${report.aborted ? ` aborted(${report.stopReason})` : ""}`,
    );
    return report;
  } catch (err) {
    console.error("[XDiscovery] session error:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    running = false;
    console.log(`[XDiscovery] Session done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

/** Next fire = baseInterval +/- jitter. */
function nextDelayMs(): number {
  const jitter = baseIntervalMs * config.startJitterPct;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(60_000, baseIntervalMs + delta);
}

async function main(): Promise<void> {
  await cycle();
  if (isOnce) process.exit(0);
  console.log(`[XDiscovery] Daemon started — every ~${intervalHours}h (+/-${Math.round(config.startJitterPct * 100)}%).`);
  let timer: NodeJS.Timeout;
  const schedule = () => {
    timer = setTimeout(async () => {
      await cycle();
      schedule();
    }, nextDelayMs());
  };
  schedule();
  const shutdown = () => {
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[XDiscovery] fatal:", err);
  process.exit(1);
});
