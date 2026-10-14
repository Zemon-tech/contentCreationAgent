import type { Story } from "../schemas/story";
import type { FactPack } from "../schemas/factpack";

/**
 * buildFactPack — assemble a verified fact pack from a clustered Story.
 *
 * Pure extraction, no LLM, no invention:
 *  - keyFacts come from the story's own whatHappened/summary text;
 *  - figures are regex-extracted from that same text (never fabricated);
 *  - names are the clustered entities; sourceUrls are the story's sources;
 *  - conflicts come straight from the verify stage's contradictions.
 * When material is thin (paywalled / fallback / summary-only), the caller
 * passes `limited: true` and we keep facts to the title + summary only.
 */

const FIGURE_RE =
  /(?:₹|rs\.?\s?|\$)\s?\d[\d,]*(?:\.\d+)?\s?(?:billion|trillion|million|crore|lakh|bn|mn|k|m|b)?\b|\b\d[\d,]*(?:\.\d+)?\s?(?:billion|trillion|million|crore|lakh)\b|\b\d+(?:\.\d+)?\s?%/gi;

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

export function extractFigures(text: string): string[] {
  return uniq((text.match(FIGURE_RE) ?? []).map((m) => m.replace(/\s+/g, " ").trim())).slice(0, 10);
}

export function buildFactPack(
  story: Story,
  opts: { limited?: boolean; sourceUrls?: string[] } = {},
): FactPack {
  const evidence = story.evidence;
  // Thin material if explicitly flagged, or when there's no real body beyond the summary.
  const body = (story.whatHappened ?? "").trim();
  const summary = (story.summary ?? "").trim();
  const limited = opts.limited ?? (body.length === 0 || body === summary);

  const factSource = limited ? [story.title, summary].filter(Boolean).join(". ") : `${body} ${summary}`;
  const keyFacts = uniq([...sentences(body || summary)]).slice(0, 5);
  // Always ensure at least the headline-as-fact when extraction is sparse.
  if (keyFacts.length === 0 && story.title) keyFacts.push(story.title);

  return {
    headline: story.title,
    keyFacts,
    figures: extractFigures(factSource),
    names: uniq(story.entities ?? []).slice(0, 12),
    // Citable sources only (signal-only exclusion happens upstream when the
    // story is assembled; evidence.primarySource is always citable).
    sourceUrls: uniq(opts.sourceUrls ?? story.sources ?? []),
    ...(evidence?.primarySource ? { primarySource: evidence.primarySource } : {}),
    conflicts: (evidence?.contradictions ?? []).map((c) => ({
      claim: c.claim,
      values: c.values,
      sources: c.sources,
    })),
    factPackLimited: limited,
  };
}
