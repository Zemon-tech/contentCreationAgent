import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { collectRankSelect, pickPostableCandidate, pickPostableCandidates, type PostableCandidate } from "../lib/workflow/autoNewsToRas";
import { postingConfig } from "../config/posting.config";
import { runHandoff, renderRasPost } from "../lib/ras/handoff";
import { publishPreflight } from "../lib/ras/preflight";
import { canonicalKeyForItem } from "../lib/safety/ledger-key";
import { canPostNow } from "../lib/safety/posting-gate";

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
function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : parseInt(v.trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : dflt;
}
const dryRunDefault = envTrue("INSTAGRAM_DRY_RUN", true);
const requireApprovalDefault = envTrue("REQUIRE_APPROVAL", true);
// How many top-ranked stories to post as SEPARATE posts in one run (rank 1,2,3…).
// Defaults to 1 (unchanged single-post behavior). Capped at the daily cap.
const maxPostsDefault = envInt("MAX_POSTS_PER_RUN", 1);

const InputSchema = z.object({
  dryRun: z.boolean().default(dryRunDefault),
  requireApproval: z.boolean().default(requireApprovalDefault),
  /** Post the top N postable stories as separate posts in this run (>=1). */
  maxPosts: z.number().int().min(1).default(maxPostsDefault),
});

const PreviewSchema = z.object({
  headline: z.string(),
  score: z.number(),
  region: z.string(),
  scoreReason: z.string(),
  sources: z.array(z.string()),
  suggestedFormat: z.string(),
  caption: z.string(),
  xCaption: z.string(),
  image: z.object({ localPath: z.string().nullable(), source: z.string().nullable(), attribution: z.string().nullable(), under1080: z.boolean(), chosenFrom: z.string() }),
  factPack: z.any(),
  renderedPost: z.object({ filePath: z.string(), viewUrl: z.string() }),
});

const XOutcomeSchema = z
  .object({
    attempted: z.boolean(),
    success: z.boolean(),
    tweetUrl: z.string().optional(),
    dryRun: z.boolean().optional(),
    error: z.string().optional(),
  });

/** One post's outcome within a batch run. */
const PostResultSchema = z.object({
  status: z.enum(["posted", "dry_run", "failed", "skipped"]),
  reason: z.string().optional(),
  error: z.string().optional(),
  headline: z.string(),
  score: z.number(),
  ledgerKey: z.string().optional(),
  renderedPost: z.object({ filePath: z.string(), viewUrl: z.string() }).optional(),
  permalink: z.string().optional(),
  x: XOutcomeSchema.optional(),
});

const OutputSchema = z.object({
  // "batch" is the top-level status when maxPosts > 1 (per-post results live in `posts`).
  status: z.enum(["posted", "dry_run", "failed", "skipped", "no_story", "batch"]),
  reason: z.string().optional(),
  error: z.string().optional(),
  headline: z.string().optional(),
  score: z.number().optional(),
  ledgerKey: z.string().optional(),
  renderedPost: z.object({ filePath: z.string(), viewUrl: z.string() }).optional(),
  permalink: z.string().optional(),
  // X (Twitter) outcome — additional info; X never changes `status` (IG stays authoritative).
  x: XOutcomeSchema.optional(),
  /** Per-post results when maxPosts > 1 (the batch path). Omitted for single-post runs. */
  posts: z.array(PostResultSchema).optional(),
  top5: z.array(z.object({ title: z.string(), score: z.number(), region: z.string() })).default([]),
});

const autoStep = createStep({
  id: "auto-news-to-ras",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  resumeSchema: z.object({ approved: z.boolean(), note: z.string().optional() }),
  // `preview` is the single-post PreviewSchema for maxPosts=1, or a batch
  // preview ({ batch:true, count, posts:[...] }) when maxPosts>1 — hence union.
  suspendSchema: z.object({ preview: z.union([PreviewSchema, z.any()]), requestedAt: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const { dryRun, requireApproval, maxPosts } = inputData;

    const { rankResult, rawById } = await collectRankSelect({ persist: !dryRun });
    const top5 = rankResult.ranked.slice(0, 5).map((r) => ({ title: r.item.title.slice(0, 100), score: r.finalScore, region: r.item.region }));

    if (rankResult.selected.length === 0) {
      return { status: "no_story" as const, reason: rankResult.note ?? "no story worthy this run", top5 };
    }

    // BATCH PATH: post the top N stories as separate posts in this run. Only
    // taken when maxPosts > 1 — the single-post path below is unchanged. The
    // batch is treated as ONE unit against the DAILY cap and bypasses the
    // minGapHours between posts within the batch (they go out together). Each
    // post's IG/X outcome is independent; one failing never aborts the others.
    if (maxPosts > 1) {
      return await runBatch({ rankResult, rawById, top5, dryRun, requireApproval, maxPosts, resumeData, suspend });
    }

    // RAS's story template needs a hero image, so take the best-ranked story
    // that clears the threshold AND has a validated image (not just rank #1).
    const { candidate, tried, skippedNoImage } = await pickPostableCandidate({
      rankResult,
      rawById,
      minScore: postingConfig.minScore,
    });
    if (!candidate) {
      return {
        status: "skipped" as const,
        reason: `no postable story: ${tried} top-ranked stor${tried === 1 ? "y" : "ies"} had no usable image (${skippedNoImage.join(" | ") || "none tried"})`,
        top5,
      };
    }
    const selected = { item: candidate.item, finalScore: candidate.finalScore, reason: candidate.reason };
    const prepared = candidate.prepared;

    // Safety: score threshold + rate caps.
    if (!prepared.scoreOk) return { status: "skipped" as const, reason: "below post score threshold", headline: selected.item.title, score: selected.finalScore, top5 };
    if (!prepared.caps.ok) return { status: "skipped" as const, reason: prepared.caps.reason, headline: selected.item.title, score: selected.finalScore, top5 };

    // Create the post graphic BEFORE the approval gate (and in dry-run too) so
    // the approver sees the real created image. Rendering publishes nothing.
    let rendered: { viewUrls: string[]; filePath: string };
    try {
      rendered = await renderRasPost(prepared.payload);
    } catch (err) {
      return {
        status: "failed" as const,
        reason: "render failed (nothing was published)",
        error: err instanceof Error ? err.message : String(err),
        headline: selected.item.title,
        score: selected.finalScore,
        top5,
      };
    }
    const renderedPost = { filePath: rendered.filePath, viewUrl: rendered.viewUrls[0] ?? "" };

    // Live mode needs a token, a public URL and the env dry-run switched off.
    // Check BEFORE touching the ledger: a config gap must not burn the story.
    // The post is already rendered above, so you can still review it.
    if (!dryRun) {
      const pre = publishPreflight();
      if (!pre.ok) {
        return {
          status: "skipped" as const,
          reason: `post created but NOT published: live publishing is not configured (${pre.missing.join("; ")})`,
          headline: selected.item.title,
          score: selected.finalScore,
          renderedPost,
          top5,
        };
      }
    }

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
            xCaption: prepared.payload.xCaption
              ? `${prepared.payload.xCaption} (${prepared.payload.xCaption.length}/280)`
              : "(no X caption — X post will be skipped)",
            image: {
              localPath: prepared.image.imageLocalPath,
              source: prepared.image.imageSourceUrl,
              attribution: prepared.image.imageAttribution,
              under1080: prepared.image.under1080,
              chosenFrom: prepared.image.chosenFrom,
            },
            factPack: prepared.payload.factPack,
            renderedPost,
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
      // Reuse the already-created graphic instead of rendering twice.
      deps: { render: async () => rendered },
    });

    return {
      status: result.status,
      reason: result.reason,
      ...(result.error ? { error: result.error } : {}),
      headline: selected.item.title,
      score: selected.finalScore,
      ledgerKey: result.ledgerKey,
      renderedPost,
      ...(result.permalink ? { permalink: result.permalink } : {}),
      ...(result.x ? { x: result.x } : {}),
      top5,
    };
  },
});

type Rendered = { viewUrls: string[]; filePath: string };

/**
 * Batch path (maxPosts > 1): post the top N postable stories as SEPARATE posts
 * in one run. The whole batch is one unit against the DAILY cap (minGapHours
 * between posts within the batch is intentionally bypassed — they go out
 * together). Each post is rendered up front so the approver sees every created
 * image; the approval gate suspends ONCE with all previews and, on resume,
 * applies the single approve/reject decision to the whole batch. Each post's
 * handoff (and its IG/X outcome) is independent: one failure never aborts the
 * rest, and the never-double-post ledger still guards each story individually.
 */
async function runBatch(args: {
  rankResult: Awaited<ReturnType<typeof collectRankSelect>>["rankResult"];
  rawById: Awaited<ReturnType<typeof collectRankSelect>>["rawById"];
  top5: { title: string; score: number; region: string }[];
  dryRun: boolean;
  requireApproval: boolean;
  maxPosts: number;
  resumeData: { approved: boolean; note?: string } | undefined;
  // Loosely typed: the real type-safety is enforced at the createStep boundary
  // where this is passed in; here we only need to call it with the batch preview.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suspend: (...a: any[]) => any;
}): Promise<z.infer<typeof OutputSchema>> {
  const { rankResult, rawById, top5, dryRun, requireApproval, maxPosts, resumeData, suspend } = args;

  // How many posts may go out: min of requested, and the remaining DAILY budget.
  let allowed = maxPosts;
  if (!dryRun) {
    const caps = await canPostNow();
    if (!caps.ok && /daily cap/.test(caps.reason ?? "")) {
      return { status: "skipped", reason: caps.reason, posts: [], top5 };
    }
    const remaining = Math.max(0, postingConfig.maxPostsPerDay - caps.postsLast24h);
    if (remaining <= 0) {
      return { status: "skipped", reason: `daily cap reached (${caps.postsLast24h}/${postingConfig.maxPostsPerDay})`, posts: [], top5 };
    }
    allowed = Math.min(maxPosts, remaining);
  }

  const { candidates, tried, skippedNoImage } = await pickPostableCandidates({
    rankResult,
    rawById,
    minScore: postingConfig.minScore,
    count: allowed,
  });
  if (candidates.length === 0) {
    return {
      status: "skipped",
      reason: `no postable story: ${tried} top-ranked stor${tried === 1 ? "y" : "ies"} had no usable image (${skippedNoImage.join(" | ") || "none tried"})`,
      posts: [],
      top5,
    };
  }

  // Render every candidate up front (publishes nothing). A render failure drops
  // only that one candidate from the batch, not the whole run.
  const prepared: { cand: PostableCandidate; rendered: Rendered }[] = [];
  const posts: z.infer<typeof PostResultSchema>[] = [];
  for (const cand of candidates) {
    try {
      const rendered = await renderRasPost(cand.prepared.payload);
      prepared.push({ cand, rendered });
    } catch (err) {
      posts.push({
        status: "failed",
        reason: "render failed (nothing was published)",
        error: err instanceof Error ? err.message : String(err),
        headline: cand.item.title,
        score: cand.finalScore,
      });
    }
  }

  // Live preflight once for the batch (config gap must not burn the stories).
  if (!dryRun && prepared.length) {
    const pre = publishPreflight();
    if (!pre.ok) {
      for (const { cand, rendered } of prepared) {
        posts.push({
          status: "skipped",
          reason: `post created but NOT published: live publishing is not configured (${pre.missing.join("; ")})`,
          headline: cand.item.title,
          score: cand.finalScore,
          renderedPost: { filePath: rendered.filePath, viewUrl: rendered.viewUrls[0] ?? "" },
        });
      }
      return { status: "batch", reason: "live publishing not configured", posts, top5 };
    }
  }

  // Approval gate for the whole batch. DRY_RUN: never suspend. Live: suspend
  // once with ALL previews, approve/reject the batch together on resume.
  let approved = false;
  if (!dryRun) {
    if (!requireApproval) {
      approved = true;
    } else if (resumeData) {
      approved = resumeData.approved;
    } else {
      await suspend({
        preview: {
          batch: true,
          count: prepared.length,
          posts: prepared.map(({ cand, rendered }) => ({
            headline: cand.prepared.payload.headline,
            score: cand.finalScore,
            region: cand.prepared.payload.region,
            scoreReason: cand.reason,
            caption: cand.prepared.payload.caption,
            xCaption: cand.prepared.payload.xCaption
              ? `${cand.prepared.payload.xCaption} (${cand.prepared.payload.xCaption.length}/280)`
              : "(no X caption — X post will be skipped)",
            renderedPost: { filePath: rendered.filePath, viewUrl: rendered.viewUrls[0] ?? "" },
          })),
        },
        requestedAt: new Date().toISOString(),
      });
      return { status: "skipped", reason: "suspended for approval", posts, top5 } as never;
    }
  }

  // Run each handoff independently. One failure never aborts the others.
  for (const { cand, rendered } of prepared) {
    const renderedPost = { filePath: rendered.filePath, viewUrl: rendered.viewUrls[0] ?? "" };
    try {
      const result = await runHandoff({
        ledgerKey: canonicalKeyForItem(cand.item),
        payload: cand.prepared.payload,
        storyId: cand.item.id,
        dryRun,
        approved,
        deps: { render: async () => rendered },
      });
      posts.push({
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.error ? { error: result.error } : {}),
        headline: cand.item.title,
        score: cand.finalScore,
        ...(result.ledgerKey ? { ledgerKey: result.ledgerKey } : {}),
        renderedPost,
        ...(result.permalink ? { permalink: result.permalink } : {}),
        ...(result.x ? { x: result.x } : {}),
      });
    } catch (err) {
      posts.push({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        headline: cand.item.title,
        score: cand.finalScore,
        renderedPost,
      });
    }
  }

  const postedCount = posts.filter((p) => p.status === "posted").length;
  return {
    status: "batch",
    reason: `batch of ${posts.length}: ${postedCount} posted`,
    posts,
    top5,
  };
}

export const autoNewsToRasWorkflow = createWorkflow({
  id: "auto-news-to-ras-workflow",
  description:
    "Auto news radar -> RAS: ingest, rank (rankStories), fact pack, image sourcing, approval gate (suspend/resume), RAS handoff, ledger record. DRY_RUN + REQUIRE_APPROVAL default true; publishes only when dryRun=false AND approved.",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .then(autoStep)
  .commit();
