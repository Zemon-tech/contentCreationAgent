import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { sniffImage, checkDimensions } from "../../src/mastra/lib/image/validate";
import { cleanupImages } from "../../src/mastra/lib/image/cleanup";
import { imageConfig } from "../../src/mastra/config/image.config";

test("sniffImage recognizes a real PNG's bytes and rejects junk", async () => {
  const png = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  assert.equal(sniffImage(png), "png");
  assert.equal(sniffImage(Buffer.from("not an image at all, just text here")), null);
});

test("checkDimensions: 1080x1350 passes, not under1080", () => {
  const d = checkDimensions(1080, 1350);
  assert.equal(d.ok, true);
  assert.equal(d.under1080, false);
});

test("checkDimensions: 800x1000 passes but flags under1080", () => {
  const d = checkDimensions(800, 1000);
  assert.equal(d.ok, true);
  assert.equal(d.under1080, true);
});

test("checkDimensions: tiny image rejected (logo guard)", () => {
  assert.equal(checkDimensions(120, 120).ok, false);
});

test("checkDimensions: extreme aspect rejected (won't crop cleanly)", () => {
  assert.equal(checkDimensions(3000, 400).ok, false);
});

test("cleanup deletes old images but never a protected (pending) one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgtest-"));
  const oldFile = path.join(dir, "old.jpg");
  const protectedFile = path.join(dir, "pending.jpg");
  fs.writeFileSync(oldFile, "x");
  fs.writeFileSync(protectedFile, "y");
  const old = Date.now() - 100 * 86_400_000;
  fs.utimesSync(oldFile, new Date(old), new Date(old));
  fs.utimesSync(protectedFile, new Date(old), new Date(old)); // also old, but protected

  const res = cleanupImages({
    protect: new Set([protectedFile]),
    config: { ...imageConfig, imageDir: dir, retentionDays: 7 },
  });
  assert.ok(res.deleted.includes(oldFile));
  assert.ok(!res.deleted.includes(protectedFile));
  assert.equal(res.protectedSkipped, 1);
  assert.equal(fs.existsSync(protectedFile), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
