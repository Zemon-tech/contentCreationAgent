/**
 * ig:check — read-only Instagram credentials check.
 *
 *   npx -y tsx --env-file=.env src/mastra/demo/igCheck.ts
 *
 * Makes ONE harmless GET against the Instagram Graph API (the account node)
 * to confirm INSTAGRAM_ACCOUNT_ID + INSTAGRAM_ACCESS_TOKEN are valid. It NEVER
 * creates a media container and NEVER publishes. Reuses the existing
 * checkInstagramConnection() helper.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import { checkInstagramConnection } from "../lib/instagram-client";

async function main(): Promise<void> {
  console.log("Checking Instagram credentials (read-only, no post)...\n");
  const s = await checkInstagramConnection();
  if (!s.connected) {
    console.log("❌ NOT connected.");
    if (s.missing.length) console.log(`   Missing env: ${s.missing.join(", ")}`);
    if (s.error) console.log(`   Error: ${s.error}`);
    console.log(`   DRY_RUN stays true; nothing can publish.`);
    process.exit(0); // not an error — just report
  }
  console.log("✅ Connected.");
  console.log(`   Account id : ${s.accountId}`);
  console.log(`   Username   : @${s.username ?? "(unknown)"}`);
  console.log(`   Type       : ${s.accountType ?? "(unknown)"}`);
  console.log(`   Graph ver  : ${s.graphVersion}`);
  console.log(`   DRY_RUN    : ${s.dryRun}`);
  if (s.publishingLimit) {
    console.log(`   Publish quota (24h): ${s.publishingLimit.quotaUsage}/${s.publishingLimit.quotaTotal}`);
  }
  console.log(`\n(Read-only check — no media was created or published.)`);
}

main().catch((err) => {
  console.error("ig:check failed:", err);
  process.exit(1);
});
