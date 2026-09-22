import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getIndustryConfig,
  IndustryConfigSchema,
} from "../config/industry";
import { getSourceRegistry } from "../config/sources";
import {
  contentRepository,
  opportunityRepository,
  sourceRepository,
  storyRepository,
} from "../repositories/store";
import { NormalizedContentSchema, RawContentSchema } from "../schemas/rawContent";
import { SourceSchema } from "../schemas/source";
import {
  ContentOpportunitySchema,
  StorySchema,
} from "../schemas/story";

export const getIndustryConfigTool = createTool({
  id: "getIndustryConfig",
  description: "Load the configured industry (topics, keywords, entities, scoring weights).",
  inputSchema: z.object({
    name: z.string().optional().describe("Industry name, e.g. 'AI'"),
  }),
  outputSchema: IndustryConfigSchema,
  execute: async ({ name }) => getIndustryConfig(name),
});

export const getSourceRegistryTool = createTool({
  id: "getSourceRegistry",
  description: "List configured sources, optionally only active ones.",
  inputSchema: z.object({
    activeOnly: z.boolean().default(true),
  }),
  outputSchema: z.object({ sources: z.array(SourceSchema) }),
  execute: async ({ activeOnly }) => {
    const sources = getSourceRegistry();
    return { sources: activeOnly ? sources.filter((s) => s.active) : sources };
  },
});

export const saveRawContentTool = createTool({
  id: "saveRawContent",
  description: "Persist raw or normalized content items to storage.",
  inputSchema: z.object({
    items: z.array(RawContentSchema),
  }),
  outputSchema: z.object({ saved: z.number() }),
  execute: async ({ items }) => {
    for (const item of items) await contentRepository.save(item);
    return { saved: items.length };
  },
});

export const saveNormalizedContentTool = createTool({
  id: "saveNormalizedContent",
  description: "Persist normalized content items to storage.",
  inputSchema: z.object({
    items: z.array(NormalizedContentSchema),
  }),
  outputSchema: z.object({ saved: z.number() }),
  execute: async ({ items }) => {
    for (const item of items) await contentRepository.save(item);
    return { saved: items.length };
  },
});

export const saveSourcesTool = createTool({
  id: "saveSources",
  description: "Persist source registry entries to storage.",
  inputSchema: z.object({
    sources: z.array(SourceSchema),
  }),
  outputSchema: z.object({ saved: z.number() }),
  execute: async ({ sources }) => {
    for (const s of sources) await sourceRepository.save(s);
    return { saved: sources.length };
  },
});

export const saveStoryTool = createTool({
  id: "saveStory",
  description: "Persist a Story object to storage.",
  inputSchema: StorySchema,
  outputSchema: z.object({ id: z.string() }),
  execute: async (story) => {
    await storyRepository.save(story);
    return { id: story.id };
  },
});

/**
 * Batch variant: persist many stories in ONE tool call. Prefer this over
 * N sequential saveStory calls — each agent tool round-trip costs an LLM
 * turn, so batching turns 15 slow sequential saves into one fast call.
 */
export const saveStoriesTool = createTool({
  id: "saveStories",
  description:
    "Persist multiple Story objects in one call. Always prefer this over calling saveStory repeatedly. Keep each call to at most 5 stories so the arguments fit the model's output token budget — make multiple calls for larger sets.",
  inputSchema: z.object({
    stories: z.array(StorySchema).min(1).max(5),
  }),
  outputSchema: z.object({ saved: z.number(), ids: z.array(z.string()) }),
  execute: async ({ stories }) => {
    await Promise.all(stories.map((s) => storyRepository.save(s)));
    return { saved: stories.length, ids: stories.map((s) => s.id) };
  },
});

export const saveContentOpportunityTool = createTool({
  id: "saveContentOpportunity",
  description: "Persist a ContentOpportunity object to storage.",
  inputSchema: ContentOpportunitySchema,
  outputSchema: z.object({ id: z.string() }),
  execute: async (opportunity) => {
    await opportunityRepository.save(opportunity);
    return { id: opportunity.id };
  },
});
