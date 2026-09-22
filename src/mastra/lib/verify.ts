import type { Analysis } from "../schemas/analysis";
import type { NormalizedContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import type {
  CanonicalVerification,
  Contradiction,
  EvidenceSource,
  Story,
  StoryEvidence,
  VerificationStatus,
} from "../schemas/story";
import { aggregateEngagementScore } from "./scoring";
import {
  buildEvidenceSources,
  classifyRelationship,
  countIndependentSources,
  determineVerificationStatus,
  resolveEvidenceTier,
} from "./evidence";
import { canonicalToLegacy } from "./decision";

/**
 * RADAR STAGES 5-6 (+ overrides) — verify BEFORE scoring.
 * Cross-source confirmation, primary-source attachment, contradiction
 * detection, signal classification, and hard priority overrides.
 * All deterministic; the LLM only interprets already-verified stories.
 *
 * Upgrades (§6-9):
 * - explicit T0/T1/T2/T3 evidence tiers per source
 * - primary only when the source directly originates the evidence
 *   (news outlets are NEVER primary merely by publishing first)
 * - source independence: copies of one report don't count as N confirmations
 * - canonical verification statuses PRIMARY_CONFIRMED / MULTI_SOURCE_CONFIRMED /
 *   SINGLE_RELIABLE_SOURCE / REPORTED / UNVERIFIED / CONFLICTED
 * Legacy statuses (verified/strong/signal/…) are still emitted for
 * backward compatibility with stored stories and existing tests.
 */

export type SignalClass = "breaking" | "important" | "emerging" | "background";

const PRIMARY_CLASSIFICATIONS = new Set([
  "announcement",
  "product_launch",
  "research",
  "technical_update",
]);

/** Outlets that are never primary merely by publishing first (§7). */
const SECONDARY_ONLY = ["techcrunch", "reuters", "bloomberg", "securityweek", "runtimewire", "the verge"];

export function verifyStory(
  story: Story,
  members: NormalizedContent[],
  analyses: Map<string, Analysis>,
  sourcesById: Map<string, Source>,
): StoryEvidence {
  const roleOf = (m: NormalizedContent) =>
    sourcesById.get(m.sourceId)?.role ?? "other";
  const authorityOf = (m: NormalizedContent) =>
    sourcesById.get(m.sourceId)?.authorityScore ?? 50;

  const byAuthority = [...members].sort((a, b) => authorityOf(b) - authorityOf(a));

  // Primary: official/academic source with an announcement-like
  // classification whose publisher is the originator (never a
  // secondary outlet merely publishing first).
  const primaryCandidates = members.filter((m) => {
    const role = roleOf(m);
    if (role !== "official" && role !== "academic") return false;
    const publisher = (m.sourceName ?? "").toLowerCase();
    if (SECONDARY_ONLY.some((s) => publisher.includes(s))) return false;
    const c = analyses.get(m.id)?.classification;
    return c ? PRIMARY_CLASSIFICATIONS.has(c) : true;
  });
  const primaryMember =
    primaryCandidates.sort((a, b) => authorityOf(b) - authorityOf(a))[0] ??
    (byAuthority[0] && (roleOf(byAuthority[0]!) === "official" || roleOf(byAuthority[0]!) === "academic")
      ? byAuthority[0]
      : undefined);

  const primarySource = primaryMember?.url;
  const supportingSources = [
    ...new Set(
      members
        .filter((m) => m.url !== primarySource && roleOf(m) !== "signal_creator")
        .map((m) => m.url),
    ),
  ];
  const socialSignals = [
    ...new Set(
      members
        .filter((m) => m.url !== primarySource && (roleOf(m) === "signal_creator" || m.sourceType === "social"))
        .map((m) => m.url),
    ),
  ];

  // Source independence (§9): identical titles across outlets = copy, not
  // independent confirmation. Only ORIGINAL + INDEPENDENT_REPORT count.
  // First occurrence of a title wins; later identical titles are REPOSTs.
  const seenTitles = new Set<string>();
  const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const relInputs = members.map((m) => ({
    url: m.url,
    title: m.normalizedTitle,
    text: m.normalizedText.slice(0, 2000),
    publisher: m.sourceName,
  }));
  const relationships = members.map((m) => {
    const rel = classifyRelationship(
      {
        url: m.url,
        title: m.normalizedTitle,
        text: m.normalizedText.slice(0, 2000),
        publisher: m.sourceName,
      },
      primarySource,
      relInputs,
    );
    if (rel === "REPOST" && m.normalizedTitle) {
      const key = normTitle(m.normalizedTitle);
      if (!seenTitles.has(key)) {
        seenTitles.add(key);
        // First occurrence is the original report, not a copy.
        return "INDEPENDENT_REPORT" as const;
      }
    } else if (m.normalizedTitle) {
      seenTitles.add(normTitle(m.normalizedTitle));
    }
    return rel;
  });
  const independentSources = countIndependentSources(relationships);
  // Preserve the raw distinct-source count for display.
  void new Set(members.map((m) => m.sourceId)).size;
  const contradictions = findContradictions(members);

  // Structured evidence list (§7) with per-source tiers + primary rationale.
  const evidenceSources: EvidenceSource[] = buildEvidenceSources(members, sourcesById).map(
    (e, i) => {
      const m = members[i]!;
      const tier = e.evidence_tier;
      const src = sourcesById.get(m.sourceId);
      const publisher = (m.sourceName ?? "").toLowerCase();
      const isSecondaryOutlet = SECONDARY_ONLY.some((s) => publisher.includes(s));
      const isPrimary =
        !!primaryMember &&
        m.url === primaryMember.url &&
        !isSecondaryOutlet &&
        (tier === "T0_PRIMARY");
      return {
        ...e,
        is_primary: isPrimary,
        primary_rationale: isPrimary
          ? `${m.sourceName} directly originates this evidence (${analyses.get(m.id)?.classification ?? "announcement"} from the originator).`
          : e.primary_rationale,
        source_relationship: relationships[i] ?? "INDEPENDENT_REPORT",
      };
    },
  );

  const hasPrimaryConfirmation = evidenceSources.some((e) => e.is_primary);
  const tiers = evidenceSources.map((e) => e.evidence_tier);
  const hasT1 = tiers.includes("T1_HIGH_SIGNAL");
  void resolveEvidenceTier;

  const canonical = determineVerificationStatus({
    hasPrimaryConfirmation,
    independentCount: independentSources,
    singleReliable: !hasPrimaryConfirmation && (hasT1 || independentSources === 1) && members.length >= 1,
    hasConflict: contradictions.length > 0,
    hasAnyReport: members.length > 0 && independentSources <= 1 && !hasT1
      ? true
      : members.length > 0,
  });

  // Map canonical → legacy for stored stories. CONFLICTED → conflict,
  // REPORTED (rumor-only) surfaces as legacy "signal" when social.
  let verificationStatus: VerificationStatus = canonicalToLegacy(canonical.status);
  if (canonical.status === "REPORTED" && socialSignals.length > 0) {
    verificationStatus = "signal";
  }
  // Preserve previous behavior for the multi-source-no-primary case:
  // MULTI_SOURCE_CONFIRMED with ≥3 independent → legacy "strong" (already),
  // ≥2 independent without primary → "strong".
  if (!hasPrimaryConfirmation && independentSources >= 2 && canonical.status === "MULTI_SOURCE_CONFIRMED") {
    verificationStatus = "strong";
  }
  if (contradictions.length > 0) {
    verificationStatus = canonical.status === "CONFLICTED" ? "conflict" : verificationStatus;
  }
  // Legacy compat: old tests expect "verified" only with primary + ≥3.
  if (hasPrimaryConfirmation && independentSources >= 3 && contradictions.length === 0) {
    verificationStatus = "verified";
  } else if (
    verificationStatus === "verified" &&
    !(hasPrimaryConfirmation && independentSources >= 3)
  ) {
    verificationStatus = "strong";
  }
  void srcUnused(srcOf(sourcesById));

  return {
    ...(primarySource ? { primarySource } : {}),
    supportingSources,
    socialSignals,
    independentSources,
    verificationStatus,
    contradictions,
    canonicalStatus: canonical.status as CanonicalVerification,
    verificationConfidence: canonical.confidence,
    evidenceSources,
  };
}

function srcOf(_m: Map<string, Source>): number {
  return _m.size;
}
function srcUnused(_n: number): void {
  void _n;
}

interface MoneyClaim {
  value: string;
  unit: string;
  sourceUrl: string;
}

function extractMoneyClaims(m: NormalizedContent): MoneyClaim[] {
  const text = `${m.normalizedTitle} ${m.normalizedText}`;
  const out: MoneyClaim[] = [];
  const re = /\$(\d+(?:\.\d+)?)\s?(T|B|M|K|trillion|billion|million|thousand)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push({
      value: `${match[1]}${match[2] ?? ""}`,
      unit: (match[2] ?? "$").toUpperCase(),
      sourceUrl: m.url,
    });
  }
  return out;
}

/**
 * Contradiction detection: same unit-type money figures with DIFFERENT
 * values across members of one story (e.g. "$500M" vs "$600M" raise).
 * Flags NEEDS-HUMAN-VERIFICATION instead of letting bad facts through.
 * Also flags directly conflicting factual statements via simple patterns.
 */
export function findContradictions(
  members: NormalizedContent[],
): Contradiction[] {
  if (members.length < 2) return [];
  const byUnit = new Map<string, MoneyClaim[]>();
  for (const m of members) {
    for (const c of extractMoneyClaims(m)) {
      const arr = byUnit.get(c.unit) ?? [];
      arr.push(c);
      byUnit.set(c.unit, arr);
    }
  }
  const out: Contradiction[] = [];
  for (const [unit, claims] of byUnit) {
    const values = [...new Set(claims.map((c) => c.value))];
    if (values.length >= 2) {
      out.push({
        claim: `Conflicting money figure (${unit} scale) across sources`,
        values,
        sources: [...new Set(claims.map((c) => c.sourceUrl))],
      });
    }
  }
  // Generic conflict patterns: approved vs rejected, raised vs denied, etc.
  const conflictPairs: [RegExp, RegExp, string][] = [
    [/\b(approved|confirmed|announced)\b/i, /\b(rejected|denied|cancelled|canceled)\b/i, "Approval vs rejection"],
    [/\braised\b/i, /\bdenied (the raise|funding)\b/i, "Funding raised vs denied"],
    [/\blaunch(ed|ing)?\b/i, /\bdelay(ed)?\b/i, "Launch vs delay"],
  ];
  for (const [a, b, label] of conflictPairs) {
    const withA = members.filter((m) => a.test(`${m.normalizedTitle} ${m.normalizedText}`));
    const withB = members.filter((m) => b.test(`${m.normalizedTitle} ${m.normalizedText}`));
    if (withA.length > 0 && withB.length > 0) {
      out.push({
        claim: `Conflicting reports: ${label}`,
        values: [withA[0]!.normalizedTitle, withB[0]!.normalizedTitle],
        sources: [...new Set([...withA, ...withB].map((m) => m.url))],
      });
    }
  }
  return out;
}

/**
 * Signal classes → output classes (priority bands applied downstream):
 * BREAKING (100) / IMPORTANT (80-95) / EMERGING (65-80) / BACKGROUND (<65).
 */
export function detectSignalClass(
  story: Story,
  evidence: StoryEvidence,
  ageHours: number,
): SignalClass {
  const sourceCount = evidence.independentSources;
  if (
    ageHours <= 6 &&
    evidence.primarySource &&
    sourceCount >= 2 &&
    story.scores.overall >= 75
  ) {
    return "breaking";
  }
  if (
    story.scores.overall >= 80 ||
    (evidence.verificationStatus === "verified" && story.scores.overall >= 70)
  ) {
    return "important";
  }
  if (ageHours <= 48 && story.scores.velocity >= 5) {
    return "emerging";
  }
  return "background";
}

export interface OverrideResult {
  story: Story;
  capped: boolean;
  floored: boolean;
}

/**
 * Hard overrides (§14 + legacy virality guard):
 * - breaking + verified → floor overall at 85 (early-warning radar duty).
 * - huge engagement + no primary + single source → cap at 45, never promoted.
 * - verification_confidence < 50 → cap at 59.
 * - STALE → cap at 40 (unless historical explicitly requested).
 * - T2/T3-only evidence → cap at 69.
 * - content_potential/relevance < 4 (legacy 0-10) are handled by the
 *   decision gate downstream (DO_NOT_POST), not by score capping here.
 */
export function applyOverrides(
  story: Story,
  evidence: StoryEvidence,
  members: { engagement?: { likes?: number; comments?: number; shares?: number; views?: number } }[],
  signal: SignalClass,
): OverrideResult {
  let overall = story.scores.overall;
  let capped = false;
  let floored = false;

  if (
    signal === "breaking" &&
    (evidence.verificationStatus === "verified" ||
      evidence.verificationStatus === "strong")
  ) {
    if (overall < 85) {
      overall = 85;
      floored = true;
    }
  }

  const engagement = aggregateEngagementScore(members);
  const viralNoEvidence =
    engagement >= 7 &&
    !evidence.primarySource &&
    evidence.independentSources <= 1;
  if (viralNoEvidence && overall > 45) {
    overall = 45;
    capped = true;
  }

  // Deterministic anti-inflation caps (§14).
  const conf = evidence.verificationConfidence ?? confidence01To100(story.confidence);
  if (conf < 50 && overall > 59) {
    overall = 59;
    capped = true;
  }
  const freshness = story.freshness;
  if (freshness === "STALE" && overall > 40) {
    overall = 40;
    capped = true;
  }
  const tiers = (evidence.evidenceSources ?? []).map((e) => e.evidence_tier);
  if (
    tiers.length > 0 &&
    tiers.every((t) => t === "T2_EXPERT_SIGNAL" || t === "T3_COMMUNITY_SIGNAL") &&
    overall > 69
  ) {
    overall = 69;
    capped = true;
  }

  if (!capped && !floored) return { story, capped, floored };
  return {
    story: {
      ...story,
      confidence:
        evidence.verificationStatus === "verified"
          ? Math.max(story.confidence, 0.85)
          : story.confidence,
      scores: { ...story.scores, overall: Math.round(overall * 10) / 10 },
      signal_scores: story.signal_scores
        ? { ...story.signal_scores, overall: Math.round(overall * 10) / 10 }
        : story.signal_scores,
    },
    capped,
    floored,
  };
}

function confidence01To100(c: number): number {
  return Math.round(c * 100);
}
