import {
  getScoringWeights,
  type IndustryConfig,
} from "../config/industry";
import type { Analysis } from "../schemas/analysis";
import type { NormalizedContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import type { Story, StoryStatus } from "../schemas/story";
import { jaccardSimilarity } from "./embeddings";
import { expandWithDuplicates, type DuplicateGroup } from "./deduplicate";
import { makeId, nowIso } from "./ids";
import {
  buildStoryScores,
  computeAuthority,
  computeVelocity,
} from "./scoring";

export interface ClusterInput {
  items: NormalizedContent[];
  analyses: Map<string, Analysis>;
  sourcesById: Map<string, Source>;
  duplicateGroups: DuplicateGroup[];
  industry: IndustryConfig;
  now?: Date;
}

/**
 * Story clustering: union-find over content items. Two items join when
 * they share topical evidence (thresholds calibrated on measured pairs —
 * same-event coverage scores textSim ~0.17-0.25, unrelated pairs <=0.12):
 *  - text Jaccard >= 0.35 (strong overlap, no other evidence needed), OR
 *  - title Jaccard >= 0.6 (same announcement, different wording), OR
 *  - text Jaccard >= 0.15 AND >= 2 shared entities, OR
 *  - text Jaccard >= 0.19 AND >= 1 shared entity, OR
 *  - text Jaccard >= 0.20 AND >= 1 shared topic (covers research coverage
 *    where outlets name different entities, e.g. lab vs model name).
 * Single shared entities/topics with low overlap do NOT merge (e.g. a GPU
 * vendor mention does not fuse a software release with a hardware launch).
 * Tune thresholds per industry as data grows; embedding cosine can be
 * added as an additional signal without changing this interface.
 * Attribution is preserved: every story keeps all member content ids +
 * source URLs, including duplicates.
 */
export function clusterIntoStories(input: ClusterInput): Story[] {
  const { items, analyses, sourcesById, duplicateGroups, industry } = input;
  const now = input.now ?? new Date();
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const i of items) parent.set(i.id, i.id);

  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const A = items[a]!;
      const B = items[b]!;
      const anaA = analyses.get(A.id);
      const anaB = analyses.get(B.id);
      if (!anaA || !anaB) continue;
      const sharedEntities = anaA.entities.filter((e) =>
        anaB.entities.map((x) => x.toLowerCase()).includes(e.toLowerCase()),
      );
      const sharedTopics = anaA.topics.filter((t) =>
        anaB.topics.map((x) => x.toLowerCase()).includes(t.toLowerCase()),
      );
      const titleSim = jaccardSimilarity(A.normalizedTitle, B.normalizedTitle);
      const textSim = jaccardSimilarity(
        `${A.normalizedTitle} ${A.normalizedText.slice(0, 2000)}`,
        `${B.normalizedTitle} ${B.normalizedText.slice(0, 2000)}`,
      );
      if (
        textSim >= 0.35 ||
        titleSim >= 0.6 ||
        (textSim >= 0.15 && sharedEntities.length >= 2) ||
        (textSim >= 0.19 && sharedEntities.length >= 1) ||
        (textSim >= 0.2 && sharedTopics.length >= 1)
      ) {
        union(A.id, B.id);
      }
    }
  }

  const clusters = new Map<string, NormalizedContent[]>();
  for (const item of items) {
    const root = find(item.id);
    const arr = clusters.get(root) ?? [];
    arr.push(item);
    clusters.set(root, arr);
  }

  const weights = getScoringWeights(industry);
  return [...clusters.values()].map((members) =>
    buildStory(members, analyses, sourcesById, duplicateGroups, industry, weights, now),
  );
}

function buildStory(
  members: NormalizedContent[],
  analyses: Map<string, Analysis>,
  sourcesById: Map<string, Source>,
  duplicateGroups: DuplicateGroup[],
  industry: IndustryConfig,
  weights: ReturnType<typeof getScoringWeights>,
  now: Date,
): Story {
  const memberAnalyses = members.map((m) => analyses.get(m.id)!);
  // Representative = highest (relevance + confidence), tie-break: earliest.
  const ranked = [...members].sort((a, b) => {
    const sa = analyses.get(a.id)!;
    const sb = analyses.get(b.id)!;
    return (
      sb.relevance + sb.confidence - (sa.relevance + sa.confidence) ||
      a.collectedAt.localeCompare(b.collectedAt)
    );
  });
  const rep = ranked[0]!;
  const repAnalysis = analyses.get(rep.id)!;

  // Include duplicates associated with any member (attribution preserved).
  const contentIds = [
    ...new Set(members.flatMap((m) => expandWithDuplicates(m.id, duplicateGroups))),
  ];
  const sources = [
    ...new Set(members.map((m) => m.url)),
  ];
  const topics = [...new Set(memberAnalyses.flatMap((a) => a.topics))];
  const entities = [...new Set(memberAnalyses.flatMap((a) => a.entities))];
  const angles = [...new Set(memberAnalyses.flatMap((a) => a.possibleAngles))].slice(0, 6);

  const avg = (f: (a: Analysis) => number) =>
    Math.round(
      (memberAnalyses.reduce((s, a) => s + f(a), 0) / memberAnalyses.length) * 10,
    ) / 10;

  const authorityScores = members.map(
    (m) => sourcesById.get(m.sourceId)?.authorityScore ?? 50,
  );
  // Event-time fix (§4): story timestamps derive from member EVENT /
  // REPORTED times, never from discovery (collectedAt) or now.
  const eventTimes = members
    .map((m) => m.eventAt ?? m.firstReportedAt ?? m.publishedAt)
    .filter((t): t is string => !!t)
    .sort();
  const updateTimes = members
    .map((m) => m.latestUpdateAt ?? m.firstReportedAt ?? m.publishedAt ?? m.collectedAt)
    .sort();
  const discoveredTimes = members.map((m) => m.discoveredAt ?? m.collectedAt).sort();
  const firstSeen = eventTimes[0] ?? members.map((m) => m.collectedAt).sort()[0]!;
  // lastUpdated = latest meaningful update across members (NOT now).
  const lastUpdated = updateTimes.at(-1)!;
  const eventAt = eventTimes[0];
  const firstReportedAt = eventTimes[0];
  const latestUpdateAt = updateTimes.at(-1);
  const discoveredAt = discoveredTimes.at(-1) ?? nowIso();

  const velocity = computeVelocity(
    firstSeen,
    lastUpdated,
    contentIds.length,
    new Set(members.map((m) => m.sourceId)).size,
    now,
  );
  const authority = computeAuthority(authorityScores);

  const scores = buildStoryScores(
    {
      relevance: avg((a) => a.relevance),
      novelty: avg((a) => a.novelty),
      impact: avg((a) => a.impact),
      audienceInterest: avg((a) => a.audienceInterest),
      contentPotential: avg((a) => a.contentPotential),
      velocity,
      authority,
    },
    weights,
  );

  const confidence =
    Math.round(
      (memberAnalyses.reduce((s, a) => s + a.confidence, 0) /
        memberAnalyses.length) *
        10,
    ) / 10;

  const status: StoryStatus =
    velocity >= 6 ? "emerging" : members.length >= 3 ? "developing" : "stable";

  const summary =
    members.length > 1
      ? `${repAnalysis.summary} (corroborated by ${members.length} pieces of content from ${new Set(members.map((m) => m.sourceName)).size} sources)`
      : repAnalysis.summary;

  return {
    id: makeId("story"),
    title: rep.normalizedTitle,
    summary,
    whatHappened: repAnalysis.summary,
    whyItMatters: repAnalysis.whyItMatters,
    topics,
    entities,
    sources,
    contentIds,
    firstSeenAt: firstSeen,
    lastUpdatedAt: lastUpdated,
    status,
    scores,
    confidence,
    possibleAngles: angles.length > 0 ? angles : ["What changed?", "Why it matters"],
    canonical_story_id: makeId("story"),
    category: [...topics],
    event_at: eventAt,
    first_reported_at: firstReportedAt,
    latest_update_at: latestUpdateAt,
    discovered_at: discoveredAt,
    claims: [
      {
        claim: repAnalysis.summary.slice(0, 300),
        evidence: [],
      },
    ],
    source_count: new Set(members.map((m) => m.sourceId)).size,
    independent_source_count: new Set(members.map((m) => m.sourceId)).size,
  };
}
