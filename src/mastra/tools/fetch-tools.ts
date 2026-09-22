import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fetchGitHubReleases } from "../collectors/github";
import { RssCollector } from "../collectors/rss";
import { extractArticleContent, fetchWebPage } from "../collectors/web";
import { RawContentSchema } from "../schemas/rawContent";

export const fetchRSSTool = createTool({
  id: "fetchRSS",
  description:
    "Fetch and parse an RSS/Atom feed URL into normalized RawContent items.",
  inputSchema: z.object({
    url: z.string().describe("Feed URL (RSS 2.0 or Atom)"),
    sourceId: z.string().default("rss:adhoc"),
    sourceName: z.string().default("Ad-hoc RSS feed"),
    maxItems: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({ items: z.array(RawContentSchema) }),
  execute: async ({ url, sourceId, sourceName, maxItems }) => {
    const collector = new RssCollector();
    const items = await collector.collect(
      {
        id: sourceId,
        name: sourceName,
        type: "rss",
        url,
        authorityScore: 50,
        active: true,
      },
      { maxItems },
    );
    return { items };
  },
});

export const fetchWebPageTool = createTool({
  id: "fetchWebPage",
  description:
    "Fetch a single web page (where allowed) and extract readable text. Only http(s), size-capped.",
  inputSchema: z.object({
    url: z.string().describe("Page URL"),
    sourceId: z.string().default("web:adhoc"),
    sourceName: z.string().default("Ad-hoc web page"),
  }),
  outputSchema: z.object({ items: z.array(RawContentSchema) }),
  execute: async ({ url, sourceId, sourceName }) => {
    const extracted = await fetchWebPage(url);
    const now = new Date().toISOString();
    return {
      items: [
        {
          id: `${sourceId}:${url}`,
          sourceId,
          sourceName,
          sourceType: "web",
          url: extracted.canonicalUrl ?? url,
          title: extracted.title,
          content: extracted.text,
          author: extracted.author ? { name: extracted.author } : undefined,
          publishedAt: extracted.publishedAt,
          collectedAt: now,
          metadata: { collector: "web" },
        },
      ],
    };
  },
});

export const fetchGitHubReleasesTool = createTool({
  id: "fetchGitHubReleases",
  description:
    "List public releases for a GitHub repo via the official API. Accepts 'owner/repo' or a github.com URL.",
  inputSchema: z.object({
    repo: z.string().describe("owner/repo slug or github.com URL"),
    sourceId: z.string().default("github:adhoc"),
    sourceName: z.string().default("Ad-hoc GitHub repo"),
    maxItems: z.number().int().min(1).max(30).default(10),
  }),
  outputSchema: z.object({ items: z.array(RawContentSchema) }),
  execute: async ({ repo, sourceId, sourceName, maxItems }) => {
    const releases = await fetchGitHubReleases(repo, maxItems);
    const now = new Date().toISOString();
    return {
      items: releases.map((r) => ({
        id: `${sourceId}:${r.html_url}`,
        sourceId,
        sourceName,
        sourceType: "github",
        url: r.html_url,
        title: r.name || r.tag_name,
        content: r.body?.slice(0, 8000) || `${r.name || r.tag_name} released.`,
        author: r.author?.login ? { name: r.author.login } : undefined,
        publishedAt: r.published_at ?? undefined,
        collectedAt: now,
        metadata: { collector: "github", tag: r.tag_name },
      })),
    };
  },
});

export const extractArticleContentTool = createTool({
  id: "extractArticleContent",
  description: "Extract title, text, author and publish date from raw HTML.",
  inputSchema: z.object({
    html: z.string().describe("Raw HTML"),
    url: z.string().optional(),
  }),
  outputSchema: z.object({
    title: z.string().optional(),
    text: z.string(),
    author: z.string().optional(),
    publishedAt: z.string().optional(),
    canonicalUrl: z.string().optional(),
  }),
  execute: async ({ html, url }) => extractArticleContent(html, url),
});
