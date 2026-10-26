import { test } from "node:test";
import assert from "node:assert/strict";
import { hardFilter, DROP_REASONS, ageInHours, type BlockState } from "../../src/mastra/lib/ranking/hardFilter";
import { rankingConfig, type RankingConfig } from "../../src/mastra/config/ranking.config";
import type { RankInputItem } from "../../src/mastra/schemas/ranking";

const NOW = new Date("2026-10-13T12:00:00.000Z");

function item(overrides: Partial<RankInputItem> = {}): RankInputItem {
  return {
    id: overrides.id ?? "i1",
    clusterId: overrides.clusterId ?? "c1",
    title: overrides.title ?? "OpenAI launches a new model with concrete specs",
    summary:
      overrides.summary ??
      "A clear, concrete news summary that comfortably exceeds the minimum length requirement for scoring.",
    url: overrides.url ?? "https://example.com/story",
    source: overrides.source ?? "The Verge",
    region: overrides.region ?? "US",
    publishedAt: overrides.publishedAt ?? new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // 1h old
    rawCategories: overrides.rawCategories ?? ["ai"],
    clusterSourceCount: overrides.clusterSourceCount ?? 2,
    ...(overrides.imageUrl ? { imageUrl: overrides.imageUrl } : {}),
    ...(overrides.sourceDisabled !== undefined ? { sourceDisabled: overrides.sourceDisabled } : {}),
  };
}

test("keeps a fresh, valid item", () => {
  const res = hardFilter({ items: [item()], now: NOW });
  assert.equal(res.kept.length, 1);
  assert.equal(res.drops.length, 0);
});

test("drops items older than maxAgeHours", () => {
  // Default maxAgeHours is 24h (FEAT-003), so use an item well beyond it.
  const old = item({ id: "old", publishedAt: new Date(NOW.getTime() - 30 * 3_600_000).toISOString() });
  const res = hardFilter({ items: [old], now: NOW });
  assert.equal(res.kept.length, 0);
  assert.equal(res.drops[0]?.reason, DROP_REASONS.TOO_OLD);
});

test("drops items with an unparseable publishedAt", () => {
  const res = hardFilter({ items: [item({ publishedAt: "not-a-date" })], now: NOW });
  assert.equal(res.drops[0]?.reason, DROP_REASONS.TOO_OLD);
});

test("drops blocklisted items (title or summary)", () => {
  const res = hardFilter({
    items: [item({ id: "sport", title: "IPL cricket final breaks viewership records" })],
    now: NOW,
  });
  assert.equal(res.drops[0]?.reason, DROP_REASONS.BLOCKLIST);
  assert.equal(res.drops[0]?.detail, "cricket");
});

test("drops too-short or empty summaries", () => {
  const res = hardFilter({ items: [item({ summary: "too short" })], now: NOW });
  assert.equal(res.drops[0]?.reason, DROP_REASONS.SUMMARY_TOO_SHORT);
});

test("drops items from a disabled source (config list)", () => {
  const cfg: RankingConfig = { ...rankingConfig, disabledSources: ["spam blog"] };
  const res = hardFilter({ items: [item({ source: "Spam Blog" })], config: cfg, now: NOW });
  assert.equal(res.drops[0]?.reason, DROP_REASONS.SOURCE_DISABLED);
});

test("drops items from a source disabled via the upstream flag", () => {
  const res = hardFilter({ items: [item({ sourceDisabled: true })], now: NOW });
  assert.equal(res.drops[0]?.reason, DROP_REASONS.SOURCE_DISABLED);
});

test("drops already-posted and already-rejected clusters", () => {
  const blocked = new Map<string, BlockState>([
    ["c-posted", "posted"],
    ["c-rejected", "rejected"],
  ]);
  const items = [
    item({ id: "p", clusterId: "c-posted" }),
    item({ id: "r", clusterId: "c-rejected" }),
    item({ id: "ok", clusterId: "c-ok" }),
  ];
  const res = hardFilter({ items, now: NOW, blocked });
  assert.equal(res.kept.length, 1);
  assert.equal(res.kept[0]?.id, "ok");
  assert.equal(res.droppedByReason[DROP_REASONS.ALREADY_POSTED], 1);
  assert.equal(res.droppedByReason[DROP_REASONS.ALREADY_REJECTED], 1);
});

test("groups dropped counts by reason", () => {
  const items = [
    item({ id: "a", publishedAt: new Date(NOW.getTime() - 48 * 3_600_000).toISOString() }),
    item({ id: "b", publishedAt: new Date(NOW.getTime() - 49 * 3_600_000).toISOString() }),
    item({ id: "c", summary: "short" }),
  ];
  const res = hardFilter({ items, now: NOW });
  assert.equal(res.droppedByReason[DROP_REASONS.TOO_OLD], 2);
  assert.equal(res.droppedByReason[DROP_REASONS.SUMMARY_TOO_SHORT], 1);
});

test("ageInHours returns null for garbage and a positive number for the past", () => {
  assert.equal(ageInHours("nope", NOW), null);
  assert.equal(ageInHours(new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), NOW), 2);
});
