import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { newsToPostWorkflow } from "../workflows/newsToPostWorkflow";
import { submitDesignJob, waitForDesignJob, copyDeliverablesToWorkspace } from "../lib/design-agent-client";

export const searchNewsAndCreatePostTool = createTool({
  id: "searchNewsAndCreatePost",
  description:
    "Searches live news on a requested topic and creates an Instagram visual post (single slide or carousel) with captions and hashtags using Design Agent.",
  inputSchema: z.object({
    topic: z.string().min(1).describe("The news topic or query to search, e.g. 'Anthropic Claude' or 'OpenAI'"),
    format: z
      .enum(["single", "carousel"])
      .describe("Instagram post format: 'single' for a single image, or 'carousel' for multi-slide."),
    template_id: z
      .enum(["tech-announcement", "keilhq-editorial", "keilhq-text", "entrepreneur-post", "360labs-news"])
      .default("tech-announcement")
      .describe("Template to use. 'tech-announcement' is recommended for tech and industry news."),
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
    topic: z.string(),
    newsTitle: z.string(),
    newsUrl: z.string(),
    caption: z.string(),
    hashtags: z.array(z.string()),
    slides: z.array(
      z.object({
        index: z.number(),
        file: z.string(),
        alt_text: z.string(),
      }),
    ),
    workspaceDir: z.string(),
    copiedFiles: z.array(z.string()),
  }),
  execute: async ({ topic, format, template_id, aspect_ratio, max_slides, cover_image_url }) => {
    const run = await newsToPostWorkflow.createRun();
    const result = await run.start({
      inputData: {
        topic,
        format: format || "single",
        template_id: template_id || "tech-announcement",
        aspect_ratio: aspect_ratio || "4:5",
        max_slides: max_slides || 5,
        ...(cover_image_url ? { cover_image_url } : {}),
      },
    });

    if (result.status !== "success") {
      throw new Error(`News to post workflow failed: ${JSON.stringify(result)}`);
    }

    return result.result;
  },
});

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
      .enum(["tech-announcement", "keilhq-editorial", "keilhq-text", "entrepreneur-post", "360labs-news"])
      .default("tech-announcement")
      .describe("Template to use. 'tech-announcement' is recommended for tech and industry news."),
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
      }),
    ),
    workspaceDir: z.string(),
    copiedFiles: z.array(z.string()),
  }),
  execute: async ({ content, format, template_id, aspect_ratio, max_slides, cover_image_url }) => {
    const { job_id } = await submitDesignJob({
      content,
      template_id: template_id || "tech-announcement",
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
      slides: deliverables.slides,
      workspaceDir: deliverables.destDir,
      copiedFiles: deliverables.copiedFiles,
    };
  },
});
