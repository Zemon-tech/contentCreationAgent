import { test } from "node:test";
import assert from "node:assert/strict";
import { publishPreflight, xPublishReady } from "../../src/mastra/lib/ras/preflight";
import { clipWords } from "../../src/mastra/lib/ras/payload";
import type { XSessionInfo } from "../../src/mastra/lib/x-publisher";

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

const loggedIn: XSessionInfo = { loggedIn: true, handle: "acme", maxChars: 280, message: "ok" };
const notLoggedIn: XSessionInfo = { loggedIn: false, handle: null, message: "Browser is connected, but account is not logged in." };

test("xPublishReady: logged-in session -> ok:true (no shell-out)", async () => {
  const r = await xPublishReady(async () => loggedIn, { X_POST_ENABLED: "true" });
  assert.equal(r.ok, true);
  assert.equal(r.handle, "acme");
});

test("xPublishReady: not logged in -> ok:false with a reason", async () => {
  const r = await xPublishReady(async () => notLoggedIn, {});
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason.length > 0);
});

test("xPublishReady: X_POST_ENABLED=false -> ok:false, session never checked", async () => {
  let checked = false;
  const r = await xPublishReady(async () => { checked = true; return loggedIn; }, { X_POST_ENABLED: "false" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "X_POST_ENABLED=false");
  assert.equal(checked, false);
});

test("xPublishReady: default (X_POST_ENABLED unset) still checks session", async () => {
  const r = await xPublishReady(async () => loggedIn, {});
  assert.equal(r.ok, true);
});

test("xPublishReady: a thrown session check is swallowed -> ok:false", async () => {
  const r = await xPublishReady(async () => { throw new Error("python missing"); }, {});
  assert.equal(r.ok, false);
  assert.ok(r.reason?.includes("python missing"));
});
