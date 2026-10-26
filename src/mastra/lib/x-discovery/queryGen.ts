/**
 * queryGen — turn topics into X search query strings.
 *
 * The LLM (xQueryAgent) proposes keyword phrasings; CODE enforces every safety
 * rule (NFR-2): any @handle / from: token is stripped, and the deterministic
 * engagement-filter template is forced onto every query. On a validation
 * failure after one retry we fall back to the deterministic template per topic,
 * so a bad model response never produces an unsafe or empty query set.
 *
 * Parsing mirrors lib/ranking/llmScore.ts: plain JSON via extractJson, Zod
 * safeParse, retry once with the error appended.
 */

import { z } from "zod";
import type { XDiscoveryConfig } from "../../config/xDiscovery";
import { getXDiscoveryConfig } from "../../config/xDiscovery";
import { extractJson } from "../json-extract";
import { xQueryAgent } from "../../agents/xQueryAgent";

export interface QueryGenerateResult {
  text: string;
}
export type QueryGenerate = (prompt: string) => Promise<QueryGenerateResult>;

/** Default generator — the real small model. Injectable for tests/demo. */
const defaultGenerate: QueryGenerate = async (prompt) => {
  const res = await xQueryAgent.generate(prompt, {
    modelSettings: { temperature: 0.3, maxOutputTokens: 300, maxRetries: 1 },
    providerOptions: { sarvam: { reasoning_effort: "none", reasoningEffort: "none" } },
  });
  return { text: res.text ?? "" };
};

/** Strip any @handle or from:handle operator the model may have emitted. */
function stripHandles(q: string): string {
  return q
    .replace(/(^|\s)from:\S+/gi, " ")
    .replace(/(^|\s)@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Force the deterministic engagement filter. We keep the cleaned keyword body
 * and append the standard operators if they're absent, so the shape is always
 *   <keywords> min_faves:300 filter:links -filter:replies lang:en
 */
function applyFilterTemplate(keywords: string): string {
  const body = stripHandles(keywords).replace(/\s+(min_faves:\d+|filter:\w+|-filter:\w+|lang:\w+)\b/gi, "").trim();
  const safeBody = body || keywords.trim();
  return `${safeBody} min_faves:300 filter:links -filter:replies lang:en`.replace(/\s+/g, " ").trim();
}

/** The deterministic fallback query for a topic (no model involved). */
export function deterministicQuery(topic: string): string {
  return applyFilterTemplate(topic);
}

function buildPrompt(topic: string, perTopic: number, priorError?: string): string {
  const base = [
    `Topic: ${topic}`,
    `Generate exactly ${perTopic} distinct X search query string(s) for this topic.`,
    `Return ONLY: {"queries": ["...", ...]} with exactly ${perTopic} item(s).`,
    `Keyword phrases only — no @handles, no from:, no operators, no scores.`,
  ].join("\n");
  if (!priorError) return base;
  return `${base}\n\nYour previous answer was rejected (${priorError}). Return JSON that matches exactly.`;
}

/**
 * generateQueries — for each topic, produce config.queriesPerTopic queries,
 * every one passed through applyFilterTemplate (handle-stripped + forced
 * engagement filter). Validation failures fall back to the deterministic
 * template. The returned list is capped at config.queriesPerTopic.
 */
export async function generateQueries(
  topics: string[],
  opts: {
    generate?: QueryGenerate;
    config?: XDiscoveryConfig;
    log?: (ev: string, data: Record<string, unknown>) => void;
  } = {},
): Promise<Map<string, string[]>> {
  const config = opts.config ?? getXDiscoveryConfig();
  const generate = opts.generate ?? defaultGenerate;
  const log = opts.log ?? (() => {});
  const perTopic = Math.max(1, config.queriesPerTopic);

  const schema = z.object({ queries: z.array(z.string()).length(perTopic) });
  const out = new Map<string, string[]>();

  for (const topic of topics) {
    let queries: string[] | null = null;
    let priorError: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      let text = "";
      try {
        const res = await generate(buildPrompt(topic, perTopic, priorError));
        text = res.text;
      } catch (err) {
        priorError = err instanceof Error ? err.message : String(err);
        log("x.query.gen_error", { topic, attempt, error: priorError });
        continue;
      }
      const parsed = schema.safeParse(extractJson(text));
      if (!parsed.success) {
        priorError = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        log("x.query.invalid", { topic, attempt, error: priorError });
        continue;
      }
      queries = parsed.data.queries;
      break;
    }

    let finalQueries: string[];
    if (queries && queries.length) {
      // Force the safe template on every model-proposed query; dedupe.
      const seen = new Set<string>();
      finalQueries = [];
      for (const q of queries) {
        const safe = applyFilterTemplate(q);
        if (safe && !seen.has(safe)) {
          seen.add(safe);
          finalQueries.push(safe);
        }
      }
      if (finalQueries.length === 0) finalQueries = [deterministicQuery(topic)];
    } else {
      // Deterministic fallback after retry.
      log("x.query.fallback", { topic });
      finalQueries = [deterministicQuery(topic)];
    }

    out.set(topic, finalQueries.slice(0, perTopic));
  }

  return out;
}
