import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOutboundUrls } from "../../src/mastra/lib/collect-x-posts";
import { normalizeScrapedPost, type ScrapedXPost } from "../../src/mastra/lib/x-publisher";

/**
 * FEAT-005 — FIX #1 ordering + FR-E3. Pure, NO network:
 *  - resolveOutboundUrls over sample link data with an INJECTED t.co -> dest
 *    expander map; x.com / twitter.com destinations are dropped.
 *  - normalizeScrapedPost applies the enriched-field defaults.
 *  - a TS mirror of scrape.py's attach_thread_texts ordering: consecutive
 *    same-author runs set thread_texts on the FIRST post (capped at 5); runs of
 *    other authors / singletons yield [].
 */

test("resolveOutboundUrls: injected t.co expander, drops x.com/twitter.com, dedupes, lowercases host", () => {
  const map: Record<string, string> = {
    "https://t.co/aaa": "https://TechCrunch.com/story?utm_source=twitter",
    "https://t.co/bbb": "https://x.com/someone/status/9", // expands to a dropped host
    "https://t.co/ccc": "https://twitter.com/foo", // dropped host
    "https://t.co/ddd": "https://techcrunch.com/story", // duplicate of aaa after normalize
  };
  const expand = (tco: string): string | null => map[tco] ?? null;

  const out = resolveOutboundUrls(
    ["https://t.co/aaa", "https://t.co/bbb", "https://t.co/ccc", "https://t.co/ddd"],
    { expand },
  );

  // Only the TechCrunch destination survives; host is lowercased; tracking stripped; deduped.
  assert.equal(out.length, 1);
  assert.match(out[0]!, /^https:\/\/techcrunch\.com\/story/);
  assert.ok(!out[0]!.includes("utm_source"));
});

test("resolveOutboundUrls: without an expander, direct links keep their host but drop x.com/t.co", () => {
  const out = resolveOutboundUrls([
    "https://example.com/a",
    "https://x.com/y/status/1",
    "https://t.co/zzz",
    "https://mobile.twitter.com/z",
  ]);
  assert.deepEqual(out, ["https://example.com/a"]);
});

test("normalizeScrapedPost: fills enriched-field defaults and the fallback dom_index", () => {
  const p = normalizeScrapedPost({ text: "hi", url: "https://x.com/a/status/1", author_handle: "a" }, 7);
  assert.equal(p.outbound_urls.length, 0);
  assert.equal(p.text_truncated, false);
  assert.equal(p.quoted, null);
  assert.deepEqual(p.thread_texts, []);
  assert.equal(p.dom_index, 7); // falls back to the provided index
  // An explicit dom_index is preserved.
  const p2 = normalizeScrapedPost({ text: "hi", url: "u", dom_index: 42 }, 0);
  assert.equal(p2.dom_index, 42);
});

// --- TS mirror of scrape.py attach_thread_texts ordering (pure, no scraper) ---

/** Mirror: sort by dom_index, set thread_texts on the FIRST post of each run of
 *  consecutive same-author, non-repost posts (capped); all others []. */
function attachThreadTexts(posts: ScrapedXPost[], cap = 5): ScrapedXPost[] {
  const ordered = [...posts].sort((a, b) => (a.dom_index ?? 0) - (b.dom_index ?? 0));
  for (const p of posts) p.thread_texts = [];
  let i = 0;
  const n = ordered.length;
  while (i < n) {
    const head = ordered[i]!;
    const author = (head.author_handle ?? "").toLowerCase();
    if (!author || head.is_repost) {
      i += 1;
      continue;
    }
    const run: ScrapedXPost[] = [head];
    let j = i + 1;
    while (j < n) {
      const nxt = ordered[j]!;
      if (nxt.is_repost) break;
      if ((nxt.author_handle ?? "").toLowerCase() !== author) break;
      run.push(nxt);
      j += 1;
    }
    if (run.length > 1) head.thread_texts = run.map((r) => r.text ?? "").slice(0, cap);
    i = j;
  }
  return posts;
}

function mk(idx: number, author: string | null, text: string, isRepost = false): ScrapedXPost {
  return normalizeScrapedPost(
    { text, url: `https://x.com/${author}/status/${idx}`, author_handle: author, is_repost: isRepost, dom_index: idx },
    idx,
  );
}

test("attach_thread_texts mirror: a consecutive same-author run sets thread_texts on the FIRST post only", () => {
  const posts = [
    mk(0, "alice", "t0"),
    mk(1, "alice", "t1"),
    mk(2, "alice", "t2"),
    mk(3, "bob", "b0"),
  ];
  attachThreadTexts(posts);
  assert.deepEqual(posts[0]!.thread_texts, ["t0", "t1", "t2"]);
  assert.deepEqual(posts[1]!.thread_texts, []);
  assert.deepEqual(posts[2]!.thread_texts, []);
  // Bob is a singleton run -> [].
  assert.deepEqual(posts[3]!.thread_texts, []);
});

test("attach_thread_texts mirror: other-author runs and singletons yield []", () => {
  const posts = [mk(0, "alice", "a0"), mk(1, "bob", "b0"), mk(2, "carol", "c0")];
  attachThreadTexts(posts);
  for (const p of posts) assert.deepEqual(p.thread_texts, []);
});

test("attach_thread_texts mirror: the run is capped at 5 texts", () => {
  const posts = Array.from({ length: 7 }, (_, i) => mk(i, "alice", `t${i}`));
  attachThreadTexts(posts, 5);
  assert.equal(posts[0]!.thread_texts.length, 5);
  assert.deepEqual(posts[0]!.thread_texts, ["t0", "t1", "t2", "t3", "t4"]);
});

test("attach_thread_texts mirror: a repost breaks the run", () => {
  const posts = [mk(0, "alice", "a0"), mk(1, "alice", "rt", true), mk(2, "alice", "a2")];
  attachThreadTexts(posts);
  // The repost at index 1 breaks the run; index 0 is a singleton, index 2 is a singleton.
  assert.deepEqual(posts[0]!.thread_texts, []);
  assert.deepEqual(posts[2]!.thread_texts, []);
});
