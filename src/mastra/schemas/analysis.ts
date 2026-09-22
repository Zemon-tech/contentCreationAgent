import { z } from "zod";

export const ClassificationSchema = z.enum([
  "announcement",
  "product_launch",
  "research",
  "funding",
  "acquisition",
  "company_update",
  "technical_update",
  "industry_trend",
  "opinion",
  "tutorial",
  "controversy",
  "community_discussion",
  "other",
]);

export type Classification = z.infer<typeof ClassificationSchema>;

/**
 * Structured output contract for the Aggregator Agent (and the
 * deterministic fallback analyzer). Scores are 0-10, confidence 0-1.
 */
export const AnalysisSchema = z.object({
  contentId: z.string(),
  classification: ClassificationSchema,
  topics: z.array(z.string()),
  entities: z.array(z.string()),
  relevance: z.number().min(0).max(10),
  novelty: z.number().min(0).max(10),
  impact: z.number().min(0).max(10),
  audienceInterest: z.number().min(0).max(10),
  contentPotential: z.number().min(0).max(10),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  whyItMatters: z.string(),
  possibleAngles: z.array(z.string()),
  /** True when produced by heuristics instead of an LLM. */
  heuristic: z.boolean().default(false),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
