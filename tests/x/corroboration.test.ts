import { test } from "node:test";
import assert from "node:assert/strict";
import {
  urlKey,
  groupTextKey,
  matchOutboundToRss,
  corroborationGroupKey,
  buildCorroborationContext,
} from "../../src/mastra/lib/ranking/rankStories";
import { corroborationComponent } from "../../src/mastra/lib/ranking/score";
import { rankingConfig } from "../../src/mastra/config/ranking.config";
import type { RankInputItem } from "../../src/mastra/schemas/ranking";

/**
 * FEAT-005 FIX #4 — corroboration from mixed RSS + X items:
 *  - an X post whose outbound host matches an RSS url gets the RSS-match share;
 *  - >=2 promoted accounts sharing an outbound URL get the multi-account share;
 *  - MIXED-CASE hosts corroborate via the canonical urlKey (host lowercased);
 *  - the clusterId-equality path is gone: same-story X + RSS with DIFFERENT
 *    clusterIds still corroborate via URL.
 */

function rss(id: string, url: string, clusterId = id): RankInputItem {
  return {
    id,
    clusterId,
    title: "RSS story",
    summary: "a".repeat(60),
    url,
    source: "TechCrunch",
    region: "US",
    publishedAt: new Date().toISOString(),
    rawCategories: [],
    clusterSourceCount: 1,
  };
}

function xPost(id: string, handle: string, outbound: string[], clusterId = id, status: "promoted" | "candidate" = "promoted"): RankInputItem {
  return {
    id,
    clusterId,
    title: "X claim",
    summary: "b".repeat(60),
    url: `https://x.com/${handle}/status/${id}`,
    source: `X/@${handle}`,
    region: "GLOBAL",
    publishedAt: new Date().toISOString(),
    rawCategories: [],
    clusterSourceCount: 1,
    isX: true,
    authorHandle: `@${handle}`,
    accountStatus: status,
    outboundUrls: outbound,
    engagementRaw: { likes: 100, reposts: 20, replies: 5, views: 10_000 },
  };
}

test("urlKey lowercases the host and strips tracking", () => {
  assert.equal(urlKey("https://TechCrunch.com/x?utm_source=rss"), "https://techcrunch.com/x");
  // Mixed-case hosts collapse to the same key.
  assert.equal(urlKey("https://TECHCRUNCH.com/x"), urlKey("https://techcrunch.com/x"));
});

test("groupTextKey is stable: lowercased, punctuation stripped, first 12 tokens", () => {
  const a = groupTextKey("Nimbus Robotics ships its new arm!!!");
  const b = groupTextKey("nimbus robotics ships its new arm");
  assert.equal(a, b);
});

test("matchOutboundToRss: full-key and host-level matches (mixed case)", () => {
  const rssSet = new Set<string>([urlKey("https://TechCrunch.com/story")]);
  assert.equal(matchOutboundToRss(["https://techcrunch.com/story"], rssSet), true);
  // Host-level match (different path, same host).
  assert.equal(matchOutboundToRss(["https://TechCrunch.com/other-path"], rssSet), true);
  assert.equal(matchOutboundToRss(["https://unrelated.example/x"], rssSet), false);
  assert.equal(matchOutboundToRss([], rssSet), false);
});

test("an X post whose outbound matches an RSS url earns the RSS-match share", () => {
  const kept: RankInputItem[] = [
    rss("rss1", "https://TechCrunch.com/acme-launch"),
    xPost("x1", "acme", ["https://techcrunch.com/acme-launch"]),
  ];
  const ctx = buildCorroborationContext(kept);
  const comp = corroborationComponent(kept[1]!, ctx, rankingConfig);
  // RSS-match share of the 10-point component.
  assert.ok(Math.abs(comp - rankingConfig.x.corroborationRssShare * 10) < 1e-6);
});

test("mixed-case host: RSS https://TechCrunch.com vs X outbound https://techcrunch.com corroborate via urlKey", () => {
  const kept: RankInputItem[] = [
    rss("rss1", "https://TechCrunch.com/acme-launch", "cluster-A"),
    xPost("x1", "acme", ["https://techcrunch.com/acme-launch"], "cluster-B"), // DIFFERENT clusterId
  ];
  const ctx = buildCorroborationContext(kept);
  // clusterId-equality is gone: different clusterIds still corroborate via URL.
  assert.notEqual(kept[0]!.clusterId, kept[1]!.clusterId);
  const comp = corroborationComponent(kept[1]!, ctx, rankingConfig);
  assert.ok(comp >= rankingConfig.x.corroborationRssShare * 10 - 1e-6);
});

test(">=2 promoted accounts sharing an outbound URL earn the multi-account share", () => {
  const shared = "https://acme.example/launch";
  const kept: RankInputItem[] = [
    xPost("x1", "alpha", [shared], "cA"),
    xPost("x2", "beta", [shared], "cB"),
  ];
  // Both map to the same group key (shared outbound host).
  assert.equal(corroborationGroupKey(kept[0]!), corroborationGroupKey(kept[1]!));
  const ctx = buildCorroborationContext(kept);
  assert.equal(ctx.credibleAccountsByGroup.get(corroborationGroupKey(kept[0]!)), 2);
  // No RSS match here, only the multi-account share applies.
  const comp = corroborationComponent(kept[0]!, ctx, rankingConfig);
  assert.ok(Math.abs(comp - rankingConfig.x.corroborationMultiAccountShare * 10) < 1e-6);
});

test("a single promoted account (no RSS, no second account) earns no corroboration", () => {
  const kept: RankInputItem[] = [xPost("x1", "solo", ["https://acme.example/launch"])];
  const ctx = buildCorroborationContext(kept);
  assert.equal(corroborationComponent(kept[0]!, ctx, rankingConfig), 0);
});

test("only PROMOTED accounts count toward the multi-account group", () => {
  const shared = "https://acme.example/launch";
  const kept: RankInputItem[] = [
    xPost("x1", "alpha", [shared], "cA", "promoted"),
    xPost("x2", "beta", [shared], "cB", "candidate"), // not promoted
  ];
  const ctx = buildCorroborationContext(kept);
  // Only one promoted handle in the group -> below the 2-account threshold.
  assert.equal(ctx.credibleAccountsByGroup.get(corroborationGroupKey(kept[0]!)) ?? 0, 1);
  assert.equal(corroborationComponent(kept[0]!, ctx, rankingConfig), 0);
});
