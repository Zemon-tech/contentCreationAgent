import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { collectRankSelect, prepareForHandoff } from "../lib/workflow/autoNewsToRas";
import { runHandoff } from "../lib/ras/handoff";
import { canonicalKeyForItem } from "../lib/safety/ledger-key";

/**
 * autoNewsToRasWorkflow (Step 9) — the orchestration that chains:
 *   ingest -> rank -> fact pack -> image -> approval gate (suspend/resume) ->
 *   RAS handoff -> record.
 *
 * Safety: DRY_RUN and REQUIRE_APPROVAL both default TRUE. The publish path runs
 * ONLY when dryRun === false AND approval was granted (see lib/ras/handoff.ts,
 * which also enforces pending-before-publish and never-double-post). "Nothing
 * worth posting this run" is a valid success, not an error.
 */

function envTrue(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}
const dryRunDefault = envTrue("INSTAGRAM_DRY_RUN", true);
const requireApprovalDefault = envTrue("REQUIRE_APPROVAL", true);

const InputSchema = z.object({
  dryRun: z.boolean().default(dryRunDefault),
  requireApproval: z.boolean().default(requireApprovalDefault),
});

const PreviewSchema = z.object({
  headline: z.string(),
  score: z.number(),
  region: z.string(),
  scoreReason: z.string(),
  sources: z.array(z.string()),
  suggestedFormat: z.string(),
  caption: z.string(),
  image: z.object({ localPath: z.string().nullable(), source: z.string().nullable(), attribution: z.string().nullable(), under1080: z.boolean(), chosenFrom: z.string() }),
  factPack: z.any(),
});

const OutputSchema = z.object({
  status: z.enum(["posted", "dry_run", "failed", "skipped", "no_story"]),
  reason: z.string().optional(),
  headline: z.string().optional(),
  score: z.number().optional(),
  ledgerKey: z.string().optional(),
  permalink: z.string().optional(),
  top5: z.array(z.object({ title: z.string(), score: z.number(), region: z.string() })).default([]),
});

const autoStep = createStep({
  id: "auto-news-to-ras",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  resumeSchema: z.object({ approved: z.boolean(), note: z.string().optional() }),
  suspendSchema: z.object({ preview: PreviewSchema, requestedAt: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const { dryRun, requireApproval } = inputData;

    const { rankResult, selected, feedCandidateUrls, selectedRaw } = await collectRankSelect({ persist: !dryRun });
    const top5 = rankResult.ranked.slice(0, 5).map((r) => ({ title: r.item.title.slice(0, 100), score: r.finalScore, region: r.item.region }));

    if (!selected) {
      return { status: "no_story" as const, reason: rankResult.note ?? "no story worthy this run", top5 };
    }

    const prepared = await prepareForHandoff({ item: selected.item, finalScore: selected.finalScore, raw: selectedRaw, feedCandidateUrls });

    // Safety: score threshold + rate caps.
    if (!prepared.scoreOk) return { status: "skipped" as const, reason: "below post score threshold", headline: selected.item.title, score: selected.finalScore, top5 };
    if (!prepared.caps.ok) return { status: "skipped" as const, reason: prepared.caps.reason, headline: selected.item.title, score: selected.finalScore, top5 };

    // Approval gate. DRY_RUN: never suspend, hand off as dry_run. Live: suspend
    // for approval unless REQUIRE_APPROVAL is off.
    let approved = false;
    if (!dryRun) {
      if (!requireApproval) {
        approved = true;
      } else if (resumeData) {
        approved = resumeData.approved;
      } else {
        return await suspend({
          preview: {
            headline: prepared.payload.headline,
            score: selected.finalScore,
            region: prepared.payload.region,
            scoreReason: selected.reason,
            sources: prepared.payload.sourceUrls,
            suggestedFormat: prepared.payload.suggestedFormat,
            caption: prepared.payload.caption,
            image: {
              localPath: prepared.image.imageLocalPath,
              source: prepared.image.imageSourceUrl,
              attribution: prepared.image.imageAttribution,
              under1080: prepared.image.under1080,
              chosenFrom: prepared.image.chosenFrom,
            },
            factPack: prepared.payload.factPack,
          },
          requestedAt: new Date().toISOString(),
        }) as never;
      }
    }

    const result = await runHandoff({
      ledgerKey: canonicalKeyForItem(selected.item),
      payload: prepared.payload,
      storyId: selected.item.id,
      dryRun,
      approved,
    });

    return {
      status: result.status,
      reason: result.reason,
      headline: selected.item.title,
      score: selected.finalScore,
      ledgerKey: result.ledgerKey,
      ...(result.permalink ? { permalink: result.permalink } : {}),
      top5,
    };
  },
});

export const autoNewsToRasWorkflow = createWorkflow({
  id: "auto-news-to-ras-workflow",
  description:
    "Auto news radar -> RAS: ingest, rank (rankStories), fact pack, image sourcing, approval gate (suspend/resume), RAS handoff, ledger record. DRY_RUN + REQUIRE_APPROVAL default true; publishes only when dryRun=false AND approved.",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .then(autoStep)
  .commit();
