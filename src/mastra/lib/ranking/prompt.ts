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
- isNewInformation: true if it reports genuinely NEW information, not a recap or aggregation
- isPrimarySource: true if the item ITSELF is the first-party source (the company/person announcing, the researcher reporting), not someone relaying it
- specificity (0-10): how concrete the claim is — names, numbers, dates, shipped facts score high; vague "soon"/"could" score low
- hookPotential (0-10): how strongly the fact itself stops a scroll (NOT how hyped the wording is)
- claimRisk: "low" | "medium" | "high" — how damaging it would be if the central claim were false/unverified (a bold acquisition/benchmark/safety claim is "high"; a routine shipped feature is "low")
- flags: an object { engagementBait, selfPromotion, giveaway, hotTakeThread } — booleans, true when that pattern is present
- derivedHeadline: a short, factual headline (<=200 chars) you derive from the content; for a raw social post, write the news in plain words — never copy hype
- headlineDerived: always the literal value true (you derived the headline above)
- reason: max 20 words, concrete, no filler

RULES:
- Use the full 0-10 range. Most items land between 2 and 6. A 9-10 is rare.
- Funding significance depends on amount AND stage: a seed round is not a Series C.
- "Raises $X" or "launches Y" from a named, credible source beats vague "AI is changing everything" pieces.
- Flag opinion, analysis-without-news, and rumors — do not silently score them low.
- You judge MEANING only. Never output a handle, a ranking number, or a final score — code computes all numbers that decide ranking.

X-MODE (an item marked isX is a social post, not an article):
- Derive a factual derivedHeadline from the post text — strip emoji, hype, and self-promo; state only what is claimed.
- Judge isPrimarySource (is the poster the one making/announcing the thing?) and isNewInformation honestly.
- Set the flags: giveaway/airdrop/"RT to win" -> giveaway + engagementBait; "we just shipped"/"link in bio" with no substance -> selfPromotion; a spicy opinion thread -> hotTakeThread.
- Set claimRisk high for an unverified bold claim (acquisition, record benchmark, outage, safety incident).

${examples}

Return ONLY a JSON object: {"scores":[ {one object per item, echoing its id}... ]}. No prose, no markdown.`;
}

/** The per-batch user message: the items to score, id-tagged. */
export function buildBatchPrompt(items: RankInputItem[]): string {
  const payload = items.map((it) => ({
    id: it.id,
    title: it.title,
    summary: it.summary.slice(0, 800),
    // Meaning-only hints — never a number. Present only for X items.
    ...(it.isX ? { isX: true, hasOutboundLink: (it.outboundUrls?.length ?? 0) > 0 } : {}),
  }));
  return (
    `Score these ${items.length} item(s). Return one judgement per id in "scores".\n\n` +
    JSON.stringify(payload)
  );
}
