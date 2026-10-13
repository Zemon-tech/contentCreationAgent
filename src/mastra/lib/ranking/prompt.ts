import type { RankingConfig } from "../../config/ranking.config";
import type { RankInputItem } from "../../schemas/ranking";
import { FEW_SHOTS } from "./fewshot";

/**
 * Stage B prompt builder. Short and rule-based by design — no generic padding.
 * The model returns ONLY judgements of meaning; the final ranking number is
 * computed in code (score.ts), never by the model.
 */

export function buildSystemPrompt(config: RankingConfig): string {
  const examples = FEW_SHOTS.map((ex, i) => {
    const { reason, ...rest } = ex.score;
    return (
      `Example ${i + 1}\n` +
      `TITLE: ${ex.title}\n` +
      `SUMMARY: ${ex.summary}\n` +
      `JUDGEMENT: ${JSON.stringify({ ...rest, reason })}`
    );
  }).join("\n\n");

  return `You score news items for an Instagram page. Judge ONLY from the title and summary given. Never assume facts that aren't there.

AUDIENCE: ${config.audience}

For each item return these fields (integers 0-10 unless noted):
- topic: "ai" | "startups" | "deeptech" | "other"
- topicFit: how squarely it fits AI / startups / deeptech
- significance: real-world impact — funding size and stage, a shipped launch, policy, a genuine breakthrough
- audienceInterest: would THIS audience care and understand it at a glance
- visualPotential: likely to have a strong, specific, usable image
- isOpinionOrRumor: true for opinion, analysis-without-news, or unconfirmed/hedged rumors
- isClickbait: true for hype headlines or engagement-bait with little substance
- isDuplicateAngle: true if another item IN THIS BATCH is the same story/angle
- reason: max 20 words, concrete, no filler

RULES:
- Use the full 0-10 range. Most items land between 2 and 6. A 9-10 is rare.
- Funding significance depends on amount AND stage: a seed round is not a Series C.
- "Raises $X" or "launches Y" from a named, credible source beats vague "AI is changing everything" pieces.
- Flag opinion, analysis-without-news, and rumors — do not silently score them low.

${examples}

Return ONLY a JSON object: {"scores":[ {one object per item, echoing its id}... ]}. No prose, no markdown.`;
}

/** The per-batch user message: the items to score, id-tagged. */
export function buildBatchPrompt(items: RankInputItem[]): string {
  const payload = items.map((it) => ({
    id: it.id,
    title: it.title,
    summary: it.summary.slice(0, 800),
  }));
  return (
    `Score these ${items.length} item(s). Return one judgement per id in "scores".\n\n` +
    JSON.stringify(payload)
  );
}
