import path from "node:path";
import fs from "node:fs";
import { createClient, type Client } from "@libsql/client";
import type { NormalizedContent, RawContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import type { ContentOpportunity, SignalCard, Story, Theme } from "../schemas/story";

/**
 * Storage abstraction. Business logic depends ONLY on these repository
 * interfaces — backed by SQLite / LibSQL (persisted to file:./mastra.db
 * or remote Turso via TURSO_DATABASE_URL).
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

function getDatabaseConfig(): { url: string; authToken?: string } {
  if (process.env.TURSO_DATABASE_URL) {
    return {
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    };
  }

  // Find project root so we always hit the consistent mastra.db file
  let dir = process.cwd();
  while (dir && !fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const dbPath = path.join(dir || process.cwd(), "mastra.db").replace(/\\/g, "/");
  return {
    url: `file:${dbPath}`,
  };
}

let _client: Client | null = null;

export function getLibSqlClient(): Client {
  if (!_client) {
    const config = getDatabaseConfig();
    _client = createClient({
      url: config.url,
      authToken: config.authToken,
    });
  }
  return _client;
}

const tableInitPromises = new Map<string, Promise<void>>();

function ensureTable(tableName: string): Promise<void> {
  let promise = tableInitPromises.get(tableName);
  if (!promise) {
    promise = (async () => {
      const client = getLibSqlClient();
      await client.execute(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      await client.execute(`
        CREATE INDEX IF NOT EXISTS idx_${tableName}_created_at ON ${tableName}(created_at)
      `);
    })();
    tableInitPromises.set(tableName, promise);
  }
  return promise;
}

export function createLibSqlRepository<T extends { id: string }>(tableName: string): Repository<T> {
  return {
    async save(item: T): Promise<T> {
      await ensureTable(tableName);
      const client = getLibSqlClient();
      const rawItem = item as Record<string, unknown>;
      const createdAt =
        (typeof rawItem.createdAt === "string" && rawItem.createdAt) ||
        (typeof rawItem.collectedAt === "string" && rawItem.collectedAt) ||
        (typeof rawItem.firstSeenAt === "string" && rawItem.firstSeenAt) ||
        new Date().toISOString();

      await client.execute({
        sql: `INSERT OR REPLACE INTO ${tableName} (id, data, created_at) VALUES (?, ?, ?)`,
        args: [item.id, JSON.stringify(item), createdAt],
      });
      return item;
    },

    async get(id: string): Promise<T | undefined> {
      await ensureTable(tableName);
      const client = getLibSqlClient();
      const res = await client.execute({
        sql: `SELECT data FROM ${tableName} WHERE id = ?`,
        args: [id],
      });
      if (!res.rows.length || !res.rows[0]?.data) {
        return undefined;
      }
      return JSON.parse(res.rows[0].data as string) as T;
    },

    async list(): Promise<T[]> {
      await ensureTable(tableName);
      const client = getLibSqlClient();
      const res = await client.execute(`SELECT data FROM ${tableName} ORDER BY created_at DESC`);
      return res.rows.map((row) => JSON.parse(row.data as string) as T);
    },

    async count(): Promise<number> {
      await ensureTable(tableName);
      const client = getLibSqlClient();
      const res = await client.execute(`SELECT COUNT(*) as count FROM ${tableName}`);
      return Number(res.rows[0]?.count ?? 0);
    },

    async clear(): Promise<void> {
      await ensureTable(tableName);
      const client = getLibSqlClient();
      await client.execute(`DELETE FROM ${tableName}`);
    },
  };
}

// Persistent repositories backed by SQLite (mastra.db / Turso)
export const sourceRepository: Repository<Source> = createLibSqlRepository<Source>("sources");
export const contentRepository: Repository<RawContent | NormalizedContent> =
  createLibSqlRepository<RawContent | NormalizedContent>("content_items");
export const storyRepository: Repository<Story> = createLibSqlRepository<Story>("stories");
export const opportunityRepository: Repository<ContentOpportunity> =
  createLibSqlRepository<ContentOpportunity>("content_opportunities");
export const themeRepository: Repository<Theme & { id: string }> =
  createLibSqlRepository<Theme & { id: string }>("themes");
export const signalCardRepository: Repository<SignalCard & { id: string }> =
  createLibSqlRepository<SignalCard & { id: string }>("signal_cards");

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
