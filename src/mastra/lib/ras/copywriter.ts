import { z } from "zod";
import type { FactPack } from "../../schemas/factpack";
import type { RankInputItem } from "../../schemas/ranking";
import { copyConfig, type CopyConfig } from "../../config/copy.config";
import { extractJson } from "../json-extract";
import { rankScoringAgent } from "../../agents/rankScoringAgent";
import { searchExa } from "../../tools/exa-tools";

/**
 * Editorial copywriter — LLM-generated post copy (title/deck/caption) that
 * replaces payload.ts's deterministic template fields.
 *
 * Pipeline, in order:
 *   1. ENRICH — Exa web search on the headline pulls FREE third-party coverage
 *      of the same story (never the paywalled source body) to widen grounding.
 *      Runs for ALL items, including factPackLimited ones. Fails OPEN: no key /
 *      an error just means fact-pack-only grounding, never a throw.
 *   2. WRITE — the SAME Sarvam ranker model writes STRICT JSON copy, grounded
 *      ONLY in the fact pack + Exa snippets (no outside memory, no invention).
 *      Parse with extractJson, validate with Zod, retry ONCE on invalid output.
 *   3. FALLBACK — if the model is disabled, errors, or stays invalid after the
 *      retry, return null so buildRasPayload keeps its template copy. A run
 *      NEVER fails because of copy.
 *
 * The deterministic layer (safeLatin + hard length clipping in payload.ts)
 * still sanitizes and clips whatever this returns — this is the editorial
 * PROPOSAL, not the final backstop.
 */

/** News-writing rules baked into the system prompt (inverted pyramid, 5Ws+H,
 *  accurate-but-hooky headline, plain language, strict grounding). */
const COPY_SYSTEM_PROMPT = `You are a sharp, trustworthy news editor writing an Instagram post for a tech/AI/startups audience (Indian students, early-career people, and founders). You turn a verified fact brief into punchy editorial copy.

NON-NEGOTIABLE GROUNDING RULE:
- Use ONLY the facts in the FACT BRIEF and the EXTRA COVERAGE snippets provided below. Do NOT add facts from your own memory. Do NOT speculate. Do NOT invent figures, names, dates, or quotes. If the material is thin, write a SHORTER but still accurate piece — never pad with made-up detail.

NEWS-WRITING PRINCIPLES (apply them):
- Inverted pyramid: most important information first. A reader who stops after the first line still knows what happened.
- The lead answers the 5 Ws + H (who, what, when, where, why, how) in plain language, as far as the facts allow.
- Headline = an ACCURATE promise plus a hook: factually correct, strong active verbs, concrete nouns/numbers, teases the core without giving everything away. Hooky but NEVER misleading or clickbait. A misleading headline is the cardinal sin — accuracy wins over cleverness every time.
- Plain language: short sentences, concrete details, no jargon, no hype, unbiased.

RETURN STRICT JSON ONLY (no prose, no markdown fences) with exactly these keys:
- "serifHeadline": the catchy, accurate headline for the image. Max 120 characters.
- "deckLead": a short punchy on-image deck line that hooks. Max 60 characters.
- "deckHighlight": the single most striking fact or figure, very short. Max 40 characters.
- "deckTail": a short on-image deck line that teases what's next / why it matters. Max 60 characters.
- "caption": the full-story Instagram caption, written inverted-pyramid, tight but complete, about 4-6 short sentences. End with the source attribution line exactly as instructed below. Max 2000 characters.

Write naturally and plainly. Return the JSON object and nothing else.`;

export const EditorialCopySchema = z.object({
  serifHeadline: z.string().min(1).max(120),
  deckLead: z.string().min(1).max(60),
  deckHighlight: z.string().min(1).max(40),
  deckTail: z.string().max(60),
  caption: z.string().min(1).max(2000),
});

export type EditorialCopy = z.infer<typeof EditorialCopySchema>;

export interface CopyGenerateResult {
  text: string;
  usage?: unknown;
}
export type CopyGenerate = (prompt: string) => Promise<CopyGenerateResult>;

export interface WriteCopyResult {
  /** The validated LLM copy, or null when the deterministic template should be used. */
  copy: EditorialCopy | null;
  /** "llm" when the model produced valid copy, "fallback" otherwise. */
  path: "llm" | "fallback";
  /** New citable source URLs discovered by Exa (deduped, excluding ones already known). */
  enrichedSourceUrls: string[];
}

/** Default generator — the real Sarvam model, mirroring llmScore.ts exactly. */
const defaultGenerate: CopyGenerate = async (prompt) => {
  const res = await rankScoringAgent.generate(prompt, {
    modelSettings: {
      temperature: copyConfig.temperature,
      maxOutputTokens: copyConfig.maxOutputTokens,
      maxRetries: 2,
    },
    // Keep Sarvam's reasoning off so reasoning tokens don't eat the output
    // budget and truncate the JSON (same guard as the ranker).
    providerOptions: { sarvam: { reasoning_effort: "none", reasoningEffort: "none" } },
  });
  return { text: res.text ?? "", usage: res.usage };
};

/**
 * Enrich the story with FREE third-party coverage via Exa. Returns the snippet
 * block for the prompt plus the new source URLs. Fails OPEN — any problem
 * (missing key, network error) yields empty grounding, never a throw.
 */
async function enrich(
  headline: string,
  knownUrls: string[],
  config: CopyConfig,
  log: (ev: string, data: Record<string, unknown>) => void,
): Promise<{ snippets: string; sourceUrls: string[] }> {
  if (!config.exaEnabled || !process.env["EXA_API_KEY"]) {
    log("copy-enrich-skip", { reason: config.exaEnabled ? "no-exa-key" : "disabled" });
    return { snippets: "", sourceUrls: [] };
  }
  try {
    const out = await searchExa({
      query: headline,
      numResults: config.exaNumResults,
      includeText: true,
      category: "news",
    });
    const known = new Set(knownUrls.map((u) => u.trim()));
    const lines: string[] = [];
    const newUrls: string[] = [];
    for (const r of out.results) {
      const text = (r.text ?? "").replace(/\s+/g, " ").trim();
      if (text) lines.push(`- ${r.title ?? r.url}: ${text.slice(0, 2000)}`);
      if (r.url && !known.has(r.url.trim())) {
        known.add(r.url.trim());
        newUrls.push(r.url.trim());
      }
    }
    log("copy-enrich", { results: out.results.length, newUrls: newUrls.length, costDollars: out.costDollars });
    return { snippets: lines.join("\n"), sourceUrls: newUrls };
  } catch (err) {
    log("copy-enrich-error", { error: err instanceof Error ? err.message : String(err) });
    return { snippets: "", sourceUrls: [] };
  }
}

/** Build the per-story user prompt from the fact pack + Exa snippets. */
function buildUserPrompt(args: {
  factPack: FactPack;
  snippets: string;
  sourceUrls: string[];
  captionMaxSentences: number;
}): string {
  const { factPack, snippets, sourceUrls } = args;
  const srcLine = factPack.primarySource ?? factPack.sourceUrls[0] ?? sourceUrls[0] ?? "";
  const limitNote = factPack.factPackLimited ? " (headline-level; details limited)" : "";

  const brief = [
    `HEADLINE: ${factPack.headline}`,
    factPack.keyFacts.length ? `KEY FACTS:\n${factPack.keyFacts.map((f) => `- ${f}`).join("\n")}` : "",
    factPack.figures.length ? `FIGURES: ${factPack.figures.join(" | ")}` : "",
    factPack.names.length ? `NAMED ENTITIES: ${factPack.names.join(", ")}` : "",
    factPack.conflicts.length
      ? `CONFLICTING CLAIMS (do not resolve, prefer the safest phrasing):\n${factPack.conflicts
          .map((c) => `- ${c.claim}: ${c.values.join(" vs ")}`)
          .join("\n")}`
      : "",
    factPack.factPackLimited
      ? "NOTE: material is LIMITED (headline-level). Stay cautious; do not invent detail."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const coverage = snippets
    ? `\n\nEXTRA COVERAGE (free third-party reporting on the same story — use for grounding only, cite nothing that isn't here):\n${snippets}`
    : "\n\nEXTRA COVERAGE: none available — rely on the fact brief above.";

  return (
    `FACT BRIEF:\n${brief}${coverage}\n\n` +
    `Write the Instagram post copy as STRICT JSON (keys: serifHeadline, deckLead, deckHighlight, deckTail, caption).\n` +
    `Keep the caption to about ${args.captionMaxSentences} short sentences.\n` +
    `The caption MUST end with this exact attribution line on its own line: "Source: ${srcLine}${limitNote}".`
  );
}

export async function writeEditorialCopy(args: {
  item: RankInputItem;
  factPack: FactPack;
  config?: CopyConfig;
  generate?: CopyGenerate;
  log?: (ev: string, data: Record<string, unknown>) => void;
}): Promise<WriteCopyResult> {
  const config = args.config ?? copyConfig;
  const generate = args.generate ?? defaultGenerate;
  const log = args.log ?? (() => {});

  if (!config.llmEnabled) {
    log("copy-write", { path: "fallback", reason: "llm-disabled" });
    return { copy: null, path: "fallback", enrichedSourceUrls: [] };
  }

  const headline = args.factPack.headline || args.item.title;

  // 1) ENRICH (fails open).
  const { snippets, sourceUrls: enrichedSourceUrls } = await enrich(
    headline,
    [...args.factPack.sourceUrls, args.item.url],
    config,
    log,
  );

  // 2) WRITE (retry once on invalid output).
  const basePrompt = `${COPY_SYSTEM_PROMPT}\n\n${buildUserPrompt({
    factPack: args.factPack,
    snippets,
    sourceUrls: enrichedSourceUrls,
    captionMaxSentences: config.captionMaxSentences,
  })}`;
  let prompt = basePrompt;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let text = "";
    try {
      const res = await generate(prompt);
      text = res.text;
    } catch (err) {
      log("copy-llm-call-error", { attempt, error: err instanceof Error ? err.message : String(err) });
      prompt = basePrompt; // transport error — retry the same prompt
      continue;
    }

    const parsed = EditorialCopySchema.safeParse(extractJson(text));
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      log("copy-llm-invalid-output", { attempt, error: detail });
      prompt = `${basePrompt}\n\nYour previous answer was rejected (${detail}). Return JSON that matches the schema exactly, respecting every max length.`;
      continue;
    }

    log("copy-write", { path: "llm", attempt, enrichedSources: enrichedSourceUrls.length });
    return { copy: parsed.data, path: "llm", enrichedSourceUrls };
  }

  // 3) FALLBACK — invalid after the retry; template copy will be used.
  log("copy-write", { path: "fallback", reason: "invalid-after-retry", enrichedSources: enrichedSourceUrls.length });
  return { copy: null, path: "fallback", enrichedSourceUrls };
}
