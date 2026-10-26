import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRasPayload } from "../../src/mastra/lib/ras/payload";
import { RasPayloadSchema } from "../../src/mastra/schemas/handoff";
import type { FactPack } from "../../src/mastra/schemas/factpack";
import type { RankInputItem, RankedStory } from "../../src/mastra/schemas/ranking";

/**
 * FEAT-005 FIX #2 (payload) — the RAS payload X extensions:
 *  - an X-only story sets attributionLine 'per @handle on X', a NON-empty
 *    facts[] with sourceType 'x', and carries verified/claimRisk;
 *  - an RSS story leaves the X fields empty/default and still validates;
 *  - `limited` is NOT forced true by signalOnly (proven by prepareForHandoff's
 *    `limited` computation; here we confirm an X payload is NOT marked limited).
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

test("an X-only story: attributionLine 'per @handle on X', non-empty facts[] with sourceType 'x', verified/claimRisk carried", () => {
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

  const payload = buildRasPayload({
    item,
    factPack: factPack(),
    image,
    story,
    authorHandle: "acme",
    isXOnly: true,
  });

  // Validates against the schema.
  const parsed = RasPayloadSchema.safeParse(payload);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));

  assert.equal(payload.attributionLine, "per @acme on X");
  assert.ok(payload.facts.length > 0, "facts[] must be non-empty for an X story");
  assert.ok(payload.facts.some((f) => f.sourceType === "x"), "at least one fact has sourceType 'x'");
  assert.equal(payload.verified, false);
  assert.equal(payload.claimRisk, "medium");
  // Prefers the derived headline over the raw first line.
  assert.equal(payload.headline, "Acme ships its new model");
  assert.equal(payload.derivedHeadline, "Acme ships its new model");
});

test("a verified X story with an outbound source marks that fact 'primary'", () => {
  const item: RankInputItem = {
    id: "x2",
    clusterId: "cx2",
    title: "post",
    summary: "post body",
    url: "https://x.com/acme/status/2",
    source: "X/@acme",
    region: "GLOBAL",
    publishedAt: new Date().toISOString(),
    rawCategories: [],
    clusterSourceCount: 1,
    isX: true,
    authorHandle: "@acme",
    outboundUrls: ["https://acme.example/official"],
  };
  const story = rankedStory(item, {
    derivedHeadline: "Acme official announcement",
    verified: true,
    claimRisk: "low",
    outboundUrls: ["https://acme.example/official"],
  });
  const payload = buildRasPayload({ item, factPack: factPack(), image, story, authorHandle: "acme", isXOnly: true });
  assert.ok(payload.facts.some((f) => f.sourceUrl === "https://acme.example/official" && f.sourceType === "primary"));
});

test("an RSS story leaves the X fields empty/default and still validates", () => {
  const item: RankInputItem = {
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
  const story = rankedStory(item, { qualityScore: 70, finalScore: 70 });

  const payload = buildRasPayload({ item, factPack: factPack({ primarySource: "https://ex.com/story" }), image, story, isXOnly: false });

  const parsed = RasPayloadSchema.safeParse(payload);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));

  assert.equal(payload.attributionLine, null);
  assert.equal(payload.verified, false);
  assert.equal(payload.claimRisk, "low");
  assert.deepEqual(payload.outboundUrls, []);
  assert.equal(payload.quoted, null);
  // RSS facts are grounded to the fact pack's source, not X.
  assert.ok(payload.facts.every((f) => f.sourceType !== "x"));
});

test("an X payload is NOT forced to factPackLimited by signalOnly (FIX #2)", () => {
  const item: RankInputItem = {
    id: "x3",
    clusterId: "cx3",
    title: "post",
    summary: "post body",
    url: "https://x.com/acme/status/3",
    source: "X/@acme",
    region: "GLOBAL",
    publishedAt: new Date().toISOString(),
    rawCategories: [],
    clusterSourceCount: 1,
    isX: true,
    authorHandle: "@acme",
    outboundUrls: ["https://acme.example/post"],
  };
  const story = rankedStory(item, { derivedHeadline: "Acme news", verified: false, claimRisk: "low" });
  // factPack built WITHOUT limited -> payload must reflect that; signalOnly
  // never flips it (trust is carried by verified/claimRisk).
  const payload = buildRasPayload({ item, factPack: factPack({ factPackLimited: false }), image, story, authorHandle: "acme", isXOnly: true });
  assert.equal(payload.factPackLimited, false);
});
