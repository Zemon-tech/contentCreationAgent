import type {
  EvidenceSource,
  SignalCard,
  Story,
  Theme,
} from "../schemas/story";

/**
 * Signal cards (§26) + final response formatting (§27-30).
 * The aggregator ends at Signal + Evidence + Verification + Scoring +
 * Decision + Angle + Theme — never the final post.
 */

export function buildSignalCard(
  story: Story,
  opts: { rank?: number; themes?: Theme[] },
): SignalCard {
  const primary = (story.evidenceList ?? []).filter((e) => e.is_primary);
  const secondary = (story.evidenceList ?? []).filter(
    (e) => !e.is_primary && (e.evidence_tier === "T1_HIGH_SIGNAL" || e.evidence_tier === "T0_PRIMARY"),
  );
  const signals = (story.evidenceList ?? []).filter(
    (e) => e.evidence_tier === "T2_EXPERT_SIGNAL" || e.evidence_tier === "T3_COMMUNITY_SIGNAL",
  );

  const classification =
    story.freshness === "BREAKING"
      ? "BREAKING"
      : story.freshness === "DEVELOPING"
        ? "DEVELOPING"
        : story.freshness === "STALE"
          ? "BACKGROUND"
          : story.signalClass === "emerging"
            ? "EMERGING"
            : "BACKGROUND";

  const theme = (opts.themes ?? []).find((t) => story.theme_ids?.includes(t.theme_id));

  const card: SignalCard = {
    story_id: story.canonical_story_id ?? story.id,
    title: story.title,
    classification,
    freshness: {
      discovered_at: story.discovered_at ?? story.firstSeenAt,
      reason: story.freshness_reason ?? "No freshness justification recorded.",
    },
    what_happened: story.whatHappened,
    why_it_matters: story.whyItMatters,
    key_facts: [
      story.title,
      story.whatHappened.slice(0, 300),
      `Entities: ${story.entities.join(", ") || "—"}.`,
    ],
    evidence: { primary, secondary, signals },
    verification: {
      status: story.verification_status ?? "UNVERIFIED",
      confidence: story.verification_confidence ?? Math.round(story.confidence * 100),
      explanation:
        story.evidence?.contradictions?.length
          ? `Conflicting evidence: ${story.evidence.contradictions.map((c) => c.claim).join("; ")}`
          : `Status ${story.verification_status ?? story.evidence?.verificationStatus ?? "UNVERIFIED"} from ${story.independent_source_count ?? story.evidence?.independentSources ?? 0} independent source(s).`,
    },
    scores: story.signal_scores ?? {
      relevance: story.scores.relevance * 10,
      impact: story.scores.impact * 10,
      novelty: story.scores.novelty * 10,
      velocity: story.scores.velocity * 10,
      source_authority: story.scores.authority * 10,
      audience_interest: story.scores.audienceInterest * 10,
      content_potential: story.scores.contentPotential * 10,
      overall: story.scores.overall,
    },
    decision: story.decision ?? "MONITOR",
    theme: theme ? { theme_id: theme.theme_id, theme_name: theme.name } : undefined,
  };
  if (story.event_at) card.freshness.event_at = story.event_at;
  if (story.first_reported_at) card.freshness.first_reported_at = story.first_reported_at;
  if (story.latest_update_at) card.freshness.latest_update_at = story.latest_update_at;
  if (typeof opts.rank === "number") card.rank = opts.rank;
  if (story.rejection_reason) card.rejection_reason = story.rejection_reason;
  if (
    (story.decision === "POST_NOW" || story.decision === "WORTH_COVERING") &&
    story.possibleAngles.length > 0
  ) {
    card.content_opportunity = {
      angle: story.possibleAngles[0]!,
      thesis: story.whyItMatters,
      target_audience: "developers and technical founders",
      formats: ["LinkedIn post", "X thread", "Short video"],
      urgency: story.freshness === "BREAKING" ? "IMMEDIATE" : story.freshness === "DEVELOPING" ? "TODAY" : "THIS_WEEK",
    };
  }
  return card;
}

/** Split primary vs secondary vs signal evidence for display. */
export function splitEvidence(e: EvidenceSource[]): {
  primary: EvidenceSource[];
  secondary: EvidenceSource[];
  signals: EvidenceSource[];
} {
  return {
    primary: e.filter((x) => x.is_primary),
    secondary: e.filter(
      (x) => !x.is_primary && (x.evidence_tier === "T0_PRIMARY" || x.evidence_tier === "T1_HIGH_SIGNAL"),
    ),
    signals: e.filter(
      (x) => x.evidence_tier === "T2_EXPERT_SIGNAL" || x.evidence_tier === "T3_COMMUNITY_SIGNAL",
    ),
  };
}

export interface RunSummary {
  collectionWindowStart: string;
  collectionWindowEnd: string;
  sourcesChecked: number;
  rawItems: number;
  uniqueItems: number;
  uniqueStories: number;
  storiesRejected: number;
  storiesVerified: number;
  contentOpportunities: number;
  themesDetected: number;
}

/** Final markdown response (§27-30): run summary + top 3-5 + filtered + themes + sources. */
export function formatRunReport(args: {
  summary: RunSummary;
  cards: SignalCard[];
  themes: Theme[];
  toolsUsed: string[];
  blockedSources: string[];
}): string {
  const { summary, cards, themes, toolsUsed, blockedSources } = args;
  const top = cards
    .filter((c) => c.decision === "POST_NOW" || c.decision === "WORTH_COVERING")
    .slice(0, 5);
  const filtered = cards.filter(
    (c) => c.decision !== "POST_NOW" && c.decision !== "WORTH_COVERING",
  );

  const lines: string[] = [];
  lines.push("## RUN SUMMARY");
  lines.push(`Collection window: ${summary.collectionWindowStart} → ${summary.collectionWindowEnd}`);
  lines.push(`Sources checked: ${summary.sourcesChecked}`);
  lines.push(`Raw items: ${summary.rawItems}`);
  lines.push(`Unique items: ${summary.uniqueItems}`);
  lines.push(`Unique stories: ${summary.uniqueStories}`);
  lines.push(`Stories rejected: ${summary.storiesRejected}`);
  lines.push(`Stories verified: ${summary.storiesVerified}`);
  lines.push(`Content opportunities: ${summary.contentOpportunities}`);
  lines.push(`Themes detected: ${summary.themesDetected}`);
  lines.push("");
  lines.push("## TOP CONTENT OPPORTUNITIES");
  if (top.length === 0) {
    lines.push("No content opportunities met the bar — DO NOT POST.");
  }
  top.forEach((c, i) => {
    lines.push(`\n#${i + 1} ${c.title}`);
    lines.push(`Classification: ${c.classification}`);
    lines.push(`Decision: ${c.decision}`);
    lines.push(`What happened: ${c.what_happened}`);
    lines.push(`Why it matters: ${c.why_it_matters}`);
    lines.push(`Key facts:\n${c.key_facts.map((k) => `- ${k}`).join("\n")}`);
    lines.push(`Freshness: ${c.freshness.reason}`);
    lines.push(`Verification: ${c.verification.status} (Confidence: ${c.verification.confidence}%)`);
    lines.push(
      `Scores: Relevance ${c.scores.relevance}, Impact ${c.scores.impact}, Novelty ${c.scores.novelty}, ` +
        `Velocity ${c.scores.velocity}, Authority ${c.scores.source_authority}, ` +
        `Audience ${c.scores.audience_interest}, Content ${c.scores.content_potential}, Overall ${c.scores.overall}`,
    );
    if (c.content_opportunity) {
      lines.push(`Content angle: ${c.content_opportunity.angle}`);
      lines.push(`Suggested formats: ${c.content_opportunity.formats.join(", ")}`);
    }
  });
  lines.push("\n## FILTERED OUT");
  if (filtered.length === 0) {
    lines.push("None — every story met the bar.");
  } else {
    lines.push("Story | Decision | Reason");
    for (const c of filtered) {
      lines.push(`${c.title} | ${c.decision} | ${c.rejection_reason ?? "—"}`);
    }
  }
  lines.push("\n## EMERGING THEMES");
  if (themes.length === 0) {
    lines.push("No sufficiently supported emerging themes detected.");
  } else {
    for (const t of themes) {
      lines.push(`\n### ${t.name}`);
      lines.push(`Momentum: ${t.momentum}`);
      lines.push(`Stories: ${t.story_ids.join(", ")}`);
      lines.push(`Why this matters: ${t.thesis}`);
      lines.push(`Potential content angle: ${t.content_angles[0] ?? "—"}`);
    }
  }
  lines.push("\n## SOURCE USAGE");
  lines.push(`Tools used: ${toolsUsed.join(", ") || "—"}`);
  lines.push(`Sources blocked/unavailable: ${blockedSources.join(", ") || "—"}`);
  return lines.join("\n");
}
