import { test } from "node:test";
import assert from "node:assert/strict";
import { hardFilter, DROP_REASONS } from "../../src/mastra/lib/ranking/hardFilter";
import { rankingConfig } from "../../src/mastra/config/ranking.config";
import type { RankInputItem } from "../../src/mastra/schemas/ranking";

/**
 * FEAT-005 — the X branch of the Stage-A hard filter. X items use the X knobs
 * (engagement floor, min text length, reply/repost drop) and SKIP the RSS
 * SUMMARY_TOO_SHORT rule; too_old stays the single source of truth for the 24h
 * drop and is proven elsewhere. The final case proves the branch really is a
 * branch: an identically-short RSS item is still dropped by the RSS rule.
 */

const NOW = new Date("2026-10-13T12:00:00.000Z");

function fresh(): string {
  return new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // 1h old
}

function xItem(overrides: Partial<RankInputItem> = {}): RankInputItem {
  return {
    id: overrides.id ?? "x1",
    clusterId: overrides.clusterId ?? "cx1",
    title: overrides.title ?? "Short title",
    summary: overrides.summary ?? "",
    url: overrides.url ?? "https://x.com/acme/status/1",
    source: overrides.source ?? "X/@acme",
    region: overrides.region ?? "GLOBAL",
    publishedAt: overrides.publishedAt ?? fresh(),
    rawCategories: [],
    clusterSourceCount: 1,
    isX: true,
    isReply: overrides.isReply ?? false,
    isRepost: overrides.isRepost ?? false,
    outboundUrls: overrides.outboundUrls ?? [],
    authorHandle: overrides.authorHandle ?? "@acme",
    engagementRaw: overrides.engagementRaw ?? { likes: 100, reposts: 20, replies: 5, views: 10_000 },
  };
}

test("an X post with an outbound link + engagement survives (short summary is fine for X)", () => {
  const item = xItem({
    summary: "", // would fail the RSS rule, but X skips it
    outboundUrls: ["https://acme.example/post"],
    engagementRaw: { likes: 80, reposts: 10, replies: 4, views: 5000 },
  });
  const res = hardFilter({ items: [item], now: NOW });
  assert.equal(res.kept.length, 1);
  assert.equal(res.drops.length, 0);
});

test("an X post with long text (no outbound) and engagement survives", () => {
  const longText = "A".repeat(rankingConfig.x.minTextLength + 10);
  const item = xItem({ title: longText, outboundUrls: [] });
  const res = hardFilter({ items: [item], now: NOW });
  assert.equal(res.kept.length, 1);
});

test("replies are always dropped", () => {
  const item = xItem({ id: "reply", isReply: true, outboundUrls: ["https://acme.example/x"] });
  const res = hardFilter({ items: [item], now: NOW });
  assert.equal(res.kept.length, 0);
  assert.equal(res.drops[0]?.reason, DROP_REASONS.X_IS_REPLY_OR_REPOST);
});

test("reposts are always dropped", () => {
  const item = xItem({ id: "repost", isRepost: true, outboundUrls: ["https://acme.example/x"] });
  const res = hardFilter({ items: [item], now: NOW });
  assert.equal(res.kept.length, 0);
  assert.equal(res.drops[0]?.reason, DROP_REASONS.X_IS_REPLY_OR_REPOST);
});

test("a bare no-source one-liner under minTextLength is dropped (X_NO_SOURCE_SHORT)", () => {
  const item = xItem({
    id: "tiny",
    title: "gm", // well under minTextLength
    summary: "",
    outboundUrls: [],
    engagementRaw: { likes: 500, reposts: 100, replies: 10, views: 99_999 }, // clears the floor
  });
  const res = hardFilter({ items: [item], now: NOW });
  assert.equal(res.kept.length, 0);
  assert.equal(res.drops[0]?.reason, DROP_REASONS.X_NO_SOURCE_SHORT);
});

test("an X post below the engagement floor is dropped (X_BELOW_ENGAGEMENT_FLOOR)", () => {
  const item = xItem({
    id: "quiet",
    outboundUrls: ["https://acme.example/post"],
    engagementRaw: { likes: 1, reposts: 0, replies: 0, views: 10 }, // below minEngagementFloor
  });
  const res = hardFilter({ items: [item], now: NOW });
  assert.equal(res.kept.length, 0);
  assert.equal(res.drops[0]?.reason, DROP_REASONS.X_BELOW_ENGAGEMENT_FLOOR);
});

test("branch proof: an identically short RSS item is still dropped by SUMMARY_TOO_SHORT", () => {
  // Same short summary as the surviving X post, but without isX -> RSS rule bites.
  const rssItem: RankInputItem = {
    id: "rss-short",
    clusterId: "c-rss",
    title: "Short RSS title",
    summary: "too short",
    url: "https://example.com/story",
    source: "The Verge",
    region: "US",
    publishedAt: fresh(),
    rawCategories: [],
    clusterSourceCount: 1,
  };
  const res = hardFilter({ items: [rssItem], now: NOW });
  assert.equal(res.kept.length, 0);
  assert.equal(res.drops[0]?.reason, DROP_REASONS.SUMMARY_TOO_SHORT);
});
