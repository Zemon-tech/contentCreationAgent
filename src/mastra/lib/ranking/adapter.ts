import type { Story } from "../../schemas/story";
import { type RankInputItem, type Region } from "../../schemas/ranking";

/**
 * Adapter: live `Story` objects (clustered + verified upstream) -> the
 * `RankInputItem` shape `rankStories` consumes. The spec's item fields don't
 * map one-to-one onto Story, so this is the single place that bridges them.
 *
 * `region` depends on the Source.region tag (added by the ingestion stage,
 * not yet wired). Until a resolver is supplied, region defaults to GLOBAL,
 * which simply means no region-balance nudge — nothing breaks. Pass a
 * `resolveSource` to light up region + a clean source name once the registry
 * carries it.
 */

export interface SourceResolution {
  name: string;
  region: Region;
}

export type SourceResolver = (opts: { url: string; story: Story }) => SourceResolution;

/** Best-effort source name from a URL host when no resolver is given. */
function hostNameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export function storyToRankInput(story: Story, resolve?: SourceResolver): RankInputItem {
  const primaryUrl = story.evidence?.primarySource ?? story.sources[0] ?? "";
  const resolution = resolve
    ? resolve({ url: primaryUrl, story })
    : { name: hostNameOf(primaryUrl), region: "GLOBAL" as Region };

  const publishedAt =
    story.event_at ?? story.first_reported_at ?? story.latest_update_at ?? story.firstSeenAt;

  const rawCategories = [
    ...(story.category ?? []),
    ...story.topics,
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  return {
    id: story.id,
    clusterId: story.canonical_story_id ?? story.id,
    title: story.title,
    summary: story.summary || story.whatHappened || "",
    url: primaryUrl,
    source: resolution.name,
    region: resolution.region,
    publishedAt,
    clusterSourceCount: story.source_count ?? story.sources.length ?? 1,
    rawCategories,
  };
}

export function storiesToRankInput(stories: Story[], resolve?: SourceResolver): RankInputItem[] {
  return stories.map((s) => storyToRankInput(s, resolve));
}
