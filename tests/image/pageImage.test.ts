import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMetaImages } from "../../src/mastra/lib/image/sourcing";

test("extracts og:image and twitter:image, in page order, deduped", () => {
  const html = `<head>
    <meta property="og:image" content="https://cdn.example.com/a.jpg">
    <meta name="twitter:image" content="https://cdn.example.com/b.jpg" />
    <meta property="og:image:secure_url" content="https://cdn.example.com/a.jpg">
  </head>`;
  assert.deepEqual(extractMetaImages(html, "https://news.example.com/story"), [
    "https://cdn.example.com/a.jpg",
    "https://cdn.example.com/b.jpg",
  ]);
});

test("handles content-before-property order, single quotes and &amp;", () => {
  const html = `<meta content='https://cdn.example.com/x.jpg?w=1200&amp;h=900' property='og:image'>`;
  assert.deepEqual(extractMetaImages(html, "https://news.example.com/"), ["https://cdn.example.com/x.jpg?w=1200&h=900"]);
});

test("resolves relative URLs against the page URL", () => {
  const html = `<meta property="og:image" content="/img/hero.png">`;
  assert.deepEqual(extractMetaImages(html, "https://news.example.com/a/b"), ["https://news.example.com/img/hero.png"]);
});

test("ignores unrelated meta tags and empty content", () => {
  const html = `<meta property="og:title" content="Hello"><meta property="og:image" content="">`;
  assert.deepEqual(extractMetaImages(html, "https://news.example.com/"), []);
});
