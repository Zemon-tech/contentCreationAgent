import { test } from "node:test";
import assert from "node:assert/strict";
import { median, credibilityOf, statusFor, isOfficialAccount } from "../../src/mastra/lib/x-discovery/learning";
import {
  createDiscoveredAccountsStubGateway,
  type DiscoveredAccount,
} from "../../src/mastra/lib/x-discovery/stores/discoveredAccounts";
import { getXDiscoveryConfig, type XDiscoveryConfig } from "../../src/mastra/config/xDiscovery";

/**
 * FEAT-005 — the pure learning math + the account gateway's upsert behaviour:
 *  - upsertFromScrape only creates rows from real scrape samples;
 *  - promotion / demotion follow the configured thresholds;
 *  - isOfficialAccount honours the officialMinCredibility gate and the
 *    pinnedHandles override.
 */

const NOW = new Date("2026-10-13T12:00:00.000Z");
const config = getXDiscoveryConfig();

function account(overrides: Partial<DiscoveredAccount> = {}): DiscoveredAccount {
  return {
    id: overrides.id ?? "acme",
    handle: overrides.handle ?? "acme",
    firstSeen: NOW.toISOString(),
    timesSeen: overrides.timesSeen ?? 0,
    medianLikes: overrides.medianLikes ?? 0,
    medianReposts: overrides.medianReposts ?? 0,
    credibilityScore: overrides.credibilityScore ?? 0,
    status: overrides.status ?? "candidate",
    recentLikes: overrides.recentLikes ?? [],
    recentReposts: overrides.recentReposts ?? [],
    recentTexts: overrides.recentTexts ?? [],
    ...(overrides.lastProfileVisitDay ? { lastProfileVisitDay: overrides.lastProfileVisitDay } : {}),
  };
}

test("median: empty -> 0; odd and even lengths", () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("statusFor: promoted when all thresholds clear, demoted below the spam floor", () => {
  const promoted = account({
    timesSeen: config.promoteMinTimesSeen,
    medianLikes: config.promoteMinMedianLikes,
    credibilityScore: config.promoteMinCredibility,
  });
  assert.equal(statusFor(promoted, config), "promoted");

  const demoted = account({ credibilityScore: config.demoteSpamCredibilityBelow - 1 });
  assert.equal(statusFor(demoted, config), "demoted");

  const candidate = account({ timesSeen: 1, medianLikes: 10, credibilityScore: config.demoteSpamCredibilityBelow + 1 });
  assert.equal(statusFor(candidate, config), "candidate");
});

test("credibilityOf: a spammy recent-texts sample lowers the score", () => {
  const clean = account({ timesSeen: 5, medianLikes: config.promoteMinMedianLikes, recentTexts: ["new chip launch", "shipping today"] });
  const spammy = account({ timesSeen: 5, medianLikes: config.promoteMinMedianLikes, recentTexts: ["giveaway! RT to win", "airdrop link in bio"] });
  assert.ok(credibilityOf(spammy, config) < credibilityOf(clean, config));
  assert.ok(credibilityOf(clean, config) <= 10 && credibilityOf(clean, config) >= 0);
});

test("isOfficialAccount: promoted + credibility gate", () => {
  const official = account({ status: "promoted", credibilityScore: config.officialMinCredibility });
  assert.equal(isOfficialAccount(official, config), true);

  const belowGate = account({ status: "promoted", credibilityScore: config.officialMinCredibility - 1 });
  assert.equal(isOfficialAccount(belowGate, config), false);

  const notPromoted = account({ status: "candidate", credibilityScore: 10 });
  assert.equal(isOfficialAccount(notPromoted, config), false);
});

test("isOfficialAccount: pinnedHandles override wins regardless of status/credibility", () => {
  const cfg: XDiscoveryConfig = { ...config, pinnedHandles: ["@pinned_co"] };
  const pinned = account({ id: "pinned_co", handle: "pinned_co", status: "candidate", credibilityScore: 0 });
  assert.equal(isOfficialAccount(pinned, cfg), true);
});

test("upsertFromScrape: creates a row only from samples and advances learning", async () => {
  const gw = createDiscoveredAccountsStubGateway([], config);
  assert.equal(await gw.get("newbie"), undefined);

  const a1 = await gw.upsertFromScrape("newbie", [{ likes: 300, reposts: 40, text: "shipping a new model" }], NOW);
  assert.equal(a1.id, "newbie");
  assert.equal(a1.timesSeen, 1);
  assert.equal(a1.medianLikes, 300);
  // A row now exists.
  assert.ok(await gw.get("newbie"));

  // Seeing it again increments timesSeen and folds more samples in.
  const a2 = await gw.upsertFromScrape("newbie", [{ likes: 500, reposts: 60, text: "another ship" }], NOW);
  assert.equal(a2.timesSeen, 2);
  assert.equal(a2.medianLikes, median([300, 500]));
});

test("upsertFromScrape: enough credible sightings promote the account", async () => {
  const gw = createDiscoveredAccountsStubGateway([], config);
  let acct!: Awaited<ReturnType<typeof gw.upsertFromScrape>>;
  for (let i = 0; i < config.promoteMinTimesSeen; i++) {
    acct = await gw.upsertFromScrape(
      "signal_co",
      [{ likes: config.promoteMinMedianLikes * 2, reposts: config.promoteMinMedianLikes / 2, text: "real product update" }],
      NOW,
    );
  }
  assert.equal(acct.status, "promoted");
  assert.ok(acct.credibilityScore >= config.promoteMinCredibility);
});
