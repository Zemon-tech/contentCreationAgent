import { z } from "zod";

/**
 * Fact pack (Step 4): a short, VERIFIED brief handed downstream. Everything in
 * it is extracted from already-collected material — never invented. When the
 * material is thin (paywalled / headline-only), `factPackLimited` is true so
 * the downstream copywriter knows not to fill gaps.
 */
export const FactConflictSchema = z.object({
  claim: z.string(),
  values: z.array(z.string()),
  sources: z.array(z.string()),
});

export const FactPackSchema = z.object({
  headline: z.string(),
  /** 3–5 grounded facts drawn from the story text. */
  keyFacts: z.array(z.string()),
  /** Figures/numbers found in the text (money, %, million/crore, …). */
  figures: z.array(z.string()),
  /** Named entities (people, companies, products). */
  names: z.array(z.string()),
  /** Citable source URLs (signal-only sources excluded). */
  sourceUrls: z.array(z.string()),
  primarySource: z.string().optional(),
  /** Cross-source contradictions, surfaced not resolved. */
  conflicts: z.array(FactConflictSchema),
  /** True when material is thin (paywalled/fallback) — do not invent. */
  factPackLimited: z.boolean(),
});

export type FactPack = z.infer<typeof FactPackSchema>;
