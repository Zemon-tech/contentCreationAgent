import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { graphBase, usesInstagramLogin, checkInstagramConnection } from "../../src/mastra/lib/instagram-client";

const realFetch = globalThis.fetch;
const saved = { ...process.env };
afterEach(() => { globalThis.fetch = realFetch; process.env = { ...saved }; });

function mockFetch(handler: (url: string) => unknown) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input); urls.push(url);
    return new Response(JSON.stringify(handler(url)), { status: 200 });
  }) as typeof fetch;
  return urls;
}

test("default host is graph.facebook.com; override switches to Instagram login", () => {
  delete process.env.INSTAGRAM_GRAPH_HOST;
  assert.equal(graphBase(), "https://graph.facebook.com");
  assert.equal(usesInstagramLogin(), false);
  process.env.INSTAGRAM_GRAPH_HOST = "https://graph.instagram.com/";
  assert.equal(graphBase(), "https://graph.instagram.com");
  assert.equal(usesInstagramLogin(), true);
});

test("Instagram-login check uses /me on graph.instagram.com and confirms the account", async () => {
  Object.assign(process.env, { INSTAGRAM_GRAPH_HOST: "https://graph.instagram.com", INSTAGRAM_ACCOUNT_ID: "1784140000", INSTAGRAM_ACCESS_TOKEN: "t".repeat(80) });
  const urls = mockFetch((u) => u.includes("content_publishing_limit") ? { data: [{ quota_usage: 1, config: { quota_total: 100 } }] } : { user_id: "1784140000", username: "ras_test", account_type: "BUSINESS" });
  const s = await checkInstagramConnection();
  assert.equal(s.connected, true);
  assert.equal(s.username, "ras_test");
  assert.equal(s.publishingLimit?.quotaTotal, 100);
  assert.ok(urls[0]!.startsWith("https://graph.instagram.com/"), urls[0]);
  assert.ok(urls[0]!.includes("/me?"), "should call /me");
});

test("account id that does not match the token's account is reported, not trusted", async () => {
  Object.assign(process.env, { INSTAGRAM_GRAPH_HOST: "https://graph.instagram.com", INSTAGRAM_ACCOUNT_ID: "999", INSTAGRAM_ACCESS_TOKEN: "t".repeat(80) });
  mockFetch(() => ({ user_id: "1784140000", username: "ras_test", account_type: "BUSINESS" }));
  const s = await checkInstagramConnection();
  assert.equal(s.connected, false);
  assert.match(s.error!, /does not match/);
});

test("Facebook-login path still reads the account node on graph.facebook.com", async () => {
  delete process.env.INSTAGRAM_GRAPH_HOST;
  Object.assign(process.env, { INSTAGRAM_ACCOUNT_ID: "555", INSTAGRAM_ACCESS_TOKEN: "t".repeat(80) });
  const urls = mockFetch(() => ({ id: "555", username: "x", account_type: "BUSINESS" }));
  const s = await checkInstagramConnection();
  assert.equal(s.connected, true);
  assert.ok(urls[0]!.startsWith("https://graph.facebook.com/") && urls[0]!.includes("/555?"), urls[0]);
});
