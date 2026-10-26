import { z } from "zod";
import { FactPackSchema } from "./factpack";
import { RegionSchema } from "./ranking";
import { ACCENT_COLORS } from "../templates/theme";

/**
 * Typed payload handed to RAS (Step 6). Built deterministically from the ranked
 * story + fact pack + sourced image. Carries both the editorial "brief" and the
 * render-ready copy, because we call RAS's render/publish TOOLS directly (we do
 * not drive RAS the agent). `factPackLimited` items must not get invented
 * details — copy stays within the fact pack.
 */
export const RasPayloadSchema = z.object({
  // Brief
  headline: z.string(),
  factPack: FactPackSchema,
  sourceUrls: z.array(z.string()),
  primaryUrl: z.string(),
  region: RegionSchema,
  suggestedFormat: z.enum(["single", "carousel"]).default("single"),
  suggestedCaptionAngle: z.string(),

  // Image (local path; RAS composites it into its rendered PNG — never needs
  // to be publicly hosted). null => text-only.
  imageLocalPath: z.string().nullable(),
  imageSourceUrl: z.string().nullable(),
  imageAttribution: z.string().nullable(),
  rightsStatus: z.literal("unverified"),
  imageUnder1080: z.boolean().default(false),

  // Render-ready copy for RAS's story template
  serifHeadline: z.string(),
  categoryTag: z.string(),
  deckLead: z.string(),
  deckHighlight: z.string(),
  deckTail: z.string(),
  accentColor: z.enum(ACCENT_COLORS),
  caption: z.string(),
  hashtags: z.array(z.string()),

  factPackLimited: z.boolean(),

  // ---- X-signal / quality extensions (all optional or defaulted so existing
  // RSS payloads validate unchanged). N/A for RSS items -> empty/default. ----
  /** Model-derived factual headline (esp. for raw X posts). */
  derivedHeadline: z.string().optional(),
  /** Scroll-stopping hook strength (0-10). */
  hookPotential: z.number().min(0).max(10).optional(),
  /** The authoritative claim set with per-claim provenance. */
  facts: z
    .array(
      z.object({
        claim: z.string(),
        sourceUrl: z.string(),
        sourceType: z.enum(["rss", "x", "primary"]),
      }),
    )
    .default([]),
  /** True when the item/source is verified (official, primary, or corroborated). */
  verified: z.boolean().default(false),
  /** Risk of the central claim if unverified. */
  claimRisk: z.enum(["low", "medium", "high"]).default("low"),
  /** Non-X outbound URLs cited by the post (normalized). */
  outboundUrls: z.array(z.string()).default([]),
  /** The quoted post, if any (carried for attribution). */
  quoted: z
    .object({
      text: z.string(),
      author_handle: z.string().nullable(),
      url: z.string(),
      at: z.string(),
    })
    .nullable()
    .default(null),
  /** 'per @handle on X' when X-only (no corroborating RSS); null otherwise. */
  attributionLine: z.string().nullable().default(null),
});

export type RasPayload = z.infer<typeof RasPayloadSchema>;

export const HandoffResultSchema = z.object({
  status: z.enum(["posted", "dry_run", "failed", "skipped"]),
  ledgerKey: z.string(),
  permalink: z.string().optional(),
  mediaId: z.string().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
});
export type HandoffResult = z.infer<typeof HandoffResultSchema>;
