import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Exa web search + scrape tools (native fetch, no extra dependencies).
 * Auth: EXA_API_KEY env var (https://dashboard.exa.ai/api-keys).
 *
 * Intended agent loop: exaSearch (latest info + URLs) -> exaScrape
 * (full text of the most promising URLs) -> analyze -> saveStory.
 */

const EXA_API_BASE = "https://api.exa.ai";

function exaApiKey(): string {
  const key = process.env["EXA_API_KEY"];
  if (!key) {
    throw new Error(
      "EXA_API_KEY is not set. Add it to your .env (see .env.example) and restart the dev server.",
    );
  }
  return key;
}

async function exaPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${EXA_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": exaApiKey(),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    tag?: string;
  } & T;
  if (!res.ok) {
    throw new Error(
      `Exa ${path} failed (HTTP ${res.status}): ${json.error ?? "unknown error"}` +
        (json.tag ? ` [${json.tag}]` : ""),
    );
  }
  return json;
}

export const ExaResultSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  url: z.string(),
  publishedDate: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
  text: z.string().nullable().optional(),
});

export type ExaResult = z.infer<typeof ExaResultSchema>;

export interface SearchExaParams {
  query: string;
  numResults?: number;
  searchType?: "auto" | "fast" | "deep";
  category?: "news" | "company" | "publication" | "personal site" | "financial report" | "people";
  startPublishedDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeText?: boolean;
}

export interface SearchExaOutput {
  results: ExaResult[];
  costDollars: number | null;
}

export async function searchExa(params: SearchExaParams): Promise<SearchExaOutput> {
  const json = await exaPost<{
    results: z.infer<typeof ExaResultSchema>[];
    costDollars?: { total?: number };
  }>("/search", {
    query: params.query,
    numResults: params.numResults ?? 10,
    type: params.searchType ?? "auto",
    ...(params.category ? { category: params.category } : {}),
    ...(params.startPublishedDate ? { startPublishedDate: params.startPublishedDate } : {}),
    ...(params.includeDomains ? { includeDomains: params.includeDomains } : {}),
    ...(params.excludeDomains ? { excludeDomains: params.excludeDomains } : {}),
    ...(params.includeText ? { contents: { text: { maxCharacters: 2000 } } } : {}),
  });

  return {
    results: (json.results ?? []).map((r) => ({
      id: r.id ?? r.url,
      title: r.title ?? null,
      url: r.url,
      publishedDate: r.publishedDate ?? null,
      author: r.author ?? null,
      score: r.score ?? null,
      text: r.text ?? null,
    })),
    costDollars: json.costDollars?.total ?? null,
  };
}

export interface ScrapeExaParams {
  urls: string[];
  maxCharacters?: number;
  maxAgeHours?: number;
}

export interface ScrapeExaOutput {
  contents: ExaResult[];
  failedUrls: string[];
}

export async function scrapeExa(params: ScrapeExaParams): Promise<ScrapeExaOutput> {
  const json = await exaPost<{ results?: z.infer<typeof ExaResultSchema>[] }>(
    "/contents",
    {
      urls: params.urls,
      text: { maxCharacters: params.maxCharacters ?? 8000 },
      maxAgeHours: params.maxAgeHours ?? 24,
    },
  );
  const contents = (json.results ?? []).map((r) => ({
    id: r.id ?? r.url,
    title: r.title ?? null,
    url: r.url,
    publishedDate: r.publishedDate ?? null,
    author: r.author ?? null,
    score: null,
    text: r.text ?? null,
  }));
  const got = new Set(contents.map((c) => c.url));
  return {
    contents,
    failedUrls: params.urls.filter((u) => !got.has(u)),
  };
}

export const exaSearchTool = createTool({
  id: "exaSearch",
  description:
    "Search the live web with Exa. Returns the latest results with titles, URLs, publish dates and scores. Use this FIRST to discover fresh information and candidate URLs, then scrape the best ones with exaScrape.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Search query, e.g. 'OpenAI GPT-6 announcement'"),
    numResults: z.number().int().min(1).max(25).default(10),
    searchType: z
      .enum(["auto", "fast", "deep"])
      .default("auto")
      .describe("auto = balanced, fast = low latency, deep = thorough research"),
    category: z
      .enum(["news", "company", "publication", "personal site", "financial report", "people"])
      .optional()
      .describe("Focus on news articles, company pages, research publications, etc."),
    startPublishedDate: z
      .string()
      .optional()
      .describe("Only results published after this ISO-8601 date, e.g. for 'latest' info"),
    includeDomains: z.array(z.string()).optional().describe("Restrict to these domains"),
    excludeDomains: z.array(z.string()).optional().describe("Exclude these domains"),
    includeText: z
      .boolean()
      .default(false)
      .describe("Also return page text snippets (costs more; prefer exaScrape for full text)"),
  }),
  outputSchema: z.object({
    results: z.array(ExaResultSchema),
    costDollars: z.number().nullable().optional(),
  }),
  execute: async ({
    query,
    numResults,
    searchType,
    category,
    startPublishedDate,
    includeDomains,
    excludeDomains,
    includeText,
  }) => {
    return searchExa({
      query,
      numResults,
      searchType,
      category,
      startPublishedDate,
      includeDomains,
      excludeDomains,
      includeText,
    });
  },
});

export const exaScrapeTool = createTool({
  id: "exaScrape",
  description:
    "Scrape full readable text from up to 10 URLs with Exa (fresh fetch, JS-rendered pages supported). Use after exaSearch to read the most promising sources in depth.",
  inputSchema: z.object({
    urls: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .describe("URLs to scrape (from exaSearch results)"),
    maxCharacters: z.number().int().min(500).max(10000).default(8000),
    maxAgeHours: z
      .number().int().min(0).max(720).default(24)
      .describe("0 = always fetch fresh, 24 = use cache younger than a day"),
  }),
  outputSchema: z.object({
    contents: z.array(ExaResultSchema),
    failedUrls: z.array(z.string()),
  }),
  execute: async ({ urls, maxCharacters, maxAgeHours }) => {
    return scrapeExa({ urls, maxCharacters, maxAgeHours });
  },
});
