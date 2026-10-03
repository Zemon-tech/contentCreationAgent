import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  checkXSession,
  launchXBrowser,
  measureXLimit,
  publishToX,
} from "../lib/x-publisher";
import { scrapeExa } from "./exa-tools";
import {
  storyRepository,
  updateStoryEditorialStatus,
  opportunityRepository,
} from "../repositories/store";
import { formatStoryForTemplate } from "../lib/content-formatter";
import { routeStoryToTemplate } from "../lib/template-router";
import {
  submitDesignJob,
  waitForDesignJob,
  copyDeliverablesToWorkspace,
} from "../lib/design-agent-client";

/**
 * Tool 1: Check session status on X.
 */
export const checkXSessionTool = createTool({
  id: "checkXSession",
  description:
    "Check if the dedicated X/Twitter browser is connected and signed in, view the active handle, and check character limits.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    loggedIn: z.boolean(),
    handle: z.string().nullable(),
    loginUrl: z.string().nullable().optional(),
    maxChars: z.number().optional(),
    message: z.string(),
    error: z.string().nullable().optional(),
    fix: z.string().nullable().optional(),
  }),
  execute: async () => {
    return await checkXSession();
  },
});

/**
 * Tool 2: Launch the dedicated automation browser.
 */
export const launchXBrowserTool = createTool({
  id: "launchXBrowser",
  description:
    "Launch the dedicated Chrome or Edge browser window for one-time X/Twitter login. Use this if checkXSession reports not logged in.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async () => {
    return await launchXBrowser();
  },
});

/**
 * Tool 3: Measure the account's empirical character limit.
 */
export const measureXLimitTool = createTool({
  id: "measureXLimit",
  description:
    "Test and save the true character ceiling of the logged-in X account (280 for free vs 25,000 for Premium) without posting anything.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    limit: z.union([z.number(), z.string()]),
    premium: z.boolean().optional(),
    saved: z.any().optional(),
    note: z.string().optional(),
  }),
  execute: async () => {
    return await measureXLimit();
  },
});

/**
 * Tool 4: Direct post to X from explicit text and optional image.
 */
export const publishToXTool = createTool({
  id: "publishToX",
  description:
    "Publish a post directly to X (Twitter) through the real browser session, with optional image attachment, and verify it live on your profile.",
  inputSchema: z.object({
    text: z.string().min(1).describe("The tweet text to post."),
    image_path: z
      .string()
      .optional()
      .describe("Optional absolute or workspace-relative path to an image to attach."),
    dry_run: z
      .boolean()
      .default(false)
      .describe("If true, types into the composer and takes a screenshot without clicking Post."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    tweetUrl: z.string().optional(),
    verified: z.boolean(),
    text: z.string(),
    image: z.string().optional(),
    screenshot: z.string().optional(),
    dryRun: z.boolean().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ text, image_path, dry_run }) => {
    let resolvedImage: string | undefined = undefined;
    if (image_path) {
      resolvedImage = path.isAbsolute(image_path)
        ? image_path
        : path.resolve(process.cwd(), image_path);
    }

    return await publishToX({
      text,
      imagePath: resolvedImage,
      dryRun: dry_run,
    });
  },
});

/**
 * Helper to draft clean, high-impact tweet copy from raw content.
 */
function draftTweetCopy(headline: string, text: string, url?: string): string {
  const cleanHeadline = headline.trim().replace(/^["']|["']$/g, "");
  const lines: string[] = [];

  lines.push(cleanHeadline);
  lines.push("");

  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 160 && !s.toLowerCase().includes("subscribe"));

  const takeaway = sentences[0] || text.slice(0, 140).trim();
  lines.push(takeaway);

  if (url) {
    lines.push("");
    lines.push(`Source: ${url}`);
  }

  let full = lines.join("\n").trim();
  if (full.length > 275) {
    const budget = 275 - (url ? url.length + 12 : 0);
    const trimmed =
      cleanHeadline.length > budget
        ? cleanHeadline.slice(0, budget - 3) + "..."
        : `${cleanHeadline}\n\n${takeaway.slice(0, budget - cleanHeadline.length - 6)}...`;
    full = url ? `${trimmed}\n\nSource: ${url}` : trimmed;
  }
  return full;
}

/**
 * Tool 5: Direct News to X Tool ("If I give it the news it posts it directly").
 */
export const directNewsToXTool = createTool({
  id: "directNewsToX",
  description:
    "Direct News-to-X Publisher: Provide a news article URL or raw news text/notes, and it will craft a hook-driven tweet in your voice, optionally generate a graphic card, and publish directly to your X account.",
  inputSchema: z.object({
    news: z
      .string()
      .min(5)
      .describe("The news article URL (e.g. 'https://...') or raw news text/bullet points to post."),
    headline: z
      .string()
      .optional()
      .describe("Optional headline or angle to prioritize."),
    with_graphic: z
      .boolean()
      .default(false)
      .describe("Whether to generate and attach a visual graphic card using Design Agent."),
    template_id: z
      .enum(["news-brief", "360labs-news", "tech-announcement", "keilhq-editorial"])
      .default("news-brief")
      .describe("Template to use if with_graphic is true."),
    dry_run: z
      .boolean()
      .default(false)
      .describe("If true, performs composition and screenshot without clicking Post."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    tweetUrl: z.string().optional(),
    tweetText: z.string(),
    imagePath: z.string().optional(),
    verified: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ news, headline, with_graphic, template_id, dry_run }) => {
    let articleTitle = headline || "";
    let articleText = news;
    let articleUrl: string | undefined = undefined;

    const isUrl = /^https?:\/\//i.test(news.trim());
    if (isUrl) {
      articleUrl = news.trim();
      try {
        console.log(`[directNewsToX] Scraping URL with Exa: ${articleUrl}`);
        const scrapeRes = await scrapeExa({ urls: [articleUrl] });
        const item = scrapeRes.contents[0];
        if (item) {
          articleTitle = articleTitle || item.title || "Industry Update";
          articleText = item.text || news;
        }
      } catch (err: any) {
        console.warn(`[directNewsToX] Exa scrape failed, falling back to direct URL: ${err.message}`);
        articleTitle = articleTitle || "Breaking Industry News";
      }
    } else {
      if (!articleTitle) {
        const firstLine = news.split("\n")[0].trim();
        articleTitle = firstLine.length < 90 ? firstLine : firstLine.slice(0, 85) + "...";
      }
    }

    const tweetText = draftTweetCopy(articleTitle, articleText, articleUrl);

    let imagePath: string | undefined = undefined;
    if (with_graphic) {
      try {
        console.log(`[directNewsToX] Generating graphic with template "${template_id}"...`);
        const { job_id } = await submitDesignJob({
          content: `${articleTitle}\n\n${articleText}`,
          template_id,
          format: "single",
          aspect_ratio: "4:5",
        });

        const job = await waitForDesignJob(job_id, { timeoutMs: 60_000 });
        if (job.status === "done") {
          const deliverables = copyDeliverablesToWorkspace(job);
          const slide1 = deliverables.copiedFiles.find(
            (f: string) => f.includes("slide_1.jpg") || f.endsWith(".jpg"),
          );
          if (slide1) {
            imagePath = path.resolve(process.cwd(), slide1);
          }
        }
      } catch (err: any) {
        console.warn(`[directNewsToX] Graphic generation failed, proceeding with text-only post: ${err.message}`);
      }
    }

    console.log(`[directNewsToX] Publishing to X...`);
    const pubRes = await publishToX({
      text: tweetText,
      imagePath,
      dryRun: dry_run,
    });

    return {
      success: pubRes.success,
      tweetUrl: pubRes.tweetUrl,
      tweetText,
      imagePath,
      verified: pubRes.verified,
      message: pubRes.message,
      error: pubRes.error,
    };
  },
});

/**
 * Tool 6: Autonomous Radar Publisher — publish an approved story from SQLite queue to X.
 */
export const publishApprovedStoryToXTool = createTool({
  id: "publishApprovedStoryToX",
  description:
    "Publish an approved story from the research radar database to X/Twitter, with optional design-agent card, and mark it as PUBLISHED.",
  inputSchema: z.object({
    story_id: z.string().describe("ID of the approved story in the database."),
    with_graphic: z.boolean().default(false).describe("Whether to render a visual card for the tweet."),
    dry_run: z.boolean().default(false).describe("If true, previews without clicking Post."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    tweetUrl: z.string().optional(),
    tweetText: z.string(),
    verified: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ story_id, with_graphic, dry_run }) => {
    const story = await storyRepository.get(story_id);
    if (!story) {
      throw new Error(`Story with ID "${story_id}" not found.`);
    }

    const opportunities = await opportunityRepository.list();
    const opportunity = opportunities.find((o) => o.storyId === story_id);
    const headline = opportunity?.hook || opportunity?.angle || story.title;
    const body = story.summary || story.whatHappened || "";
    const sourceUrl = story.evidence?.primarySource || (story.sources && story.sources[0]);

    const tweetText = draftTweetCopy(
      headline,
      body,
      typeof sourceUrl === "string" ? sourceUrl : undefined,
    );

    let imagePath: string | undefined = undefined;
    if (with_graphic) {
      try {
        const routing = await routeStoryToTemplate(story, opportunity);
        const selectedTemplate = routing.template_id;
        const formatted = formatStoryForTemplate(story, opportunity, {
          template_id: selectedTemplate,
          aspect_ratio: "4:5",
        });
        const { job_id } = await submitDesignJob({
          content: formatted.content,
          template_id: selectedTemplate as never,
          format: "single",
          aspect_ratio: "4:5",
        });
        const job = await waitForDesignJob(job_id, { timeoutMs: 60_000 });
        if (job.status === "done") {
          const deliverables = copyDeliverablesToWorkspace(job);
          const slide1 = deliverables.copiedFiles.find(
            (f: string) => f.includes("slide_1.jpg") || f.endsWith(".jpg"),
          );
          if (slide1) {
            imagePath = path.resolve(process.cwd(), slide1);
          }
        }
      } catch (err: any) {
        console.warn(`[publishApprovedStoryToX] Graphic render failed, falling back to text-only: ${err.message}`);
      }
    }

    const pubRes = await publishToX({
      text: tweetText,
      imagePath,
      dryRun: dry_run,
    });

    if (pubRes.success && !dry_run) {
      await updateStoryEditorialStatus(story_id, "PUBLISHED");
    }

    return {
      success: pubRes.success,
      tweetUrl: pubRes.tweetUrl,
      tweetText,
      verified: pubRes.verified,
      message: pubRes.message,
      error: pubRes.error,
    };
  },
});
