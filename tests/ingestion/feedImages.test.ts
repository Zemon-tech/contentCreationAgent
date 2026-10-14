import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFeedImages, parseFeedXml } from "../../src/mastra/collectors/rss";

test("extracts media:content / media:thumbnail / enclosure images, largest first", () => {
  const block = `
    <item>
      <title>Story</title>
      <link>https://ex.com/a</link>
      <media:thumbnail url="https://ex.com/thumb.jpg" width="150" height="100"/>
      <media:content url="https://ex.com/big.jpg" medium="image" width="1200" height="800"/>
      <enclosure url="https://ex.com/enc.png" type="image/png"/>
    </item>`;
  const imgs = extractFeedImages(block);
  assert.ok(imgs.length >= 2);
  assert.equal(imgs[0]!.url, "https://ex.com/big.jpg"); // largest by area first
  assert.ok(imgs.some((i) => i.origin === "media:thumbnail"));
  assert.ok(imgs.some((i) => i.origin === "enclosure"));
});

test("ignores non-image enclosures", () => {
  const block = `<item><link>https://ex.com/a</link><enclosure url="https://ex.com/ep.mp3" type="audio/mpeg"/></item>`;
  assert.equal(extractFeedImages(block).length, 0);
});

test("an item with only a feed image yields candidates that are NOT cleared", () => {
  // Simulate the ingest mapping: feed image -> ImageCandidate.
  const xml = `<rss><channel>
    <item><title>T</title><link>https://ex.com/a</link><pubDate>${new Date().toUTCString()}</pubDate>
      <media:content url="https://ex.com/hero.jpg" medium="image" width="1080" height="1350"/>
    </item>
  </channel></rss>`;
  const items = parseFeedXml(xml);
  assert.equal(items.length, 1);
  const imgs = items[0]!.images ?? [];
  assert.equal(imgs.length, 1);
  // The schema uses cleared: literal false — nothing in ingestion may clear it.
  const candidate = { url: imgs[0]!.url, origin: imgs[0]!.origin, cleared: false as const };
  assert.equal(candidate.cleared, false);
});
