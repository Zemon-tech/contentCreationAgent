import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { aggregatorAgent } from "../agents/aggregatorAgent";
import { isLlmConfigured } from "../config/model";
import { sweepSources } from "../collectors/index";
import { getIndustryConfig, OPPORTUNITY_THRESHOLD_DEFAULT } from "../config/industry";
import { FRESHNESS_HOURS_DEFAULT, FilterDiscardSchema, RELEVANCE_THRESHOLD_DEFAULT, hardFilter, semanticFilter } from "../lib/relevance";
import { applyOverrides, detectSignalClass, verifyStory } from "../lib/verify";
import { classifyFreshness } from "../lib/freshness";
import { resolveEvidenceTier } from "../lib/evidence";
import { applyScoreCaps, decideContent, toSignalScores } from "../lib/decision";
import { clusterIntoThemes } from "../lib/themes";
import { buildSignalCard, formatRunReport } from "../lib/signalCards";
import { getActiveSources, getSourceRegistry } from "../config/sources";
import { MOCK_RAW_ITEMS, MOCK_SOURCES } from "../demo/mockData";
import { analyzeBatch } from "../lib/analysis";
import { clusterIntoStories } from "../lib/clustering";
import { dedupePipeline } from "../lib/deduplicate";
import { makeId, nowIso } from "../lib/ids";
import { normalizeBatch } from "../lib/normalize";
import { priorityForScore } from "../lib/scoring";
import {
  contentRepository,
  opportunityRepository,
  signalCardRepository,
  sourceRepository,
  storyRepository,
  themeRepository,
} from "../repositories/store";
import { AnalysisSchema } from "../schemas/analysis";
import { IndustryConfigSchema } from "../config/industry";
import { NormalizedContentSchema, RawContentSchema } from "../schemas/rawContent";
import { SourceSchema } from "../schemas/source";
import {
  ContentOpportunitySchema,
  RunMetadataSchema,
  SignalCardSchema,
  StorySchema,
  ThemeSchema,
  type ContentFormat,
  type ContentOpportunity,
  type Story,
} from "../schemas/story";

/**
 * industryAggregationWorkflow — the production pipeline:
 * 1. Load industry config + active sources
 * 2. Collect (parallel, per-source fault isolation)
 * 3. Normalize (raw preserved, cleaned fields added)
 * 4. Dedupe (URL -> content-hash -> semantic; dupes associated, not lost)
 * 5. Analyze + cluster into Stories
 * 6. Score (deterministic math) -> filter -> Content Opportunities -> persist
 *
 * Scheduling is external (Mastra schedules / cron hitting this workflow):
 * every 5/15 min, hourly, daily, or manual trigger from Studio.
 */

// ---------- Shared schemas ----------

const WorkflowInputSchema = z.object({
  industryName: z.string().optional().describe("Industry key, e.g. 'AI'"),
  demoMode: z
    .boolean()
    .default(true)
    .describe("Use bundled mock data (no network, no credentials)"),
  sourceIds: z
    .array(z.string())
    .optional()
    .describe("Restrict run to these source ids"),
  minScore: z.number().min(0).max(100).default(OPPORTUNITY_THRESHOLD_DEFAULT),
  similarityThreshold: z.number().min(0).max(1).default(0.9),
  maxItemsPerSource: z.number().int().min(1).max(50).default(20),
  concurrency: z.number().int().min(1).max(32).default(8),
  perSourceTimeoutMs: z.number().int().min(2000).max(60000).default(20000),
  /** Radar freshness cutoff: items older than this never reach the LLM. */
  maxAgeHours: z.number().int().min(1).max(720).default(FRESHNESS_HOURS_DEFAULT),
  /** Semantic relevance gate 0-1 (default 0.65). Below → archived. */
  relevanceThreshold: z.number().min(0).max(1).default(RELEVANCE_THRESHOLD_DEFAULT),
  /** Freshness classification window in hours (default 24 for "last 24h"). */
  windowHours: z.number().int().min(1).max(720).default(24).optional(),
  /** Max content opportunities in final output (3-5 per spec). */
  maxOpportunities: z.number().int().min(1).max(10).default(5).optional(),
});

const CollectionResultSchema = z.object({
  sourceId: z.string(),
  sourceName: z.string(),
  count: z.number(),
  error: z.string().optional(),
  skipped: z.string().optional(),
});

const DuplicateGroupSchema = z.object({
  representativeId: z.string(),
  memberIds: z.array(z.string()),
  reason: z.string(),
  detail: z.string(),
});

const DedupeStatsSchema = z.object({
  input: z.number(),
  urlDuplicates: z.number(),
  hashDuplicates: z.number(),
  semanticDuplicates: z.number(),
  unique: z.number(),
});

const ContextFields = {
  runId: z.string(),
  industryName: z.string(),
  demoMode: z.boolean(),
  minScore: z.number(),
  similarityThreshold: z.number(),
  maxItemsPerSource: z.number(),
  concurrency: z.number(),
  perSourceTimeoutMs: z.number(),
  maxAgeHours: z.number(),
  relevanceThreshold: z.number(),
  windowHours: z.number(),
  maxOpportunities: z.number(),
  startedAt: z.string(),
  /** Exact UTC collection window (§24): windowHours back from start. */
  collectionWindowStart: z.string(),
  collectionWindowEnd: z.string(),
  industry: IndustryConfigSchema,
  sources: z.array(SourceSchema),
};

const CollectFields = {
  ...ContextFields,
  rawItems: z.array(RawContentSchema),
  collectionResults: z.array(CollectionResultSchema),
};

const NormalizeFields = {
  ...CollectFields,
  normalizedItems: z.array(NormalizedContentSchema),
};

/** After the zero-LLM hard filter (freshness + keyword prefilter). */
const FilterFields = {
  ...NormalizeFields,
  filteredItems: z.array(NormalizedContentSchema),
  filterDiscards: z.array(FilterDiscardSchema),
};

const DedupeFields = {
  ...FilterFields,
  uniqueItems: z.array(NormalizedContentSchema),
  duplicateGroups: z.array(DuplicateGroupSchema),
  dedupeStats: DedupeStatsSchema,
};

/** After the embedding relevance gate. */
const SemanticFields = {
  ...DedupeFields,
  relevantItems: z.array(NormalizedContentSchema),
  relevanceDiscards: z.array(FilterDiscardSchema),
};

const ClusterFields = {
  ...SemanticFields,
  stories: z.array(StorySchema),
};

/** After VERIFY (evidence attached, pre-score classes pending). */
const VerifyFields = {
  ...ClusterFields,
  verifiedAt: z.string(),
};

const WorkflowOutputSchema = z.object({
  runId: z.string(),
  industryName: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  stories: z.array(StorySchema),
  opportunities: z.array(ContentOpportunitySchema),
  themes: z.array(ThemeSchema).default([]),
  signalCards: z.array(SignalCardSchema).default([]),
  filteredOut: z.array(z.object({
    storyId: z.string(),
    title: z.string(),
    decision: z.string(),
    reason: z.string(),
  })).default([]),
  runMetadata: RunMetadataSchema.optional(),
  report: z.string().optional(),
  stats: z.object({
    sourcesChecked: z.number(),
    sourcesSucceeded: z.number(),
    sourcesFailed: z.number(),
    collected: z.number(),
    normalized: z.number(),
    duplicatesAssociated: z.number(),
    uniqueItems: z.number(),
    stories: z.number(),
    opportunities: z.number(),
    avgStoryScore: z.number(),
    rejected: z.number().optional(),
    verified: z.number().optional(),
    themes: z.number().optional(),
  }),
  errors: z.array(
    z.object({ sourceId: z.string(), sourceName: z.string(), error: z.string() }),
  ),
});

function log(runId: string, step: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ runId, step, ...data }));
}

// ---------- Steps ----------

const loadContextStep = createStep({
  id: "load-context",
  inputSchema: WorkflowInputSchema,
  outputSchema: z.object(ContextFields),
  execute: async ({ inputData }) => {
    const runId = makeId("run");
    const industry = getIndustryConfig(inputData.industryName);
    const registry = inputData.demoMode ? MOCK_SOURCES : getSourceRegistry();
    let sources = getActiveSources(registry);
    if (inputData.sourceIds?.length) {
      const wanted = new Set(inputData.sourceIds);
      sources = sources.filter((s) => wanted.has(s.id));
    }
    const startedAt = nowIso();
    // Exact UTC window (§24): windowHours back from run start.
    const windowEnd = startedAt;
    const windowStart = new Date(
      Date.parse(startedAt) - (inputData.windowHours ?? 24) * 3_600_000,
    ).toISOString();
    log(runId, "load-context", {
      industry: industry.name,
      demoMode: inputData.demoMode,
      sources: sources.map((s) => s.id),
      collectionWindowStart: windowStart,
      collectionWindowEnd: windowEnd,
    });
    return {
      runId,
      industryName: industry.name,
      demoMode: inputData.demoMode,
      minScore: inputData.minScore,
      similarityThreshold: inputData.similarityThreshold,
      maxItemsPerSource: inputData.maxItemsPerSource,
      concurrency: inputData.concurrency,
      perSourceTimeoutMs: inputData.perSourceTimeoutMs,
      maxAgeHours: inputData.maxAgeHours,
      relevanceThreshold: inputData.relevanceThreshold,
      windowHours: inputData.windowHours ?? 24,
      maxOpportunities: inputData.maxOpportunities ?? 5,
      startedAt,
      collectionWindowStart: windowStart,
      collectionWindowEnd: windowEnd,
      industry,
      sources,
    };
  },
});

const collectStep = createStep({
  id: "collect",
  inputSchema: z.object(ContextFields),
  outputSchema: z.object(CollectFields),
  execute: async ({ inputData }) => {
    if (inputData.demoMode) {
      const wanted = new Set(inputData.sources.map((s) => s.id));
      const rawItems = MOCK_RAW_ITEMS.filter((i) => wanted.has(i.sourceId));
      log(inputData.runId, "collect", {
        mode: "demo",
        collected: rawItems.length,
      });
      return {
        ...inputData,
        rawItems,
        collectionResults: inputData.sources.map((s) => ({
          sourceId: s.id,
          sourceName: s.name,
          count: rawItems.filter((i) => i.sourceId === s.id).length,
        })),
      };
    }
    // Live: bounded parallel sweep. Slow/failed sources never gate the run.
    const sweepStarted = Date.now();
    const results = await sweepSources(inputData.sources, {
      maxItems: inputData.maxItemsPerSource,
      concurrency: inputData.concurrency,
      perSourceTimeoutMs: inputData.perSourceTimeoutMs,
    });
    const rawItems = results.flatMap((r) => r.items);
    const slowest = [...results]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5)
      .map((r) => `${r.sourceId}:${r.durationMs}ms`);
    log(inputData.runId, "collect", {
      mode: "live-sweep",
      sources: results.length,
      collected: rawItems.length,
      elapsedMs: Date.now() - sweepStarted,
      slowest,
    });
    return {
      ...inputData,
      rawItems,
      collectionResults: results.map((r) => ({
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        count: r.items.length,
        error: r.error,
        skipped: r.skipped,
      })),
    };
  },
});

const normalizeStep = createStep({
  id: "normalize",
  inputSchema: z.object(CollectFields),
  outputSchema: z.object(NormalizeFields),
  execute: async ({ inputData }) => {
    const normalizedItems = normalizeBatch(inputData.rawItems);
    log(inputData.runId, "normalize", {
      input: inputData.rawItems.length,
      normalized: normalizedItems.length,
    });
    return { ...inputData, normalizedItems };
  },
});

const hardFilterStep = createStep({
  id: "hard-filter",
  description: "Zero-LLM gate: drop stale and off-topic items before any embedding/LLM work.",
  inputSchema: z.object(NormalizeFields),
  outputSchema: z.object(FilterFields),
  execute: async ({ inputData }) => {
    const sourcesById = new Map(inputData.sources.map((s) => [s.id, s]));
    const { kept, discarded } = hardFilter(inputData.normalizedItems, {
      maxAgeHours: inputData.maxAgeHours,
      industry: inputData.industry,
      sourcesById,
    });
    for (const d of discarded) {
      log(inputData.runId, "hard-filter-discard", { id: d.id, reason: d.reason });
    }
    log(inputData.runId, "hard-filter", {
      input: inputData.normalizedItems.length,
      kept: kept.length,
      discarded: discarded.length,
    });
    return { ...inputData, filteredItems: kept, filterDiscards: discarded };
  },
});

const dedupeStep = createStep({
  id: "deduplicate",
  inputSchema: z.object(FilterFields),
  outputSchema: z.object(DedupeFields),
  execute: async ({ inputData }) => {
    const result = dedupePipeline(
      inputData.filteredItems,
      inputData.similarityThreshold,
    );
    for (const g of result.groups) {
      log(inputData.runId, "duplicate", {
        representative: g.representativeId,
        members: g.memberIds,
        reason: g.reason,
        detail: g.detail,
      });
    }
    log(inputData.runId, "deduplicate", result.stats);
    return {
      ...inputData,
      uniqueItems: result.unique,
      duplicateGroups: result.groups,
      dedupeStats: result.stats,
    };
  },
});

const semanticFilterStep = createStep({
  id: "semantic-filter",
  description: "Embedding relevance gate: only items scoring above threshold reach analysis.",
  inputSchema: z.object(DedupeFields),
  outputSchema: z.object(SemanticFields),
  execute: async ({ inputData }) => {
    const { kept, discarded } = semanticFilter(
      inputData.uniqueItems,
      inputData.industry,
      inputData.relevanceThreshold,
    );
    for (const d of discarded) {
      log(inputData.runId, "semantic-filter-discard", { id: d.id, reason: d.reason });
    }
    log(inputData.runId, "semantic-filter", {
      input: inputData.uniqueItems.length,
      kept: kept.length,
      discarded: discarded.length,
      threshold: inputData.relevanceThreshold,
    });
    return { ...inputData, relevantItems: kept, relevanceDiscards: discarded };
  },
});

const analyzeClusterStep = createStep({
  id: "analyze-and-cluster",
  inputSchema: z.object(SemanticFields),
  outputSchema: z.object(ClusterFields),
  execute: async ({ inputData }) => {
    const analyses = analyzeBatch(inputData.relevantItems, inputData.industry);
    const analysisById = new Map(analyses.map((a) => [a.contentId, a]));
    const sourcesById = new Map(inputData.sources.map((s) => [s.id, s]));

    let stories = clusterIntoStories({
      items: inputData.relevantItems,
      analyses: analysisById,
      sourcesById,
      duplicateGroups: inputData.duplicateGroups,
      industry: inputData.industry,
    });

    // LLM sees ONLY clustered stories (the 150 → 30 funnel tip), one call
    // per story passing the bar. Deterministic results stand on their own.
    stories = await maybeEnrichWithAgent(
      inputData.runId,
      stories,
      analysisById,
    );

    for (const s of stories) {
      log(inputData.runId, "story", {
        id: s.id,
        title: s.title,
        overall: s.scores.overall,
        sources: s.sources.length,
        contentIds: s.contentIds.length,
        scoreBreakdown: s.scores,
      });
    }
    return { ...inputData, stories };
  },
});

const verifyStep = createStep({
  id: "verify",
  description: "Attach primary/supporting/social evidence, detect contradictions, BEFORE scoring.",
  inputSchema: z.object(ClusterFields),
  outputSchema: z.object(VerifyFields),
  execute: async ({ inputData }) => {
    const sourcesById = new Map(inputData.sources.map((s) => [s.id, s]));
    // Full coverage (incl. duplicates) so every contentId has an analysis.
    const full = analyzeBatch(inputData.normalizedItems, inputData.industry);
    const analysesById = new Map(full.map((a) => [a.contentId, a]));
    const byId = new Map(inputData.normalizedItems.map((i) => [i.id, i]));

    const stories = inputData.stories.map((story) => {
      const members = story.contentIds.flatMap((id) => {
        const m = byId.get(id);
        return m ? [m] : [];
      });
      const evidence = verifyStory(story, members, analysesById, sourcesById);
      log(inputData.runId, "verify", {
        storyId: story.id,
        status: evidence.verificationStatus,
        primary: evidence.primarySource ?? "(none)",
        independent: evidence.independentSources,
        contradictions: evidence.contradictions.length,
      });
      return { ...story, evidence };
    });
    return { ...inputData, stories, verifiedAt: nowIso() };
  },
});

const opportunityStep = createStep({
  id: "score-filter-opportunities",
  inputSchema: z.object(VerifyFields),
  outputSchema: WorkflowOutputSchema,
  execute: async ({ inputData }) => {
    const { runId } = inputData;
    // Majority classification per story drives recommended formats.
    const analyses = analyzeBatch(inputData.relevantItems, inputData.industry);
    const classByContent = new Map(analyses.map((a) => [a.contentId, a]));
    const byId = new Map(inputData.normalizedItems.map((i) => [i.id, i]));
    const sourcesById = new Map(inputData.sources.map((s) => [s.id, s]));
    const now = Date.now();
    const nowDate = new Date(now);
    const windowHours = inputData.windowHours ?? 24;

    const candidates: { story: Story; signal: string }[] = [];
    const finalStories: Story[] = [];
    for (const raw of inputData.stories) {
      const evidence = raw.evidence ?? {
        supportingSources: [],
        socialSignals: [],
        independentSources: 0,
        verificationStatus: "unverified" as const,
        contradictions: [],
      };
      // Event-time age (firstSeenAt is now event time, not discovery).
      const ageHours = Math.max(
        0,
        (now - Date.parse(raw.event_at ?? raw.firstSeenAt)) / 3_600_000,
      );
      const signal = detectSignalClass(raw, evidence, ageHours);
      const members = raw.contentIds.flatMap((id) => {
        const m = byId.get(id);
        return m ? [m] : [];
      });
      const { story, capped, floored } = applyOverrides(raw, evidence, members, signal);

      // Freshness (§5): event_at / latest_update_at, NEVER discovered_at.
      const { freshness, reason } = classifyFreshness(
        {
          event_at: story.event_at ?? raw.event_at,
          first_reported_at: story.first_reported_at ?? raw.first_reported_at,
          latest_update_at: story.latest_update_at ?? raw.latest_update_at,
          discovered_at: story.discovered_at ?? raw.discovered_at ?? story.firstSeenAt,
        },
        nowDate,
        windowHours,
      );

      // Canonical signal scores (0-100) + hard caps (§12-14).
      const signalScores = toSignalScores({
        relevance: story.scores.relevance,
        novelty: story.scores.novelty,
        impact: story.scores.impact,
        velocity: story.scores.velocity,
        authority: story.scores.authority,
        audienceInterest: story.scores.audienceInterest,
        contentPotential: story.scores.contentPotential,
      });
      const tiers = (evidence.evidenceSources ?? []).map((e) => e.evidence_tier);
      const fallbackTiers = members.map((m) => {
        const src = sourcesById.get(m.sourceId);
        return src ? resolveEvidenceTier(src) : "T3_COMMUNITY_SIGNAL";
      });
      const effectiveTiers = tiers.length > 0 ? tiers : fallbackTiers;
      const verificationConfidence =
        evidence.verificationConfidence ?? Math.round(story.confidence * 100);
      const { overall: cappedOverall } = applyScoreCaps(signalScores.overall, {
        signalScores,
        verificationConfidence,
        freshness,
        tiers: effectiveTiers,
        isDuplicate: false,
        independentCount: evidence.independentSources,
      });

      // Decision gate (§15-16): every story gets a decision + rejection reason.
      const { decision, rejection_reason } = decideContent(cappedOverall, {
        signalScores: { ...signalScores, overall: cappedOverall },
        verificationConfidence,
        freshness,
        tiers: effectiveTiers,
        isDuplicate: false,
        independentCount: evidence.independentSources,
      });

      const canonicalStatus =
        evidence.canonicalStatus ??
        (evidence.verificationStatus === "verified"
          ? "PRIMARY_CONFIRMED"
          : evidence.verificationStatus === "strong"
            ? "MULTI_SOURCE_CONFIRMED"
            : evidence.verificationStatus === "conflict"
              ? "CONFLICTED"
              : evidence.verificationStatus === "signal"
                ? "REPORTED"
                : "UNVERIFIED");

      const withSignal: Story = {
        ...story,
        signalClass: signal,
        isTrending: story.scores.velocity >= 7 && evidence.independentSources >= 3,
        scores: { ...story.scores, overall: cappedOverall },
        freshness,
        freshness_reason: `${reason} Window: last ${windowHours}h (${inputData.collectionWindowStart} → ${inputData.collectionWindowEnd}).`,
        signal_scores: { ...signalScores, overall: cappedOverall },
        verification_status: canonicalStatus,
        verification_confidence: verificationConfidence,
        evidenceList: evidence.evidenceSources,
        source_count: new Set(members.map((m) => m.sourceId)).size,
        independent_source_count: evidence.independentSources,
        decision,
        ...(rejection_reason ? { rejection_reason } : {}),
      };
      if (!withSignal.canonical_story_id) {
        withSignal.canonical_story_id = withSignal.id;
      }
      finalStories.push(withSignal);
      candidates.push({ story: withSignal, signal });
      log(runId, "signal", {
        storyId: story.id,
        signal,
        freshness,
        overall: cappedOverall,
        decision,
        verification: evidence.verificationStatus,
        ...(capped ? { capped: "viral-no-evidence" } : {}),
        ...(floored ? { floored: "breaking-verified" } : {}),
        ...(rejection_reason ? { rejected: rejection_reason } : {}),
      });

      if (evidence.verificationStatus === "conflict") {
        log(runId, "conflict-hold", {
          storyId: story.id,
          contradictions: evidence.contradictions,
        });
      }
    }

    // Theme clustering (§19) over decided stories.
    const themes = clusterIntoThemes({ stories: finalStories });
    const themeByStory = new Map<string, string[]>();
    for (const t of themes) {
      for (const sid of t.story_ids) {
        const arr = themeByStory.get(sid) ?? [];
        arr.push(t.theme_id);
        themeByStory.set(sid, arr);
      }
    }
    for (const s of finalStories) {
      const ids = themeByStory.get(s.id);
      if (ids) s.theme_ids = ids;
    }

    // Rejection gate: threshold + decision. Top 3-5 only (§27).
    const eligible = finalStories.filter(
      (s) =>
        (s.decision === "POST_NOW" || s.decision === "WORTH_COVERING") &&
        s.scores.overall >= inputData.minScore,
    );
    eligible.sort((a, b) => b.scores.overall - a.scores.overall);
    const topStories = eligible.slice(0, inputData.maxOpportunities ?? 5);

    const opportunities: ContentOpportunity[] = [];
    for (const ws of topStories) {
      const opp = buildOpportunity(ws, classByContent, inputData.industry);
      opportunities.push(opp);
      log(runId, "opportunity", {
        id: opp.id,
        storyId: ws.id,
        priority: opp.priority,
        formats: opp.recommendedFormats,
        reason: opp.reason,
      });
    }
    for (const s of finalStories) {
      if (!topStories.some((t) => t.id === s.id)) {
        log(runId, "filtered", {
          storyId: s.id,
          overall: s.scores.overall,
          decision: s.decision,
          reason: s.rejection_reason ?? `below threshold ${inputData.minScore} or not top-${inputData.maxOpportunities ?? 5}`,
          threshold: inputData.minScore,
        });
      }
    }

    // Signal cards (§26) for every story (ranked).
    const ranked = [...finalStories].sort((a, b) => b.scores.overall - a.scores.overall);
    const signalCards = ranked.map((s, i) => buildSignalCard(s, { rank: i + 1, themes }));

    // Persist (repository abstraction — swappable for Postgres later).
    for (const s of inputData.sources) {
      await sourceRepository.save(s).catch((e) => log(runId, "persist-warn", { e: String(e) }));
    }
    for (const i of inputData.normalizedItems) {
      await contentRepository.save(i).catch(() => undefined);
    }
    for (const s of finalStories) {
      await storyRepository.save(s).catch(() => undefined);
    }
    for (const o of opportunities) {
      await opportunityRepository.save(o).catch(() => undefined);
    }
    for (const t of themes) {
      await themeRepository.save({ ...t, id: t.theme_id }).catch(() => undefined);
    }
    for (const c of signalCards) {
      await signalCardRepository.save({ ...c, id: c.story_id }).catch(() => undefined);
    }

    const avgStoryScore =
      finalStories.length === 0
        ? 0
        : Math.round(
            (finalStories.reduce((sum, s) => sum + s.scores.overall, 0) /
              finalStories.length) *
              10,
          ) / 10;

    const failed = inputData.collectionResults.filter((r) => r.error);
    const completedAt = nowIso();
    const rejected = finalStories.filter(
      (s) => s.decision === "DO_NOT_POST" || s.decision === "MONITOR",
    ).length;
    const verified = finalStories.filter(
      (s) =>
        s.verification_status === "PRIMARY_CONFIRMED" ||
        s.verification_status === "MULTI_SOURCE_CONFIRMED",
    ).length;
    const filteredOut = finalStories
      .filter((s) => !topStories.some((t) => t.id === s.id))
      .map((s) => ({
        storyId: s.id,
        title: s.title,
        decision: s.decision ?? "MONITOR",
        reason: s.rejection_reason ?? "Below threshold or outside top opportunities",
      }));
    const toolsUsed = [
      "sweepSources",
      "normalize",
      "hardFilter",
      "dedupe",
      "semanticFilter",
      "cluster",
      "verify",
      "score",
      "themeCluster",
      "signalCards",
    ];
    const blockedSources = failed.map((f) => f.sourceId);
    const report = formatRunReport(
      {
        summary: {
          collectionWindowStart: inputData.collectionWindowStart,
          collectionWindowEnd: inputData.collectionWindowEnd,
          sourcesChecked: inputData.collectionResults.length,
          rawItems: inputData.rawItems.length,
          uniqueItems: inputData.uniqueItems.length,
          uniqueStories: finalStories.length,
          storiesRejected: rejected,
          storiesVerified: verified,
          contentOpportunities: opportunities.length,
          themesDetected: themes.length,
        },
        cards: signalCards,
        themes,
        toolsUsed,
        blockedSources,
      },
    );
    return {
      runId,
      industryName: inputData.industryName,
      startedAt: inputData.startedAt,
      completedAt,
      stories: finalStories,
      opportunities,
      themes,
      signalCards,
      filteredOut,
      runMetadata: {
        run_id: runId,
        started_at: inputData.startedAt,
        completed_at: completedAt,
        collection_window_start: inputData.collectionWindowStart,
        collection_window_end: inputData.collectionWindowEnd,
        raw_item_count: inputData.rawItems.length,
        normalized_item_count: inputData.normalizedItems.length,
        filtered_item_count: inputData.relevantItems.length,
        duplicate_item_count:
          inputData.dedupeStats.urlDuplicates +
          inputData.dedupeStats.hashDuplicates +
          inputData.dedupeStats.semanticDuplicates,
        story_count: finalStories.length,
        rejected_story_count: rejected,
        verified_story_count: verified,
        theme_count: themes.length,
        opportunity_count: opportunities.length,
        tools_used: toolsUsed,
        sources_used: inputData.collectionResults.map((r) => r.sourceId),
        errors: failed.map((f) => `${f.sourceId}: ${f.error}`),
        blocked_sources: blockedSources,
      },
      report,
      stats: {
        sourcesChecked: inputData.collectionResults.length,
        sourcesSucceeded: inputData.collectionResults.filter((r) => !r.error).length,
        sourcesFailed: failed.length,
        collected: inputData.rawItems.length,
        normalized: inputData.normalizedItems.length,
        duplicatesAssociated:
          inputData.dedupeStats.urlDuplicates +
          inputData.dedupeStats.hashDuplicates +
          inputData.dedupeStats.semanticDuplicates,
        uniqueItems: inputData.uniqueItems.length,
        stories: finalStories.length,
        opportunities: opportunities.length,
        avgStoryScore,
        rejected,
        verified,
        themes: themes.length,
      },
      errors: failed.map((f) => ({
        sourceId: f.sourceId,
        sourceName: f.sourceName,
        error: f.error!,
      })),
    };
  },
});

// ---------- Helpers ----------

function majorityClassification(
  story: Story,
  classByContent: Map<string, { classification: string }>,
): string {
  const votes = new Map<string, number>();
  for (const id of story.contentIds) {
    const c = classByContent.get(id)?.classification ?? "other";
    votes.set(c, (votes.get(c) ?? 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
}

const FORMATS_BY_CLASSIFICATION: Record<string, ContentFormat[]> = {
  announcement: ["x_post", "x_thread", "linkedin"],
  product_launch: ["x_thread", "x_post", "linkedin"],
  research: ["x_thread", "newsletter", "linkedin"],
  funding: ["x_post", "linkedin", "newsletter"],
  acquisition: ["x_post", "linkedin", "newsletter"],
  technical_update: ["linkedin", "newsletter", "x_post"],
  industry_trend: ["linkedin", "newsletter", "x_thread"],
  tutorial: ["linkedin", "newsletter", "short_video"],
  opinion: ["x_thread", "short_video"],
  controversy: ["x_thread", "short_video"],
  company_update: ["linkedin", "x_post"],
  community_discussion: ["x_post", "x_thread"],
  other: ["x_post", "linkedin"],
};

function buildOpportunity(
  story: Story,
  classByContent: Map<string, { classification: string }>,
  industry: { audience?: string },
): ContentOpportunity {
  const classification = majorityClassification(story, classByContent);
  const priority = priorityForScore(story.scores.overall);
  const audience = industry.audience ?? "developers and technical founders";
  const angle0 = story.possibleAngles[0] ?? "Why it matters";
  // Distinct angle (§32): what changed / why now / second-order effect —
  // never a bare repeat of the announcement.
  const angle = angle0.startsWith("What changed") || angle0.startsWith("Why")
    ? `${angle0} — ${story.whyItMatters.slice(0, 160)}`
    : angle0;
  const urgency =
    story.freshness === "BREAKING"
      ? ("IMMEDIATE" as const)
      : story.freshness === "DEVELOPING"
        ? ("TODAY" as const)
        : ("THIS_WEEK" as const);
  return {
    id: makeId("opp"),
    storyId: story.id,
    priority,
    reason:
      `Overall signal ${story.scores.overall}/100 (threshold met): ` +
      `relevance ${story.scores.relevance}, novelty ${story.scores.novelty}, ` +
      `impact ${story.scores.impact}, velocity ${story.scores.velocity}, ` +
      `authority ${story.scores.authority}. Supported by ${story.sources.length} ` +
      `source(s), ${story.contentIds.length} content item(s); ` +
      `classification "${classification}", status "${story.status}", ` +
      `freshness "${story.freshness ?? "BACKGROUND"}", ` +
      `signal "${story.signalClass ?? "background"}", ` +
      `verification "${story.verification_status ?? story.evidence?.verificationStatus ?? "unverified"}" ` +
      `(confidence ${story.verification_confidence ?? Math.round(story.confidence * 100)}), ` +
      `decision "${story.decision ?? "WORTH_COVERING"}".`,
    recommendedFormats: FORMATS_BY_CLASSIFICATION[classification] ?? ["x_post", "linkedin"],
    recommendedAngles: story.possibleAngles.slice(0, 4),
    keyFacts: [
      story.title,
      story.whatHappened.slice(0, 300),
      `Event ${story.event_at ?? story.firstSeenAt}; update ${story.latest_update_at ?? story.lastUpdatedAt}; status ${story.status}.`,
      `Entities: ${story.entities.join(", ") || "—"}.`,
    ],
    sources: story.sources,
    confidence: story.confidence,
    createdAt: nowIso(),
    hook: `${story.title} — ${angle0}.`,
    whyPost: `Signal ${story.scores.overall}/100 from ${story.sources.length} source(s): ${story.whatHappened.slice(0, 200)}`,
    audience,
    angle,
    thesis: story.whyItMatters,
    urgency,
    decision: story.decision,
  };
}

/**
 * Best-effort story-level LLM enrichment. Skipped entirely without an
 * API key. Never invents facts: only refines interpretation fields, and
 * any failure falls back to deterministic values with a log line.
 */
async function maybeEnrichWithAgent(
  runId: string,
  stories: Story[],
  analysisById: Map<string, z.infer<typeof AnalysisSchema>>,
): Promise<Story[]> {
  if (!isLlmConfigured()) {
    log(runId, "agent-enrichment", {
      skipped: "no LOCAL_MODEL_* (or OPENAI_API_KEY) configured",
    });
    return stories;
  }
  const out: Story[] = [];
  for (const story of stories) {
    // Funnel tip only: the LLM interprets verified, high-signal stories.
    if (story.scores.relevance < 6 || story.scores.overall < 50) {
      out.push(story);
      continue;
    }
    try {
      const result = await aggregatorAgent.generate(
        `Refine ONLY the interpretation of this industry story. Do not invent facts, sources, or numbers. ` +
          `Return JSON with keys: whyItMatters (1-2 sentences), possibleAngles (3-5 strings).\n` +
          `Story: ${JSON.stringify({ title: story.title, summary: story.summary, topics: story.topics, entities: story.entities })}`,
      );
      const text = result.text ?? "";
      const parsed = tryParseJson(text);
      out.push({
        ...story,
        whyItMatters:
          typeof parsed?.whyItMatters === "string" && parsed.whyItMatters.length > 0
            ? parsed.whyItMatters
            : story.whyItMatters,
        possibleAngles:
          Array.isArray(parsed?.possibleAngles) && parsed.possibleAngles.length > 0
            ? parsed.possibleAngles.filter((x: unknown) => typeof x === "string").slice(0, 5)
            : story.possibleAngles,
      });
      log(runId, "agent-enrichment", { storyId: story.id, enriched: true });
    } catch (err) {
      log(runId, "agent-enrichment", {
        storyId: story.id,
        enriched: false,
        error: err instanceof Error ? err.message : String(err),
      });
      out.push(story);
    }
    void analysisById;
  }
  return out;
}

function tryParseJson(text: string): { whyItMatters?: unknown; possibleAngles?: unknown } | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as { whyItMatters?: unknown; possibleAngles?: unknown };
  } catch {
    return undefined;
  }
}

// ---------- Workflow ----------

export const industryAggregationWorkflow = createWorkflow({
  id: "industry-aggregation-workflow",
  description:
    "Industry intelligence engine: registry -> collect -> normalize -> hard filter -> dedupe -> semantic filter -> cluster -> verify -> score/decision -> themes -> signal cards -> persist. Event-time freshness, tiered evidence, DO_NOT_POST gate, top 3-5 opportunities.",
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowOutputSchema,
})
  .then(loadContextStep)
  .then(collectStep)
  .then(normalizeStep)
  .then(hardFilterStep)
  .then(dedupeStep)
  .then(semanticFilterStep)
  .then(analyzeClusterStep)
  .then(verifyStep)
  .then(opportunityStep)
  .commit();
