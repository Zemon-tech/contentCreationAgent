import type { LlmScore } from "../../schemas/ranking";

/**
 * Few-shot examples for Stage B scoring. EDIT THESE to calibrate the model.
 *
 * Keep 4-6 spanning the range: a clear post (high), a solid-but-ordinary item
 * (medium), a thin item (low), a rumor, and a clickbait. Each example is a
 * (title, summary) the model would see plus the judgement it SHOULD return.
 * The final score is computed in code — these only teach the 0-10 judgements
 * and the boolean flags.
 */
export interface FewShotExample {
  title: string;
  summary: string;
  score: Omit<LlmScore, "id">;
}

export const FEW_SHOTS: FewShotExample[] = [
  {
    // HIGH: concrete, significant launch from a credible primary source.
    title: "OpenAI releases GPT-5.5 with native agent orchestration",
    summary:
      "OpenAI announced GPT-5.5, adding built-in multi-agent orchestration and a 2M-token context window. Available in the API today; pricing cut 40% versus GPT-5.",
    score: {
      topic: "ai",
      topicFit: 10,
      significance: 9,
      audienceInterest: 9,
      visualPotential: 7,
      isOpinionOrRumor: false,
      isClickbait: false,
      isDuplicateAngle: false,
      reason: "Major model launch, concrete specs and pricing, directly relevant.",
    },
  },
  {
    // HIGH-MED: real Indian startup funding with amount + stage.
    title: "Bengaluru deeptech startup Peptris raises $12M Series A for AI drug discovery",
    summary:
      "Peptris Technologies raised a $12M Series A led by Accel to scale its AI platform for small-molecule drug discovery. The round brings total funding to $18M.",
    score: {
      topic: "deeptech",
      topicFit: 9,
      significance: 6,
      audienceInterest: 8,
      visualPotential: 5,
      isOpinionOrRumor: false,
      isClickbait: false,
      isDuplicateAngle: false,
      reason: "Named Indian deeptech Series A with amount and lead investor.",
    },
  },
  {
    // MEDIUM: ordinary product update, limited impact.
    title: "Notion adds a new AI meeting-notes feature to its business plan",
    summary:
      "Notion rolled out AI-generated meeting notes for business-tier customers, transcribing and summarizing calls inside the workspace.",
    score: {
      topic: "ai",
      topicFit: 6,
      significance: 3,
      audienceInterest: 4,
      visualPotential: 4,
      isOpinionOrRumor: false,
      isClickbait: false,
      isDuplicateAngle: false,
      reason: "Incremental feature on one product; limited real-world impact.",
    },
  },
  {
    // LOW: vague thought-piece, no news.
    title: "Why AI will change everything about how we work",
    summary:
      "A sweeping look at how artificial intelligence could reshape jobs, creativity, and the economy over the next decade.",
    score: {
      topic: "ai",
      topicFit: 5,
      significance: 2,
      audienceInterest: 3,
      visualPotential: 2,
      isOpinionOrRumor: true,
      isClickbait: false,
      isDuplicateAngle: false,
      reason: "Opinion/analysis with no concrete news or facts.",
    },
  },
  {
    // RUMOR: unconfirmed, hedged sourcing.
    title: "Report: Apple may be in early talks to acquire a stealth AI chip startup",
    summary:
      "People familiar with the matter say Apple has held preliminary conversations about acquiring an unnamed AI silicon startup. Apple declined to comment; nothing is finalized.",
    score: {
      topic: "ai",
      topicFit: 7,
      significance: 4,
      audienceInterest: 6,
      visualPotential: 4,
      isOpinionOrRumor: true,
      isClickbait: false,
      isDuplicateAngle: false,
      reason: "Unconfirmed acquisition talks, hedged sourcing, nothing finalized.",
    },
  },
  {
    // CLICKBAIT: hype headline, empty substance.
    title: "This tiny AI startup is about to DESTROY Google forever 🤯",
    summary:
      "You won't believe what this unknown startup just did. Experts are stunned and Google should be terrified. Here's everything you need to know.",
    score: {
      topic: "startups",
      topicFit: 4,
      significance: 1,
      audienceInterest: 2,
      visualPotential: 2,
      isOpinionOrRumor: false,
      isClickbait: true,
      isDuplicateAngle: false,
      reason: "Hype headline, no facts, engagement-bait framing.",
    },
  },
];
