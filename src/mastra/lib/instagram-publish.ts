/**
 * Bridges the Design Agent's rendered deliverables to the Instagram
 * publishing client. Responsibilities:
 *  - build publicly reachable HTTPS URLs for slide images (Meta must fetch
 *    them from its own servers, so localhost is not enough)
 *  - resolve deliverables from a design job id or from an already-copied
 *    workspace folder
 *  - assemble the full caption (caption body + hashtag block)
 */

import fs from "node:fs";
import path from "node:path";
import { getDesignJobStatus, type SlideManifest } from "./design-agent-client";

/**
 * Base URL that serves the /post-assets route to the public internet.
 * In production set PUBLIC_BASE_URL to your deployed HTTPS host; in local
 * dev point it at a tunnel (ngrok / cloudflared) that forwards to the
 * Mastra server, otherwise Instagram cannot fetch the slides.
 */
export function getPublicBaseUrl(): string {
  const raw =
    process.env.PUBLIC_BASE_URL?.trim() ||
    process.env.PUBLIC_ASSET_BASE_URL?.trim() ||
    "";
  return raw.replace(/\/+$/, "");
}

/** Builds the public HTTPS URL for a single rendered slide file. */
export function buildPublicImageUrl(jobId: string, filename: string): string {
  const base = getPublicBaseUrl();
  if (!base) {
    throw new Error(
      "PUBLIC_BASE_URL is not set. Instagram must fetch slide images from a public HTTPS URL. " +
        "Set PUBLIC_BASE_URL to your deployed host or a tunnel (e.g. https://<id>.ngrok.app).",
    );
  }
  return `${base}/post-assets/${jobId}/${encodeURIComponent(filename)}`;
}

export interface ResolvedPost {
  jobId: string;
  imageUrls: string[];
  slides: SlideManifest[];
  caption: string;
  hashtags: string[];
}

/** Joins caption body and hashtags into the final Instagram caption text. */
export function assembleCaption(caption: string, hashtags: string[]): string {
  const body = (caption || "").trim();
  const tags = (hashtags || [])
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t : `#${t}`));
  if (tags.length === 0) return body;
  return body ? `${body}\n\n${tags.join(" ")}` : tags.join(" ");
}

/**
 * Resolves a completed design job into the slide image URLs + caption
 * required for publishing. Reads the job status from the Design Agent API.
 */
export async function resolvePostFromJob(jobId: string): Promise<ResolvedPost> {
  const status = await getDesignJobStatus(jobId);
  if (status.status !== "done" || !status.post) {
    throw new Error(
      `Design job ${jobId} is not ready to publish (status: ${status.status}).`,
    );
  }
  const slides = [...status.post.slides].sort((a, b) => a.index - b.index);
  const imageUrls = slides.map((s) => buildPublicImageUrl(jobId, s.file));
  return {
    jobId,
    imageUrls,
    slides,
    caption: assembleCaption(status.post.caption, status.post.hashtags),
    hashtags: status.post.hashtags,
  };
}

/**
 * Fallback resolver that reads deliverables straight from the workspace
 * folder (workspace/output/<jobId>/) when the Design Agent API is not
 * reachable but the files were already copied locally. Uses post.json for
 * caption/hashtags and slide_NN.jpg files for images.
 */
export function resolvePostFromWorkspace(jobId: string): ResolvedPost {
  const dir = path.resolve(process.cwd(), "workspace", "output", jobId);
  if (!fs.existsSync(dir)) {
    throw new Error(`Workspace output folder not found for job ${jobId}: ${dir}`);
  }

  const slideFiles = fs
    .readdirSync(dir)
    .filter((f) => /^slide_\d+\.jpe?g$/i.test(f))
    .sort((a, b) => slideIndex(a) - slideIndex(b));

  if (slideFiles.length === 0) {
    throw new Error(`No slide images found in ${dir}`);
  }

  let caption = "";
  let hashtags: string[] = [];
  const postJsonPath = path.join(dir, "post.json");
  if (fs.existsSync(postJsonPath)) {
    try {
      const post = JSON.parse(fs.readFileSync(postJsonPath, "utf8")) as {
        caption?: string;
        hashtags?: string[];
      };
      caption = post.caption ?? "";
      hashtags = post.hashtags ?? [];
    } catch {
      // Ignore malformed post.json — fall back to caption.txt below.
    }
  }
  if (!caption) {
    const captionTxt = path.join(dir, "caption.txt");
    if (fs.existsSync(captionTxt)) {
      caption = fs.readFileSync(captionTxt, "utf8").trim();
    }
  }

  const slides: SlideManifest[] = slideFiles.map((file, i) => ({
    index: i,
    file,
    alt_text: "",
  }));

  return {
    jobId,
    imageUrls: slides.map((s) => buildPublicImageUrl(jobId, s.file)),
    slides,
    caption: hashtags.length ? assembleCaption(caption, hashtags) : caption,
    hashtags,
  };
}

function slideIndex(filename: string): number {
  const m = filename.match(/slide_(\d+)/i);
  return m ? Number(m[1]) : 0;
}
