import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { buildCoverPrompt } from "../lib/cover-prompt";

/**
 * Cover-prompt builder driven by the `neoclassical-editorial-image` skill
 * (.agents/skills/neoclassical-editorial-image/SKILL.md).
 * Runs in PARALLEL with angle mining after news collection.
 */
export const generateCoverPromptTool = createTool({
  id: "generateCoverPrompt",
  description:
    "Generates the slide-1 cover image prompt as canonical neoclassical-editorial-image JSON (Flux-adapted). Runs in parallel with angle mining after news collection.",
  inputSchema: z.object({
    articleTitle: z.string().min(1).describe("Headline of the collected story."),
    articleText: z.string().min(10).describe("Full collected article text to art-direct from."),
    target_model: z.enum(["flux", "general"]).default("flux"),
  }),
  outputSchema: z.object({
    thesis: z.string(),
    visualMetaphor: z.string(),
    fluxPrompt: z.string(),
    compact: z.string(),
    colorPalette: z.array(z.string()),
    composition: z.string(),
    coverPromptJson: z.record(z.string(), z.unknown()),
  }),
  execute: async ({ articleTitle, articleText, target_model }) => {
    return buildCoverPrompt(articleTitle, articleText, target_model || "flux");
  },
});
