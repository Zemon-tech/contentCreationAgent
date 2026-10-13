import type { RankingConfig } from "../../config/ranking.config";
import { rankingConfig } from "../../config/ranking.config";
import {
  LlmBatchResponseSchema,
  type LlmScore,
  type RankInputItem,
  type TokenEstimate,
} from "../../schemas/ranking";
import { extractJson } from "../json-extract";
import { rankScoringAgent } from "../../agents/rankScoringAgent";
import { buildBatchPrompt } from "./prompt";

/**
 * Stage B — LLM scoring (batched, cheap model, low temperature).
 *
 * Mirrors lib/leads/judge.ts: ask for plain JSON, parse with extractJson,
 * validate with Zod safeParse, retry ONCE with the validation error appended,
 * then leave any still-missing id `unscored`. A failure never throws — the run
 * continues with unscored items (penalized in Stage C).
 */

export interface RankGenerateResult {
  text: string;
  usage?: unknown;
}
export type RankGenerate = (prompt: string) => Promise<RankGenerateResult>;

export interface LlmScoreOutput {
  /** id -> validated score (only items the model scored successfully). */
  scores: Map<string, LlmScore>;
  /** Kept ids the model never returned a valid score for. */
  unscoredIds: string[];
  tokenEstimate: TokenEstimate;
}

/** Default generator — the real Stage B model. Injectable for tests/eval. */
const defaultGenerate: RankGenerate = async (prompt) => {
  const res = await rankScoringAgent.generate(prompt, {
    modelSettings: {
      temperature: rankingConfig.temperature,
      maxOutputTokens: rankingConfig.maxOutputTokens,
      maxRetries: 2,
    },
  });
  return { text: res.text ?? "", usage: res.usage };
};

export async function scoreItems(
  items: RankInputItem[],
  opts: { config?: RankingConfig; generate?: RankGenerate; log?: (ev: string, data: Record<string, unknown>) => void } = {},
): Promise<LlmScoreOutput> {
  const config = opts.config ?? rankingConfig;
  const generate = opts.generate ?? defaultGenerate;
  const log = opts.log ?? (() => {});

  const scores = new Map<string, LlmScore>();
  const usageTotals = { prompt: 0, completion: 0, total: 0, calls: 0 };

  for (const batch of chunk(items, config.batchSize)) {
    const validIds = new Set(batch.map((b) => b.id));
    const basePrompt = buildBatchPrompt(batch);
    let prompt = basePrompt;

    // Up to 2 attempts: initial + one retry with the error appended.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let text = "";
      try {
        const res = await generate(prompt);
        text = res.text;
        addUsage(usageTotals, res.usage);
      } catch (err) {
        log("rank-llm-call-error", { attempt, error: errMsg(err), batchSize: batch.length });
        prompt = basePrompt; // transport error — just retry the same prompt
        continue;
      }

      const parsed = LlmBatchResponseSchema.safeParse(extractJson(text));
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 6)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        log("rank-llm-invalid-output", { attempt, error: detail });
        prompt = `${basePrompt}\n\nYour previous answer was rejected (${detail}). Return JSON that matches the schema exactly.`;
        continue;
      }

      for (const s of parsed.data.scores) {
        if (validIds.has(s.id) && !scores.has(s.id)) {
          scores.set(s.id, { ...s, reason: trimWords(s.reason, 20) });
        }
      }
      // Stop early once every id in this batch is covered.
      if (batch.every((b) => scores.has(b.id))) break;
    }
  }

  const unscoredIds = items.filter((it) => !scores.has(it.id)).map((it) => it.id);
  const totalTokens = usageTotals.total || usageTotals.prompt + usageTotals.completion;
  const tokenEstimate: TokenEstimate = {
    promptTokens: usageTotals.prompt,
    completionTokens: usageTotals.completion,
    totalTokens,
    calls: usageTotals.calls,
    costUsd: Math.round((totalTokens / 1000) * config.costPer1kTokensUsd * 1e6) / 1e6,
  };

  return { scores, unscoredIds, tokenEstimate };
}

// ---------- helpers ----------

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += Math.max(1, size)) out.push(arr.slice(i, i + Math.max(1, size)));
  return out;
}

function trimWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text.trim() : words.slice(0, maxWords).join(" ");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Normalize the many usage shapes Mastra providers emit. */
function addUsage(
  totals: { prompt: number; completion: number; total: number; calls: number },
  usage: unknown,
): void {
  totals.calls += 1;
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return 0;
  };
  totals.prompt += num("promptTokens", "inputTokens", "prompt_tokens", "input_tokens");
  totals.completion += num("completionTokens", "outputTokens", "completion_tokens", "output_tokens");
  totals.total += num("totalTokens", "total_tokens");
}
