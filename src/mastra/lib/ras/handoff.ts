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
}

export const defaultHandoffDeps: HandoffDeps = {
  render: (p) => renderRasPost(p),
  publish: defaultPublish,
  getRow: (key) => getRow(key),
  record: (row) => recordAttempt(row),
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

  // Render (retry once — idempotent).
  let viewUrls: string[];
  const forPublish = (r: { viewUrls: string[]; publishPaths?: string[] }) => r.publishPaths ?? r.viewUrls;
  try {
    viewUrls = forPublish(await deps.render(payload));
  } catch {
    try {
      viewUrls = forPublish(await deps.render(payload));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await deps.record({ ...base, status: "failed", at: new Date().toISOString(), error: `render: ${error}` });
      return { status: "failed", ledgerKey, error: `render: ${error}` };
    }
  }

  // Publish ONCE (no re-invoke after a throw — see retry policy above).
  try {
    const res = await deps.publish({ viewUrls, caption: payload.caption, hashtags: payload.hashtags });
    // The Instagram client has its OWN dry-run switch (INSTAGRAM_DRY_RUN env).
    // If it declined to publish, nothing went live: record dry_run, NEVER
    // "posted" — a fake "posted" row would block this story forever.
    if (!res.published) {
      await deps.record({ ...base, status: "dry_run", at: new Date().toISOString() });
      return { status: "dry_run", ledgerKey, reason: "Instagram client did not publish (INSTAGRAM_DRY_RUN=true in env)" };
    }
    await deps.record({
      ...base,
      status: "posted",
      at: new Date().toISOString(),
      ...(res.mediaId ? { mediaId: res.mediaId } : {}),
      ...(res.permalink ? { permalink: res.permalink } : {}),
    });
    return { status: "posted", ledgerKey, ...(res.mediaId ? { mediaId: res.mediaId } : {}), ...(res.permalink ? { permalink: res.permalink } : {}) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await deps.record({ ...base, status: "failed", at: new Date().toISOString(), error: `publish: ${error}` });
    return { status: "failed", ledgerKey, error: `publish: ${error}` };
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
  const res = await publishImagesToInstagram({ imageUrls, caption });
  return { published: res.published, dryRun: res.dryRun, mediaId: res.mediaId, permalink: res.permalink };
}

function toAssetPath(viewUrlOrPath: string): string {
  try {
    const u = new URL(viewUrlOrPath);
    return u.pathname + u.search;
  } catch {
    return viewUrlOrPath.startsWith("/") ? viewUrlOrPath : `/${viewUrlOrPath}`;
  }
}
