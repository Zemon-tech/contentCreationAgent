import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFactPack, extractFigures } from "../../src/mastra/lib/fact-pack";
import type { Story } from "../../src/mastra/schemas/story";

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "s1",
    title: "Peptris raises $12M Series A for AI drug discovery",
    summary: "Bengaluru startup Peptris raised $12M led by Accel.",
    whatHappened:
      "Peptris Technologies raised a $12M Series A led by Accel. The round values the company at $60M. It will expand its team by 40%.",
    whyItMatters: "Signals Indian deeptech momentum.",
    topics: ["Deeptech"],
    entities: ["Peptris", "Accel"],
    sources: ["https://inc42.com/peptris", "https://yourstory.com/peptris"],
    contentIds: ["c1", "c2"],
    firstSeenAt: "2026-10-14T00:00:00Z",
    lastUpdatedAt: "2026-10-14T00:00:00Z",
    status: "stable",
    scores: { relevance: 8, novelty: 6, impact: 6, velocity: 5, authority: 6, audienceInterest: 7, contentPotential: 7, overall: 70 },
    confidence: 0.8,
    possibleAngles: ["What changed?"],
    ...overrides,
  };
}

test("extractFigures pulls money and percentages, never invents", () => {
  const f = extractFigures("Raised $12M at a $60M valuation, growing 40% with ₹5 crore in revenue.");
  assert.ok(f.some((x) => /\$12M/i.test(x)));
  assert.ok(f.some((x) => /\$60M/i.test(x)));
  assert.ok(f.some((x) => /40\s?%/.test(x)));
  assert.ok(f.some((x) => /crore/i.test(x)));
});

test("buildFactPack produces grounded facts, figures, names and sources", () => {
  const fp = buildFactPack(story());
  assert.equal(fp.headline, story().title);
  assert.ok(fp.keyFacts.length >= 1 && fp.keyFacts.length <= 5);
  assert.ok(fp.figures.some((x) => /\$12M/i.test(x)));
  assert.deepEqual(fp.names.sort(), ["Accel", "Peptris"]);
  assert.equal(fp.sourceUrls.length, 2);
  assert.equal(fp.factPackLimited, false);
});

test("paywalled/limited material sets factPackLimited and avoids body text", () => {
  const fp = buildFactPack(story({ whatHappened: "" }), { limited: true });
  assert.equal(fp.factPackLimited, true);
  // Figures only from title + summary (no $60M / 40% which lived in the body).
  assert.ok(!fp.figures.some((x) => /\$60M/i.test(x)));
});

test("surfaces cross-source conflicts from the verify stage", () => {
  const fp = buildFactPack(
    story({
      evidence: {
        supportingSources: [],
        socialSignals: [],
        independentSources: 2,
        verificationStatus: "strong",
        contradictions: [{ claim: "round size", values: ["$12M", "$15M"], sources: ["inc42", "et"] }],
        primarySource: "https://inc42.com/peptris",
      },
    }),
  );
  assert.equal(fp.conflicts.length, 1);
  assert.equal(fp.conflicts[0]!.values.length, 2);
  assert.equal(fp.primarySource, "https://inc42.com/peptris");
});
