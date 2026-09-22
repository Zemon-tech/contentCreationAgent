import type { NormalizedContent } from "../schemas/rawContent";
import { findSimilarContent } from "./embeddings";

export interface DuplicateGroup {
  representativeId: string;
  memberIds: string[];
  /** "url" | "content-hash" | "semantic" */
  reason: string;
  detail: string;
}

export interface DedupeResult {
  /** Items surviving all three levels. */
  unique: NormalizedContent[];
  /** Groups of duplicates (kept for story association, not deleted). */
  groups: DuplicateGroup[];
  stats: {
    input: number;
    urlDuplicates: number;
    hashDuplicates: number;
    semanticDuplicates: number;
    unique: number;
  };
}

/**
 * Three-level dedup. Duplicates are ASSOCIATED (returned in groups for
 * story clustering), never silently dropped by the caller pipeline —
 * the pipeline keeps every member id on its story for attribution.
 */
export function dedupePipeline(
  items: NormalizedContent[],
  semanticThreshold = 0.9,
): DedupeResult {
  // Level 1 — exact URL.
  const seenUrl = new Map<string, NormalizedContent>();
  const afterUrl: NormalizedContent[] = [];
  const groups: DuplicateGroup[] = [];
  let urlDuplicates = 0;
  for (const item of items) {
    const key = item.normalizedUrl;
    const existing = seenUrl.get(key);
    if (existing) {
      urlDuplicates++;
      pushGroup(groups, existing.id, item.id, "url", `same URL: ${key}`);
    } else {
      seenUrl.set(key, item);
      afterUrl.push(item);
    }
  }

  // Level 2 — content hash.
  const seenHash = new Map<string, NormalizedContent>();
  const afterHash: NormalizedContent[] = [];
  let hashDuplicates = 0;
  for (const item of afterUrl) {
    const existing = seenHash.get(item.contentHash);
    if (existing) {
      hashDuplicates++;
      pushGroup(
        groups,
        existing.id,
        item.id,
        "content-hash",
        `identical normalized content (sha256 ${item.contentHash.slice(0, 12)}…)`,
      );
    } else {
      seenHash.set(item.contentHash, item);
      afterHash.push(item);
    }
  }

  // Level 3 — semantic (embedding cosine). High default threshold: only
  // near-duplicates (e.g. same article via different URLs) merge here.
  // Cross-outlet coverage of one event is handled by story clustering.
  const pairs = findSimilarContent(afterHash, semanticThreshold);
  const merged = new Set<string>();
  let semanticDuplicates = 0;
  for (const p of pairs) {
    if (merged.has(p.idA) || merged.has(p.idB)) continue;
    merged.add(p.idB);
    semanticDuplicates++;
    pushGroup(
      groups,
      p.idA,
      p.idB,
      "semantic",
      `embedding cosine ${p.similarity.toFixed(3)} >= ${semanticThreshold}`,
    );
  }
  const unique = afterHash.filter((i) => !merged.has(i.id));

  return {
    unique,
    groups,
    stats: {
      input: items.length,
      urlDuplicates,
      hashDuplicates,
      semanticDuplicates,
      unique: unique.length,
    },
  };
}

function pushGroup(
  groups: DuplicateGroup[],
  representativeId: string,
  memberId: string,
  reason: string,
  detail: string,
): void {
  const g = groups.find((x) => x.representativeId === representativeId);
  if (g) {
    if (!g.memberIds.includes(memberId)) g.memberIds.push(memberId);
  } else {
    groups.push({ representativeId, memberIds: [memberId], reason, detail });
  }
}

/** Expand a surviving item id to all ids associated with it (incl. dupes). */
export function expandWithDuplicates(
  id: string,
  groups: DuplicateGroup[],
): string[] {
  const out = new Set([id]);
  for (const g of groups) {
    if (g.representativeId === id || g.memberIds.includes(id)) {
      out.add(g.representativeId);
      for (const m of g.memberIds) out.add(m);
    }
  }
  return [...out];
}
