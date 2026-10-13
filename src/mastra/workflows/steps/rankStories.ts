import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { RankInputItemSchema, RankResultSchema } from "../../schemas/ranking";
import { rankStories } from "../../lib/ranking/rankStories";

/**
 * `rankStories` workflow step (Stage 3). Takes N deduplicated, clustered items
 * and returns a ranked, explainable shortlist (possibly empty — a valid "no
 * story worthy this run" outcome, never an error).
 *
 * This step supersedes the legacy deterministic opportunity-scoring for the
 * Instagram/RAS path: feed it the clustered stories (via storiesToRankInput)
 * and use `selected` as the authoritative pick. The old scoring is left intact
 * for any other consumers.
 */

export const RankStoriesInputSchema = z.object({
  items: z.array(RankInputItemSchema).describe("Deduplicated, clustered items to rank."),
});

export const rankStoriesStep = createStep({
  id: "rank-stories",
  description:
    "Relevance filter + ranking: Stage A hard filters (code), Stage B LLM scoring " +
    "(batched, structured, validated), Stage C deterministic final score, Stage D selection.",
  inputSchema: RankStoriesInputSchema,
  outputSchema: RankResultSchema,
  execute: async ({ inputData }) => {
    return rankStories(inputData.items);
  },
});
