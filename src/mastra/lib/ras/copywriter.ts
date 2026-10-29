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
const COPY_SYSTEM_PROMPT = `You are a sharp, trustworthy news editor writing an Instagram post for a tech/AI/startups audience (Indian students, early-career people, and founders). You turn a verified fact brief into punchy editorial copy with a CATCHY but strictly accurate headline.

NON-NEGOTIABLE GROUNDING RULE:
- Use ONLY the facts in the FACT BRIEF and the EXTRA COVERAGE snippets provided below. Do NOT add facts from your own memory. Do NOT speculate. Do NOT invent figures, names, dates, or quotes. If the material is thin, write a SHORTER but still accurate piece — never pad with made-up detail.

HEADLINE CRAFT (serifHeadline) — pick the strongest of these formulas for THIS story, do not label it:
- Number hero: lead with the most striking number or comparison in the facts.
- Fact + consequence: state the event, then what follows / what it means.
- Odd specific detail: lead with the most concrete, unusual detail in the facts.
- Price/size tag: the product plus the figure that makes it notable.
- Boring subject, surprising verb: only if the verb is literally what happened.
- You-as-stakeholder: frame around what it means for an Indian student, early-career person or founder — ONLY if the facts support that link.
Headline style: max ~14 words; plain conversational words; specific beats vague; strong active verbs; concrete nouns/numbers; tease the core without giving everything away.

FIDELITY RULES (non-negotiable — you may change wording, order and tone, NEVER facts):
- Every number, name, date and claim in the headline, deck and caption MUST appear in the FACT BRIEF / EXTRA COVERAGE. No rounding up. No merging two facts into one stronger claim. No implied causation that isn't stated.
- Headline strength may not exceed the evidence. When the brief is marked LIMITED or a claim is unconfirmed, keep the catchy tone but HEDGE and ATTRIBUTE ("reportedly", "per [source]").
- A misleading headline is the cardinal sin — accuracy wins over cleverness every time. Before finalizing, silently verify every claim in the headline and caption traces to a brief entry; if one does not, rewrite it down to what the facts support.

BANNED in the headline: hyperbole verbs ("killed", "crushed", "destroyed", "is cooked"); unverifiable superlatives ("biggest ever", "most serious in history"); direct-address bait ("do you realize", "you won't believe"); the words "shocking" and "breaking"; and any clickbait.

NEWS-WRITING PRINCIPLES (apply them):
- Inverted pyramid: most important information first. A reader who stops after the first line still knows what happened.
- The lead answers the 5 Ws + H (who, what, when, where, why, how) in plain language, as far as the facts allow.
- Plain language: short sentences, concrete details, no jargon, no hype, unbiased. Confident, simple, curious tone; no hype adjectives, no emoji spam, no filler.

RETURN STRICT JSON ONLY (no prose, no markdown fences) with exactly these keys:
- "serifHeadline": the catchy, accurate headline for the image, built per HEADLINE CRAFT above. Max 120 characters.
- "deckLead": a short punchy on-image deck line that hooks. Max 60 characters.
- "deckHighlight": the single most striking fact or figure, very short (this is the ACCENT line). Max 40 characters.
- "deckTail": a short on-image deck line that teases what's next / why it matters. Max 60 characters.
- "caption": the full-story Instagram caption. First line restates the hook in DIFFERENT words from the headline; then 3-5 short context lines (inverted pyramid, tight but complete); you may name the source PUBLICATION by name if it reads naturally; add ONE question that invites comments. Do NOT put any raw URL or a "Source: <link>" line in the caption — no links at all. Max 2000 characters.
- "xCaption": a SINGLE standalone tweet for X (Twitter), written fresh for X — NOT a truncation of the Instagram caption. Lead with the hook in the FIRST line so a scroller stops. Punchy, plain, one or two short sentences. 0-2 topical hashtags maximum (fewer is better). Do NOT include any URL or link in the tweet. HARD LIMIT: the entire xCaption MUST be 280 characters or fewer (count hashtags). Obey EVERY grounding and fidelity rule above exactly as for the Instagram caption: no invented facts, numbers, names, dates or quotes; hedge/attribute when the brief is LIMITED or unconfirmed.

Write naturally and plainly. Return the JSON object and nothing else.`;

export const EditorialCopySchema = z.object({
  serifHeadline: z.string().min(1).max(120),
  deckLead: z.string().min(1).max(60),
  deckHighlight: z.string().min(1).max(40),
  deckTail: z.string().max(60),
  caption: z.string().min(1).max(2000),
  // Standalone tweet. OPTIONAL, length-UNCONSTRAINED, and FIELD-LEVEL CATCH on
  // purpose: a missing, over-length, null, or otherwise non-string value must
  // NEVER fail the whole EditorialCopySchema parse, which would discard the
  // otherwise-good Instagram copy (serifHeadline, deck fields, caption) and
  // force everything onto the deterministic template. `.catch(undefined)`
  // recovers this field independently — any non-string (null, number, object)
  // collapses to `undefined`, so the rest of the object still validates and the
  // deterministic X fallback kicks in. buildRasPayload normalizes a surviving
  // string independently (0-2 hashtag cap, clipped <=280 word-safe), so the 280
  // guarantee holds downstream regardless. NOT a truncated IG caption.
  xCaption: z.string().optional().catch(undefined),
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
  const { factPack, snippets } = args;

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
    `Write the post copy as STRICT JSON (keys: serifHeadline, deckLead, deckHighlight, deckTail, caption, xCaption).\n` +
    `Keep the caption to about ${args.captionMaxSentences} short sentences.\n` +
    `The xCaption is a standalone tweet for X: hook first, punchy, <= 280 characters total (count hashtags), 0-2 hashtags, same grounding/fidelity rules — it is NOT a truncation of the caption.\n` +
    `Do NOT put any URL or "Source:" link line in either the caption or the xCaption — no links at all.`
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
