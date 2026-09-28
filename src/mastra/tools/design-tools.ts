import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { submitDesignJob, waitForDesignJob, copyDeliverablesToWorkspace } from "../lib/design-agent-client";
import { formatStoryForTemplate } from "../lib/content-formatter";
import { routeStoryToTemplate } from "../lib/template-router";
import { storyRepository, opportunityRepository, updateStoryEditorialStatus } from "../repositories/store";

export const createPostFromContentTool = createTool({
  id: "createPostFromContent",
  description:
    "Creates an Instagram visual post (single slide or carousel) directly from article text, story summary, or notes using Design Agent without searching the web.",
  inputSchema: z.object({
    content: z
      .string()
      .min(10)
      .describe("The story text, headline, summary, or details to render into the post."),
    format: z
      .enum(["single", "carousel"])
      .describe("Instagram post format: 'single' for a single image, or 'carousel' for multi-slide."),
    template_id: z
      .enum(["tech-announcement", "keilhq-editorial", "keilhq-text", "entrepreneur-post", "360labs-news", "news-brief"])
      .default("news-brief")
      .describe("Template to use. Defaults to 'news-brief'."),
    aspect_ratio: z.enum(["4:5", "1:1", "3:4"]).default("4:5"),
    max_slides: z.number().int().min(1).max(10).default(5),
    cover_image_url: z
      .string()
      .url()
      .optional()
      .describe("Optional direct image URL used as-is for the cover (slide 1) hero instead of AI generation."),
  }),
  outputSchema: z.object({
    status: z.string(),
    job_id: z.string(),
    caption: z.string(),
    hashtags: z.array(z.string()),
    slides: z.array(
      z.object({
        index: z.number(),
        file: z.string(),
        alt_text: z.string(),
        view_url: z.string(),
        download_url: z.string(),
      }),
    ),
    workspaceDir: z.string(),
    copiedFiles: z.array(z.string()),
  }),
  execute: async ({ content, format, template_id, aspect_ratio, max_slides, cover_image_url }) => {
    const { job_id } = await submitDesignJob({
      content,
      template_id: template_id || "news-brief",
      format: format || "single",
      aspect_ratio: aspect_ratio || "4:5",
      max_slides: max_slides || 5,
      ...(cover_image_url ? { cover_image_url } : {}),
    });

    const job = await waitForDesignJob(job_id);
    const deliverables = await copyDeliverablesToWorkspace(job);

    return {
      status: "success",
      job_id,
      caption: deliverables.caption,
      hashtags: deliverables.hashtags,
      slides: deliverables.slides.map((slide) => ({
        ...slide,
        view_url: `/post-assets/${job_id}/${encodeURIComponent(slide.file)}`,
        download_url: `/post-assets/${job_id}/${encodeURIComponent(slide.file)}?download=1`,
      })),
      workspaceDir: deliverables.destDir,
      copiedFiles: deliverables.copiedFiles,
    };
  },
});

export const renderPostFromApprovedStoryTool = createTool({
  id: "renderPostFromApprovedStory",
  description:
    "Renders an approved story from the editorial review queue into a ready-to-publish Instagram post using the Design Agent and the selected template (default: 'news-brief').",
  inputSchema: z.object({
    story_id: z.string().describe("ID of the approved story in the review queue"),
    template_id: z
      .enum(["tech-announcement", "keilhq-editorial", "keilhq-text", "entrepreneur-post", "360labs-news", "news-brief"])
      .optional()
      .describe("Template override. Defaults to 'news-brief'."),
    aspect_ratio: z.enum(["4:5", "3:4", "1:1"]).optional().describe("Aspect ratio for the template. Defaults to 4:5."),
    cover_image_url: z
      .string()
      .url()
      .optional()
      .describe("Optional cover image URL override for the hero slot."),
  }),
  outputSchema: z.object({
    status: z.string(),
    job_id: z.string().optional(),
    story_id: z.string(),
    template_id: z.string(),
    caption: z.string().optional(),
    hashtags: z.array(z.string()).optional(),
    slides: z
      .array(
        z.object({
          index: z.number(),
          file: z.string(),
          alt_text: z.string(),
          view_url: z.string(),
          download_url: z.string(),
        }),
      )
      .optional(),
    workspaceDir: z.string().optional(),
    copiedFiles: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
  execute: async (input: any) => {
    const story_id = input.story_id ?? input.context?.story_id;
    const template_id = input.template_id ?? input.context?.template_id;
    const aspect_ratio = input.aspect_ratio ?? input.context?.aspect_ratio;
    const cover_image_url = input.cover_image_url ?? input.context?.cover_image_url;

    const story = await storyRepository.get(story_id);
    if (!story) {
      return {
        status: "error",
        story_id,
        template_id: template_id || "news-brief",
        error: `Story with ID '${story_id}' not found.`,
      };
    }

    // Find any matching opportunity or synthesize from story
    const opportunities = await opportunityRepository.list();
    const opportunity = opportunities.find((o) => o.storyId === story_id);

    // Route template (defaulting to news-brief)
    const routing = await routeStoryToTemplate(story, opportunity, {
      forceTemplateId: template_id || "news-brief",
    });
    const selectedTemplate = routing.template_id;
    const selectedRatio = (aspect_ratio || "4:5") as "4:5" | "3:4" | "1:1";

    // Format content with exact template slots
    const formatted = formatStoryForTemplate(story, opportunity, {
      template_id: selectedTemplate,
      aspect_ratio: selectedRatio,
      cover_image_url: cover_image_url || story.evidence?.primarySource || story.sources[0],
    });

    // Mark as SENT_TO_DESIGN
    await updateStoryEditorialStatus(story_id, "SENT_TO_DESIGN");

    // Submit to Design Agent
    const { job_id } = await submitDesignJob({
      content: formatted.content,
      template_id: selectedTemplate as any,
      format: formatted.format,
      aspect_ratio: formatted.aspect_ratio,
      max_slides: 1,
      ...(formatted.cover_image_url ? { cover_image_url: formatted.cover_image_url } : {}),
    });

    const job = await waitForDesignJob(job_id);
    const deliverables = await copyDeliverablesToWorkspace(job);

    return {
      status: "success",
      job_id,
      story_id,
      template_id: selectedTemplate,
      caption: deliverables.caption,
      hashtags: deliverables.hashtags,
      slides: deliverables.slides.map((slide) => ({
        ...slide,
        view_url: `/post-assets/${job_id}/${encodeURIComponent(slide.file)}`,
        download_url: `/post-assets/${job_id}/${encodeURIComponent(slide.file)}?download=1`,
      })),
      workspaceDir: deliverables.destDir,
      copiedFiles: deliverables.copiedFiles,
    };
  },
});
