import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, isPathDisallowed } from "../../src/mastra/lib/http-polite";

test("parses Disallow prefixes for the * user-agent group only", () => {
  const txt = `
User-agent: Googlebot
Disallow: /secret

User-agent: *
Disallow: /private
Disallow: /tmp
`;
  const d = parseRobots(txt);
  assert.deepEqual(d.sort(), ["/private", "/tmp"]);
});

test("Disallow: / blocks everything", () => {
  const d = parseRobots("User-agent: *\nDisallow: /");
  assert.equal(isPathDisallowed(d, "/anything"), true);
  assert.equal(isPathDisallowed(d, "/"), true);
});

test("path prefix matching", () => {
  const d = ["/private", "/tmp"];
  assert.equal(isPathDisallowed(d, "/private/x"), true);
  assert.equal(isPathDisallowed(d, "/public/x"), false);
});

test("empty Disallow means allow all", () => {
  const d = parseRobots("User-agent: *\nDisallow:");
  assert.equal(d.length, 0);
  assert.equal(isPathDisallowed(d, "/anything"), false);
});
