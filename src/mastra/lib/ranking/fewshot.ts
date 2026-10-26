import type { LlmScore } from "../../schemas/ranking";

/**
 * Few-shot examples for Stage B scoring. EDIT THESE to calibrate the model.
 *
 * Keep a spread across the range: a clear post (high), a solid-but-ordinary
 * item (medium), a thin item (low), a rumor, a clickbait, plus a few X-mode
 * examples. Each example is a (title, summary) the model would see plus the
 * judgement it SHOULD return. The final score is computed in code — these only
 * teach the 0-10 judgements, the boolean flags, and (X-mode) the derived
 * factual headline.
 *
 * X examples are tagged `synthetic: true`: they use clearly fictional company
 * and person names and no real facts, as a placeholder until real posts are
 * swapped in.
 */
export interface FewShotExample {
  title: string;
  summary: string;
  score: Omit<LlmScore, "id">;
  /** True for a fabricated/placeholder example (fictional names, no real facts). */
  synthetic?: boolean;
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
      isNewInformation: true,
      isPrimarySource: true,
      specificity: 9,
      hookPotential: 8,
      claimRisk: "low",
      flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
      derivedHeadline: "OpenAI releases GPT-5.5 with native agent orchestration",
      headlineDerived: true,
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
      isNewInformation: true,
      isPrimarySource: false,
      specificity: 8,
      hookPotential: 6,
      claimRisk: "low",
      flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
      derivedHeadline: "Bengaluru deeptech startup Peptris raises $12M Series A for AI drug discovery",
      headlineDerived: true,
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
      isNewInformation: true,
      isPrimarySource: false,
      specificity: 6,
      hookPotential: 3,
      claimRisk: "low",
      flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
      derivedHeadline: "Notion adds a new AI meeting-notes feature to its business plan",
      headlineDerived: true,
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
      isNewInformation: false,
      isPrimarySource: false,
      specificity: 1,
      hookPotential: 2,
      claimRisk: "low",
      flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
      derivedHeadline: "Opinion piece on how AI could reshape work over the next decade",
      headlineDerived: true,
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
      isNewInformation: false,
      isPrimarySource: false,
      specificity: 3,
      hookPotential: 5,
      claimRisk: "high",
      flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
      derivedHeadline: "Report: Apple reportedly in early talks to acquire an AI chip startup",
      headlineDerived: true,
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
      isNewInformation: false,
      isPrimarySource: false,
      specificity: 1,
      hookPotential: 2,
      claimRisk: "medium",
      flags: { engagementBait: true, selfPromotion: false, giveaway: false, hotTakeThread: false },
      derivedHeadline: "Unnamed AI startup makes an unspecified claim about competing with Google",
      headlineDerived: true,
      reason: "Hype headline, no facts, engagement-bait framing.",
    },
  },
  {
    // X-GOOD (synthetic): fictional company shipping, with an outbound link.
    title: "@nimbus_robotics: We're shipping Nimbus Dock 1.0",
    summary:
      "Nimbus Robotics: Nimbus Dock 1.0 is live — autonomous warehouse docking that cuts unloading time ~30% in our pilot. Full technical writeup and benchmarks here: nimbusrobotics.example/dock",
    synthetic: true,
    score: {
      topic: "deeptech",
      topicFit: 8,
      significance: 6,
      audienceInterest: 7,
      visualPotential: 6,
      isOpinionOrRumor: false,
      isClickbait: false,
      isDuplicateAngle: false,
      isNewInformation: true,
      isPrimarySource: true,
      specificity: 7,
      hookPotential: 6,
      claimRisk: "low",
      flags: { engagementBait: false, selfPromotion: true, giveaway: false, hotTakeThread: false },
      derivedHeadline: "Nimbus Robotics ships Nimbus Dock 1.0, claims ~30% faster warehouse unloading",
      headlineDerived: true,
      reason: "First-party launch with an outbound writeup; concrete, mild self-promo.",
    },
  },
  {
    // X-MEDIUM (synthetic): single-account bold claim, no corroboration.
    title: "@fakefounder: Heard Vellum AI just closed a huge round",
    summary:
      "Vellum AI apparently closed a massive Series B this week at a crazy valuation. No official word yet but my sources are solid. Big if true.",
    synthetic: true,
    score: {
      topic: "startups",
      topicFit: 7,
      significance: 4,
      audienceInterest: 5,
      visualPotential: 3,
      isOpinionOrRumor: true,
      isClickbait: false,
      isDuplicateAngle: false,
      isNewInformation: false,
      isPrimarySource: false,
      specificity: 2,
      hookPotential: 5,
      claimRisk: "high",
      flags: { engagementBait: false, selfPromotion: false, giveaway: false, hotTakeThread: false },
      derivedHeadline: "Unverified claim that Vellum AI closed a Series B round",
      headlineDerived: true,
      reason: "Single-account rumor, no source, bold unverified funding claim.",
    },
  },
  {
    // X-BAD (synthetic): giveaway / engagement bait.
    title: "@fakefounder: 🚀 GIVEAWAY — $500 to one lucky follower!",
    summary:
      "GIVEAWAY TIME! 🎉 RT + follow + tag 3 friends and one of you wins $500. Link in bio. Don't miss out, ending soon!!! #giveaway #crypto",
    synthetic: true,
    score: {
      topic: "other",
      topicFit: 1,
      significance: 0,
      audienceInterest: 1,
      visualPotential: 1,
      isOpinionOrRumor: false,
      isClickbait: true,
      isDuplicateAngle: false,
      isNewInformation: false,
      isPrimarySource: false,
      specificity: 0,
      hookPotential: 1,
      claimRisk: "low",
      flags: { engagementBait: true, selfPromotion: true, giveaway: true, hotTakeThread: false },
      derivedHeadline: "Promotional giveaway post asking followers to retweet and tag friends",
      headlineDerived: true,
      reason: "Pure giveaway engagement-bait, no news value.",
    },
  },
];
