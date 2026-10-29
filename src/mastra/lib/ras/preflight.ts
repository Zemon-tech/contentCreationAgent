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

import { checkXSession, type XSessionInfo } from "../x-publisher";

export interface XReadyResult {
  ok: boolean;
  reason?: string;
  handle?: string | null;
}

/**
 * X readiness check — separate from publishPreflight because it is async and
 * shells out to the tweetytweets session check. A missing/not-logged-in X
 * session must NOT fail the whole run: the caller simply skips X and still
 * publishes to Instagram. `check` is injectable so tests never spawn Python.
 *
 * Gated by X_POST_ENABLED (default true): set X_POST_ENABLED=false to disable
 * the X attempt entirely while leaving Instagram untouched.
 */
export async function xPublishReady(
  check: () => Promise<XSessionInfo> = checkXSession,
  env: Record<string, string | undefined> = process.env,
): Promise<XReadyResult> {
  const enabled = env["X_POST_ENABLED"]?.trim();
  if (enabled !== undefined && /^(0|false|no|off)$/i.test(enabled)) {
    return { ok: false, reason: "X_POST_ENABLED=false" };
  }
  try {
    const session = await check();
    if (session.loggedIn) return { ok: true, handle: session.handle };
    return { ok: false, reason: session.message || "X session not logged in", handle: session.handle };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
