import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRasPayload } from "../../src/mastra/lib/ras/payload";
import { RasPayloadSchema } from "../../src/mastra/schemas/handoff";
import type { FactPack } from "../../src/mastra/schemas/factpack";
import type { RankInputItem, RankedStory } from "../../src/mastra/schemas/ranking";
import type { EditorialCopy } from "../../src/mastra/lib/ras/copywriter";

/**
 * X caption (xCaption) on the RAS payload:
 *  - LLM-copy path honors a provided xCaption and keeps it <= 280;
 *  - deterministic fallback (no llmCopy.xCaption) still yields a <= 280 caption;
 *  - an X-only story's fallback includes the 'per @handle on X' attribution;
 *  - an over-length LLM xCaption is clipped word-safe to <= 280.
 */

const image = { imageLocalPath: "/tmp/i.jpg", imageSourceUrl: "https://ex.com/i.jpg", imageAttribution: "ex.com", under1080: false };

function factPack(overrides: Partial<FactPack> = {}): FactPack {
  return {
    headline: overrides.headline ?? "Fact pack headline",
    keyFacts: overrides.keyFacts ?? ["a grounded key fact", "another grounded fact"],
    figures: overrides.figures ?? [],
    names: overrides.names ?? [],
    sourceUrls: overrides.sourceUrls ?? ["https://ex.com/story"],
    conflicts: [],
    factPackLimited: overrides.factPackLimited ?? false,
    ...(overrides.primarySource ? { primarySource: overrides.primarySource } : {}),
  };
}

function rankedStory(item: RankInputItem, overrides: Partial<RankedStory> = {}): RankedStory {
  return {
    item,
    llm: null,
    unscored: false,
    qualityScore: 80,
    finalScore: 80,
    components: {} as never,
    weightedContributions: {},
    appliedPenalties: [],
    reason: "test",
    ...overrides,
  };
}

function rssItem(): RankInputItem {
  return {
    id: "r1",
    clusterId: "cr1",
    title: "An RSS headline",
    summary: "An RSS summary long enough to be meaningful content.",
    url: "https://ex.com/story",
    source: "The Verge",
    region: "US",
    publishedAt: new Date().toISOString(),
    rawCategories: ["ai"],
    clusterSourceCount: 2,
  };
}

const baseCopy: EditorialCopy = {
  serifHeadline: "Acme lands $20M to scale its AI stack",
  deckLead: "Series A fuels the next build phase",
  deckHighlight: "$20M raised",
  deckTail: "Foo Ventures leads the round",
  caption: "Acme raised $20M in a Series A led by Foo Ventures.\n\nSource: https://ex.com/a",
};

test("LLM-copy path: xCaption honored and <= 280", () => {
  const item = rssItem();
  const tweet = "Acme just raised $20M (Series A, led by Foo Ventures) to scale its AI stack. #startups";
  const payload = buildRasPayload({
    item,
    factPack: factPack({ primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, xCaption: tweet },
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  assert.ok(payload.xCaption.length <= 280);
  assert.equal(payload.xCaption, tweet);
});

test("deterministic fallback path: no llmCopy.xCaption still yields a <= 280 caption", () => {
  const item = rssItem();
  const payload = buildRasPayload({
    item,
    factPack: factPack({ headline: "Acme raises $20M Series A", primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  assert.ok(payload.xCaption.length > 0, "fallback must produce a non-empty tweet");
  assert.ok(payload.xCaption.length <= 280);
  assert.ok(payload.xCaption.includes("Acme raises $20M"), "fallback leads with the headline");
});

test("X-only story fallback includes the 'per @handle on X' attribution within 280", () => {
  const item: RankInputItem = {
    id: "x1",
    clusterId: "cx1",
    title: "raw first line of the post",
    summary: "an X post body",
    url: "https://x.com/acme/status/1",
    source: "X/@acme",
    region: "GLOBAL",
    publishedAt: new Date().toISOString(),
    rawCategories: [],
    clusterSourceCount: 1,
    isX: true,
    authorHandle: "@acme",
    outboundUrls: ["https://acme.example/post"],
  };
  const story = rankedStory(item, {
    derivedHeadline: "Acme ships its new model",
    claimRisk: "medium",
    verified: false,
    outboundUrls: ["https://acme.example/post"],
  });
  const payload = buildRasPayload({ item, factPack: factPack(), image, story, authorHandle: "acme", isXOnly: true });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  assert.ok(payload.xCaption.length <= 280);
  assert.ok(payload.xCaption.includes("per @acme on X"), "X-only fallback carries attribution");
  assert.ok(payload.xCaption.includes("Acme ships its new model"), "leads with the derived headline");
});

test("over-length LLM xCaption is clipped word-safe to <= 280", () => {
  const item = rssItem();
  const longTweet = "Word ".repeat(100).trim(); // 500 chars, all word boundaries
  const payload = buildRasPayload({
    item,
    factPack: factPack({ primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, xCaption: longTweet },
    isXOnly: false,
  });
  assert.ok(payload.xCaption.length <= 280);
  assert.ok(!payload.xCaption.includes("..."), "no ellipsis — word-boundary clip");
});
