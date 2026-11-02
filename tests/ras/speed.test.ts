import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPostableCandidates, type PreparedPost } from "../../src/mastra/lib/workflow/autoNewsToRas";
import { writeEditorialCopy } from "../../src/mastra/lib/ras/copywriter";
import { withTimeout, TimeoutError, isTimeoutError } from "../../src/mastra/lib/timeout";
import { copyConfig } from "../../src/mastra/config/copy.config";
import type { RankResult, RankedStory, RankInputItem } from "../../src/mastra/schemas/ranking";

function ranked(id: string, score: number): RankedStory {
  const item: RankInputItem = { id, clusterId: `c-${id}`, title: `Story ${id}`, summary: "s".repeat(60), url: `https://ex.com/${id}`, source: "X", region: "US", publishedAt: new Date().toISOString(), rawCategories: [], clusterSourceCount: 1 };
  return { item, llm: null, unscored: false, finalScore: score, components: {} as never, weightedContributions: {}, appliedPenalties: [], reason: "r" };
}
const result = (rs: RankedStory[]) => ({ ranked: rs, selected: [], droppedByReason: {} }) as unknown as RankResult;
const prep = (hasImage: boolean): PreparedPost => ({
  payload: { imageLocalPath: hasImage ? "/tmp/i.jpg" : null } as never,
  image: {} as never,
  caps: { ok: true, postsLast24h: 0, lastPostedAt: null },
  scoreOk: true,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- timeout helper ----

test("withTimeout rejects with TimeoutError and aborts the signal", async () => {
  let aborted = false;
  await assert.rejects(
    withTimeout(30, "slow", (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return sleep(500);
    }),
    (err) => isTimeoutError(err) && err instanceof TimeoutError,
  );
  assert.equal(aborted, true);
});

test("withTimeout returns the value when the call is fast", async () => {
  assert.equal(await withTimeout(500, "fast", async () => 42), 42);
});

// ---- batch preparation ----

test("batch: prepares the needed stories in PARALLEL, not one after another", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await pickPostableCandidates({
    rankResult: result([ranked("a", 90), ranked("b", 80), ranked("c", 70)]),
    rawById: new Map(),
    minScore: 0,
    count: 2,
    prepare: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(50);
      inFlight--;
      return prep(true);
    },
  });
  assert.equal(peak, 2);
  assert.deepEqual(out.candidates.map((c) => c.item.id), ["a", "b"]);
  assert.equal(out.tried, 2); // story c never prepared — no wasted copy
});

test("batch: keeps RANK order and back-fills image-less stories from further down", async () => {
  const out = await pickPostableCandidates({
    rankResult: result([ranked("a", 90), ranked("b", 80), ranked("c", 70), ranked("d", 60)]),
    rawById: new Map(),
    minScore: 0,
    count: 2,
    // "a" resolves last but must still come first; "b" has no image.
    prepare: async ({ item }) => {
      await sleep(item.id === "a" ? 60 : 5);
      return prep(item.id !== "b");
    },
  });
  assert.deepEqual(out.candidates.map((c) => c.item.id), ["a", "c"]);
  assert.deepEqual(out.skippedNoImage, ["Story b"]);
  assert.equal(out.tried, 3); // d untouched
});

// ---- copywriter timeout ----

test("copy: a timed-out LLM call is NOT retried; falls back to template copy", async () => {
  let calls = 0;
  const res = await writeEditorialCopy({
    item: ranked("a", 90).item,
    factPack: { headline: "Story a", keyFacts: [], figures: [], names: [], conflicts: [], sourceUrls: [], factPackLimited: false } as never,
    config: { ...copyConfig, exaEnabled: false },
    generate: async () => {
      calls++;
      throw new TimeoutError("copy LLM call", 100_000);
    },
  });
  assert.equal(calls, 1);
  assert.equal(res.path, "fallback");
  assert.equal(res.copy, null);
});
