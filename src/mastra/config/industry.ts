import { z } from "zod";

export const ScoringWeightsSchema = z.object({
  relevanceWeight: z.number().min(0).max(1),
  noveltyWeight: z.number().min(0).max(1),
  impactWeight: z.number().min(0).max(1),
  velocityWeight: z.number().min(0).max(1),
  authorityWeight: z.number().min(0).max(1),
  audienceInterestWeight: z.number().min(0).max(1),
  contentPotentialWeight: z.number().min(0).max(1),
});

export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;

export const IndustryConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  topics: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  excludedTopics: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  audience: z.string().optional(),
  scoring: ScoringWeightsSchema.optional(),
});

export type IndustryConfig = z.infer<typeof IndustryConfigSchema>;

/** Default weights: relevance 25 / novelty 15 / impact 20 / velocity 10 /
 *  authority 10 / audience interest 10 / content potential 10. */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  relevanceWeight: 0.25,
  noveltyWeight: 0.15,
  impactWeight: 0.2,
  velocityWeight: 0.1,
  authorityWeight: 0.1,
  audienceInterestWeight: 0.1,
  contentPotentialWeight: 0.1,
};

/** Radar threshold: only stories scoring ABOVE this become opportunities. */
export const OPPORTUNITY_THRESHOLD_DEFAULT = 70;

/** Example configuration. Replace/extend via INDUSTRY_CONFIGS. */
export const AI_INDUSTRY_CONFIG: IndustryConfig = {
  name: "AI",
  description:
    "Artificial intelligence, generative AI, AI agents and developer AI",
  topics: [
    "LLMs",
    "AI Agents",
    "AI Coding",
    "AI Infrastructure",
    "Generative AI",
    "AI Research",
    "Open Source AI",
    "AI Startups",
  ],
  keywords: [
    "LLM",
    "GPT",
    "Claude",
    "Gemini",
    "AI agent",
    "AI coding",
    "inference",
    "GPU",
  ],
  entities: [
    "OpenAI",
    "Anthropic",
    "Google",
    "Meta",
    "Microsoft",
    "xAI",
    "Mistral",
    "NVIDIA",
  ],
  audience: "developers and technical founders",
  scoring: DEFAULT_SCORING_WEIGHTS,
};

/**
 * Funding & Venture Capital Industry Configuration:
 * Tracks startup funding rounds, venture capital investments, Seed to Series C+,
 * M&A, valuations, and venture deals.
 */
export const FUNDING_INDUSTRY_CONFIG: IndustryConfig = {
  name: "Funding",
  description:
    "Startup funding rounds, venture capital investments, Seed to Series C+, M&A, valuations, and venture deals",
  topics: [
    "Venture Capital",
    "Startup Funding",
    "Seed Rounds",
    "Series A",
    "Series B",
    "Series C",
    "Growth Capital",
    "M&A",
    "Tech Investments",
    "Valuations",
    "Unicorns",
    "AI Startups",
  ],
  keywords: [
    "raised",
    "funding",
    "Series A",
    "Series B",
    "Series C",
    "Seed round",
    "pre-seed",
    "valuation",
    "venture capital",
    "lead investor",
    "participated in",
    "closed round",
    "growth round",
    "acquired",
    "acquisition",
    "unicorn",
    "million",
    "billion",
    "$M",
    "$B",
  ],
  entities: [
    "Sequoia",
    "a16z",
    "Andreessen Horowitz",
    "Y Combinator",
    "Accel",
    "Benchmark",
    "Lightspeed",
    "Founders Fund",
    "Khosla Ventures",
    "General Catalyst",
    "Index Ventures",
    "Bessemer",
    "Tiger Global",
    "Coatue",
    "Thrive Capital",
  ],
  audience: "investors, startup founders, operators, and tech leaders",
  scoring: {
    impactWeight: 0.25,
    authorityWeight: 0.2,
    noveltyWeight: 0.2,
    relevanceWeight: 0.15,
    velocityWeight: 0.1,
    audienceInterestWeight: 0.05,
    contentPotentialWeight: 0.05,
  },
};

/**
 * Registry of industry configs. Add new industries here or load from
 * storage/env later — never hardcode a single industry in the pipeline.
 */
export const INDUSTRY_CONFIGS: Record<string, IndustryConfig> = {
  AI: AI_INDUSTRY_CONFIG,
  Funding: FUNDING_INDUSTRY_CONFIG,
  "Funding News": FUNDING_INDUSTRY_CONFIG,
  "funding-news": FUNDING_INDUSTRY_CONFIG,
};

export function getIndustryConfig(name?: string): IndustryConfig {
  if (!name) return INDUSTRY_CONFIGS["AI"]!;
  const found =
    INDUSTRY_CONFIGS[name] ??
    Object.values(INDUSTRY_CONFIGS).find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
  if (!found) throw new Error(`Unknown industry: ${name}`);
  return found;
}

export function getScoringWeights(config: IndustryConfig): ScoringWeights {
  return config.scoring ?? DEFAULT_SCORING_WEIGHTS;
}
