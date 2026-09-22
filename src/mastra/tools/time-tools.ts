import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Current date/time. Agents have no reliable built-in clock (and a local
 * model's training data is stale), so call this FIRST whenever recency
 * matters — e.g. to compute Exa `startPublishedDate` ("last 7 days").
 */
export const getCurrentTimeTool = createTool({
  id: "getCurrentTime",
  description:
    "Get the current date and time (UTC + server-local). Call this before any recency-dependent search or scoring.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    iso: z.string().describe("Current time, ISO-8601 UTC"),
    unixSeconds: z.number(),
    utcDate: z.string().describe("YYYY-MM-DD"),
    weekday: z.string(),
    serverLocal: z.string(),
  }),
  execute: async () => {
    const now = new Date();
    return {
      iso: now.toISOString(),
      unixSeconds: Math.floor(now.getTime() / 1000),
      utcDate: now.toISOString().slice(0, 10),
      weekday: now.toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: "UTC",
      }),
      serverLocal: now.toString(),
    };
  },
});
