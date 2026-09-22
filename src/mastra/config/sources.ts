import type { Source } from "../schemas/source";
import {
  AI_CODING_TOOLS,
  AI_ECOSYSTEM,
  DEV_INFRA,
  FRONTIER_AI,
  OSS_REPOS,
  RESEARCH_SOURCES,
} from "./sourceCatalog1";
import {
  AI_NEWSLETTERS,
  COMMUNITIES,
  DEV_NEWS,
  INDIA_SOURCES,
  MORE_SOURCES,
  SECURITY_SOURCES,
  SHOWS,
  STARTUP_SOURCES,
  TECH_NEWS,
  VC_SOURCES,
} from "./sourceCatalog2";
import { X_SOURCES } from "./xSources";

/**
 * Live source registry — built EXCLUSIVELY from the curated catalog.
 * Machine-collectable sources (rss/github/web/paper with URLs) are active;
 * social/newsletter/podcast/video stubs without endpoints are registered
 * but inactive until an official integration is wired.
 */
export const CATALOG_SOURCES: Source[] = [
  ...FRONTIER_AI,
  ...DEV_INFRA,
  ...AI_ECOSYSTEM,
  ...RESEARCH_SOURCES,
  ...AI_CODING_TOOLS,
  ...OSS_REPOS,
  ...VC_SOURCES,
  ...STARTUP_SOURCES,
  ...TECH_NEWS,
  ...AI_NEWSLETTERS,
  ...DEV_NEWS,
  ...SHOWS,
  ...COMMUNITIES,
  ...INDIA_SOURCES,
  ...SECURITY_SOURCES,
  ...MORE_SOURCES,
  ...X_SOURCES,
];

assertUniqueIds(CATALOG_SOURCES);

export function getSourceRegistry(): Source[] {
  return CATALOG_SOURCES.map((s) => ({ ...s }));
}

export function getActiveSources(sources?: Source[]): Source[] {
  return (sources ?? getSourceRegistry()).filter((s) => s.active);
}

/** Filter by polling tier (1 = every run, 2 = hourly, 3 = daily). */
export function getSourcesByTier(tier: 1 | 2 | 3, sources?: Source[]): Source[] {
  return getActiveSources(sources).filter((s) => (s.tier ?? 2) <= tier);
}

/** Machine-collectable right now (has a URL + supported collector type). */
export function getCollectableSources(sources?: Source[]): Source[] {
  const collectable: Source["type"][] = ["rss", "github", "web", "blog", "paper"];
  return getActiveSources(sources).filter(
    (s) => s.url && (collectable as string[]).includes(s.type),
  );
}

export function registryStats(sources?: Source[]): Record<string, number> {
  const all = sources ?? CATALOG_SOURCES;
  const count = (f: (s: Source) => boolean) => all.filter(f).length;
  return {
    total: all.length,
    active: count((s) => s.active),
    collectable: count(
      (s) =>
        s.active &&
        !!s.url &&
        ["rss", "github", "web", "blog", "paper"].includes(s.type),
    ),
    stubs: count((s) => !s.active),
    official: count((s) => s.role === "official"),
    news: count((s) => s.role === "news"),
    signalCreators: count((s) => s.role === "signal_creator"),
    community: count((s) => s.role === "community"),
    academic: count((s) => s.role === "academic"),
  };
}

function assertUniqueIds(sources: Source[]): void {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const s of sources) {
    if (seen.has(s.id)) dupes.push(s.id);
    seen.add(s.id);
  }
  if (dupes.length > 0) {
    throw new Error(`Duplicate source ids in catalog: ${dupes.join(", ")}`);
  }
}
