/**
 * x:discover:demo — fully OFFLINE dry run of the X discovery subsystem + the
 * quality-first ranker reading the posts it saved. NOTHING is scraped, no
 * network call is made, and nothing is published. Everything is injected:
 *   - a heuristic generateQueries (fixed strings, no LLM),
 *   - a mock search / scrapeProfile returning synthetic, clearly-fictional
 *     enriched posts (one text_truncated, plus a simulated block pass),
 *   - in-memory stub gateways (discovered_accounts, health, budget, saved_x_posts).
 *
 *   npx -y tsx --env-file=.env src/mastra/demo/xDiscoveryDryRun.ts
 *
 * It prints: queries generated, posts scraped, accounts discovered (+status),
 * a simulated block, then ranks the saved posts with an offline heuristic and
 * prints the top-5 with the full score breakdown + any truncated/blocked items.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import { runDiscovery, type RunDiscoveryDeps, type XSearchFn } from "../lib/x-discovery/runDiscovery";
import { createDiscoveredAccountsStubGateway } from "../lib/x-discovery/stores/discoveredAccounts";
import { createXScrapeHealthStubGateway } from "../lib/x-discovery/stores/xScrapeHealth";
import { createXBudgetStubGateway } from "../lib/x-discovery/stores/xBudget";
import { createSavedXPostsStubGateway } from "../lib/x-discovery/stores/savedXPosts";
import { getXDiscoveryConfig, type XDiscoveryConfig } from "../config/xDiscovery";
import { collectXPosts } from "../lib/collect-x-posts";
import { rankStories } from "../lib/ranking/rankStories";
import { createStubGateway } from "../lib/ranking/storage";
import type { ScrapedXPost } from "../lib/x-publisher";
import type { RawContent } from "../schemas/rawContent";
import type { RankGenerate } from "../lib/ranking/llmScore";
import type { RankInputItem, Region } from "../schemas/ranking";

const NOW = new Date();

/** A clearly-fictional synthetic post (no real company/person/facts). */
function synthPost(handle: string, n: number, likes: number, opts: { truncated?: boolean } = {}): ScrapedXPost {
  return {
    text:
      `Synthetic demo post #${n} from @${handle}: fictional company "Nimbus Robotics" ships a demo widget. ` +
      `No real facts — offline smoke-run content only.` + (opts.truncated ? " … (show more)" : ""),
    url: `https://x.com/${handle}/status/${1000 + n}`,
    author_handle: handle,
    at: NOW.toISOString(),
    is_reply: false,
    is_repost: false,
    replies: 4,
    reposts: Math.round(likes / 10),
    likes,
    views: likes * 25,
    dom_index: n,
    outbound_urls: [`https://nimbus-robotics.example/${handle}/${n}`],
    text_truncated: !!opts.truncated,
    quoted: null,
    thread_texts: [],
  };
}

/** Heuristic (no-LLM) query generator: fixed, safe query strings per topic. */
const heuristicQueries: RunDiscoveryDeps["generateQueries"] = async (topics) =>
  new Map(topics.map((t) => [t, [`${t} min_faves:300 filter:links -filter:replies lang:en`]]));

async function runGoodDiscovery(config: XDiscoveryConfig) {
  const accounts = createDiscoveredAccountsStubGateway([], config);
  const health = createXScrapeHealthStubGateway();
  const budget = createXBudgetStubGateway();
  const savedPosts = createSavedXPostsStubGateway();

  let seq = 0;
  const mockSearch: XSearchFn = async ({ query, tab }) => {
    seq++;
    // Two synthetic accounts per query; make one post text_truncated.
    const posts = [
      synthPost("nimbus_labs", seq * 10 + 1, 420),
      synthPost("nimbus_labs", seq * 10 + 2, 380, { truncated: true }),
      synthPost("orbit_founder", seq * 10 + 3, 260),
    ];
    return { success: true, query, tab, count: posts.length, posts };
  };

  const deps: RunDiscoveryDeps = {
    config,
    generateQueries: heuristicQueries,
    search: mockSearch,
    accounts,
    health,
    budget,
    savedPosts,
    now: NOW,
    sleep: async () => {},
    rng: () => 0.5,
    log: (ev, data) => console.log(`  [disc] ${ev} ${JSON.stringify(data)}`),
  };

  const report = await runDiscovery(deps);
  return { report, accounts, savedPosts };
}

async function runBlockedDiscovery(config: XDiscoveryConfig) {
  const blockSearch: XSearchFn = async ({ query, tab }) => ({
    success: false,
    query,
    tab,
    count: 0,
    posts: [],
    stopReason: "login_wall",
  });
  const report = await runDiscovery({
    config: { ...config, topics: ["AI"], maxTopicsPerSession: 1 },
    generateQueries: heuristicQueries,
    search: blockSearch,
    accounts: createDiscoveredAccountsStubGateway([], config),
    health: createXScrapeHealthStubGateway(),
    budget: createXBudgetStubGateway(),
    savedPosts: createSavedXPostsStubGateway(),
    now: NOW,
    sleep: async () => {},
    rng: () => 0.5,
    log: () => {},
  });
  return report;
}

/** Map a saved X RawContent to a RankInputItem (mirror of the workflow mapper). */
function rawToRankItem(raw: RawContent): RankInputItem {
  const md = raw.metadata ?? {};
  const summary = (raw.content || raw.title || "").replace(/\s+/g, " ").trim().slice(0, 800);
  const eng = md["engagementRaw"] as { likes?: number; reposts?: number; replies?: number; views?: number } | undefined;
  return {
    id: raw.id,
    clusterId: raw.id,
    title: (raw.title || "").trim(),
    summary,
    url: raw.url,
    source: raw.sourceName,
    region: "GLOBAL" as Region,
    publishedAt: raw.publishedAt ?? raw.collectedAt,
    rawCategories: [],
    clusterSourceCount: 1,
    isX: true,
    isReply: !!md["isReply"],
    isRepost: !!md["isRepost"],
    outboundUrls: Array.isArray(md["outboundUrls"]) ? (md["outboundUrls"] as string[]) : [],
    authorHandle: typeof md["authorHandle"] === "string" ? (md["authorHandle"] as string) : undefined,
    ...(eng ? { engagementRaw: { likes: eng.likes ?? 0, reposts: eng.reposts ?? 0, replies: eng.replies ?? 0, views: eng.views ?? 0 } } : {}),
    accountMedianLikes: typeof md["accountMedianLikes"] === "number" ? (md["accountMedianLikes"] as number) : 0,
    accountMedianReposts: typeof md["accountMedianReposts"] === "number" ? (md["accountMedianReposts"] as number) : 0,
    accountStatus: typeof md["accountStatus"] === "string" ? (md["accountStatus"] as string) : "candidate",
    isOfficialAccount: !!md["isOfficialAccount"],
    accountCredibilityScore: typeof md["accountCredibilityScore"] === "number" ? (md["accountCredibilityScore"] as number) : 0,
  };
}

/** Offline heuristic ranker — emits the full LlmScore shape (8 new fields). */
const heuristicRank: RankGenerate = async (prompt) => {
  const arr = JSON.parse(prompt.slice(prompt.indexOf("["))) as Array<{ id: string; title: string; summary: string }>;
  const scores = arr.map((it) => {
    const t = `${it.title} ${it.summary}`.toLowerCase();
    const strong = /ship|launch|release|unveil|raises?/.test(t);
    return {
      id: it.id,
      topic: "deeptech",
      topicFit: 7,
      significance: strong ? 7 : 5,
      audienceInterest: 6,
      visualPotential: 6,
      isOpinionOrRumor: false,
      isClickbait: false,
      isDuplicateAngle: false,
      isNewInformation: true,
      isPrimarySource: false,
      specificity: 6,
      hookPotential: 6,
      claimRisk: "low",
      flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
      derivedHeadline: it.title.slice(0, 120),
      headlineDerived: true,
      reason: "offline heuristic (demo)",
    };
  });
  return { text: JSON.stringify({ scores }), usage: { totalTokens: 0 } };
};

async function main(): Promise<void> {
  console.log("\n=== X DISCOVERY : OFFLINE DEMO (nothing scraped, nothing published) ===\n");
  const config: XDiscoveryConfig = { ...getXDiscoveryConfig(), topics: ["AI", "startups", "deeptech"], maxTopicsPerSession: 3 };

  console.log("-- Discovery run (mock search, stub gateways) --");
  const { report, accounts, savedPosts } = await runGoodDiscovery(config);
  console.log(`\nQueries generated (${report.queries.length}):`);
  for (const q of report.queries) console.log(`  • ${q}`);
  console.log(`\nPosts scraped & saved: ${report.postsScraped} · accounts touched: ${report.accountsTouched} · promoted: ${report.promoted.length}`);

  const roster = await accounts.list();
  console.log(`\nAccounts discovered:`);
  for (const a of roster) {
    console.log(`  @${a.handle}  status=${a.status}  seen=${a.timesSeen}  medianLikes=${a.medianLikes}  credibility=${a.credibilityScore}`);
  }

  console.log(`\n-- Simulated block pass --`);
  const blocked = await runBlockedDiscovery(config);
  console.log(`  aborted=${blocked.aborted} blocked=${blocked.blocked} stopReason=${blocked.stopReason} (cooldown set; RSS continues)`);

  // Rank the saved posts the discovery run produced, fully offline.
  console.log(`\n-- Ranking the saved X posts (offline heuristic) --`);
  const collected = await collectXPosts({ savedPosts, now: NOW, config });
  const items = collected.items.map(rawToRankItem);
  const truncated = collected.items.filter((r) => r.metadata?.["textTruncated"] === true);

  const result = await rankStories(items, {
    generate: heuristicRank,
    gateway: createStubGateway(),
    now: NOW,
    persist: false,
    log: () => {},
  });

  console.log(`\nTop ${Math.min(5, result.ranked.length)} ranked:`);
  for (const [i, r] of result.ranked.slice(0, 5).entries()) {
    const c = r.components;
    console.log(
      `  ${i + 1}. [final ${r.finalScore}] @${r.item.authorHandle ?? "?"}  ${r.item.title.slice(0, 60)}`,
    );
    console.log(
      `       qualityScore=${c.qualityScore} engagement=${c.engagementComponent} (ratio ${c.engagementRatio}) ` +
        `corroboration=${c.corroborationComponent} recencyMultiplier=${c.recencyMultiplier} penalties=${c.penalties}`,
    );
  }

  console.log(`\nTruncated posts (text_truncated): ${truncated.length}`);
  for (const t of truncated) console.log(`  • ${t.url}`);
  console.log(`Blocked branch this run: ${blocked.blocked ? `yes (${blocked.stopReason})` : "no"}`);

  console.log(`\nDone. Everything offline; no scrape, no publish.\n`);
}

main().catch((err) => {
  console.error("x:discover:demo failed:", err);
  process.exit(1);
});
