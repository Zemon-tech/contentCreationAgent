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

test("LLM xCaption with >2 hashtags is capped to the first two", () => {
  const item = rssItem();
  const tweet = "Acme raised $20M Series A to scale its AI stack #ai #startups #funding #india #tech";
  const payload = buildRasPayload({
    item,
    factPack: factPack({ primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, xCaption: tweet },
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  const tags = payload.xCaption.match(/#[A-Za-z0-9_]+/g) ?? [];
  assert.equal(tags.length, 2, "at most two hashtags survive");
  assert.deepEqual(tags, ["#ai", "#startups"], "the first two are kept in order");
});

test("punctuation-adjacent hashtags are still capped to two", () => {
  const item = rssItem();
  // Tags follow '(' and ')' punctuation, not whitespace — the old
  // `(^|\s)#...` regex missed these, letting >2 tags through.
  const tweet = "Acme raised $20M (#ai) #ml #tech #india";
  const payload = buildRasPayload({
    item,
    factPack: factPack({ primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, xCaption: tweet },
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  const tags = payload.xCaption.match(/#[A-Za-z0-9_]+/g) ?? [];
  assert.equal(tags.length, 2, "at most two hashtags survive punctuation-adjacent tags");
});

test("slash-separated hashtags are still capped to two", () => {
  const item = rssItem();
  const tweet = "Acme raised $20M #ai/#ml/#tech/#india";
  const payload = buildRasPayload({
    item,
    factPack: factPack({ primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, xCaption: tweet },
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  const tags = payload.xCaption.match(/#[A-Za-z0-9_]+/g) ?? [];
  assert.equal(tags.length, 2, "slash-separated tags are counted and capped");
});

test("a '#fragment' inside a URL is not counted as a hashtag", () => {
  const item = rssItem();
  // Captions carry NO raw link: a URL in the model tweet is stripped, while the
  // two real hashtags next to it still count and cap at 2. (The URL's #section
  // fragment must NOT be mistaken for a hashtag once the URL is removed.)
  const tweet = "Acme raised $20M https://ex.com/p#section #ai #ml";
  const payload = buildRasPayload({
    item,
    factPack: factPack({ primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, xCaption: tweet },
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  // The URL is stripped; both real hashtags survive (<=2).
  assert.ok(!/https?:\/\//.test(payload.xCaption), "no raw URL in the tweet");
  assert.ok(!payload.xCaption.includes("ex.com"), "the stripped URL leaves no domain behind");
  const tags = payload.xCaption.match(/#[A-Za-z0-9_]+/g) ?? [];
  assert.deepEqual(tags, ["#ai", "#ml"], "both real hashtags survive, URL fragment not counted");
});

test("LLM single overlength token is dropped, not hard-cut mid-word", () => {
  const item = rssItem();
  // One unbroken 300-char token: there is no word boundary to clip on, so it
  // must be dropped entirely rather than published as a 280-char fragment.
  const monster = "A".repeat(300);
  const payload = buildRasPayload({
    item,
    factPack: factPack({ primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, xCaption: monster },
    isXOnly: false,
  });
  assert.ok(payload.xCaption.length <= 280);
  // No mid-word fragment of the monster token may survive.
  assert.ok(!payload.xCaption.includes("AAAAAAAAAA"), "overlength single token is not hard-cut into the tweet");
});

test("deterministic single overlength headline token is dropped, not hard-cut", () => {
  const item = rssItem();
  const monster = "B".repeat(320); // one token, no spaces, no usable source
  const payload = buildRasPayload({
    item,
    factPack: factPack({ headline: monster, sourceUrls: [] }),
    image,
    story: rankedStory(item),
    isXOnly: false,
  });
  assert.ok(payload.xCaption.length <= 280);
  assert.ok(!payload.xCaption.includes("BBBBBBBBBB"), "overlength single headline token is not hard-cut");
});

test("deterministic fallback never publishes the scrape source URL", () => {
  const item = rssItem();
  // The deterministic X caption no longer appends a source URL at all (captions
  // carry no raw link), so the source URL must never appear — whole OR partial.
  const longHeadline = "Acme ".repeat(50).trim() + " closes record round"; // ~270 chars
  const longUrl = "https://ex.com/" + "a".repeat(60);
  const payload = buildRasPayload({
    item,
    factPack: factPack({ headline: longHeadline, primarySource: longUrl }),
    image,
    story: rankedStory(item),
    isXOnly: false,
  });
  assert.ok(payload.xCaption.length <= 280);
  assert.ok(!/https?:\/\//.test(payload.xCaption), "no URL (whole or partial) in the tweet");
  assert.ok(!payload.xCaption.includes("ex.com"), "no source domain in the tweet");
});

test("deterministic fallback headline with >2 hashtags is capped to two", () => {
  const item = rssItem();
  // The hashtag cap must apply to the FINAL caption for the deterministic path
  // too — not only to model captions. A fallback headline carrying three tags
  // must be reduced to two.
  const payload = buildRasPayload({
    item,
    // No llmCopy.xCaption -> deterministic path; headline carries 3 hashtags.
    factPack: factPack({ headline: "Launch #ai #ml #tech", sourceUrls: [] }),
    image,
    story: rankedStory(item),
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  const tags = payload.xCaption.match(/#[A-Za-z0-9_]+/g) ?? [];
  assert.equal(tags.length, 2, "deterministic fallback caps hashtags at two");
  assert.deepEqual(tags, ["#ai", "#ml"], "the first two hashtags are kept in order");
});

test("whitespace-only model caption falls back to deterministic headline copy", () => {
  const item = rssItem();
  // A truthy-but-blank model value normalizes to empty; the deterministic
  // headline+source fallback must still produce a usable tweet (NOT empty).
  const payload = buildRasPayload({
    item,
    factPack: factPack({ headline: "Acme raises $20M Series A", primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, xCaption: "   \n  \t " },
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  assert.ok(payload.xCaption.length > 0, "whitespace model caption falls back, not empty");
  assert.ok(payload.xCaption.length <= 280);
  assert.ok(payload.xCaption.includes("Acme raises $20M"), "fallback leads with the headline");
});

test("unbreakable-token model caption falls back to deterministic headline copy", () => {
  const item = rssItem();
  // A single 300-char unbroken token normalizes to empty (no word boundary to
  // clip on); with usable headline/source data the deterministic fallback must
  // still produce a non-empty tweet rather than skipping X.
  const payload = buildRasPayload({
    item,
    factPack: factPack({ headline: "Acme raises $20M Series A", primarySource: "https://ex.com/story" }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, xCaption: "A".repeat(300) },
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  assert.ok(payload.xCaption.length > 0, "unbreakable model caption falls back, not empty");
  assert.ok(payload.xCaption.length <= 280);
  assert.ok(!payload.xCaption.includes("AAAAAAAAAA"), "the bad token does not leak in");
  assert.ok(payload.xCaption.includes("Acme raises $20M"), "fallback leads with the headline");
});

test("deterministic fallback omits the source URL even when it would fit", () => {
  const item = rssItem();
  // Captions carry no raw link: even a short source URL that WOULD fit under
  // 280 is never appended to the deterministic tweet.
  const url = "https://ex.com/story";
  const payload = buildRasPayload({
    item,
    factPack: factPack({ headline: "Acme raises $20M Series A", primarySource: url }),
    image,
    story: rankedStory(item),
    isXOnly: false,
  });
  assert.ok(payload.xCaption.length <= 280);
  assert.ok(!payload.xCaption.includes(url), "the source URL is never appended");
  assert.ok(!/https?:\/\//.test(payload.xCaption), "no URL at all in the deterministic tweet");
  assert.ok(payload.xCaption.includes("Acme raises $20M"), "fallback still leads with the headline");
});

test("Instagram caption carries no scrape URL in either copy path", () => {
  const item = rssItem();
  const url = "https://ex.com/story";
  // Deterministic path (no llmCopy): caption must have no URL / "Source:" line.
  const det = buildRasPayload({
    item,
    factPack: factPack({ headline: "Acme raises $20M Series A", primarySource: url, sourceUrls: [url] }),
    image,
    story: rankedStory(item),
    isXOnly: false,
  });
  assert.ok(!/https?:\/\//.test(det.caption), "deterministic IG caption has no URL");
  assert.ok(!/\bSource\s*:/i.test(det.caption), "deterministic IG caption has no 'Source:' line");

  // LLM path: a model caption that sneaks in a trailing Source link is stripped.
  const llm = buildRasPayload({
    item,
    factPack: factPack({ headline: "Acme raises $20M Series A", primarySource: url, sourceUrls: [url] }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, caption: "Acme raised $20M in a Series A.\n\nSource: https://ex.com/a" },
    isXOnly: false,
  });
  assert.ok(!/https?:\/\//.test(llm.caption), "LLM IG caption has its URL stripped");
  assert.ok(llm.caption.includes("Acme raised $20M"), "the real caption text survives the strip");
});

test("X-only story: xCaption keeps the @handle attribution but no URL", () => {
  const item: RankInputItem = {
    id: "xa", clusterId: "cxa", title: "raw post", summary: "x post body",
    url: "https://x.com/acme/status/9", source: "X/@acme", region: "GLOBAL",
    publishedAt: new Date().toISOString(), rawCategories: [], clusterSourceCount: 1,
    isX: true, authorHandle: "@acme", outboundUrls: ["https://acme.example/post"],
  };
  const story = rankedStory(item, { derivedHeadline: "Acme ships a new model", verified: false, claimRisk: "low", outboundUrls: ["https://acme.example/post"] });
  const payload = buildRasPayload({ item, factPack: factPack(), image, story, authorHandle: "acme", isXOnly: true });
  assert.ok(payload.xCaption.length <= 280);
  assert.ok(payload.xCaption.includes("per @acme on X"), "human attribution kept");
  assert.ok(!/https?:\/\//.test(payload.xCaption), "no URL in the X-only tweet");
});

/**
 * Deterministic deck quality (used when the LLM copywriter returns no copy):
 * the highlight (the bold accent line) must be the single most striking element
 * — a figure when one exists, else a named entity — and the three deck lines
 * must be distinct from one another, not duplicated filler.
 */
test("deterministic deck: highlight is the figure, lines are distinct, no 'Why it matters' filler", () => {
  const item = rssItem();
  const payload = buildRasPayload({
    item,
    factPack: factPack({
      headline: "Samsung posts record quarterly profit on AI memory demand",
      keyFacts: [
        "Samsung posted its highest-ever quarterly profit.",
        "AI memory chip demand drove the surge.",
        "The company guided to further growth next quarter.",
      ],
      figures: ["$80bn"],
      names: ["Samsung"],
      sourceUrls: ["https://ex.com/story"],
    }),
    image,
    story: rankedStory(item),
    // No llmCopy -> deterministic deck path.
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  // The highlight is the concrete figure — the thing the eye should land on.
  assert.ok(payload.deckHighlight.includes("$80bn"), "figure is chosen as the highlight");
  // No generic placeholder.
  assert.notEqual(payload.deckHighlight.toLowerCase(), "why it matters");
  // Lead and tail are non-empty and distinct from the highlight and each other.
  assert.ok(payload.deckLead.length > 0 && payload.deckTail.length > 0, "lead and tail present");
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  assert.notEqual(norm(payload.deckLead), norm(payload.deckTail), "lead and tail are distinct");
  assert.notEqual(norm(payload.deckLead), norm(payload.deckHighlight), "lead and highlight are distinct");
});

test("deterministic deck: with no figures, highlight falls back to a named entity", () => {
  const item = rssItem();
  const payload = buildRasPayload({
    item,
    factPack: factPack({
      headline: "OpenAI partners with a national lab on safety research",
      keyFacts: [
        "OpenAI announced a research partnership.",
        "The work focuses on model safety evaluation.",
      ],
      figures: [],
      names: ["OpenAI"],
      sourceUrls: ["https://ex.com/story"],
    }),
    image,
    story: rankedStory(item),
    isXOnly: false,
  });
  assert.ok(RasPayloadSchema.safeParse(payload).success);
  assert.ok(payload.deckHighlight.length > 0, "highlight is non-empty");
  assert.notEqual(payload.deckHighlight.toLowerCase(), "why it matters", "no filler placeholder");
  assert.ok(payload.deckHighlight.includes("OpenAI"), "named entity chosen when no figure exists");
});

test("deterministic deck: llmCopy deck fields win over the deterministic fallback", () => {
  const item = rssItem();
  const payload = buildRasPayload({
    item,
    factPack: factPack({ figures: ["$80bn"], names: ["Samsung"], sourceUrls: ["https://ex.com/story"] }),
    image,
    story: rankedStory(item),
    llmCopy: { ...baseCopy, deckLead: "Model lead", deckHighlight: "Model highlight", deckTail: "Model tail" },
    isXOnly: false,
  });
  assert.equal(payload.deckLead, "Model lead");
  assert.equal(payload.deckHighlight, "Model highlight");
  assert.equal(payload.deckTail, "Model tail");
});
