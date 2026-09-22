import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sweepSources } from "../collectors/index";
import { getSourceRegistry } from "../config/sources";
import { RawContentSchema } from "../schemas/rawContent";

/**
 * One tool call fans out across many sources IN PARALLEL (bounded
 * concurrency pool, per-source timeouts). This is the fast path for
 * broad collection — prefer it over N sequential fetchRSS calls.
 * Returns items inline; keep maxItems small to protect context.
 */
export const sweepSourcesTool = createTool({
  id: "sweepSources",
  description:
    "Collect from many catalog sources in parallel (bounded concurrency, per-source timeouts). Filter by tier (1 = every run, 2 = hourly, 3 = daily), role, or explicit source ids. Failed sources are reported, never fatal.",
  inputSchema: z.object({
    tier: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .describe("Only sources with tier <= this value"),
    roles: z
      .array(z.enum(["official", "news", "signal_creator", "community", "academic", "launch", "other"]))
      .optional()
      .describe("Only these source roles"),
    sourceIds: z.array(z.string()).optional().describe("Explicit source ids (overrides tier/roles)"),
    maxItems: z.number().int().min(1).max(10).default(5),
    concurrency: z.number().int().min(1).max(32).default(8),
    timeoutMs: z.number().int().min(2000).max(60000).default(20000),
  }),
  outputSchema: z.object({
    items: z.array(RawContentSchema),
    results: z.array(
      z.object({
        sourceId: z.string(),
        sourceName: z.string(),
        count: z.number(),
        durationMs: z.number(),
        error: z.string().optional(),
        skipped: z.string().optional(),
      }),
    ),
    stats: z.object({
      sourcesChecked: z.number(),
      sourcesSucceeded: z.number(),
      sourcesFailed: z.number(),
      totalItems: z.number(),
      elapsedMs: z.number(),
    }),
  }),
  execute: async ({ tier, roles, sourceIds, maxItems, concurrency, timeoutMs }) => {
    let sources = getSourceRegistry().filter((s) => s.active);
    if (sourceIds?.length) {
      const wanted = new Set(sourceIds);
      sources = sources.filter((s) => wanted.has(s.id));
    } else {
      if (tier) sources = sources.filter((s) => (s.tier ?? 2) <= tier);
      if (roles?.length) {
        const wanted = new Set(roles);
        sources = sources.filter((s) => s.role && wanted.has(s.role));
      }
    }
    // Only machine-collectable types; stubs explain themselves via error path.
    const started = Date.now();
    const swept = await sweepSources(sources, { maxItems, concurrency, perSourceTimeoutMs: timeoutMs });
    const items = swept.flatMap((r) => r.items);
    return {
      items,
      results: swept.map((r) => ({
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        count: r.items.length,
        durationMs: r.durationMs,
        error: r.error,
        skipped: r.skipped,
      })),
      stats: {
        sourcesChecked: swept.length,
        sourcesSucceeded: swept.filter((r) => !r.error).length,
        sourcesFailed: swept.filter((r) => r.error).length,
        totalItems: items.length,
        elapsedMs: Date.now() - started,
      },
    };
  },
});
