import type { OpenAICompatibleConfig } from "@mastra/core/llm";

/**
 * Local OpenAI-compatible model configuration (vLLM-served or Sarvam).
 *
 * Everything is env-driven — nothing is hardcoded:
 *   LOCAL_MODEL_BASE_URL  e.g. http://localhost:8000/v1 (vLLM)
 *                         or https://api.sarvam.ai/v1 (Sarvam)
 *   LOCAL_MODEL_NAME      served model id (GET /v1/models, or
 *                         sarvam-30b / sarvam-105b for Sarvam)
 *   LOCAL_MODEL_API_KEY   any non-empty string for vLLM; your Sarvam
 *                         subscription key for Sarvam (SARVAM_API_KEY works too)
 *
 * OPENAI_BASE_URL / OPENAI_API_KEY are honored as fallbacks.
 * Sarvam accepts the standard Authorization: Bearer header, which is
 * what Mastra's OpenAI-compatible gateway sends — no extra headers needed.
 */

export interface LocalModelConfig {
  baseUrl: string;
  modelName: string;
  apiKey: string;
  providerId: string;
}

const PROVIDER_ID = "local-vllm";

function readEnv(): { baseUrl?: string; modelName?: string; apiKey?: string } {
  return {
    baseUrl:
      process.env["LOCAL_MODEL_BASE_URL"] ?? process.env["OPENAI_BASE_URL"],
    modelName:
      process.env["LOCAL_MODEL_NAME"] ?? process.env["LOCAL_MODEL_ID"],
    apiKey:
      process.env["LOCAL_MODEL_API_KEY"] ??
      process.env["SARVAM_API_KEY"] ??
      process.env["OPENAI_API_KEY"] ??
      "local",
  };
}

export function isLocalModelConfigured(): boolean {
  const { baseUrl, modelName } = readEnv();
  return !!baseUrl && !!modelName;
}

/** Any LLM (local or OpenAI) available for agent calls / enrichment. */
export function isLlmConfigured(): boolean {
  return isLocalModelConfigured() || !!process.env["OPENAI_API_KEY"];
}

export function getLocalModelConfig(): LocalModelConfig {
  const { baseUrl, modelName, apiKey } = readEnv();
  if (!baseUrl || !modelName) {
    throw new Error(
      "Local model is not configured. Set LOCAL_MODEL_BASE_URL (e.g. http://localhost:8000/v1) " +
        "and LOCAL_MODEL_NAME (served model id from GET /v1/models) in your .env, then restart the dev server.",
    );
  }
  return { baseUrl, modelName, apiKey: apiKey || "local", providerId: PROVIDER_ID };
}

/**
 * Model value for Mastra agents (incl. memory title/observer models).
 * Uses the native OpenAICompatibleConfig — no extra provider package needed.
 */
export function localChatModel(): OpenAICompatibleConfig {
  const cfg = getLocalModelConfig();
  return {
    providerId: cfg.providerId,
    modelId: cfg.modelName,
    url: cfg.baseUrl,
    apiKey: cfg.apiKey,
  };
}

const LEGACY_OPENAI_MODEL = "openai/gpt-5.6-terra";
const LEGACY_OPENAI_SMALL_MODEL = "openai/gpt-5-mini";

/**
 * Resolve the chat model for an agent: local vLLM model when configured,
 * otherwise the previous OpenAI model id (preserves old behavior until
 * the user sets LOCAL_MODEL_* and restarts — never crashes Studio boot).
 */
export function resolveChatModel(): OpenAICompatibleConfig | string {
  if (isLocalModelConfigured()) {
    const cfg = getLocalModelConfig();
    console.log(
      `[model] using local OpenAI-compatible model "${cfg.modelName}" at ${cfg.baseUrl}`,
    );
    return localChatModel();
  }
  console.log(`[model] LOCAL_MODEL_* not set — falling back to ${LEGACY_OPENAI_MODEL}`);
  return LEGACY_OPENAI_MODEL;
}

/** Same as resolveChatModel but for small/auxiliary models (memory titles, observers). */
export function resolveSmallChatModel(): OpenAICompatibleConfig | string {
  if (isLocalModelConfigured()) {
    return localChatModel();
  }
  return LEGACY_OPENAI_SMALL_MODEL;
}
