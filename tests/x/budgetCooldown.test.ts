import { test } from "node:test";
import assert from "node:assert/strict";
import { runDiscovery, type XSearchFn } from "../../src/mastra/lib/x-discovery/runDiscovery";
import { createDiscoveredAccountsStubGateway } from "../../src/mastra/lib/x-discovery/stores/discoveredAccounts";
import { createXScrapeHealthStubGateway } from "../../src/mastra/lib/x-discovery/stores/xScrapeHealth";
import { createXBudgetStubGateway, dayKey } from "../../src/mastra/lib/x-discovery/stores/xBudget";
import { createSavedXPostsStubGateway } from "../../src/mastra/lib/x-discovery/stores/savedXPosts";
import { getXDiscoveryConfig, type XDiscoveryConfig } from "../../src/mastra/config/xDiscovery";

/**
 * FEAT-005 — budget, per-query cooldown, day-boundary reset, and the escalating
 * stop ladder. All against stub gateways, fully offline, deterministic.
 */

const NOW = new Date("2026-10-13T12:00:00.000Z");

/** A search that always returns one synthetic post for `query`. */
const okSearch: XSearchFn = async ({ query, tab }) => ({
  success: true,
  query,
  tab,
  count: 1,
  posts: [
    {
      text: `Synthetic result for ${query} — long enough to be a candidate for the offline test.`,
      url: `https://x.com/acme/status/${encodeURIComponent(query).slice(0, 8)}`,
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

function baseDeps(overrides: Partial<Parameters<typeof runDiscovery>[0]> = {}) {
  return {
    config: getXDiscoveryConfig(),
    generateQueries: async (topics: string[]) =>
      new Map(topics.map((t) => [t, [`${t} min_faves:300 filter:links -filter:replies lang:en`]])),
    search: okSearch,
    accounts: createDiscoveredAccountsStubGateway(),
    health: createXScrapeHealthStubGateway(),
    budget: createXBudgetStubGateway(),
    savedPosts: createSavedXPostsStubGateway(),
    now: NOW,
    sleep: async () => {},
    rng: () => 0.5,
    log: () => {},
    ...overrides,
  };
}

test("when the day's search-load budget is already spent, the session is skipped and logged", async () => {
  const config = getXDiscoveryConfig();
  const day = dayKey(NOW, config.dayBoundaryTz);
  const budget = createXBudgetStubGateway([{ id: day, searchLoads: config.maxSearchLoadsPerDay, profileVisits: 0 }]);
  const events: string[] = [];
  const report = await runDiscovery(
    baseDeps({ budget, log: (ev) => events.push(ev) }),
  );
  assert.equal(report.aborted, true);
  assert.equal(report.stopReason, "budget_exhausted");
  assert.ok(events.includes("x.discovery.budget_exhausted"));
  assert.equal(report.budgetUsed.searchLoads, 0);
});

test("budget exhausted mid-session stops further searches", async () => {
  // Leave room for exactly one search load, then run two topics.
  const config: XDiscoveryConfig = { ...getXDiscoveryConfig(), topics: ["AI", "startups"], maxTopicsPerSession: 2, topMinPosts: 0 };
  const day = dayKey(NOW, config.dayBoundaryTz);
  const budget = createXBudgetStubGateway([{ id: day, searchLoads: config.maxSearchLoadsPerDay - 1, profileVisits: 0 }]);
  const report = await runDiscovery(baseDeps({ config, budget }));
  // Only one query could run before the budget was spent.
  assert.equal(report.budgetUsed.searchLoads, 1);
  assert.equal(report.stopReason, "budget_exhausted");
});

test("the same query within queryCooldownHours is skipped", async () => {
  const config = getXDiscoveryConfig();
  const query = "AI min_faves:300 filter:links -filter:replies lang:en";
  // Seed a last-run time 1h ago (< queryCooldownHours default 4h).
  const recent = new Date(NOW.getTime() - 1 * 3_600_000).toISOString();
  const health = createXScrapeHealthStubGateway({ lastQueryRunAt: { [query]: recent } });
  const events: string[] = [];
  const report = await runDiscovery(
    baseDeps({
      config: { ...config, topics: ["AI"], maxTopicsPerSession: 1 },
      health,
      generateQueries: async () => new Map([["AI", [query]]]),
      log: (ev) => events.push(ev),
    }),
  );
  assert.ok(events.includes("x.discovery.query_cooldown"));
  assert.equal(report.budgetUsed.searchLoads, 0); // nothing searched
});

test("a day-boundary key change resets the counters", async () => {
  const config = getXDiscoveryConfig();
  const yesterday = dayKey(new Date(NOW.getTime() - 24 * 3_600_000), config.dayBoundaryTz);
  const today = dayKey(NOW, config.dayBoundaryTz);
  assert.notEqual(yesterday, today);
  // Yesterday is maxed, but today's key is fresh -> today starts at 0.
  const budget = createXBudgetStubGateway([
    { id: yesterday, searchLoads: config.maxSearchLoadsPerDay, profileVisits: config.maxProfileVisitsPerDay },
  ]);
  const todayBudget = await budget.today(today);
  assert.equal(todayBudget.searchLoads, 0);
  assert.equal(todayBudget.profileVisits, 0);
  // And a run today is NOT blocked by yesterday's exhaustion.
  const report = await runDiscovery(
    baseDeps({ config: { ...config, topics: ["AI"], maxTopicsPerSession: 1, topMinPosts: 0 }, budget }),
  );
  assert.notEqual(report.stopReason, "budget_exhausted");
});

test("the escalating ladder 12 -> 24 -> 48 advances on repeats and caps at the last rung", async () => {
  const ladder = getXDiscoveryConfig().stopCooldownHoursLadder; // [12,24,48]
  const blockSearch: XSearchFn = async ({ query, tab }) => ({ success: false, query, tab, count: 0, posts: [], stopReason: "http_429" });

  // Run 1: index 0 -> 12h, index becomes 1.
  const health = createXScrapeHealthStubGateway();
  let r = await runDiscovery(baseDeps({ search: blockSearch, health, config: { ...getXDiscoveryConfig(), topics: ["AI"], maxTopicsPerSession: 1 } }));
  assert.equal(r.blocked, true);
  let h = await health.load();
  assert.equal(Date.parse(h.cooldownUntil!), NOW.getTime() + ladder[0]! * 3_600_000);
  assert.equal(h.cooldownLadderIndex, 1);

  // Run 2: clear the active cooldown (keep the index) and block again -> 24h, index 2.
  h.cooldownUntil = undefined;
  await health.save(h);
  r = await runDiscovery(baseDeps({ search: blockSearch, health, config: { ...getXDiscoveryConfig(), topics: ["AI"], maxTopicsPerSession: 1 } }));
  h = await health.load();
  assert.equal(Date.parse(h.cooldownUntil!), NOW.getTime() + ladder[1]! * 3_600_000);
  assert.equal(h.cooldownLadderIndex, 2);

  // Run 3: block again -> 48h, index capped at 2 (last rung).
  h.cooldownUntil = undefined;
  await health.save(h);
  r = await runDiscovery(baseDeps({ search: blockSearch, health, config: { ...getXDiscoveryConfig(), topics: ["AI"], maxTopicsPerSession: 1 } }));
  h = await health.load();
  assert.equal(Date.parse(h.cooldownUntil!), NOW.getTime() + ladder[2]! * 3_600_000);
  assert.equal(h.cooldownLadderIndex, 2);
});
