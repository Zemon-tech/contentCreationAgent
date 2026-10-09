/**
 * publish-ras-to-instagram — posts rendered RAS graphics to Instagram.
 *
 * Takes the local PNG paths produced by the render tools, maps them to the
 * public /ras-assets URLs (via PUBLIC_BASE_URL), and publishes a single post
 * or carousel through the existing Instagram client.
 *
 * Human-in-the-loop: the tool is gated with requireApproval so the agent
 * pauses for explicit user approval before any REAL post. Dry runs
 * (INSTAGRAM_DRY_RUN=true) skip the approval pause since nothing is published.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  publishImagesToInstagram,
  InstagramApiError,
  InstagramConfigError,
} from "../lib/instagram-client.js";
import { assembleCaption, getPublicBaseUrl } from "../lib/instagram-publish.js";

/** True when INSTAGRAM_DRY_RUN is set to a truthy value. */
function isDryRun(): boolean {
  return /^(1|true|yes)$/i.test(process.env.INSTAGRAM_DRY_RUN?.trim() || "");
}

/**
 * Reduces a render-tool view URL to its server-relative asset path.
 * Accepts an absolute URL (http://localhost:4111/ras-assets/...) or a bare
 * path (/ras-assets/...), returning the leading-slash path either way.
 */
function toAssetPath(viewUrlOrPath: string): string {
  try {
    const u = new URL(viewUrlOrPath);
    return u.pathname + u.search;
  } catch {
    return viewUrlOrPath.startsWith("/") ? viewUrlOrPath : `/${viewUrlOrPath}`;
  }
}

/** Maps a render-tool view URL to the PUBLIC_BASE_URL that Instagram fetches. */
function toPublicUrl(viewUrlOrPath: string): string {
  return `${getPublicBaseUrl()}${toAssetPath(viewUrlOrPath)}`;
}

export const publishRasToInstagramTool = createTool({
  id: "publish-ras-to-instagram",
  description:
    "Publish rendered Rise & Shine graphics to Instagram (single post or carousel) with a caption. " +
    "Pass the view_url paths returned by the render tools (1 = single, 2-10 = carousel). " +
    "This posts live and requires explicit approval; in dry-run it reports the payload without posting.",
  inputSchema: z.object({
    viewUrls: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .describe(
        "Ordered view_url paths from the render tool (e.g. '/ras-assets/<slug>/01.png'). " +
          "1 image = single post, 2-10 = carousel.",
      ),
    caption: z.string().default("").describe("Full caption body (without the hashtag block)."),
    hashtags: z
      .array(z.string())
      .default([])
      .describe("Hashtags appended as a block to the caption (with or without '#')."),
  }),
  outputSchema: z.object({
    status: z.enum(["success", "dry_run", "error"]),
    published: z.boolean(),
    media_id: z.string().optional(),
    permalink: z.string().optional(),
    image_count: z.number(),
    caption: z.string(),
    image_urls: z.array(z.string()),
    error: z.string().optional(),
    message: z.string(),
  }),
  // Require human approval for REAL posts; allow dry runs through unattended.
  requireApproval: async () => !isDryRun(),
  execute: async (inputData) => {
    const dryRun = isDryRun();
    const finalCaption = inputData.hashtags.length
      ? assembleCaption(inputData.caption, inputData.hashtags)
      : inputData.caption;

    // In dry-run we don't need a public base URL — report the local asset paths.
    let imageUrls: string[];
    if (dryRun && !getPublicBaseUrl()) {
      imageUrls = inputData.viewUrls.map(toAssetPath);
    } else {
      const base = getPublicBaseUrl();
      if (!base) {
        return {
          status: "error" as const,
          published: false,
          image_count: inputData.viewUrls.length,
          caption: finalCaption,
          image_urls: [],
          error: "PUBLIC_BASE_URL is not set.",
          message:
            "Cannot publish: PUBLIC_BASE_URL is not set. Instagram must fetch images from a public HTTPS URL. " +
            "Set PUBLIC_BASE_URL to a tunnel (ngrok/cloudflared) or deployed host, or set INSTAGRAM_DRY_RUN=true to test.",
        };
      }
      imageUrls = inputData.viewUrls.map(toPublicUrl);
    }

    try {
      const result = await publishImagesToInstagram({
        imageUrls,
        caption: finalCaption,
      });

      if (result.dryRun) {
        return {
          status: "dry_run" as const,
          published: false,
          image_count: result.imageCount,
          caption: result.caption,
          image_urls: imageUrls,
          message:
            `DRY-RUN: would publish ${result.imageCount === 1 ? "a single post" : `a ${result.imageCount}-slide carousel`} ` +
            `to Instagram. Set INSTAGRAM_DRY_RUN=false (and PUBLIC_BASE_URL) to go live.`,
        };
      }

      return {
        status: "success" as const,
        published: true,
        media_id: result.mediaId,
        permalink: result.permalink,
        image_count: result.imageCount,
        caption: result.caption,
        image_urls: imageUrls,
        message:
          `Published ${result.imageCount === 1 ? "single post" : `${result.imageCount}-slide carousel`} to Instagram` +
          (result.permalink ? `: ${result.permalink}` : ` (media ${result.mediaId}).`),
      };
    } catch (error) {
      return {
        status: "error" as const,
        published: false,
        image_count: inputData.viewUrls.length,
        caption: finalCaption,
        image_urls: imageUrls,
        error: describeError(error),
        message: `Failed to publish to Instagram: ${describeError(error)}`,
      };
    }
  },
});

function describeError(error: unknown): string {
  if (error instanceof InstagramApiError) {
    const parts = [error.message];
    if (error.code !== undefined) parts.push(`code ${error.code}`);
    if (error.subcode !== undefined) parts.push(`subcode ${error.subcode}`);
    if (error.fbtraceId) parts.push(`fbtrace_id ${error.fbtraceId}`);
    return parts.join(" | ");
  }
  if (error instanceof InstagramConfigError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
