import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "../../src/mastra/lib/normalize";

test("strips utm_* and other tracking params", () => {
  assert.equal(
    normalizeUrl("https://ex.com/a?utm_source=x&utm_medium=y&id=5&fbclid=z"),
    "https://ex.com/a?id=5",
  );
});

test("removes trailing slash but keeps root", () => {
  assert.equal(normalizeUrl("https://ex.com/a/b/"), "https://ex.com/a/b");
  assert.equal(normalizeUrl("https://ex.com/"), "https://ex.com/");
});

test("strips AMP path segments and amp query flags", () => {
  assert.equal(normalizeUrl("https://ex.com/story/amp"), "https://ex.com/story");
  assert.equal(normalizeUrl("https://ex.com/story/amp/"), "https://ex.com/story");
  assert.equal(normalizeUrl("https://ex.com/story?amp=1"), "https://ex.com/story");
});

test("drops the hash fragment", () => {
  assert.equal(normalizeUrl("https://ex.com/a#section"), "https://ex.com/a");
});

test("resolves a Google News redirect with an embedded url param", () => {
  assert.equal(
    normalizeUrl("https://news.google.com/rss/articles/abc?url=https://cnn.com/tech/x&oc=5"),
    "https://cnn.com/tech/x",
  );
});

test("two URLs that differ only by tracking/AMP/slash canonicalize equal", () => {
  const a = normalizeUrl("https://ex.com/story/amp/?utm_source=rss");
  const b = normalizeUrl("https://ex.com/story");
  assert.equal(a, b);
});
