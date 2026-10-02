import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  checkInstagramConnection,
  publishImagesToInstagram,
  InstagramApiError,
  InstagramConfigError,
} from "../lib/instagram-client";
import {
  resolvePostFromJob,
  resolvePostFromWorkspace,
  assembleCaption,
} from "../lib/instagram-publish";
import {
  submitDesignJob,
  waitForDesignJob,
  copyDeliverablesToWorkspace,
} from "../lib/design-agent-client";
import { storyRepository, updateStoryEditorialStatus } from "../repositories/store";
import { routeStoryToTemplate } from "../lib/template-router";
import { formatStoryForTemplate } from "../lib/content-formatter";
import { opportunityRepository } from "../repositories/store";

const TEMPLATE_ENUM = z.enum([
  "tech-announcement",
  "keilhq-editorial",
  "keilhq-text",
  "entrepreneur-post",
  "360labs-news",
  "news-brief",
]);

const SlideSchema = z.object({
  index: z.number(),
  file: z.string(),
  alt_text: z.string(),
});

/** Turns any thrown error into a clean, structured tool result string. */
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

/**
 * Tool 1 — connection health check. Verifies the configured token can see
 * the account and reports the remaining daily publishing quota.
 */
export const checkInstagramConnectionTool = createTool({
  id: "checkInstagramConnection",
  description:
    "Verify the Instagram publishing connection: confirms the access token can reach the configured Instagram Professional account and reports the remaining daily publishing quota. Use this before publishing to diagnose setup issues.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    connected: z.boolean(),
    dryRun: z.boolean(),
    graphVersion: z.string(),
    accountId: z.string().optional(),
    username: z.string().optional(),
    accountType: z.string().optional(),
    publishingLimit: z
      .object({ quotaUsage: z.number(), quotaTotal: z.number() })
      .optional(),
    missing: z.array(z.string()),
    error: z.string().optional(),
    message: z.string(),
  }),
  execute: async () => {
    const status = await checkInstagramConnection();
    const message = status.connected
      ? `Connected to Instagram as @${status.username ?? status.accountId} (${status.accountType ?? "professional"})` +
        (status.publishingLimit
          ? `. Published ${status.publishingLimit.quotaUsage}/${status.publishingLimit.quotaTotal} in the last 24h.`
          : ".") +
        (status.dryRun ? " DRY-RUN mode is ON — nothing will actually post." : "")
      : status.missing.length
        ? `Not connected. Missing config: ${status.missing.join(", ")}.`
        : `Not connected. ${status.error ?? "Unknown error."}`;
    return { ...status, message };
  },
});

/**
 * Tool 2 — publish from explicit public image URLs. Lowest-level publish
 * entry point; useful when the caller already has hosted image URLs.
 */
export const publishToInstagramTool = createTool({
  id: "publishToInstagram",
  description:
    "Publish one image (single post) or 2-10 images (carousel) to Instagram from public HTTPS image URLs, with a caption. Image URLs MUST be publicly reachable by Meta's servers.",
  inputSchema: z.object({
    image_urls: z
      .array(z.string().url())
      .min(1)
      .max(10)
      .describe("Public HTTPS image URLs. 1 = single post, 2-10 = carousel."),
    caption: z.string().default("").describe("Full caption text (include hashtags inline)."),
    hashtags: z
      .array(z.string())
      .optional()
      .describe("Optional hashtags appended to the caption if not already present."),
  }),
  outputSchema: z.object({
    status: z.enum(["success", "dry_run", "error"]),
    published: z.boolean(),
    media_id: z.string().optional(),
    permalink: z.string().optional(),
    image_count: z.number(),
    caption: z.string(),
    error: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ image_urls, caption, hashtags }) => {
    const finalCaption = hashtags?.length ? assembleCaption(caption, hashtags) : caption;
    try {
      const result = await publishImagesToInstagram({
        imageUrls: image_urls,
        caption: finalCaption,
      });
      if (result.dryRun) {
        return {
          status: "dry_run" as const,
          published: false,
          image_count: result.imageCount,
          caption: result.caption,
          message: `DRY-RUN: would publish ${result.imageCount} image(s). Set INSTAGRAM_DRY_RUN=false to go live.`,
        };
      }
      return {
        status: "success" as const,
        published: true,
        media_id: result.mediaId,
        permalink: result.permalink,
        image_count: result.imageCount,
        caption: result.caption,
        message: `Published ${result.imageCount === 1 ? "single post" : `${result.imageCount}-slide carousel`} to Instagram${result.permalink ? `: ${result.permalink}` : ` (media ${result.mediaId}).`}`,
      };
    } catch (error) {
      return {
        status: "error" as const,
        published: false,
        image_count: image_urls.length,
        caption: finalCaption,
        error: describeError(error),
        message: `Failed to publish to Instagram: ${describeError(error)}`,
      };
    }
  },
});

/**
 * Tool 3 — publish an already-rendered Design Agent job by its job id.
 * Resolves slide image URLs + caption from the job, then publishes.
 */
export const publishDesignJobToInstagramTool = createTool({
  id: "publishDesignJobToInstagram",
  description:
    "Publish an already-rendered Design Agent post (by its job_id) to Instagram. Resolves the slide images and caption from the completed job and posts a single image or carousel.",
  inputSchema: z.object({
    job_id: z.string().describe("The Design Agent job id of a completed post."),
    caption_override: z
      .string()
      .optional()
      .describe("Optional caption to use instead of the rendered caption."),
    from_workspace: z
      .boolean()
      .default(false)
      .describe("Read deliverables from workspace/output/<job_id>/ instead of the Design Agent API."),
  }),
  outputSchema: z.object({
    status: z.enum(["success", "dry_run", "error"]),
    published: z.boolean(),
    job_id: z.string(),
    media_id: z.string().optional(),
    permalink: z.string().optional(),
    image_count: z.number(),
    slides: z.array(SlideSchema).optional(),
    caption: z.string(),
    error: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ job_id, caption_override, from_workspace }) => {
    try {
      const resolved = from_workspace
        ? resolvePostFromWorkspace(job_id)
        : await resolvePostFromJob(job_id);
      const caption = caption_override ?? resolved.caption;

      const result = await publishImagesToInstagram({
        imageUrls: resolved.imageUrls,
        caption,
      });

      if (result.dryRun) {
        return {
          status: "dry_run" as const,
          published: false,
          job_id,
          image_count: result.imageCount,
          slides: resolved.slides,
          caption: result.caption,
          message: `DRY-RUN: would publish job ${job_id} (${result.imageCount} image(s)). Set INSTAGRAM_DRY_RUN=false to go live.`,
        };
      }

      return {
        status: "success" as const,
        published: true,
        job_id,
        media_id: result.mediaId,
        permalink: result.permalink,
        image_count: result.imageCount,
        slides: resolved.slides,
        caption: result.caption,
        message: `Published job ${job_id} to Instagram${result.permalink ? `: ${result.permalink}` : ` (media ${result.mediaId}).`}`,
      };
    } catch (error) {
      return {
        status: "error" as const,
        published: false,
        job_id,
        image_count: 0,
        caption: caption_override ?? "",
        error: describeError(error),
        message: `Failed to publish job ${job_id}: ${describeError(error)}`,
      };
    }
  },
});

/**
 * Tool 4 — end-to-end: render an approved story via the Design Agent, then
 * publish it to Instagram and mark the story PUBLISHED. This is the primary
 * "approve -> post" path for the editorial workflow.
 */
export const publishStoryToInstagramTool = createTool({
  id: "publishStoryToInstagram",
  description:
    "Render an approved story into an Instagram post via the Design Agent and publish it to Instagram, then mark the story as PUBLISHED. Use for the editorial approve-then-post flow.",
  inputSchema: z.object({
    story_id: z.string().describe("ID of the story to render and publish."),
    template_id: TEMPLATE_ENUM.optional().describe("Template override. Defaults to 'news-brief'."),
    format: z.enum(["single", "carousel"]).default("single"),
    aspect_ratio: z.enum(["4:5", "1:1", "3:4"]).default("4:5"),
    max_slides: z.number().int().min(1).max(10).default(5),
    cover_image_url: z.string().url().optional(),
    caption_override: z.string().optional(),
  }),
  outputSchema: z.object({
    status: z.enum(["success", "dry_run", "error"]),
    published: z.boolean(),
    story_id: z.string(),
    job_id: z.string().optional(),
    template_id: z.string().optional(),
    media_id: z.string().optional(),
    permalink: z.string().optional(),
    image_count: z.number(),
    caption: z.string().optional(),
    error: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({
    story_id,
    template_id,
    format,
    aspect_ratio,
    max_slides,
    cover_image_url,
    caption_override,
  }) => {
    try {
      const story = await storyRepository.get(story_id);
      if (!story) {
        return {
          status: "error" as const,
          published: false,
          story_id,
          image_count: 0,
          error: `Story '${story_id}' not found.`,
          message: `Story '${story_id}' not found.`,
        };
      }

      // Route + format the story into template-ready content.
      const opportunities = await opportunityRepository.list();
      const opportunity = opportunities.find((o) => o.storyId === story_id);
      const routing = await routeStoryToTemplate(story, opportunity, {
        forceTemplateId: template_id || "news-brief",
      });
      const selectedTemplate = routing.template_id;
      const formatted = formatStoryForTemplate(story, opportunity, {
        template_id: selectedTemplate,
        aspect_ratio,
        cover_image_url:
          cover_image_url || story.evidence?.primarySource || story.sources[0],
      });

      // Render via Design Agent.
      const { job_id } = await submitDesignJob({
        content: formatted.content,
        template_id: selectedTemplate as never,
        format: formatted.format ?? format,
        aspect_ratio: formatted.aspect_ratio ?? aspect_ratio,
        max_slides,
        ...(formatted.cover_image_url ? { cover_image_url: formatted.cover_image_url } : {}),
      });
      await updateStoryEditorialStatus(story_id, "SENT_TO_DESIGN");
      const job = await waitForDesignJob(job_id, { timeoutMs: 180_000 });
      const deliverables = copyDeliverablesToWorkspace(job);

      // Resolve public URLs + publish.
      const resolved = await resolvePostFromJob(job_id);
      const caption = caption_override ?? resolved.caption;
      const result = await publishImagesToInstagram({
        imageUrls: resolved.imageUrls,
        caption,
      });

      if (result.dryRun) {
        return {
          status: "dry_run" as const,
          published: false,
          story_id,
          job_id,
          template_id: selectedTemplate,
          image_count: result.imageCount,
          caption: result.caption,
          message: `DRY-RUN: rendered story '${story.title}' as job ${job_id} but did not publish (INSTAGRAM_DRY_RUN is on).`,
        };
      }

      await updateStoryEditorialStatus(
        story_id,
        "PUBLISHED",
        result.permalink ? `Published to Instagram: ${result.permalink}` : `Published (media ${result.mediaId}).`,
      );

      return {
        status: "success" as const,
        published: true,
        story_id,
        job_id,
        template_id: selectedTemplate,
        media_id: result.mediaId,
        permalink: result.permalink,
        image_count: result.imageCount,
        caption: result.caption,
        message: `Published story '${story.title}' to Instagram${result.permalink ? `: ${result.permalink}` : ` (media ${result.mediaId}).`}`,
      };
    } catch (error) {
      return {
        status: "error" as const,
        published: false,
        story_id,
        image_count: 0,
        error: describeError(error),
        message: `Failed to publish story '${story_id}': ${describeError(error)}`,
      };
    }
  },
});
