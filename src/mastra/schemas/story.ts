import { z } from "zod";

export const StoryScoresSchema = z.object({
  relevance: z.number().min(0).max(10),
  novelty: z.number().min(0).max(10),
  impact: z.number().min(0).max(10),
  /** Deterministic: recency + mention velocity + source count. 0-10. */
  velocity: z.number().min(0).max(10),
  /** Deterministic: mean source authority. 0-10. */
  authority: z.number().min(0).max(10),
  audienceInterest: z.number().min(0).max(10),
  contentPotential: z.number().min(0).max(10),
  /** Weighted overall signal. 0-100. */
  overall: z.number().min(0).max(100),
});

export type StoryScores = z.infer<typeof StoryScoresSchema>;

/**
 * Canonical 0-100 signal scores (spec §12). The legacy 0-10 StoryScores
 * stay as the stored form; signal scores are derived via ×10 mapping plus
 * source_authority from verification. Kept separate to avoid breaking
 * existing persisted stories.
 */
export const SignalScoresSchema = z.object({
  relevance: z.number().min(0).max(100),
  impact: z.number().min(0).max(100),
  novelty: z.number().min(0).max(100),
  velocity: z.number().min(0).max(100),
  source_authority: z.number().min(0).max(100),
  audience_interest: z.number().min(0).max(100),
  content_potential: z.number().min(0).max(100),
  overall: z.number().min(0).max(100),
});

export type SignalScores = z.infer<typeof SignalScoresSchema>;

export const StoryStatusSchema = z.enum([
  "emerging",
  "developing",
  "stable",
  "archived",
]);

export type StoryStatus = z.infer<typeof StoryStatusSchema>;

/** Canonical freshness (§5): based on event_at / latest_update_at, NEVER discovered_at. */
export const FreshnessSchema = z.enum([
  "BREAKING",
  "DEVELOPING",
  "BACKGROUND",
  "STALE",
]);

export type Freshness = z.infer<typeof FreshnessSchema>;

/** Legacy verification statuses (kept for backward compat). */
export const VerificationStatusSchema = z.enum([
  "verified",
  "strong",
  "signal",
  "unverified",
  "conflict",
  "PRIMARY_CONFIRMED",
  "MULTI_SOURCE_CONFIRMED",
  "SINGLE_RELIABLE_SOURCE",
  "REPORTED",
  "UNVERIFIED",
  "CONFLICTED",
]);

export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/** Canonical verification status (§8). */
export const CanonicalVerificationSchema = z.enum([
  "PRIMARY_CONFIRMED",
  "MULTI_SOURCE_CONFIRMED",
  "SINGLE_RELIABLE_SOURCE",
  "REPORTED",
  "UNVERIFIED",
  "CONFLICTED",
]);

export type CanonicalVerification = z.infer<typeof CanonicalVerificationSchema>;

export const ContentDecisionSchema = z.enum([
  "POST_NOW",
  "WORTH_COVERING",
  "MONITOR",
  "DO_NOT_POST",
]);

export type ContentDecision = z.infer<typeof ContentDecisionSchema>;

export const SourceRelationshipSchema = z.enum([
  "ORIGINAL",
  "INDEPENDENT_REPORT",
  "SYNDICATED",
  "REPOST",
  "COMMENTARY",
]);

export type SourceRelationship = z.infer<typeof SourceRelationshipSchema>;

export const EvidenceTierSchema = z.enum([
  "T0_PRIMARY",
  "T1_HIGH_SIGNAL",
  "T2_EXPERT_SIGNAL",
  "T3_COMMUNITY_SIGNAL",
]);

export type EvidenceTier = z.infer<typeof EvidenceTierSchema>;

export const ClaimEvidenceSchema = z.object({
  source_id: z.string(),
  tier: EvidenceTierSchema,
});

export type ClaimEvidence = z.infer<typeof ClaimEvidenceSchema>;

export const ClaimSchema = z.object({
  claim: z.string(),
  evidence: z.array(ClaimEvidenceSchema).default([]),
});

export type Claim = z.infer<typeof ClaimSchema>;

export const EvidenceSourceSchema = z.object({
  url: z.string(),
  publisher: z.string().optional(),
  title: z.string().optional(),
  published_at: z.string().optional(),
  evidence_tier: EvidenceTierSchema,
  source_type: z.string().optional(),
  /** True only when the source directly originates the evidence/event. */
  is_primary: z.boolean().default(false),
  /** Why this source counts (or does not count) as primary. */
  primary_rationale: z.string().optional(),
  source_relationship: SourceRelationshipSchema.optional(),
  supports_claims: z.array(z.string()).default([]),
});

export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const ContradictionSchema = z.object({
  claim: z.string(),
  values: z.array(z.string()),
  sources: z.array(z.string()),
});

export type Contradiction = z.infer<typeof ContradictionSchema>;

/** Verification evidence attached by the VERIFY stage (before scoring). */
export const StoryEvidenceSchema = z.object({
  primarySource: z.string().optional(),
  supportingSources: z.array(z.string()),
  socialSignals: z.array(z.string()),
  independentSources: z.number(),
  verificationStatus: VerificationStatusSchema,
  contradictions: z.array(ContradictionSchema),
  /** Canonical status (§8). Mirrors verificationStatus when legacy value used. */
  canonicalStatus: CanonicalVerificationSchema.optional(),
  /** 0-100 verification confidence. */
  verificationConfidence: z.number().min(0).max(100).optional(),
  /** Structured per-source evidence (§7). */
  evidenceSources: z.array(EvidenceSourceSchema).optional(),
});

export type StoryEvidence = z.infer<typeof StoryEvidenceSchema>;

export const SignalClassSchema = z.enum([
  "breaking",
  "important",
  "emerging",
  "background",
]);

export type SignalClass = z.infer<typeof SignalClassSchema>;

export const StorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  whatHappened: z.string(),
  whyItMatters: z.string(),
  topics: z.array(z.string()),
  entities: z.array(z.string()),
  /** Source URLs supporting this story — attribution is never dropped. */
  sources: z.array(z.string()),
  /** RawContent ids grouped into this story (duplicates included). */
  contentIds: z.array(z.string()),
  firstSeenAt: z.string(),
  lastUpdatedAt: z.string(),
  status: StoryStatusSchema,
  scores: StoryScoresSchema,
  confidence: z.number().min(0).max(1),
  possibleAngles: z.array(z.string()),
  /** Attached by VERIFY; absent only if verification was skipped. */
  evidence: StoryEvidenceSchema.optional(),
  /** breaking | important | emerging | background (VERIFY + score). */
  signalClass: SignalClassSchema.optional(),
  isTrending: z.boolean().optional(),
  // ---- Canonical intelligence fields (§11) ----
  /** Canonical story id shared by all items covering the same event. */
  canonical_story_id: z.string().optional(),
  category: z.array(z.string()).optional(),
  /** When the actual event happened (NOT discovery time). */
  event_at: z.string().optional(),
  first_reported_at: z.string().optional(),
  latest_update_at: z.string().optional(),
  discovered_at: z.string().optional(),
  freshness: FreshnessSchema.optional(),
  freshness_reason: z.string().optional(),
  claims: z.array(ClaimSchema).optional(),
  /** Structured evidence list (§7). */
  evidenceList: z.array(EvidenceSourceSchema).optional(),
  verification_status: CanonicalVerificationSchema.optional(),
  verification_confidence: z.number().min(0).max(100).optional(),
  source_count: z.number().optional(),
  independent_source_count: z.number().optional(),
  signal_scores: SignalScoresSchema.optional(),
  decision: ContentDecisionSchema.optional(),
  rejection_reason: z.string().optional(),
  theme_ids: z.array(z.string()).optional(),
});

export type Story = z.infer<typeof StorySchema>;

export const ThemeSchema = z.object({
  theme_id: z.string(),
  name: z.string(),
  thesis: z.string(),
  story_ids: z.array(z.string()),
  momentum: z.number().min(0).max(100),
  novelty: z.number().min(0).max(100),
  importance: z.number().min(0).max(100),
  emerging: z.boolean(),
  content_angles: z.array(z.string()),
});

export type Theme = z.infer<typeof ThemeSchema>;

export const ContentOpportunityPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "breaking",
]);

export type ContentOpportunityPriority = z.infer<
  typeof ContentOpportunityPrioritySchema
>;

export const ContentFormatSchema = z.enum([
  "x_post",
  "x_thread",
  "linkedin",
  "instagram",
  "short_video",
  "newsletter",
]);

export type ContentFormat = z.infer<typeof ContentFormatSchema>;

export const ContentOpportunitySchema = z.object({
  id: z.string().min(1),
  storyId: z.string().min(1),
  priority: ContentOpportunityPrioritySchema,
  reason: z.string(),
  recommendedFormats: z.array(ContentFormatSchema),
  recommendedAngles: z.array(z.string()),
  keyFacts: z.array(z.string()),
  sources: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  createdAt: z.string(),
  /** Story-brief fields for the downstream Content Strategy agent. */
  hook: z.string().optional(),
  whyPost: z.string().optional(),
  audience: z.string().optional(),
  /** Distinct content angle (not a repeat of the announcement). */
  angle: z.string().optional(),
  thesis: z.string().optional(),
  urgency: z.enum(["IMMEDIATE", "TODAY", "THIS_WEEK", "EVERGREEN"]).optional(),
  decision: ContentDecisionSchema.optional(),
});

export type ContentOpportunity = z.infer<typeof ContentOpportunitySchema>;

export const SignalCardSchema = z.object({
  story_id: z.string(),
  rank: z.number().optional(),
  title: z.string(),
  classification: z.enum(["BREAKING", "DEVELOPING", "EMERGING", "BACKGROUND"]),
  freshness: z.object({
    event_at: z.string().optional(),
    first_reported_at: z.string().optional(),
    latest_update_at: z.string().optional(),
    discovered_at: z.string(),
    reason: z.string(),
  }),
  what_happened: z.string(),
  why_it_matters: z.string(),
  key_facts: z.array(z.string()),
  evidence: z.object({
    primary: z.array(EvidenceSourceSchema),
    secondary: z.array(EvidenceSourceSchema),
    signals: z.array(EvidenceSourceSchema),
  }),
  verification: z.object({
    status: CanonicalVerificationSchema,
    confidence: z.number().min(0).max(100),
    explanation: z.string(),
  }),
  scores: SignalScoresSchema,
  decision: ContentDecisionSchema,
  rejection_reason: z.string().optional(),
  content_opportunity: z
    .object({
      angle: z.string(),
      thesis: z.string(),
      target_audience: z.string(),
      formats: z.array(z.string()),
      urgency: z.enum(["IMMEDIATE", "TODAY", "THIS_WEEK", "EVERGREEN"]),
    })
    .optional(),
  theme: z
    .object({ theme_id: z.string(), theme_name: z.string() })
    .optional(),
});

export type SignalCard = z.infer<typeof SignalCardSchema>;

export const RunMetadataSchema = z.object({
  run_id: z.string(),
  started_at: z.string(),
  completed_at: z.string().optional(),
  collection_window_start: z.string().optional(),
  collection_window_end: z.string().optional(),
  raw_item_count: z.number().optional(),
  normalized_item_count: z.number().optional(),
  filtered_item_count: z.number().optional(),
  duplicate_item_count: z.number().optional(),
  story_count: z.number().optional(),
  rejected_story_count: z.number().optional(),
  verified_story_count: z.number().optional(),
  theme_count: z.number().optional(),
  opportunity_count: z.number().optional(),
  tools_used: z.array(z.string()).optional(),
  sources_used: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
  blocked_sources: z.array(z.string()).optional(),
});

export type RunMetadata = z.infer<typeof RunMetadataSchema>;
