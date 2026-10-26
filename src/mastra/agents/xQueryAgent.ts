/**
 * xQueryAgent — a small, cheap model that turns a topic into a few X SEARCH
 * QUERY STRINGS (keyword phrases, not handles). It judges MEANING only: what
 * phrasing surfaces high-signal posts for a topic. It NEVER invents an @handle
 * and NEVER emits a score — queryGen.ts strips any handle/from: tokens, forces
 * the engagement-filter template, and the code decides every number.
 *
 * Model resolution mirrors agents/rankScoringAgent.ts: a dedicated
 * RANK_MODEL_* endpoint if configured, else resolveSmallChatModel(). No new
 * provider package is introduced.
 *
 * Constructor shape (Agent from @mastra/core/agent, id/name/description/
 * instructions/model) verified against the installed rankScoringAgent usage on
 * @mastra/core 1.67.0.
 */

import type { OpenAICompatibleConfig } from "@mastra/core/llm";
import { Agent } from "@mastra/core/agent";
import { resolveSmallChatModel } from "../config/model";

function resolveQueryModel(): OpenAICompatibleConfig | string {
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

const INSTRUCTIONS = [
  "You generate X (Twitter) SEARCH QUERY STRINGS for a given topic.",
  "A good query is a short keyword phrase that surfaces substantive, high-signal posts about the topic.",
  "",
  "HARD RULES:",
  "- Output keyword phrases ONLY. Never include an @handle, a from: operator, or any account name.",
  "- Do not add engagement filters or operators yourself; the system appends those deterministically.",
  "- Do not rank, score, or number the queries. Judge meaning (relevance) only.",
  "- Return ONLY a JSON object of the form {\"queries\": [\"...\", \"...\"]} with no prose or code fences.",
].join("\n");

export const xQueryAgent = new Agent({
  id: "x-query-agent",
  name: "X Query Generator",
  description:
    "Turns a topic into a few X search query strings (keyword phrases only). " +
    "Judges relevance of phrasing; never emits handles, operators, or scores.",
  instructions: INSTRUCTIONS,
  model: resolveQueryModel(),
});
