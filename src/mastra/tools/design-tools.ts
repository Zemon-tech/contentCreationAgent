import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { newsToPostWorkflow } from "../workflows/newsToPostWorkflow";

const TemplateIdSchema = z
  .enum(["tech-announcement", "keilhq-editorial", "keilhq-text", "entrepreneur-post", "360labs-news"])
  .optional()
  .describe(
    "Suggested template. Omit for auto-select (controversy/news → 360labs-news, tech launch → tech-announcement, founder → entrepreneur-post).",
  );

const NewsInput = {
  topic: z.string().min(1).optional().describe("News topic to search, e.g. 'Anthropic Claude'. Omit when content is provided."),
  content: z.string().min(10).optional().describe("User-provided news text used directly instead of web search."),
  format: z
    .enum(["single", "carousel"])
    .describe("Instagram post format: 'single' for a single image, or 'carousel' for multi-slide."),
  template_id: TemplateIdSchema,
  aspect_ratio: z.enum(["4:5", "1:1", "3:4"]).default("4:5"),
  max_slides: z.number().int().min(1).max(10).default(5),
  cover_image_url: z
    .string()
    .url()
    .optional()
    .describe("Optional direct image URL used as-is for the cover (slide 1) hero instead of AI generation."),
  cover_prompt: z
    .string()
    .min(10)
    .optional()
    .describe("Optional explicit Flux cover prompt overriding the skill-generated one."),
};

const PostOutput = {
  status: z.string(),
  job_id: z.string(),
  topic: z.string().optional(),
  newsTitle: z.string().optional(),
  newsUrl: z.string().optional(),
  selected_template: z.string().optional(),
  template_rationale: z.string().optional(),
  coverPrompt: z
    .object({ thesis: z.string(), visualMetaphor: z.string(), fluxPrompt: z.string() })
    .optional(),
  anglePack: z
    .object({
      recommendedAngle: z.string(),
      viralAngle: z.string(),
      controversyAngle: z.string(),
      uniqueAngle: z.string(),
    })
    .optional(),
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
  previewFile: z.string().nullable().optional(),
  zipFile: z.string().nullable().optional(),
  copiedFiles: z.array(z.string()),
};

export const searchNewsAndCreatePostTool = createTool({
  id: "searchNewsAndCreatePost",
  description:
    "Searches live news on a topic, then in parallel generates the cover prompt (neoclassical-editorial skill) and mines viral/controversy/unique angles, auto-selects the template, renders with Design Agent, and packages preview.html + bundle.zip.",
  inputSchema: z.object(NewsInput),
  outputSchema: z.object({ ...PostOutput, topic: z.string(), newsTitle: z.string(), newsUrl: z.string() }),
  execute: async (input) => {
    const run = await newsToPostWorkflow.createRun();
    const result = await run.start({ inputData: input });

    if (result.status !== "success") {
      throw new Error(`News to post workflow failed: ${JSON.stringify(result)}`);
    }

    return result.result;
  },
});

export const createPostFromContentTool = createTool({
  id: "createPostFromContent",
  description:
    "Creates an Instagram post directly from user-provided news text: cover prompt (neoclassical-editorial skill) + angle mining run in parallel, template auto-selected unless suggested, then rendered with preview.html + bundle.zip packaging.",
  inputSchema: z.object(NewsInput),
  outputSchema: z.object(PostOutput),
  execute: async (input) => {
    if (!input.content && !input.topic) {
      throw new Error("Provide either `content` (user news text) or `topic` (to search news).");
    }
    const run = await newsToPostWorkflow.createRun();
    const result = await run.start({ inputData: input });
    if (result.status !== "success") {
      throw new Error(`News to post workflow failed: ${JSON.stringify(result)}`);
    }
    return result.result;
  },
});
