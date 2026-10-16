import { test } from "node:test";
import assert from "node:assert/strict";
import { publishPreflight } from "../../src/mastra/lib/ras/preflight";
import { clipWords } from "../../src/mastra/lib/ras/payload";

test("preflight lists everything missing", () => {
  const r = publishPreflight({ INSTAGRAM_DRY_RUN: "true" });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("INSTAGRAM_ACCOUNT_ID"));
  assert.ok(r.missing.includes("INSTAGRAM_ACCESS_TOKEN"));
  assert.ok(r.missing.includes("PUBLIC_BASE_URL"));
  assert.ok(r.missing.some((m) => m.includes("INSTAGRAM_DRY_RUN")));
});

test("preflight passes only when fully configured and env dry-run is off", () => {
  const ok = publishPreflight({ INSTAGRAM_ACCOUNT_ID: "1", INSTAGRAM_ACCESS_TOKEN: "t", PUBLIC_BASE_URL: "https://x.io", INSTAGRAM_DRY_RUN: "false" });
  assert.equal(ok.ok, true);
});

test("clipWords never ends mid-word and adds no ellipsis", () => {
  const out = clipWords("Meta Platforms Inc. today released open weights for its Muse Spark model", 60);
  assert.ok(out.length <= 60);
  assert.ok(!out.includes("..."));
  assert.ok("Meta Platforms Inc. today released open weights for its Muse Spark model".startsWith(out));
  assert.ok(/\s/.test("Meta Platforms Inc. today released open weights for its Muse Spark model"[out.length] ?? " "), "must stop on a word boundary");
});

test("clipWords leaves short text alone", () => {
  assert.equal(clipWords("Short line", 60), "Short line");
});
