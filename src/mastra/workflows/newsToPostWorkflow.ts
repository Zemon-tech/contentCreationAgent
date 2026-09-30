import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { searchExa, scrapeExa } from '../tools/exa-tools';
import { buildAnglePack } from '../lib/angle-pack';
import { buildCoverPrompt } from '../lib/cover-prompt';
import {
  submitDesignJob,
  waitForDesignJob,
  copyDeliverablesToWorkspace,
  getPreviewHtml,
  downloadBundleZip,
  savePreviewAndBundle,
} from '../lib/design-agent-client';

/**
 * News → Post pipeline (v2):
 *
 *   collect (user news OR live search, all relevant content)
 *     → PARALLEL fan-out: [cover-prompt via neoclassical-editorial skill,
 *                          viral/controversy/unique-angle mining]
 *     → template select (explicit choice wins, else auto)
 *     → render via Design Agent (cover prompt drives slide-1 hero)
 *     → package (preview.html + bundle.zip in the workspace)
 */

const TemplateIdSchema = z.enum([
  'tech-announcement',
  'keilhq-editorial',
  'keilhq-text',
  'entrepreneur-post',
  '360labs-news',
]);

// ---------- Schemas ----------

export const NewsToPostInputSchema = z
  .object({
    topic: z.string().min(1).optional().describe("News topic to search, e.g. 'Anthropic Claude'. Omit when content is provided."),
    content: z
      .string()
      .min(10)
      .optional()
      .describe('User-provided news text used directly instead of web search.'),
    template_id: TemplateIdSchema.optional().describe(
      'Suggested template. Omit for auto-select (controversy/news → 360labs-news, tech launch → tech-announcement, founder → entrepreneur-post).',
    ),
    format: z.enum(['single', 'carousel']).default('single').describe('Single slide or multi-slide carousel.'),
    aspect_ratio: z.enum(['4:5', '1:1', '3:4']).default('4:5'),
    max_slides: z.number().int().min(1).max(10).default(5),
    cover_image_url: z
      .string()
      .url()
      .optional()
      .describe('Optional direct image URL used as-is for the cover (slide 1) hero instead of AI generation.'),
    cover_prompt: z
      .string()
      .min(10)
      .optional()
      .describe('Optional explicit Flux cover prompt overriding the skill-generated one.'),
  })
  .refine((v) => v.topic || v.content, {
    message: 'Provide either `topic` (to search news) or `content` (user-provided news).',
  });

const CollectOutputSchema = z.object({
  topic: z.string(),
  template_id: TemplateIdSchema.optional(),
  format: z.enum(['single', 'carousel']),
  aspect_ratio: z.enum(['4:5', '1:1', '3:4']),
  max_slides: z.number(),
  cover_image_url: z.string().url().optional(),
  cover_prompt: z.string().optional(),
  articleTitle: z.string(),
  articleUrl: z.string(),
  articlePublishedDate: z.string().nullable(),
  articleText: z.string(),
  summary: z.string(),
  sources: z.array(z.string()),
});

const CoverSchema = z.object({
  thesis: z.string(),
  visualMetaphor: z.string(),
  fluxPrompt: z.string(),
  compact: z.string(),
  colorPalette: z.array(z.string()),
  composition: z.string(),
  coverPromptJson: z.record(z.string(), z.unknown()),
});

const AnglesSchema = z.object({
  stakeholders: z.array(z.string()),
  moneyAndNumbers: z.array(z.string()),
  openQuestions: z.array(z.string()),
  viralAngle: z.string(),
  controversyAngle: z.string(),
  uniqueAngle: z.string(),
  recommendedAngle: z.string(),
  rationale: z.string(),
});

const EnrichOutputSchema = CollectOutputSchema.extend({
  cover: CoverSchema,
  angles: AnglesSchema,
});

const TemplateOutputSchema = EnrichOutputSchema.extend({
  selected_template: TemplateIdSchema,
  template_rationale: z.string(),
});

const RenderOutputSchema = TemplateOutputSchema.extend({
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
});

export const NewsToPostOutputSchema = RenderOutputSchema.extend({
  status: z.string(),
  newsTitle: z.string(),
  newsUrl: z.string(),
  coverPrompt: z.object({
    thesis: z.string(),
    visualMetaphor: z.string(),
    fluxPrompt: z.string(),
  }),
  anglePack: z.object({
    recommendedAngle: z.string(),
    viralAngle: z.string(),
    controversyAngle: z.string(),
    uniqueAngle: z.string(),
  }),
  previewFile: z.string().nullable(),
  zipFile: z.string().nullable(),
});

// ---------- Steps ----------

/**
 * Step 1: Collect — user-provided news is used as-is; otherwise search Exa
 * and merge all relevant results (not just the first snippet).
 */
export const collectNewsStep = createStep({
  id: 'collect-news',
  inputSchema: NewsToPostInputSchema,
  outputSchema: CollectOutputSchema,
  execute: async ({ inputData }) => {
    const format = inputData.format || 'single';

    // Direct path: user provided the news.
    if (inputData.content) {
      const text = inputData.content.trim();
      const firstLine = text.split('\n')[0].slice(0, 120).trim();
      const title = (inputData.topic || firstLine || 'User-provided story').trim();
      console.log(`[newsToPostWorkflow] Using user-provided news (${text.length} chars).`);
      return {
        topic: inputData.topic || title,
        template_id: inputData.template_id,
        format,
        aspect_ratio: inputData.aspect_ratio || '4:5',
        max_slides: inputData.max_slides || 5,
        cover_image_url: inputData.cover_image_url,
        cover_prompt: inputData.cover_prompt,
        articleTitle: title,
        articleUrl: '',
        articlePublishedDate: null,
        articleText: text,
        summary: text.slice(0, 600),
        sources: [],
      };
    }

    // Search path: live news via Exa, merging every relevant result.
    const topic = inputData.topic as string;
    const hasNewsKeyword = /news|announc|launch|update|release|breakthrough|model/i.test(topic);
    const searchQuery = hasNewsKeyword ? topic : `${topic} news announcement`;
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
      console.warn(`[newsToPostWorkflow] Exa news-category search failed, retrying general:`, err);
      searchResult = await searchExa({
        query: searchQuery,
        numResults: 6,
        searchType: 'auto',
        includeText: true,
      });
    }

    const items = (searchResult?.results ?? []).filter(
      (item) => item.text && item.text.length > 200 && !/^https?:\/\/[^\/]+\/?$/.test(item.url),
    );
    if (items.length === 0) {
      throw new Error(`No news found for topic "${topic}". Try a different or broader search term.`);
    }

    // Scrape thin snippets so every source contributes real content.
    const thin = items.filter((i) => (i.text || '').length < 800).slice(0, 4);
    const scrapedByUrl = new Map<string, string>();
    if (thin.length > 0) {
      try {
        const scrapeResult = await scrapeExa({
          urls: thin.map((i) => i.url),
          maxCharacters: 4000,
          maxAgeHours: 24,
        });
        for (const c of scrapeResult?.contents ?? []) {
          if (c.text) scrapedByUrl.set(c.url, c.text);
        }
      } catch (err) {
        console.warn(`[newsToPostWorkflow] Exa scrape failed, using snippets:`, err);
      }
    }

    const primary = items[0];
    const mergedText = items
      .slice(0, 3)
      .map((i) => (scrapedByUrl.get(i.url) || i.text || '').trim())
      .filter(Boolean)
      .join('\n\n---\n\n')
      .slice(0, 6000);

    return {
      topic,
      template_id: inputData.template_id,
      format,
      aspect_ratio: inputData.aspect_ratio || '4:5',
      max_slides: inputData.max_slides || 5,
      cover_image_url: inputData.cover_image_url,
      cover_prompt: inputData.cover_prompt,
      articleTitle: (primary.title || topic).trim(),
      articleUrl: primary.url,
      articlePublishedDate: primary.publishedDate ?? null,
      articleText: mergedText,
      summary: mergedText.slice(0, 600),
      sources: items.slice(0, 3).map((i) => i.url),
    };
  },
});

/**
 * Step 2: PARALLEL fan-out — cover JSON prompt (neoclassical-editorial
 * skill, Flux-adapted) and viral/controversy/unique-angle mining run
 * concurrently via Promise.all on the same collected story.
 */
export const enrichParallelStep = createStep({
  id: 'enrich-parallel',
  inputSchema: CollectOutputSchema,
  outputSchema: EnrichOutputSchema,
  execute: async ({ inputData }) => {
    console.log(`[newsToPostWorkflow] Fan-out: cover prompt + angle pack in parallel...`);
    const [cover, angles] = await Promise.all([
      (async () => buildCoverPrompt(inputData.articleTitle, inputData.articleText, 'flux'))(),
      (async () => buildAnglePack(inputData.articleTitle, inputData.articleText))(),
    ]);

    // Explicit caller override wins for the render prompt only.
    if (inputData.cover_prompt) {
      cover.fluxPrompt = inputData.cover_prompt;
      (cover.coverPromptJson as Record<string, Record<string, string>>).prompts = {
        primary: inputData.cover_prompt,
        compact: cover.compact,
        model_specific: inputData.cover_prompt,
      };
    }

    console.log(`[newsToPostWorkflow] Cover thesis: ${cover.thesis}`);
    console.log(`[newsToPostWorkflow] Recommended angle: ${angles.recommendedAngle.slice(0, 120)}...`);
    return { ...inputData, cover, angles };
  },
});

/**
 * Step 3: Template select — explicit suggestion wins; otherwise auto-pick
 * from story signals and record the rationale.
 */
export const selectTemplateStep = createStep({
  id: 'select-template',
  inputSchema: EnrichOutputSchema,
  outputSchema: TemplateOutputSchema,
  execute: async ({ inputData }) => {
    if (inputData.template_id) {
      return {
        ...inputData,
        selected_template: inputData.template_id,
        template_rationale: 'User-suggested template honored.',
      };
    }
    const text = `${inputData.articleTitle}\n${inputData.articleText}`;
    let selected: z.infer<typeof TemplateIdSchema>;
    let rationale: string;
    if (/controvers|accus|investigat|breach|leak|scandal|vs\.|lawsuit/i.test(text)) {
      selected = '360labs-news';
      rationale = 'Auto: controversy/investigation story → 360labs-news editorial carousel (hero + evidence slides).';
    } else if (/founder|startup|entrepreneur|raise|series [abc]/i.test(text)) {
      selected = 'entrepreneur-post';
      rationale = 'Auto: founder/startup story → entrepreneur-post magazine layout.';
    } else if (inputData.format === 'carousel') {
      selected = '360labs-news';
      rationale = 'Auto: carousel requested without preference → 360labs-news multi-slide deck.';
    } else if (/launch|release|announc|model|introduc/i.test(text)) {
      selected = 'tech-announcement';
      rationale = 'Auto: tech launch/announcement → tech-announcement bold single.';
    } else {
      selected = 'keilhq-editorial';
      rationale = 'Auto: general insight story → keilhq-editorial quiet layout.';
    }
    console.log(`[newsToPostWorkflow] Template: ${selected} (${rationale})`);
    return { ...inputData, selected_template: selected, template_rationale: rationale };
  },
});

/**
 * Step 4: Render — angle-enriched copy + skill cover prompt go to Design
 * Agent; the cover prompt drives the slide-1 hero slot.
 */
export const renderPostStep = createStep({
  id: 'render-post',
  inputSchema: TemplateOutputSchema,
  outputSchema: RenderOutputSchema,
  execute: async ({ inputData }) => {
    const narrative = inputData.articleText.length > 0 ? inputData.articleText.slice(0, 1500) : inputData.summary;
    const sourceLine =
      inputData.sources.length > 0
        ? `Sources: ${inputData.sources.join(', ')}`
        : inputData.articleUrl
          ? `Source: ${inputData.articleUrl}`
          : 'Source: user-provided';

    const postContent = `
${inputData.articleTitle}

Angle: ${inputData.angles.recommendedAngle}

${narrative}

${sourceLine}
`.trim();

    console.log(
      `[newsToPostWorkflow] Submitting job (${inputData.selected_template}, ${inputData.format}) with skill cover prompt...`,
    );
    const { job_id } = await submitDesignJob({
      content: postContent,
      template_id: inputData.selected_template,
      format: inputData.format,
      aspect_ratio: inputData.aspect_ratio,
      max_slides: inputData.max_slides,
      ...(inputData.cover_image_url ? { cover_image_url: inputData.cover_image_url } : {}),
      cover_prompt: inputData.cover.fluxPrompt,
    });

    const jobStatus = await waitForDesignJob(job_id, {
      timeoutMs: 180_000,
      pollIntervalMs: 2_000,
      onProgress: (status) => console.log(`[newsToPostWorkflow] Job ${job_id} status: ${status}`),
    });

    const deliverables = copyDeliverablesToWorkspace(jobStatus);
    return {
      ...inputData,
      job_id,
      caption: deliverables.caption,
      hashtags: deliverables.hashtags,
      slides: deliverables.slides,
      workspaceDir: deliverables.destDir,
      copiedFiles: deliverables.copiedFiles,
    };
  },
});

/**
 * Step 5: Package — fetch the HTML preview + bundle ZIP (best-effort for
 * older Design Agent servers) and save them next to the slides.
 */
export const packagePostStep = createStep({
  id: 'package-post',
  inputSchema: RenderOutputSchema,
  outputSchema: NewsToPostOutputSchema,
  execute: async ({ inputData }) => {
    let previewHtml: string | null = null;
    let zipBytes: Buffer | null = null;
    try {
      [previewHtml, zipBytes] = await Promise.all([getPreviewHtml(inputData.job_id), downloadBundleZip(inputData.job_id)]);
    } catch (err) {
      console.warn(`[newsToPostWorkflow] Preview/zip fetch failed (continuing without):`, err);
    }
    const { previewFile, zipFile } = savePreviewAndBundle(inputData.workspaceDir, previewHtml, zipBytes);

    return {
      ...inputData,
      status: 'done',
      newsTitle: inputData.articleTitle,
      newsUrl: inputData.articleUrl,
      coverPrompt: {
        thesis: inputData.cover.thesis,
        visualMetaphor: inputData.cover.visualMetaphor,
        fluxPrompt: inputData.cover.fluxPrompt,
      },
      anglePack: {
        recommendedAngle: inputData.angles.recommendedAngle,
        viralAngle: inputData.angles.viralAngle,
        controversyAngle: inputData.angles.controversyAngle,
        uniqueAngle: inputData.angles.uniqueAngle,
      },
      previewFile,
      zipFile,
    };
  },
});

// ---------- Workflow ----------

export const newsToPostWorkflow = createWorkflow({
  id: 'news-to-post-workflow',
  description:
    'Collects news (user-provided or live Exa search), fans out cover-prompt generation (neoclassical-editorial skill) + angle mining in parallel, auto-selects template, renders via Design Agent, and packages preview.html + bundle.zip.',
  inputSchema: NewsToPostInputSchema,
  outputSchema: NewsToPostOutputSchema,
})
  .then(collectNewsStep)
  .then(enrichParallelStep)
  .then(selectTemplateStep)
  .then(renderPostStep)
  .then(packagePostStep)
  .commit();
