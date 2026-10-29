import React from "react";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { RasPayload, HandoffResult } from "../../schemas/handoff";
import { recordAttempt, getRow } from "../../repositories/postedLedger";
import type { PostedLedgerRow } from "../../repositories/postedLedger";
import { assembleCaption, getPublicBaseUrl } from "../instagram-publish";
import { publishImagesToInstagram } from "../instagram-client";
import { RasStoryTemplate } from "../../templates/RasStoryTemplate";
import { renderComponentToPng, RAS_CANVAS } from "../../renderer/satori-renderer";
import { resolveHeroImage, loadLocalLogo } from "../../renderer/images";
import { logoPath } from "../../renderer/assets";
import { ensureRasOutputDir, rasViewUrl, sanitizeSlug } from "../../renderer/output";
import { pngToInstagramJpeg, IG_MAX_BYTES } from "./jpeg";
import { publishToX, type XPublishResult } from "../x-publisher";
import { xPublishReady, type XReadyResult } from "./preflight";

/**
 * RAS handoff (Step 6). Builds nothing itself — it takes a finished payload and:
 *  - refuses if the ledger already has this canonical key posted/pending (no double post);
 *  - in DRY_RUN or without approval, NEVER calls render/publish;
 *  - on a real, approved post: writes `pending` to the ledger BEFORE publishing
 *    (so a crash mid-publish cannot repost on restart), renders, publishes, then
 *    records `posted` or `failed`.
 *
 * Retry policy: the RENDER step is retried once (idempotent — just regenerates
 * PNGs). The PUBLISH call is attempted once and NOT re-invoked after a throw —
 * the Instagram client already retries transient (5xx/429) errors internally,
 * and re-calling publish could double-post. This is the safe reading of the
 * "never retry in a way that could double-post" rule.
 *
 * X (Twitter) side effect - independence rule:
 *   On the live+approved publish path (both the Instagram `posted` branch and
 *   the `published:false` env-dry-run `dry_run` branch), the SAME rendered PNG
 *   (rendered.filePath) is ALSO posted to X with the standalone <=280
 *   `payload.xCaption`. X is attempted whenever that publish path executes and
 *   X is ready (`xReady`); it is NOT attempted on the pre-publish dry-run early
 *   return, the not-approved skip, the never-double-post skip, or a render
 *   failure. X and Instagram are INDEPENDENT: X is never written to the posted
 *   ledger (Instagram stays ledger-authoritative) and a X failure / missing
 *   session NEVER flips a successful Instagram `posted` to `failed` - the X
 *   result is attached as ADDITIONAL `result.x` info only. X obeys the SAME
 *   `dryRun` safety switch as Instagram (posts nothing in dry-run), gated by
 *   X_POST_ENABLED (default true) via `xPublishReady`.
 */

export interface HandoffDeps {
  /**
   * `viewUrls` = preview (PNG, for Studio). `publishPaths` = server-relative
   * JPEG paths Instagram will fetch (Instagram accepts JPEG only); publish uses
   * these when present.
   */
  render: (p: RasPayload) => Promise<{ viewUrls: string[]; filePath?: string; publishPaths?: string[] }>;
  publish: (a: { viewUrls: string[]; caption: string; hashtags: string[] }) => Promise<{ published: boolean; dryRun?: boolean; mediaId?: string; permalink?: string }>;
  getRow: (key: string) => Promise<{ status: string } | undefined>;
  record: (row: Omit<PostedLedgerRow, "createdAt"> & { createdAt?: string }) => Promise<void>;
  /**
   * Post the SAME rendered PNG to X. Independent + fail-soft: never throws out,
   * never touches the IG ledger. Injectable so tests don't shell out to Python.
   */
  xPublish: (a: { text: string; imagePath?: string; dryRun: boolean }) => Promise<XPublishResult>;
  /** X readiness (session logged in + X_POST_ENABLED). Injectable for tests. */
  xReady: () => Promise<XReadyResult>;
}

export const defaultHandoffDeps: HandoffDeps = {
  render: (p) => renderRasPost(p),
  publish: defaultPublish,
  getRow: (key) => getRow(key),
  record: (row) => recordAttempt(row),
  xPublish: (a) => publishToX({ text: a.text, imagePath: a.imagePath, dryRun: a.dryRun }),
  xReady: () => xPublishReady(),
};

export async function runHandoff(args: {
  ledgerKey: string;
  payload: RasPayload;
  storyId: string;
  dryRun: boolean;
  approved: boolean;
  now?: Date;
  deps?: Partial<HandoffDeps>;
}): Promise<HandoffResult> {
  const deps: HandoffDeps = { ...defaultHandoffDeps, ...args.deps };
  const now = (args.now ?? new Date()).toISOString();
  const { ledgerKey, payload, storyId } = args;

  const base = {
    id: ledgerKey,
    storyId,
    url: payload.primaryUrl,
    title: payload.headline,
    region: payload.region,
    imageLocalPath: payload.imageLocalPath,
  };

  // Never double-post: posted/pending already on record for this canonical key.
  const existing = await deps.getRow(ledgerKey);
  if (existing && (existing.status === "posted" || existing.status === "pending")) {
    return { status: "skipped", ledgerKey, reason: `already ${existing.status}` };
  }

  // DRY-RUN: record and return the payload; never render/publish.
  if (args.dryRun) {
    await deps.record({ ...base, status: "dry_run", at: now });
    return { status: "dry_run", ledgerKey };
  }

  // Not approved: do not record (so it can be approved later), never publish.
  if (!args.approved) {
    return { status: "skipped", ledgerKey, reason: "not approved" };
  }

  // Real, approved post. Pending BEFORE publish.
  await deps.record({ ...base, status: "pending", at: now });

  // Render (retry once — idempotent). Keep the FULL result so the X publisher
  // gets the absolute local PNG (rendered.filePath); IG uses publishPaths.
  let rendered: { viewUrls: string[]; filePath?: string; publishPaths?: string[] };
  const forPublish = (r: { viewUrls: string[]; publishPaths?: string[] }) => r.publishPaths ?? r.viewUrls;
  try {
    rendered = await deps.render(payload);
  } catch {
    try {
      rendered = await deps.render(payload);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await deps.record({ ...base, status: "failed", at: new Date().toISOString(), error: `render: ${error}` });
      return { status: "failed", ledgerKey, error: `render: ${error}` };
    }
  }
  const viewUrls = forPublish(rendered);
  const renderedFilePath = rendered.filePath;

  // Publish ONCE (no re-invoke after a throw — see retry policy above).
  try {
    const res = await deps.publish({ viewUrls, caption: payload.caption, hashtags: payload.hashtags });
    // The Instagram client has its OWN dry-run switch (INSTAGRAM_DRY_RUN env).
    // If it declined to publish, nothing went live: record dry_run, NEVER
    // "posted" — a fake "posted" row would block this story forever.
    if (!res.published) {
      await deps.record({ ...base, status: "dry_run", at: new Date().toISOString() });
      // X runs on the live+approved publish path even when IG is in env dry-run
      // (it posts nothing itself because we pass the handoff dryRun through).
      const x = await attemptX(deps, payload.xCaption, renderedFilePath, args.dryRun);
      return { status: "dry_run", ledgerKey, reason: "Instagram client did not publish (INSTAGRAM_DRY_RUN=true in env)", ...(x ? { x } : {}) };
    }
    await deps.record({
      ...base,
      status: "posted",
      at: new Date().toISOString(),
      ...(res.mediaId ? { mediaId: res.mediaId } : {}),
      ...(res.permalink ? { permalink: res.permalink } : {}),
    });
    // X is an ADDITIONAL, fail-soft side effect: its outcome never changes the
    // IG `posted` status nor touches the ledger (see independence rule above).
    const x = await attemptX(deps, payload.xCaption, renderedFilePath, args.dryRun);
    return {
      status: "posted",
      ledgerKey,
      ...(res.mediaId ? { mediaId: res.mediaId } : {}),
      ...(res.permalink ? { permalink: res.permalink } : {}),
      ...(x ? { x } : {}),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await deps.record({ ...base, status: "failed", at: new Date().toISOString(), error: `publish: ${error}` });
    return { status: "failed", ledgerKey, error: `publish: ${error}` };
  }
}

/**
 * Attempt the independent X post. NEVER throws: any error (missing session,
 * empty caption, publishToX failure or unexpected throw) is captured into the
 * returned XOutcome and NEVER propagated, so a successful Instagram post is
 * never flipped to failed. Returns the XOutcome to attach to the result.
 */
async function attemptX(
  deps: HandoffDeps,
  xCaption: string,
  imagePath: string | undefined,
  dryRun: boolean,
): Promise<HandoffResult["x"]> {
  try {
    // publishToX throws on empty text — guard before attempting.
    if (!xCaption || xCaption.trim().length === 0) {
      return { attempted: false, success: false, error: "no X caption" };
    }
    const ready = await deps.xReady();
    if (!ready.ok) {
      return { attempted: false, success: false, error: ready.reason ?? "X not ready" };
    }
    const res = await deps.xPublish({ text: xCaption, imagePath, dryRun });
    return {
      attempted: true,
      success: res.success,
      ...(res.tweetUrl ? { tweetUrl: res.tweetUrl } : {}),
      ...(res.dryRun != null ? { dryRun: res.dryRun } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
  } catch (err) {
    // publishToX never throws for post failures, but swallow any unexpected
    // throw so it can NEVER flip the Instagram status.
    return { attempted: true, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- default deps (only invoked in live, approved mode) ----------

/** Render the RAS story PNG (no publish). Exported so the workflow can show the created post BEFORE approval. */
export async function renderRasPost(payload: RasPayload): Promise<{ viewUrls: string[]; filePath: string; publishPaths: string[] }> {
  if (!payload.imageLocalPath) {
    // RAS's story template requires a hero image; text-only single posts are
    // not supported by RAS's current tools. Flagged for a product decision.
    throw new Error("text-only: RAS story template requires a hero image (not supported without a brand placeholder)");
  }
  const slug = sanitizeSlug(`${payload.headline.slice(0, 40)}-${Date.now()}`);
  const outputDir = ensureRasOutputDir(slug);
  const hero = await resolveHeroImage(payload.imageLocalPath);
  const logo = loadLocalLogo(logoPath("ras-logo-dark.svg"));
  const component = React.createElement(RasStoryTemplate, {
    heroImageBase64: hero,
    categoryTag: payload.categoryTag,
    serifHeadline: payload.serifHeadline,
    deckLead: payload.deckLead,
    deckHighlight: payload.deckHighlight,
    deckTail: payload.deckTail,
    accentColor: payload.accentColor,
    logoBase64: logo.dataUrl,
    logoWidth: logo.width,
    logoHeight: logo.height,
  });
  const png = await renderComponentToPng(component, RAS_CANVAS);
  const filePath = path.join(outputDir, "01.png");
  writeFileSync(filePath, png);

  // Instagram only accepts JPEG: write a JPEG sibling and publish THAT.
  const jpeg = await pngToInstagramJpeg(png);
  if (jpeg.length > IG_MAX_BYTES) throw new Error(`rendered JPEG is ${jpeg.length} bytes (> Instagram's 8 MB limit)`);
  writeFileSync(path.join(outputDir, "01.jpg"), jpeg);

  return {
    viewUrls: [rasViewUrl(slug, "01.png")],
    filePath,
    publishPaths: [`/ras-publish/${encodeURIComponent(slug)}/01.jpg`],
  };
}

async function defaultPublish(a: { viewUrls: string[]; caption: string; hashtags: string[] }): Promise<{ published: boolean; dryRun?: boolean; mediaId?: string; permalink?: string }> {
  const caption = a.hashtags.length ? assembleCaption(a.caption, a.hashtags) : a.caption;
  const base = getPublicBaseUrl();
  if (!base) {
    throw new Error("PUBLIC_BASE_URL is not set. Instagram must fetch the rendered post from a public HTTPS URL (set it to your deployed host or an ngrok/cloudflared tunnel that serves /ras-assets).");
  }
  const imageUrls = a.viewUrls.map((v) => base + toAssetPath(v));
  // Preflight: Instagram fetches these URLs itself and, when a URL returns a
  // 404/HTML page (wrong port, stale tunnel, output-root mismatch), rejects it
  // with the opaque "Only photo or video can be accepted as media type". Check
  // here so that failure mode surfaces as a clear, actionable error instead.
  await preflightPublicImages(imageUrls);
  const res = await publishImagesToInstagram({ imageUrls, caption });
  return { published: res.published, dryRun: res.dryRun, mediaId: res.mediaId, permalink: res.permalink };
}

/**
 * Verifies each public image URL is reachable and actually serves an image
 * before handing it to Instagram. Throws a descriptive error otherwise.
 */
async function preflightPublicImages(imageUrls: string[]): Promise<void> {
  for (const url of imageUrls) {
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", redirect: "follow" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `preflight: could not fetch the public image URL ${url} (${msg}). ` +
          `Instagram must be able to fetch it over the internet — check PUBLIC_BASE_URL and that the tunnel/proxy is up.`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `preflight: ${url} returned HTTP ${res.status}. Instagram would see the same and reject it. ` +
          `The tunnel/proxy is not serving this path — verify it points at the server serving /ras-publish ` +
          `and that RAS_OUTPUT_ROOT matches where the renderer wrote the file.`,
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!/^image\//i.test(contentType)) {
      throw new Error(
        `preflight: ${url} returned content-type "${contentType || "(none)"}", not an image. ` +
          `Instagram rejects non-image responses with "Only photo or video can be accepted as media type". ` +
          `This usually means the URL resolves to an HTML page (404 or an ngrok browser-warning interstitial).`,
      );
    }
  }
}

function toAssetPath(viewUrlOrPath: string): string {
  try {
    const u = new URL(viewUrlOrPath);
    return u.pathname + u.search;
  } catch {
    return viewUrlOrPath.startsWith("/") ? viewUrlOrPath : `/${viewUrlOrPath}`;
  }
}
