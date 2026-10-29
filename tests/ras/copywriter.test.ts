import { test } from "node:test";
import assert from "node:assert/strict";
import { writeEditorialCopy, type CopyGenerate } from "../../src/mastra/lib/ras/copywriter";
import { copyConfig, type CopyConfig } from "../../src/mastra/config/copy.config";
import type { FactPack } from "../../src/mastra/schemas/factpack";
import type { RankInputItem } from "../../src/mastra/schemas/ranking";

// Exa is off in every test so nothing hits the network (fully offline).
const cfg = (over: Partial<CopyConfig> = {}): CopyConfig => ({ ...copyConfig, exaEnabled: false, ...over });

function item(): RankInputItem {
  return { id: "i1", clusterId: "c1", title: "Acme raises $20M", summary: "x".repeat(60), url: "https://ex.com/a", source: "X", region: "US", publishedAt: new Date().toISOString(), rawCategories: [], clusterSourceCount: 1 };
}
function factPack(limited = false): FactPack {
  return { headline: "Acme raises $20M Series A", keyFacts: ["Acme raised $20M.", "Led by Foo Ventures."], figures: ["$20M"], names: ["Acme", "Foo Ventures"], sourceUrls: ["https://ex.com/a"], conflicts: [], factPackLimited: limited };
}

const validCopy = {
  serifHeadline: "Acme lands $20M to scale its AI stack",
  deckLead: "Series A fuels the next build phase",
  deckHighlight: "$20M raised",
  deckTail: "Foo Ventures leads the round",
  caption: "Acme raised $20M in a Series A led by Foo Ventures.\n\nSource: https://ex.com/a",
};

test("valid model output takes the llm path", async () => {
  const generate: CopyGenerate = async () => ({ text: JSON.stringify(validCopy) });
  const out = await writeEditorialCopy({ item: item(), factPack: factPack(), config: cfg(), generate });
  assert.equal(out.path, "llm");
  assert.ok(out.copy);
  assert.equal(out.copy!.serifHeadline, validCopy.serifHeadline);
});

test("retries once on invalid output, then succeeds", async () => {
  let calls = 0;
  const generate: CopyGenerate = async () => {
    calls++;
    return { text: calls === 1 ? "not json at all" : JSON.stringify(validCopy) };
  };
  const out = await writeEditorialCopy({ item: item(), factPack: factPack(), config: cfg(), generate });
  assert.equal(calls, 2);
  assert.equal(out.path, "llm");
});

test("falls back when output is invalid after the retry", async () => {
  let calls = 0;
  const generate: CopyGenerate = async () => { calls++; return { text: "{ not valid }" }; };
  const out = await writeEditorialCopy({ item: item(), factPack: factPack(), config: cfg(), generate });
  assert.equal(calls, 2);
  assert.equal(out.path, "fallback");
  assert.equal(out.copy, null);
});

test("falls back (never throws) when the model errors", async () => {
  const generate: CopyGenerate = async () => { throw new Error("model down"); };
  const out = await writeEditorialCopy({ item: item(), factPack: factPack(), config: cfg(), generate });
  assert.equal(out.path, "fallback");
  assert.equal(out.copy, null);
});

test("rejects over-length fields (serifHeadline > 120)", async () => {
  const bad = { ...validCopy, serifHeadline: "A".repeat(130) };
  let calls = 0;
  const generate: CopyGenerate = async () => { calls++; return { text: JSON.stringify(bad) }; };
  const out = await writeEditorialCopy({ item: item(), factPack: factPack(), config: cfg(), generate });
  assert.equal(out.path, "fallback");
  assert.equal(calls, 2); // tried twice, both over-length
});

test("an over-length xCaption does NOT discard the good Instagram copy", async () => {
  // xCaption is X-only; a >280 value must never fail the whole EditorialCopySchema
  // parse and drag the valid IG fields (serifHeadline/deck/caption) to fallback.
  const bad = { ...validCopy, xCaption: "Word ".repeat(100).trim() }; // ~500 chars
  let calls = 0;
  const generate: CopyGenerate = async () => { calls++; return { text: JSON.stringify(bad) }; };
  const out = await writeEditorialCopy({ item: item(), factPack: factPack(), config: cfg(), generate });
  assert.equal(calls, 1); // accepted on the FIRST try — no retry, no fallback
  assert.equal(out.path, "llm");
  assert.ok(out.copy);
  assert.equal(out.copy!.serifHeadline, validCopy.serifHeadline);
  assert.equal(out.copy!.caption, validCopy.caption);
});

test("llmEnabled=false short-circuits to fallback without calling the model", async () => {
  let calls = 0;
  const generate: CopyGenerate = async () => { calls++; return { text: JSON.stringify(validCopy) }; };
  const out = await writeEditorialCopy({ item: item(), factPack: factPack(), config: cfg({ llmEnabled: false }), generate });
  assert.equal(calls, 0);
  assert.equal(out.path, "fallback");
});
