import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { buildAnglePack } from "../lib/angle-pack";

/**
 * Angle miner: viral / controversy / unique-angle pack.
 * Runs in PARALLEL with cover-prompt generation after news collection.
 */
export const generateAnglePackTool = createTool({
  id: "generateAnglePack",
  description:
    "Mines the viral, controversy, and unique-angle pack from collected news text. Runs in parallel with cover-prompt generation.",
  inputSchema: z.object({
    articleTitle: z.string().min(1),
    articleText: z.string().min(10),
  }),
  outputSchema: z.object({
    stakeholders: z.array(z.string()),
    moneyAndNumbers: z.array(z.string()),
    openQuestions: z.array(z.string()),
    viralAngle: z.string(),
    controversyAngle: z.string(),
    uniqueAngle: z.string(),
    recommendedAngle: z.string(),
    rationale: z.string(),
  }),
  execute: async ({ articleTitle, articleText }) => {
    return buildAnglePack(articleTitle, articleText);
  },
});
