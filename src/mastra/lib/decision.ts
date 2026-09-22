import type {
  ContentDecision,
  Freshness,
  SignalScores,
  VerificationStatus,
} from "../schemas/story";
import { classifyFreshness } from "./freshness";

/**
 * Signal scoring (§12-14) + content decision gate (§15-16).
 * Deterministic constraints prevent LLM score inflation.
 */

export interface DecisionInputs {
  signalScores: SignalScores;
  verificationConfidence: number; // 0-100
  freshness: Freshness;
  tiers: string[]; // evidence tiers present
  isDuplicate: boolean;
  independentCount: number;
  historicalRequested?: boolean;
}

export const SCORE_WEIGHTS = {
  relevance: 0.25,
  impact: 0.2,
  novelty: 0.15,
  velocity: 0.1,
  source_authority: 0.1,
  audience_interest: 0.1,
  content_potential: 0.1,
} as const;

/** Weighted overall 0-100 from explicit sub-scores (never a bare LLM guess). */
export function computeSignalOverall(
  s: Omit<SignalScores, "overall">,
): number {
  const overall =
    s.relevance * SCORE_WEIGHTS.relevance +
    s.impact * SCORE_WEIGHTS.impact +
    s.novelty * SCORE_WEIGHTS.novelty +
    s.velocity * SCORE_WEIGHTS.velocity +
    s.source_authority * SCORE_WEIGHTS.source_authority +
    s.audience_interest * SCORE_WEIGHTS.audience_interest +
    s.content_potential * SCORE_WEIGHTS.content_potential;
  return Math.round(overall * 10) / 10;
}

/** Map legacy 0-10 story scores to canonical 0-100 signal scores. */
export function toSignalScores(legacy: {
  relevance: number;
  novelty: number;
  impact: number;
  velocity: number;
  authority: number;
  audienceInterest: number;
  contentPotential: number;
}): SignalScores {
  const s = {
    relevance: legacy.relevance * 10,
    impact: legacy.impact * 10,
    novelty: legacy.novelty * 10,
    velocity: legacy.velocity * 10,
    source_authority: legacy.authority * 10,
    audience_interest: legacy.audienceInterest * 10,
    content_potential: legacy.contentPotential * 10,
  };
  return { ...s, overall: computeSignalOverall(s) };
}

/**
 * Hard score overrides (§14). Returns capped overall + reasons.
 * Caps apply in order; the lowest cap wins.
 */
export function applyScoreCaps(
  overall: number,
  inputs: DecisionInputs,
): { overall: number; cappedReasons: string[] } {
  const reasons: string[] = [];
  let capped = overall;

  if (inputs.verificationConfidence < 50 && capped > 59) {
    capped = 59;
    reasons.push("verification_confidence < 50 → cap 59");
  }
  if (inputs.freshness === "STALE" && !inputs.historicalRequested && capped > 40) {
    capped = 40;
    reasons.push("STALE → cap 40");
  }
  const onlyWeak =
    inputs.tiers.length > 0 &&
    inputs.tiers.every((t) => t === "T2_EXPERT_SIGNAL" || t === "T3_COMMUNITY_SIGNAL");
  if (onlyWeak && capped > 69) {
    capped = 69;
    reasons.push("T2/T3-only evidence → cap 69");
  }
  return { overall: Math.round(capped * 10) / 10, cappedReasons: reasons };
}

/** Content decision gate (§15): every story gets POST_NOW / WORTH_COVERING / MONITOR / DO_NOT_POST. */
export function decideContent(
  overall: number,
  inputs: DecisionInputs & { signalScores: SignalScores },
): { decision: ContentDecision; rejection_reason?: string } {
  if (inputs.isDuplicate) {
    return { decision: "DO_NOT_POST", rejection_reason: "Duplicate" };
  }
  if (inputs.signalScores.relevance < 40) {
    return { decision: "DO_NOT_POST", rejection_reason: "Low relevance" };
  }
  if (inputs.signalScores.content_potential < 40) {
    return { decision: "DO_NOT_POST", rejection_reason: "No useful content angle" };
  }
  if (overall < 40) {
    return { decision: "DO_NOT_POST", rejection_reason: rejectionFor(inputs, overall) };
  }
  if (overall >= 80 && inputs.verificationConfidence >= 70 && (inputs.freshness === "BREAKING" || inputs.freshness === "DEVELOPING")) {
    return { decision: "POST_NOW" };
  }
  if (overall >= 70) {
    return { decision: "WORTH_COVERING" };
  }
  if (overall >= 60) {
    // Weak evidence with moderate score → monitor, don't post.
    if (inputs.verificationConfidence < 60) {
      return { decision: "MONITOR", rejection_reason: "Insufficient evidence" };
    }
    return { decision: "MONITOR", rejection_reason: "Worth monitoring / potentially useful" };
  }
  return { decision: "DO_NOT_POST", rejection_reason: rejectionFor(inputs, overall) };
}

function rejectionFor(inputs: DecisionInputs, overall: number): string {
  if (inputs.freshness === "STALE") return "Too old";
  if (inputs.verificationConfidence < 50) return "Weak evidence";
  if (inputs.signalScores.novelty * 1 < 40) return "Low novelty";
  if (inputs.signalScores.impact < 40) return "Low impact";
  if (inputs.independentCount <= 1 && overall < 60) return "Only community rumor";
  if (inputs.signalScores.content_potential < 50) return "No useful content angle";
  return "Low content value";
}

/** Map canonical verification → legacy verification for stored stories. */
export function canonicalToLegacy(
  status: string,
): VerificationStatus {
  switch (status) {
    case "PRIMARY_CONFIRMED":
      return "verified";
    case "MULTI_SOURCE_CONFIRMED":
    case "SINGLE_RELIABLE_SOURCE":
      return "strong";
    case "REPORTED":
      return "signal";
    case "CONFLICTED":
      return "conflict";
    default:
      return "unverified";
  }
}

/** Score calibration band (§13) for human-readable labels. */
export function calibrationBand(overall: number): string {
  if (overall >= 95) return "Exceptional / major industry-changing development";
  if (overall >= 90) return "Major development with broad impact";
  if (overall >= 80) return "Strong content opportunity";
  if (overall >= 70) return "Worth monitoring / potentially useful";
  if (overall >= 60) return "Interesting but limited content value";
  if (overall >= 40) return "Low-value / niche";
  return "Reject";
}

export function decisionFromTimestamps(args: {
  event_at?: string;
  latest_update_at?: string;
  discovered_at: string;
  windowHours?: number;
  now?: Date;
}): { freshness: Freshness; reason: string } {
  return classifyFreshness(
    {
      event_at: args.event_at,
      latest_update_at: args.latest_update_at,
      discovered_at: args.discovered_at,
    },
    args.now ?? new Date(),
    args.windowHours ?? 24,
  );
}
