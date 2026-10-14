import { test } from "node:test";
import assert from "node:assert/strict";
import { isPaywalledDomain, fetchArticleBody, PAYWALLED_DOMAINS } from "../../src/mastra/lib/article-body";

test("isPaywalledDomain matches domain and subdomains", () => {
  assert.equal(isPaywalledDomain("https://www.wsj.com/articles/x"), true);
  assert.equal(isPaywalledDomain("https://subdomain.wsj.com/x"), true);
  assert.equal(isPaywalledDomain("https://www.theverge.com/x"), false);
});

test("paywalled source NEVER triggers a body fetch (returns before any network)", async () => {
  // If this tried to fetch, the test host has no network guarantee; the guard
  // must short-circuit purely from the paywalled flag.
  const res = await fetchArticleBody({ url: "https://example.com/story", source: { paywalled: true } });
  assert.equal(res.body, null);
  assert.equal(res.reason, "paywalled");
});

test("a URL resolving to a paywalled domain is refused even without a source flag", async () => {
  const res = await fetchArticleBody({ url: "https://www.wsj.com/articles/anything" });
  assert.equal(res.body, null);
  assert.equal(res.reason, "paywalled");
});

test("WSJ + Dow Jones feed infra are in the paywalled set", () => {
  assert.ok(PAYWALLED_DOMAINS.has("wsj.com"));
  assert.ok(PAYWALLED_DOMAINS.has("dowjones.io"));
});
