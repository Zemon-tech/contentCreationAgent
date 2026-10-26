import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDiscovery, type XSearchFn } from "../../src/mastra/lib/x-discovery/runDiscovery";
import { collectXPosts } from "../../src/mastra/lib/collect-x-posts";
import { rankStories } from "../../src/mastra/lib/ranking/rankStories";
import { createStubGateway } from "../../src/mastra/lib/ranking/storage";
import { createDiscoveredAccountsStubGateway } from "../../src/mastra/lib/x-discovery/stores/discoveredAccounts";
import { createXScrapeHealthStubGateway } from "../../src/mastra/lib/x-discovery/stores/xScrapeHealth";
import { createXBudgetStubGateway } from "../../src/mastra/lib/x-discovery/stores/xBudget";
import { createSavedXPostsStubGateway, type SavedXPostsGateway } from "../../src/mastra/lib/x-discovery/stores/savedXPosts";
import { getXDiscoveryConfig } from "../../src/mastra/config/xDiscovery";
import type { RankGenerate } from "../../src/mastra/lib/ranking/llmScore";
import type { RankInputItem } from "../../src/mastra/schemas/ranking";

/**
 * FEAT-005 FR-E4 — fail-soft everywhere X touches the pipeline:
 *  (i)  a stop condition (login_wall / captcha / http_429 / empty-twice) aborts
 *       the X branch, sets an escalating cooldown, and NEVER throws.
 *  (ii) a SavedXPostsGateway whose recentWithin throws yields { items: [],
 *       perAccount: [] } from collectXPosts, and the RSS ranker still runs.
 *       collectXPosts also has NO scraper in its import graph (structural
 *       feed-only guarantee).
 */

const NOW = new Date("2026-10-13T12:00:00.000Z");

function deps(search: XSearchFn | undefined, extra: Partial<Parameters<typeof runDiscovery>[0]> = {}) {
  return {
    config: getXDiscoveryConfig(),
    // Force the deterministic query template (no LLM/network).
    generateQueries: async (topics: string[]) =>
      new Map(topics.map((t) => [t, [`${t} min_faves:300 filter:links -filter:replies lang:en`]])),
    search,
    accounts: createDiscoveredAccountsStubGateway(),
    health: createXScrapeHealthStubGateway(),
    budget: createXBudgetStubGateway(),
    savedPosts: createSavedXPostsStubGateway(),
    now: NOW,
    sleep: async () => {},
    rng: () => 0.5,
    log: () => {},
    ...extra,
  };
}

for (const reason of ["login_wall", "captcha", "unusual_activity", "http_429"] as const) {
  test(`runDiscovery aborts on a ${reason} block, sets a cooldown, never throws`, async () => {
    const search: XSearchFn = async ({ query, tab }) => ({
      success: false,
      query,
      tab,
      count: 0,
      posts: [],
      stopReason: reason,
    });
    const health = createXScrapeHealthStubGateway();
    const report = await runDiscovery(deps(search, { health }));
    assert.equal(report.aborted, true);
    assert.equal(report.blocked, true);
    assert.equal(report.stopReason, reason);
    const saved = await health.load();
    assert.ok(saved.cooldownUntil, "a cooldown must be set after a block");
    // First stop -> first rung of the ladder (12h by default).
    const until = Date.parse(saved.cooldownUntil!);
    const expected = NOW.getTime() + getXDiscoveryConfig().stopCooldownHoursLadder[0]! * 3_600_000;
    assert.equal(until, expected);
  });
}

test("empty results twice in a row abort the X branch with stopReason 'empty'", async () => {
  const search: XSearchFn = async ({ query, tab }) => ({ success: true, query, tab, count: 0, posts: [] });
  const health = createXScrapeHealthStubGateway();
  const report = await runDiscovery(deps(search, { health }));
  assert.equal(report.aborted, true);
  assert.equal(report.stopReason, "empty");
  const saved = await health.load();
  assert.ok(saved.cooldownUntil, "empty-limit also starts a cooldown");
});

test("the escalating cooldown ladder advances 12h -> 24h on repeated stops", async () => {
  const ladder = getXDiscoveryConfig().stopCooldownHoursLadder; // [12, 24, 48]
  const blockSearch: XSearchFn = async ({ query, tab }) => ({ success: false, query, tab, count: 0, posts: [], stopReason: "http_429" });

  // Seed the health so the FIRST run is NOT in cooldown but has ladder index 1.
  const health = createXScrapeHealthStubGateway({ cooldownLadderIndex: 1 });
  const report = await runDiscovery(deps(blockSearch, { health }));
  assert.equal(report.blocked, true);
  const saved = await health.load();
  const until = Date.parse(saved.cooldownUntil!);
  // Index 1 -> the 24h rung.
  assert.equal(until, NOW.getTime() + ladder[1]! * 3_600_000);
  // And the index advanced toward the 48h rung (capped at the last index).
  assert.equal(saved.cooldownLadderIndex, 2);
});

test("runDiscovery never throws even when a gateway throws (top-level fail-soft)", async () => {
  const search: XSearchFn = async ({ query, tab }) => ({
    success: true,
    query,
    tab,
    count: 1,
    posts: [
      {
        text: "Synthetic post body long enough to be a candidate for the offline test run.",
        url: "https://x.com/acme/status/1",
        author_handle: "acme",
        at: NOW.toISOString(),
        is_reply: false,
        is_repost: false,
        replies: 1,
        reposts: 2,
        likes: 50,
        views: 1000,
        dom_index: 0,
        outbound_urls: ["https://acme.example/post"],
        text_truncated: false,
        quoted: null,
        thread_texts: [],
      },
    ],
  });
  const throwingAccounts = createDiscoveredAccountsStubGateway();
  throwingAccounts.upsertFromScrape = async () => {
    throw new Error("boom");
  };
  // Even with a throwing accounts gateway, the learn step is caught per-author
  // and the run returns a clean report.
  const report = await runDiscovery(deps(search, { accounts: throwingAccounts }));
  assert.equal(typeof report.aborted, "boolean");
});

test("collectXPosts fails soft when recentWithin throws (empty result, no throw)", async () => {
  const bad: SavedXPostsGateway = {
    saveMany: async () => {},
    recentWithin: async () => {
      throw new Error("store down");
    },
  };
  const result = await collectXPosts({ savedPosts: bad, now: NOW, config: { ...getXDiscoveryConfig(), enabled: true } });
  assert.deepEqual(result, { items: [], perAccount: [] });
});

test("the RSS ranker still ranks when the X signal contributes nothing", async () => {
  // Prove the main pipeline survives an empty X contribution: rank an RSS-only
  // item set with an offline heuristic generator and a stub gateway.
  const rssItems: RankInputItem[] = [
    {
      id: "r1",
      clusterId: "c1",
      title: "A concrete RSS story about a new AI model launch",
      summary: "A sufficiently long, concrete summary that clears the minimum length for scoring.",
      url: "https://example.com/story",
      source: "The Verge",
      region: "US",
      publishedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
      rawCategories: [],
      clusterSourceCount: 2,
    },
  ];
  const generate: RankGenerate = async () => ({
    text: JSON.stringify({
      scores: [
        {
          id: "r1",
          topic: "ai",
          topicFit: 8,
          significance: 8,
          audienceInterest: 7,
          visualPotential: 6,
          isOpinionOrRumor: false,
          isClickbait: false,
          isDuplicateAngle: false,
          isNewInformation: true,
          isPrimarySource: true,
          specificity: 8,
          hookPotential: 7,
          claimRisk: "low",
          flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
          derivedHeadline: "A concrete RSS story about a new AI model launch",
          headlineDerived: true,
          reason: "offline heuristic",
        },
      ],
    }),
    usage: { totalTokens: 0 },
  });

  const result = await rankStories(rssItems, { generate, gateway: createStubGateway(), now: NOW, persist: false, log: () => {} });
  assert.equal(result.ranked.length, 1);
  assert.equal(result.ranked[0]?.item.id, "r1");
});

test("collectXPosts has NO scraper in its import graph (feed-only guarantee)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../src/mastra/lib/collect-x-posts.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(!/scrapeXPosts|searchXPosts|checkXSession|getXWatchConfig/.test(src), "no scraper reference may remain in collect-x-posts.ts");
});
