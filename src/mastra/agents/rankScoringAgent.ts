/**
 * rankScoringAgent — the cheap, low-temperature model used by Stage B of the
 * news ranker. It returns ONLY judgements of meaning (topic fit, significance,
 * audience interest, visual potential, and quality flags); the final ranking
 * number is computed deterministically in code.
 *
 * Model resolution:
 *   1. RANK_MODEL_BASE_URL + RANK_MODEL_NAME (+ RANK_MODEL_API_KEY) — a
 *      dedicated, cheaper OpenAI-compatible endpoint for ranking.
 *   2. otherwise resolveSmallChatModel() — the project's configured small model.
 *
 * Like lib/leads/judge.ts, we DON'T use Mastra structuredOutput here: on local
 * / Sarvam models it truncates under the token budget and throws, discarding
 * partial JSON. Stage B asks for plain JSON and parses + validates it itself.
 */

import type { OpenAICompatibleConfig } from "@mastra/core/llm";
import { Agent } from "@mastra/core/agent";
import { resolveSmallChatModel } from "../config/model";
import { rankingConfig } from "../config/ranking.config";
import { buildSystemPrompt } from "../lib/ranking/prompt";

function resolveRankModel(): OpenAICompatibleConfig | string {
  const baseUrl = process.env["RANK_MODEL_BASE_URL"];
  const modelName = process.env["RANK_MODEL_NAME"];
  if (baseUrl && modelName) {
    return {
      providerId: "rank-model",
      modelId: modelName,
      url: baseUrl,
      apiKey:
        process.env["RANK_MODEL_API_KEY"] ??
        process.env["OPENAI_API_KEY"] ??
        "local",
    };
  }
  return resolveSmallChatModel();
}

export const rankScoringAgent = new Agent({
  id: "rank-scoring-agent",
  name: "News Ranker (Stage B)",
  description:
    "Scores clustered news items for the RAS Instagram page: topic fit, " +
    "significance, audience interest, visual potential, and quality flags. " +
    "Judges meaning only — the final ranking number is computed in code.",
  instructions: buildSystemPrompt(rankingConfig),
  model: resolveRankModel(),
});
