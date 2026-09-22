import { jaccardSimilarity } from "./embeddings";
import { makeId } from "./ids";
import type { Story, Theme } from "../schemas/story";

/**
 * Theme clustering (§18-19): EVENT → STORY → THEME.
 * Only creates a theme with enough evidence (≥2 stories with shared
 * topics/entities); never manufactures themes from unrelated stories.
 */

export interface ThemeClusterInput {
  stories: Story[];
  /** Minimum stories to form a theme. */
  minStories?: number;
  /** Minimum shared signal (topic/entity overlap) to link stories. */
  minOverlap?: number;
}

export function clusterIntoThemes(input: ThemeClusterInput): Theme[] {
  const { stories, minStories = 2 } = input;
  // Only verified, non-rejected stories can seed themes.
  const eligible = stories.filter(
    (s) => s.decision === "POST_NOW" || s.decision === "WORTH_COVERING" || s.decision === "MONITOR",
  );
  if (eligible.length < minStories) return [];

  // Union-find over stories by topic/entity overlap.
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
  for (const s of eligible) parent.set(s.id, s.id);

  for (let a = 0; a < eligible.length; a++) {
    for (let b = a + 1; b < eligible.length; b++) {
      const A = eligible[a]!;
      const B = eligible[b]!;
      if (storiesRelated(A, B)) union(A.id, B.id);
    }
  }

  const groups = new Map<string, Story[]>();
  for (const s of eligible) {
    const root = find(s.id);
    const arr = groups.get(root) ?? [];
    arr.push(s);
    groups.set(root, arr);
  }

  const themes: Theme[] = [];
  for (const members of groups.values()) {
    if (members.length < minStories) continue;
    themes.push(buildTheme(members));
  }
  return themes.sort((a, b) => b.momentum - a.momentum);
}

function storiesRelated(a: Story, b: Story): boolean {
  const sharedTopics = a.topics.filter((t) =>
    b.topics.map((x) => x.toLowerCase()).includes(t.toLowerCase()),
  );
  const sharedEntities = a.entities.filter((e) =>
    b.entities.map((x) => x.toLowerCase()).includes(e.toLowerCase()),
  );
  if (sharedTopics.length >= 1 && sharedEntities.length >= 1) return true;
  if (sharedTopics.length >= 2) return true;
  if (sharedEntities.length >= 2) return true;
  // Title-level narrative overlap as a fallback.
  const sim = jaccardSimilarity(a.title, b.title);
  if (sim >= 0.25 && (sharedTopics.length >= 1 || sharedEntities.length >= 1)) {
    return true;
  }
  return false;
}

function buildTheme(members: Story[]): Theme {
  const topicCounts = new Map<string, number>();
  const entityCounts = new Map<string, number>();
  for (const m of members) {
    for (const t of m.topics) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    for (const e of m.entities) entityCounts.set(e, (entityCounts.get(e) ?? 0) + 1);
  }
  const topTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const topEntities = [...entityCounts.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
  const label = topTopics[0] ?? topEntities[0] ?? "Emerging trend";
  const name = `${label} momentum`;

  const avg = (f: (s: Story) => number) =>
    members.reduce((sum, s) => sum + f(s), 0) / members.length;
  const momentum = Math.round(Math.min(100, avg((s) => s.scores.velocity * 10)));
  const novelty = Math.round(Math.min(100, avg((s) => s.scores.novelty * 10)));
  const importance = Math.round(Math.min(100, avg((s) => s.scores.impact * 10)));

  const angles = [...new Set(members.flatMap((m) => m.possibleAngles))].slice(0, 5);
  const thesis =
    `Multiple related developments point to a broader narrative around ${label}: ` +
    members
      .slice(0, 3)
      .map((m) => m.title)
      .join("; ") +
    ".";
  void topEntities;

  return {
    theme_id: makeId("theme"),
    name,
    thesis,
    story_ids: members.map((m) => m.id),
    momentum,
    novelty,
    importance,
    emerging: momentum >= 60 && novelty >= 50,
    content_angles:
      angles.length > 0 ? angles : ["What changed across these stories?", "Why now?"],
  };
}
