/**
 * copy.config.ts — knobs for the LLM editorial copywriter (post title/deck/
 * caption) that replaces the deterministic template copy in payload.ts.
 *
 * The copywriter (lib/ras/copywriter.ts) enriches a story with Exa web search,
 * then asks the SAME Sarvam ranker model to WRITE the on-image headline/deck
 * and the full-story caption, grounded ONLY in the fact pack + Exa snippets.
 * The deterministic template remains the fallback: if the model is disabled,
 * errors, or returns invalid output, buildRasPayload fills those fields the old
 * way. A run NEVER fails because of copy.
 *
 * Env overrides (all optional; defaults below mirror the ranking/image config
 * style). Change numbers here, not in the module code.
 */

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export interface CopyConfig {
  /** Master switch. false => always use the deterministic template (old behavior). */
  llmEnabled: boolean;

  /** Exa enrichment switch + how many results to pull for grounding. */
  exaEnabled: boolean;
  exaNumResults: number;

  /**
   * A bit higher than the ranker's 0.15: this is creative editorial writing, so
   * we want some lively phrasing — but kept modest so the model stays grounded
   * in the supplied facts rather than embellishing.
   */
  temperature: number;
  /**
   * Output budget. MUST be large: Sarvam spends ~2k REASONING tokens per call
   * on top of the JSON text even with reasoning_effort "none" (observed:
   * reasoning fills the whole budget first, leaving the JSON empty and
   * finishReason "length" when the budget is small). Matches the ranker's
   * 16384 for the same reason — a big budget keeps the JSON from being starved.
   */
  maxOutputTokens: number;

  /** Soft target for caption length (sentences). Keeps the caption tight. */
  captionMaxSentences: number;
}

export const copyConfig: CopyConfig = {
  llmEnabled: envBool("COPY_LLM_ENABLED", true),
  exaEnabled: envBool("COPY_EXA_ENABLED", true),
  exaNumResults: envNum("COPY_EXA_NUM_RESULTS", 5),
  temperature: envNum("COPY_TEMPERATURE", 0.4),
  maxOutputTokens: envNum("COPY_MAX_OUTPUT_TOKENS", 16384),
  captionMaxSentences: envNum("COPY_CAPTION_MAX_SENTENCES", 6),
};
