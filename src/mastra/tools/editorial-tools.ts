import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  listPendingStories,
  updateStoryEditorialStatus,
  storyRepository,
} from "../repositories/store";
import { StorySchema } from "../schemas/story";

/**
 * Phase 3: List candidate news stories waiting for human review.
 */
export const listPendingNewsTool = createTool({
  id: "listPendingNews",
  description:
    "Lists all high-scoring candidate news stories waiting for human editorial review and approval before post generation.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(20).default(5),
  }),
  outputSchema: z.object({
    count: z.number(),
    stories: z.array(StorySchema),
  }),
  execute: async (input: any) => {
    const { limit = 5 } = input.context || input;
    const pending = await listPendingStories();
    const sliced = pending.slice(0, limit);
    return {
      count: sliced.length,
      stories: sliced,
    };
  },
});

/**
 * Phase 3: Approve a candidate news story for visual post generation.
 */
export const approveNewsStoryTool = createTool({
  id: "approveNewsStory",
  description:
    "Approves a discovered news story for visual post generation, with optional headline or angle overrides.",
  inputSchema: z.object({
    storyId: z.string().describe("ID of the story to approve"),
    headlineOverride: z.string().optional().describe("Optional revised headline"),
    angleOverride: z.string().optional().describe("Optional revised angle"),
    editorialNotes: z.string().optional().describe("Optional editorial notes"),
  }),
  outputSchema: z.object({
    status: z.enum(["APPROVED", "NOT_FOUND"]),
    storyId: z.string(),
    title: z.string().optional(),
    message: z.string(),
  }),
  execute: async (input: any) => {
    const { storyId, headlineOverride, angleOverride, editorialNotes } = input.context || input;
    const existing = await storyRepository.get(storyId);
    if (!existing) {
      return {
        status: "NOT_FOUND" as const,
        storyId,
        message: `Story ${storyId} not found in database.`,
      };
    }

    const updated = {
      ...existing,
      ...(headlineOverride ? { title: headlineOverride } : {}),
      ...(angleOverride ? { possibleAngles: [angleOverride, ...existing.possibleAngles] } : {}),
      editorial_status: "APPROVED" as const,
      ...(editorialNotes ? { editorial_notes: editorialNotes } : {}),
    };

    await storyRepository.save(updated);

    return {
      status: "APPROVED" as const,
      storyId,
      title: updated.title,
      message: `Story '${updated.title}' approved for post generation.`,
    };
  },
});

/**
 * Phase 3: Reject a candidate news story from the editorial review queue.
 */
export const rejectNewsStoryTool = createTool({
  id: "rejectNewsStory",
  description:
    "Rejects a discovered news story so it is not forwarded to post generation.",
  inputSchema: z.object({
    storyId: z.string().describe("ID of the story to reject"),
    reason: z.string().describe("Reason for rejection"),
  }),
  outputSchema: z.object({
    status: z.enum(["REJECTED", "NOT_FOUND"]),
    storyId: z.string(),
    message: z.string(),
  }),
  execute: async (input: any) => {
    const { storyId, reason } = input.context || input;
    const updated = await updateStoryEditorialStatus(storyId, "REJECTED", reason);
    if (!updated) {
      return {
        status: "NOT_FOUND" as const,
        storyId,
        message: `Story ${storyId} not found.`,
      };
    }
    return {
      status: "REJECTED" as const,
      storyId,
      message: `Story '${updated.title}' marked as REJECTED: ${reason}`,
    };
  },
});
