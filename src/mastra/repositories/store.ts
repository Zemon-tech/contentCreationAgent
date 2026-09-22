/**
 * Storage abstraction. Business logic depends ONLY on these repository
 * interfaces — today backed by in-memory stores, later swappable for
 * PostgreSQL + pgvector without touching the pipeline.
 */
export interface Repository<T extends { id: string }> {
  save(item: T): Promise<T>;
  get(id: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

export function createMemoryRepository<T extends { id: string }>(): Repository<T> {
  const store = new Map<string, T>();
  return {
    async save(item: T): Promise<T> {
      store.set(item.id, item);
      return item;
    },
    async get(id: string): Promise<T | undefined> {
      return store.get(id);
    },
    async list(): Promise<T[]> {
      return [...store.values()];
    },
    async count(): Promise<number> {
      return store.size;
    },
    async clear(): Promise<void> {
      store.clear();
    },
  };
}

import type { NormalizedContent, RawContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import type { ContentOpportunity, SignalCard, Story, Theme } from "../schemas/story";

export const sourceRepository: Repository<Source> = createMemoryRepository();
export const contentRepository: Repository<RawContent | NormalizedContent> =
  createMemoryRepository();
export const storyRepository: Repository<Story> = createMemoryRepository();
export const opportunityRepository: Repository<ContentOpportunity> =
  createMemoryRepository();
export const themeRepository: Repository<Theme & { id: string }> =
  createMemoryRepository();
export const signalCardRepository: Repository<SignalCard & { id: string }> =
  createMemoryRepository();

/** Clears all repositories — used by demo mode and tests. */
export async function resetAllRepositories(): Promise<void> {
  await Promise.all([
    sourceRepository.clear(),
    contentRepository.clear(),
    storyRepository.clear(),
    opportunityRepository.clear(),
    themeRepository.clear(),
    signalCardRepository.clear(),
  ]);
}
