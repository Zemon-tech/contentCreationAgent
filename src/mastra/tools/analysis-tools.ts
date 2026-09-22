import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  cosineSimilarity,
  embedText,
  findSimilarContent,
} from "../lib/embeddings";

export const generateEmbeddingTool = createTool({
  id: "generateEmbedding",
  description:
    "Generate a deterministic embedding vector for text (semantic similarity / dedup).",
  inputSchema: z.object({
    text: z.string().min(1),
    dimensions: z.number().int().min(16).max(512).default(128),
  }),
  outputSchema: z.object({ embedding: z.array(z.number()) }),
  execute: async ({ text, dimensions }) => ({
    embedding: await embedText(text, dimensions),
  }),
});

export const findSimilarContentTool = createTool({
  id: "findSimilarContent",
  description:
    "Find semantically similar content pairs above a cosine threshold.",
  inputSchema: z.object({
    items: z.array(
      z.object({ id: z.string(), text: z.string() }),
    ),
    threshold: z.number().min(0).max(1).default(0.82),
    dimensions: z.number().int().min(16).max(512).default(128),
  }),
  outputSchema: z.object({
    pairs: z.array(
      z.object({
        idA: z.string(),
        idB: z.string(),
        similarity: z.number(),
      }),
    ),
  }),
  execute: async ({ items, threshold, dimensions }) => {
    const embedded = await Promise.all(
      items.map(async (i) => ({
        id: i.id,
        embedding: await embedText(i.text, dimensions),
      })),
    );
    void cosineSimilarity;
    return { pairs: findSimilarContent(embedded, threshold) };
  },
});
