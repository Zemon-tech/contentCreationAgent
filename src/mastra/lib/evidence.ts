import type { Source, EvidenceTier, SourceRelationship } from "../schemas/source";
import type {
  CanonicalVerification,
  EvidenceSource,
} from "../schemas/story";
import type { NormalizedContent } from "../schemas/rawContent";

/**
 * Evidence hierarchy (§6-9): primary vs secondary vs signal sources,
 * source independence, claim-level provenance, structured verification.
 */

/** Sources that can NEVER be primary merely by publishing first. */
const NEVER_PRIMARY_PUBLISHERS = new Set(
  ["securityweek", "runtimewire", "techcrunch", "reuters", "bloomberg", "the verge", "financial times", "wall street journal", "ap"].map((s) =>
    s.toLowerCase(),
  ),
);

export function resolveEvidenceTier(source: Source): EvidenceTier {
  if (source.evidenceTier) return source.evidenceTier;
  switch (source.role) {
    case "official":
    case "academic":
      // Official/academic origins are primary candidates (confirmed per-claim).
      return "T0_PRIMARY";
    case "news":
      return "T1_HIGH_SIGNAL";
    case "signal_creator":
    case "launch":
      return "T2_EXPERT_SIGNAL";
    case "community":
      return "T3_COMMUNITY_SIGNAL";
    default:
      break;
  }
  // Fallback by type.
  if (source.type === "social" || source.type === "community") return "T3_COMMUNITY_SIGNAL";
  if (source.type === "paper") return "T0_PRIMARY";
  if (source.type === "github" || source.type === "blog") return "T0_PRIMARY";
  return "T1_HIGH_SIGNAL";
}

/** Default use: discovery (fast) vs verification (strong). */
export function resolveDefaultUse(source: Source): "DISCOVERY" | "VERIFICATION" | "BOTH" {
  if (source.defaultUse) return source.defaultUse;
  const tier = resolveEvidenceTier(source);
  if (tier === "T0_PRIMARY") return "VERIFICATION";
  if (tier === "T1_HIGH_SIGNAL") return "BOTH";
  return "DISCOVERY";
}

export function verificationValueOf(source: Source): number {
  if (typeof source.verificationValue === "number") return source.verificationValue;
  const tier = resolveEvidenceTier(source);
  if (tier === "T0_PRIMARY") return 95;
  if (tier === "T1_HIGH_SIGNAL") return 75;
  if (tier === "T2_EXPERT_SIGNAL") return 40;
  return 15;
}

/**
 * A source is primary ONLY when it directly originates the evidence/event —
 * never merely because it published first. News outlets (even Reuters /
 * TechCrunch) are corroboration, not primary.
 */
export function isPrimarySource(
  source: Source | undefined,
  evidence: { url: string; publisher?: string },
): { isPrimary: boolean; rationale: string } {
  if (!source) {
    return { isPrimary: false, rationale: "Unknown source; cannot be primary." };
  }
  const publisher = (evidence.publisher ?? source.publisher ?? source.name).toLowerCase();
  for (const blocked of NEVER_PRIMARY_PUBLISHERS) {
    if (publisher.includes(blocked) && source.role !== "official") {
      return {
        isPrimary: false,
        rationale:
          `${source.name} is a secondary outlet reporting the story, not the originator ` +
          `of the evidence; it corroborates but does not primarily confirm.`,
      };
    }
  }
  if (source.role === "official" || source.role === "academic" || source.type === "paper" || source.type === "github") {
    return {
      isPrimary: false, // confirmed per-story by classification check in verify.ts
      rationale:
        `${source.name} is a first-party/academic origin and is a primary candidate ` +
        `when its content directly establishes the claim (announcement, release, paper, dataset).`,
    };
  }
  return {
    isPrimary: false,
    rationale: `${source.name} (${resolveEvidenceTier(source)}) does not directly originate the evidence.`,
  };
}

export interface IndependenceInput {
  url: string;
  normalizedUrl?: string;
  title?: string;
  text?: string;
  publisher?: string;
}

/**
 * Heuristic source relationship: detect syndication / reposts / commentary
 * vs independent reporting. Only ORIGINAL + INDEPENDENT_REPORT raise
 * verification confidence materially.
 */
export function classifyRelationship(
  item: IndependenceInput,
  primaryUrl?: string,
  allItems: IndependenceInput[] = [],
): SourceRelationship {
  const text = `${item.title ?? ""} ${item.text ?? ""}`.toLowerCase();
  if (/(syndicated|republished|via |cross-posted|originally appeared)/.test(text)) {
    return "SYNDICATED";
  }
  if (/(opinion|analysis|commentary|what this means|take:|hot take)/.test(text)) {
    return "COMMENTARY";
  }
  // Same canonical URL seen before → repost.
  if (primaryUrl && item.url === primaryUrl) return "REPOST";
  // Near-identical titles across outlets → likely copy, not independent.
  if (allItems.length > 1 && item.title) {
    const twins = allItems.filter(
      (o) => o.url !== item.url && o.title && item.title && titlesNearIdentical(o.title, item.title),
    );
    if (twins.length > 0) return "REPOST";
  }
  // First occurrence of an outlet's own reporting → original by default for T0.
  return "INDEPENDENT_REPORT";
}

function titlesNearIdentical(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

/** Count only independent confirmations (ORIGINAL + INDEPENDENT_REPORT). */
export function countIndependentSources(
  relationships: SourceRelationship[],
): number {
  return relationships.filter(
    (r) => r === "ORIGINAL" || r === "INDEPENDENT_REPORT",
  ).length;
}

/**
 * Structured verification (§8). Never upgrades merely because N sites
 * copied the same original report — independence is required.
 */
export function determineVerificationStatus(opts: {
  hasPrimaryConfirmation: boolean;
  independentCount: number;
  singleReliable: boolean;
  hasConflict: boolean;
  hasAnyReport: boolean;
}): { status: CanonicalVerification; confidence: number; explanation: string } {
  if (opts.hasConflict) {
    return {
      status: "CONFLICTED",
      confidence: 30,
      explanation:
        "Credible sources materially disagree; holding for human verification instead of choosing a side.",
    };
  }
  if (opts.hasPrimaryConfirmation) {
    return {
      status: "PRIMARY_CONFIRMED",
      confidence: 94,
      explanation: "A credible T0 primary source directly confirms the claim.",
    };
  }
  if (opts.independentCount >= 2) {
    return {
      status: "MULTI_SOURCE_CONFIRMED",
      confidence: 82,
      explanation:
        `${opts.independentCount} independent reliable sources corroborate the claim ` +
        `(copies of one report do not count); no primary source available.`,
    };
  }
  if (opts.singleReliable) {
    return {
      status: "SINGLE_RELIABLE_SOURCE",
      confidence: 60,
      explanation: "Only one credible source supports the claim so far.",
    };
  }
  if (opts.hasAnyReport) {
    return {
      status: "REPORTED",
      confidence: 40,
      explanation: "Reported by a source but not sufficiently corroborated; primary confirmation not found.",
    };
  }
  return {
    status: "UNVERIFIED",
    confidence: 20,
    explanation: "Insufficient evidence to verify the claim.",
  };
}

/** Build structured evidence entries (§7) for a story's members. */
export function buildEvidenceSources(
  members: NormalizedContent[],
  sourcesById: Map<string, Source>,
): EvidenceSource[] {
  return members.map((m) => {
    const src = sourcesById.get(m.sourceId);
    const tier = src ? resolveEvidenceTier(src) : "T3_COMMUNITY_SIGNAL";
    const primaryCheck = isPrimarySource(src, {
      url: m.url,
      publisher: m.sourceName,
    });
    // Only first-party origins with announcement-like content are primary.
    // verify.ts refines this with classification; here we mark conservatively.
    return {
      url: m.url,
      publisher: m.sourceName,
      title: m.normalizedTitle || m.title,
      published_at: m.publishedAt ?? m.firstReportedAt ?? m.collectedAt,
      evidence_tier: tier,
      source_type: m.sourceType,
      is_primary: false,
      primary_rationale: primaryCheck.rationale,
      source_relationship: "INDEPENDENT_REPORT" as SourceRelationship,
      supports_claims: [],
    };
  });
}
