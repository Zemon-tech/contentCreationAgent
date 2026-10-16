import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { pngToInstagramJpeg, IG_MAX_BYTES } from "../../src/mastra/lib/ras/jpeg";
import { sniffImage } from "../../src/mastra/lib/image/validate";
import { runHandoff, type HandoffDeps } from "../../src/mastra/lib/ras/handoff";
import type { RasPayload } from "../../src/mastra/schemas/handoff";

test("PNG (even with transparency) becomes a real 1080x1350 JPEG under Instagram's 8MB limit", async () => {
  const png = await sharp({ create: { width: 1080, height: 1350, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } } }).png().toBuffer();
  const jpg = await pngToInstagramJpeg(png);
  assert.equal(sniffImage(jpg), "jpg");
  const m = await sharp(jpg).metadata();
  assert.equal(m.format, "jpeg");
  assert.equal(m.width, 1080); assert.equal(m.height, 1350);
  assert.ok(m.width! / m.height! >= 0.8, "4:5 is the narrowest aspect Instagram allows");
  assert.ok(jpg.length < IG_MAX_BYTES);
});

test("handoff publishes the JPEG path, not the PNG preview", async () => {
  const published: string[][] = [];
  const deps: Partial<HandoffDeps> = {
    render: async () => ({ viewUrls: ["http://localhost:4111/ras-assets/s/01.png"], publishPaths: ["/ras-publish/s/01.jpg"] }),
    publish: async (a) => { published.push(a.viewUrls); return { published: true, mediaId: "m", permalink: "p" }; },
    getRow: async () => undefined,
    record: async () => {},
  };
  const payload = { headline: "h", primaryUrl: "https://ex.com/a", region: "US", imageLocalPath: "/tmp/x.jpg", caption: "c", hashtags: [] } as unknown as RasPayload;
  const res = await runHandoff({ ledgerKey: "k", payload, storyId: "s", dryRun: false, approved: true, deps });
  assert.equal(res.status, "posted");
  assert.deepEqual(published, [["/ras-publish/s/01.jpg"]]);
});
