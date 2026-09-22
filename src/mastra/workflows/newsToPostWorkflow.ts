import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { searchExa, scrapeExa } from '../tools/exa-tools';
import {
  submitDesignJob,
  waitForDesignJob,
  copyDeliverablesToWorkspace,
} from '../lib/design-agent-client';

// ---------- Schemas ----------

export const NewsToPostInputSchema = z.object({
  topic: z.string().min(1).describe("News topic or query to search, e.g. 'Anthropic Claude' or 'OpenAI'"),
  template_id: z
    .enum(['tech-announcement', 'keilhq-editorial', 'keilhq-text', 'entrepreneur-post', '360labs-news'])
    .default('tech-announcement')
    .describe("Design template to use. 'tech-announcement' is recommended for tech news."),
  format: z.enum(['single', 'carousel']).default('single').describe('Single slide or multi-slide carousel.'),
  aspect_ratio: z.enum(['4:5', '1:1', '3:4']).default('4:5'),
  max_slides: z.number().int().min(1).max(10).default(5),
  cover_image_url: z
    .string()
    .url()
    .optional()
    .describe('Optional direct image URL used as-is for the cover (slide 1) hero instead of AI generation.'),
});

const ResearchOutputSchema = z.object({
  topic: z.string(),
  template_id: z.enum(['tech-announcement', 'keilhq-editorial', 'keilhq-text', 'entrepreneur-post', '360labs-news']),
  format: z.enum(['single', 'carousel']),
  aspect_ratio: z.enum(['4:5', '1:1', '3:4']),
  max_slides: z.number(),
  cover_image_url: z.string().url().optional(),
  articleTitle: z.string(),
  articleUrl: z.string(),
  articlePublishedDate: z.string().nullable(),
  articleText: z.string(),
  summary: z.string(),
});

const DistillOutputSchema = z.object({
  topic: z.string(),
  template_id: z.enum(['tech-announcement', 'keilhq-editorial', 'keilhq-text', 'entrepreneur-post', '360labs-news']),
  format: z.enum(['single', 'carousel']),
  aspect_ratio: z.enum(['4:5', '1:1', '3:4']),
  max_slides: z.number(),
  cover_image_url: z.string().url().optional(),
  articleTitle: z.string(),
  articleUrl: z.string(),
  postContent: z.string(),
});

export const NewsToPostOutputSchema = z.object({
  job_id: z.string(),
  status: z.string(),
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
      view_url: z.string(),
      download_url: z.string(),
    }),
  ),
  workspaceDir: z.string(),
  copiedFiles: z.array(z.string()),
});

// ---------- Steps ----------

/**
 * Step 1: Search and collect primary news content using Exa.
 */
export const researchNewsStep = createStep({
  id: 'research-news',
  inputSchema: NewsToPostInputSchema,
  outputSchema: ResearchOutputSchema,
  execute: async ({ inputData }) => {
    // Focus query on news and announcements if not already specified
    const hasNewsKeyword = /news|announc|launch|update|release|breakthrough|model/i.test(inputData.topic);
    const searchQuery = hasNewsKeyword ? inputData.topic : `${inputData.topic} news announcement`;

    console.log(`[newsToPostWorkflow] Searching news for query: "${searchQuery}"...`);

    let searchResult;
    try {
      searchResult = await searchExa({
        query: searchQuery,
        numResults: 6,
        searchType: 'auto',
        category: 'news',
        includeText: true,
      });
    } catch (err) {
      console.warn(`[newsToPostWorkflow] Exa search with category 'news' failed, retrying general search:`, err);
      searchResult = await searchExa({
        query: searchQuery,
        numResults: 6,
        searchType: 'auto',
        includeText: true,
      });
    }

    const items = searchResult?.results ?? [];
    if (items.length === 0) {
      throw new Error(`No news found for topic "${inputData.topic}". Try a different or broader search term.`);
    }

    // Pick top news result that has informative content (avoiding root homepages)
    const selected =
      items.find(
        (item) => item.text && item.text.length > 200 && !/^https?:\/\/[^\/]+\/?$/.test(item.url),
      ) || items[0];

    let articleText = selected.text || '';

    // If snippet is short (< 300 chars), scrape full content
    if (articleText.length < 300 && selected.url) {
      try {
        console.log(`[newsToPostWorkflow] Scraping full text from ${selected.url}...`);
        const scrapeResult = await scrapeExa({
          urls: [selected.url],
          maxCharacters: 4000,
          maxAgeHours: 24,
        });
        const scraped = scrapeResult?.contents?.find((c) => c.url === selected.url);
        if (scraped?.text) {
          articleText = scraped.text;
        }
      } catch (err) {
        console.warn(`[newsToPostWorkflow] Exa scrape failed, using snippet:`, err);
      }
    }

    const cleanTitle = (selected.title || inputData.topic).trim();
    const cleanText = articleText.trim();
    const summary = cleanText.slice(0, 600);

    return {
      topic: inputData.topic,
      template_id: inputData.template_id,
      format: inputData.format,
      aspect_ratio: inputData.aspect_ratio,
      max_slides: inputData.max_slides,
      cover_image_url: inputData.cover_image_url,
      articleTitle: cleanTitle,
      articleUrl: selected.url,
      articlePublishedDate: selected.publishedDate ?? null,
      articleText: cleanText,
      summary,
    };
  },
});

/**
 * Step 2: Distill the news facts and takeaways into post-ready text.
 */
export const distillPostCopyStep = createStep({
  id: 'distill-post-copy',
  inputSchema: ResearchOutputSchema,
  outputSchema: DistillOutputSchema,
  execute: async ({ inputData }) => {
    console.log(`[newsToPostWorkflow] Distilling news story: "${inputData.articleTitle}"...`);

    const narrative = inputData.articleText.length > 0 ? inputData.articleText.slice(0, 1500) : inputData.summary;

    const postContent = `
${inputData.articleTitle}

${narrative}

Source: ${inputData.articleUrl}
`.trim();

    return {
      topic: inputData.topic,
      template_id: inputData.template_id,
      format: inputData.format,
      aspect_ratio: inputData.aspect_ratio,
      max_slides: inputData.max_slides,
      cover_image_url: inputData.cover_image_url,
      articleTitle: inputData.articleTitle,
      articleUrl: inputData.articleUrl,
      postContent,
    };
  },
});

/**
 * Step 3: Send post copy to Design Agent, await rendering, and copy deliverables to workspace.
 */
export const renderPostStep = createStep({
  id: 'render-post',
  inputSchema: DistillOutputSchema,
  outputSchema: NewsToPostOutputSchema,
  execute: async ({ inputData }) => {
    console.log(`[newsToPostWorkflow] Submitting job to Design Agent (${inputData.template_id}, ${inputData.format})...`);

    const { job_id } = await submitDesignJob({
      content: inputData.postContent,
      template_id: inputData.template_id,
      format: inputData.format,
      aspect_ratio: inputData.aspect_ratio,
      max_slides: inputData.max_slides,
      ...(inputData.cover_image_url ? { cover_image_url: inputData.cover_image_url } : {}),
    });

    console.log(`[newsToPostWorkflow] Job created: ${job_id}. Waiting for rendering...`);

    const jobStatus = await waitForDesignJob(job_id, {
      timeoutMs: 180_000,
      pollIntervalMs: 2_000,
      onProgress: (status) => {
        console.log(`[newsToPostWorkflow] Job ${job_id} status: ${status}`);
      },
    });

    console.log(`[newsToPostWorkflow] Job completed! Copying deliverables to workspace...`);
    const deliverables = copyDeliverablesToWorkspace(jobStatus);

    return {
      job_id,
      status: 'done',
      topic: inputData.topic,
      newsTitle: inputData.articleTitle,
      newsUrl: inputData.articleUrl,
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

// ---------- Workflow ----------

export const newsToPostWorkflow = createWorkflow({
  id: 'news-to-post-workflow',
  description:
    'Searches live news using Exa, synthesizes key announcement details, submits to Design Agent, and outputs completed Instagram slide images + caption into the workspace.',
  inputSchema: NewsToPostInputSchema,
  outputSchema: NewsToPostOutputSchema,
})
  .then(researchNewsStep)
  .then(distillPostCopyStep)
  .then(renderPostStep)
  .commit();
