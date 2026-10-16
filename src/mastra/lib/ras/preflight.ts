/**
 * Live-publish preflight. Checked BEFORE the handoff writes anything to the
 * ledger, so a missing setting (no token, no public URL, env dry-run still on)
 * can never burn a story: the post is still rendered for review, the run just
 * reports what to configure. Pure over `env`, so it is unit-testable.
 */
export interface PreflightResult {
  ok: boolean;
  missing: string[];
}

export function publishPreflight(env: Record<string, string | undefined> = process.env): PreflightResult {
  const has = (k: string) => !!env[k]?.trim();
  const missing: string[] = [];
  if (!has("INSTAGRAM_ACCOUNT_ID")) missing.push("INSTAGRAM_ACCOUNT_ID");
  if (!has("INSTAGRAM_ACCESS_TOKEN")) missing.push("INSTAGRAM_ACCESS_TOKEN");
  if (!has("PUBLIC_BASE_URL") && !has("PUBLIC_ASSET_BASE_URL")) missing.push("PUBLIC_BASE_URL");
  if (/^(1|true|yes)$/i.test(env["INSTAGRAM_DRY_RUN"]?.trim() || "")) {
    missing.push("INSTAGRAM_DRY_RUN must be false (it is still true in .env)");
  }
  return { ok: missing.length === 0, missing };
}
