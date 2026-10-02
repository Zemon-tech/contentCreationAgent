import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getIndustryConfig,
  IndustryConfigSchema,
} from "../config/industry";
import { getSourceRegistry } from "../config/sources";
import {
  opportunityRepository,
  storyRepository,
} from "../repositories/store";
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

/**
 * Batch variant: persist many stories in ONE tool call.
 * Batches stories to avoid slow sequential tool round-trips.
 */
export const saveStoriesTool = createTool({
  id: "saveStories",
  description:
    "Persist multiple Story objects in one call. Keep each call to at most 5 stories so the arguments fit the model's output token budget.",
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
