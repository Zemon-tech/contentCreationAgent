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
