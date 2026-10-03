import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import path from 'node:path';
import { scrapeExa } from '../tools/exa-tools';
import { publishToX } from '../lib/x-publisher';
import {
  submitDesignJob,
  waitForDesignJob,
  copyDeliverablesToWorkspace,
} from '../lib/design-agent-client';

export const NewsToXInputSchema = z.object({
  news: z
    .string()
    .min(3)
    .describe("News article URL (e.g. 'https://...') or raw news text/bullet points to post."),
  headline: z
    .string()
    .optional()
    .describe('Optional custom headline or hook.'),
  with_graphic: z
    .boolean()
    .default(false)
    .describe('Whether to generate and attach a visual graphic card using Design Agent.'),
  template_id: z
    .enum(['news-brief', '360labs-news', 'tech-announcement', 'keilhq-editorial'])
    .default('news-brief')
    .describe('Template to use when with_graphic is true.'),
  dry_run: z
    .boolean()
    .default(false)
    .describe('If true, tests composition and screenshot without clicking Post.'),
});

const IngestOutputSchema = z.object({
  news: z.string(),
  headline: z.string().optional(),
  with_graphic: z.boolean(),
  template_id: z.string(),
  dry_run: z.boolean(),
  articleTitle: z.string(),
  articleText: z.string(),
  articleUrl: z.string().optional(),
});

const DraftOutputSchema = IngestOutputSchema.extend({
  tweetText: z.string(),
});

const RenderGraphicOutputSchema = DraftOutputSchema.extend({
  imagePath: z.string().optional(),
});

export const NewsToXOutputSchema = z.object({
  success: z.boolean(),
  tweetUrl: z.string().optional(),
  tweetText: z.string(),
  imagePath: z.string().optional(),
  verified: z.boolean(),
  dryRun: z.boolean().optional(),
  message: z.string(),
  error: z.string().optional(),
});

export const ingestNewsStep = createStep({
  id: 'ingest-news',
  inputSchema: NewsToXInputSchema,
  outputSchema: IngestOutputSchema,
  execute: async ({ inputData }) => {
    const raw = inputData.news.trim();
    let articleTitle = inputData.headline || '';
    let articleText = raw;
    let articleUrl: string | undefined = undefined;

    const isUrl = /^https?:\/\//i.test(raw);
    if (isUrl) {
      articleUrl = raw;
      try {
        console.log(`[newsToXWorkflow] Ingesting URL via Exa: ${articleUrl}`);
        const scrapeRes = await scrapeExa({ urls: [articleUrl] });
        const item = scrapeRes.contents[0];
        if (item) {
          articleTitle = articleTitle || item.title || 'Breaking Tech Update';
          articleText = item.text || raw;
        }
      } catch (err: any) {
        console.warn(`[newsToXWorkflow] Exa scrape failed, proceeding with URL: ${err.message}`);
        articleTitle = articleTitle || 'Industry Update';
      }
    } else {
      if (!articleTitle) {
        const firstLine = raw.split('\n')[0].trim();
        articleTitle = firstLine.length < 90 ? firstLine : firstLine.slice(0, 85) + '...';
      }
    }

    return {
      news: inputData.news,
      headline: inputData.headline,
      with_graphic: inputData.with_graphic,
      template_id: inputData.template_id,
      dry_run: inputData.dry_run,
      articleTitle,
      articleText,
      articleUrl,
    };
  },
});

export const draftTweetStep = createStep({
  id: 'draft-tweet',
  inputSchema: IngestOutputSchema,
  outputSchema: DraftOutputSchema,
  execute: async ({ inputData }) => {
    const { articleTitle, articleText, articleUrl } = inputData;
    const cleanHeadline = articleTitle.trim().replace(/^["']|["']$/g, '');
    const sentences = articleText
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20 && s.length < 160 && !s.toLowerCase().includes('subscribe'));

    const takeaway = sentences[0] || articleText.slice(0, 140).trim();
    const budget = 275 - (articleUrl ? articleUrl.length + 12 : 0);

    let tweetBody = '';
    if (cleanHeadline.length > budget) {
      tweetBody = cleanHeadline.slice(0, budget - 3) + '...';
    } else {
      const remaining = budget - cleanHeadline.length - 2;
      tweetBody = `${cleanHeadline}\n\n${takeaway.slice(0, Math.max(20, remaining - 3))}...`;
    }

    const tweetText = articleUrl ? `${tweetBody}\n\nSource: ${articleUrl}` : tweetBody;

    console.log(`[newsToXWorkflow] Drafted tweet (${tweetText.length} chars):\n${tweetText}`);
    return {
      ...inputData,
      tweetText,
    };
  },
});

export const renderGraphicStep = createStep({
  id: 'render-graphic',
  inputSchema: DraftOutputSchema,
  outputSchema: RenderGraphicOutputSchema,
  execute: async ({ inputData }) => {
    let imagePath: string | undefined = undefined;
    if (inputData.with_graphic) {
      try {
        console.log(`[newsToXWorkflow] Rendering graphic card with template "${inputData.template_id}"...`);
        const { job_id } = await submitDesignJob({
          content: `${inputData.articleTitle}\n\n${inputData.articleText}`,
          template_id: inputData.template_id as any,
          format: 'single',
          aspect_ratio: '4:5',
        });

        const job = await waitForDesignJob(job_id, { timeoutMs: 60_000 });
        if (job.status === 'done') {
          const deliverables = copyDeliverablesToWorkspace(job);
          const slide1 = deliverables.copiedFiles.find(
            (f: string) => f.includes('slide_1.jpg') || f.endsWith('.jpg'),
          );
          if (slide1) {
            imagePath = path.resolve(process.cwd(), slide1);
            console.log(`[newsToXWorkflow] Graphic rendered: ${imagePath}`);
          }
        }
      } catch (err: any) {
        console.warn(`[newsToXWorkflow] Graphic generation failed (falling back to text-only): ${err.message}`);
      }
    }

    return {
      ...inputData,
      imagePath,
    };
  },
});

export const publishToXStep = createStep({
  id: 'publish-to-x',
  inputSchema: RenderGraphicOutputSchema,
  outputSchema: NewsToXOutputSchema,
  execute: async ({ inputData }) => {
    console.log(`[newsToXWorkflow] Publishing to X (dry_run=${inputData.dry_run})...`);
    const pubRes = await publishToX({
      text: inputData.tweetText,
      imagePath: inputData.imagePath,
      dryRun: inputData.dry_run,
    });

    return {
      success: pubRes.success,
      tweetUrl: pubRes.tweetUrl,
      tweetText: inputData.tweetText,
      imagePath: inputData.imagePath,
      verified: pubRes.verified,
      dryRun: pubRes.dryRun,
      message: pubRes.message,
      error: pubRes.error,
    };
  },
});

export const newsToXWorkflow = createWorkflow({
  id: 'news-to-x-workflow',
  description:
    'Publishes news to X/Twitter directly: accepts an article URL or text, crafts a high-impact tweet, optionally renders a visual card via Design Agent, and posts & verifies via real browser automation.',
  inputSchema: NewsToXInputSchema,
  outputSchema: NewsToXOutputSchema,
})
  .then(ingestNewsStep)
  .then(draftTweetStep)
  .then(renderGraphicStep)
  .then(publishToXStep)
  .commit();
