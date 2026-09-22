import { z } from "zod";

export const SourceTypeSchema = z.enum([
  "rss",
  "blog",
  "news",
  "social",
  "newsletter",
  "launch",
  "github",
  "web",
  "podcast",
  "video",
  "paper",
  "community",
]);

export type SourceType = z.infer<typeof SourceTypeSchema>;

/**
 * Source role — who is speaking. SIGNAL_CREATOR (X/YouTube creators,
 * influencers) is signal, never primary evidence. OFFICIAL (first-party
 * company blogs, docs, GitHub) is preferred evidence.
 */
export const SourceRoleSchema = z.enum([
  "official",
  "news",
  "signal_creator",
  "community",
  "academic",
  "launch",
  "other",
]);

export type SourceRole = z.infer<typeof SourceRoleSchema>;

export const EvidenceTierSchema = z.enum([
  "T0_PRIMARY",
  "T1_HIGH_SIGNAL",
  "T2_EXPERT_SIGNAL",
  "T3_COMMUNITY_SIGNAL",
]);

export type EvidenceTier = z.infer<typeof EvidenceTierSchema>;

export const SourceRelationshipSchema = z.enum([
  "ORIGINAL",
  "INDEPENDENT_REPORT",
  "SYNDICATED",
  "REPOST",
  "COMMENTARY",
]);

export type SourceRelationship = z.infer<typeof SourceRelationshipSchema>;

export const SourceDefaultUseSchema = z.enum([
  "DISCOVERY",
  "VERIFICATION",
  "BOTH",
]);

export type SourceDefaultUse = z.infer<typeof SourceDefaultUseSchema>;

export const SourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: SourceTypeSchema,
  url: z.string().optional(),
  /** 0-100: editorial authority / trust in this source. */
  authorityScore: z.number().min(0).max(100),
  topics: z.array(z.string()).optional(),
  active: z.boolean().default(true),
  role: SourceRoleSchema.optional(),
  /** Polling tier: 1 = every run, 2 = hourly batch, 3 = daily deep sweep. */
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  note: z.string().optional(),
  /** Evidence hierarchy tier. Derived from role/type when absent. */
  evidenceTier: EvidenceTierSchema.optional(),
  /** 0-100: how often this source originates (vs copies) stories. */
  originalityScore: z.number().min(0).max(100).optional(),
  /** 0-100: how fast this source surfaces new developments. */
  speedScore: z.number().min(0).max(100).optional(),
  /** 0-100: how much this source contributes to verification. */
  verificationValue: z.number().min(0).max(100).optional(),
  /** Discovery (fast, weak verification) vs verification (slow, strong). */
  defaultUse: SourceDefaultUseSchema.optional(),
  /** Publisher / outlet name for attribution. */
  publisher: z.string().optional(),
});

export type Source = z.infer<typeof SourceSchema>;

export const SourceRegistrySchema = z.object({
  industry: z.string(),
  sources: z.array(SourceSchema),
});

export type SourceRegistry = z.infer<typeof SourceRegistrySchema>;
