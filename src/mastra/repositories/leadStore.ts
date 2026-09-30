import path from "node:path";
import fs from "node:fs";
import { createClient, type Client, type InValue } from "@libsql/client";
import type { BatchRecord, CompanyRecord, ModuleRunRecord, SeedRow } from "../schemas/lead";

/**
 * Lead store: a SEPARATE LibSQL database (LEAD_DATABASE_URL) for the ICP
 * research pipeline. It is the source of truth for resumability — every Exa
 * run_id and every terminal output is written here the moment it exists, so a
 * crash / kill / Studio restart never loses paid research.
 *
 * Relative `file:` URLs resolve against the PROJECT ROOT (the first folder
 * with a package.json that is not inside `.mastra/`), so `mastra dev`
 * (bundled into .mastra/output) and tsx scripts hit the same file.
 */

export function resolveProjectRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  while (true) {
    const insideMastraBuild = dir.split(path.sep).includes(".mastra");
    if (!insideMastraBuild && fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** Resolve a user-supplied path (relative -> project root). */
export function resolveFromProjectRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(resolveProjectRoot(), p);
}

export function resolveDatabaseUrl(url: string): string {
  if (!url.startsWith("file:")) return url; // libsql://, http(s):// (Turso) etc.
  const raw = url.slice("file:".length);
  if (raw === ":memory:") return url;
  const abs = resolveFromProjectRoot(raw);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return `file:${abs.replace(/\\/g, "/")}`;
}

// ---------- client + schema ----------

let client: Client | null = null;
let clientUrl: string | null = null;
let schemaReady: Promise<void> | null = null;

export function getLeadDb(url: string, authToken?: string): Client {
  const resolved = resolveDatabaseUrl(url);
  if (!client || clientUrl !== resolved) {
    client?.close();
    client = createClient({ url: resolved, authToken: authToken || undefined });
    clientUrl = resolved;
    schemaReady = null;
  }
  return client;
}

/** Close + forget the client (tests, CLI shutdown). */
export function closeLeadDb(): void {
  client?.close();
  client = null;
  clientUrl = null;
  schemaReady = null;
}

export function currentLeadDbUrl(): string | null {
  return clientUrl;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS lead_batches (
     batch_id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lead_rows (
     batch_id TEXT NOT NULL, row_id TEXT NOT NULL, row_number INTEGER NOT NULL,
     status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (batch_id, row_id))`,
  `CREATE TABLE IF NOT EXISTS lead_module_runs (
     cache_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL, row_id TEXT NOT NULL,
     module_id TEXT NOT NULL, schema_version TEXT NOT NULL, input_hash TEXT NOT NULL,
     state TEXT NOT NULL, run_id TEXT, cost_usd REAL NOT NULL DEFAULT 0,
     data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_lead_module_runs_row ON lead_module_runs(row_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lead_module_runs_batch ON lead_module_runs(batch_id)`,
  `CREATE TABLE IF NOT EXISTS lead_companies (
     batch_id TEXT NOT NULL, row_id TEXT NOT NULL, research_status TEXT NOT NULL,
     icp_status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (batch_id, row_id))`,
  `CREATE INDEX IF NOT EXISTS idx_lead_companies_row ON lead_companies(row_id)`,
];

async function ensureSchema(db: Client): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of DDL) await db.execute(sql);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  await schemaReady;
}

/** Retry transient SQLite/LibSQL errors (busy/locked/network) a few times. */
async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50));
    }
  }
  throw lastErr;
}

// ---------- repository ----------

export interface LeadStore {
  db: Client;
  saveBatch(b: BatchRecord): Promise<void>;
  getBatch(batchId: string): Promise<BatchRecord | undefined>;
  upsertRow(batchId: string, row: SeedRow, status: string): Promise<void>;
  setRowStatus(batchId: string, rowId: string, status: string): Promise<void>;
  listRows(batchId: string): Promise<{ row: SeedRow; status: string }[]>;
  getModuleRun(cacheKey: string): Promise<ModuleRunRecord | undefined>;
  saveModuleRun(r: ModuleRunRecord): Promise<void>;
  listModuleRunsForRow(rowId: string): Promise<ModuleRunRecord[]>;
  sumBatchCost(batchId: string): Promise<number>;
  sumRowCostInBatch(batchId: string, rowId: string): Promise<number>;
  saveCompany(c: CompanyRecord): Promise<void>;
  getCompany(batchId: string, rowId: string): Promise<CompanyRecord | undefined>;
  listCompanies(batchId: string): Promise<CompanyRecord[]>;
  deleteRow(rowId: string): Promise<{ moduleRuns: number; companies: number; rows: number; runIds: string[] }>;
}

export function createLeadStore(url: string, authToken?: string): LeadStore {
  const db = getLeadDb(url, authToken);
  const exec = async (sql: string, args: InValue[] = []) =>
    withDbRetry(async () => {
      await ensureSchema(db);
      return db.execute({ sql, args });
    });
  const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;

  return {
    db,
    async saveBatch(b) {
      await exec(
        `INSERT INTO lead_batches (batch_id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(batch_id) DO UPDATE SET status=excluded.status, data=excluded.data, updated_at=excluded.updated_at`,
        [b.batch_id, b.status, JSON.stringify(b), b.created_at, b.updated_at],
      );
    },
    async getBatch(batchId) {
      const r = await exec(`SELECT data FROM lead_batches WHERE batch_id = ?`, [batchId]);
      return r.rows[0] ? parse<BatchRecord>(r.rows[0].data) : undefined;
    },
    async upsertRow(batchId, row, status) {
      await exec(
        `INSERT INTO lead_rows (batch_id, row_id, row_number, status, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(batch_id, row_id) DO UPDATE SET data=excluded.data, row_number=excluded.row_number, updated_at=excluded.updated_at`,
        [batchId, row.row_id, row.row_number, status, JSON.stringify(row), new Date().toISOString()],
      );
    },
    async setRowStatus(batchId, rowId, status) {
      await exec(`UPDATE lead_rows SET status = ?, updated_at = ? WHERE batch_id = ? AND row_id = ?`, [
        status,
        new Date().toISOString(),
        batchId,
        rowId,
      ]);
    },
    async listRows(batchId) {
      const r = await exec(`SELECT data, status FROM lead_rows WHERE batch_id = ? ORDER BY row_number`, [batchId]);
      return r.rows.map((x) => ({ row: parse<SeedRow>(x.data), status: String(x.status) }));
    },
    async getModuleRun(cacheKey) {
      const r = await exec(`SELECT data FROM lead_module_runs WHERE cache_key = ?`, [cacheKey]);
      return r.rows[0] ? parse<ModuleRunRecord>(r.rows[0].data) : undefined;
    },
    async saveModuleRun(rec) {
      await exec(
        `INSERT INTO lead_module_runs (cache_key, batch_id, row_id, module_id, schema_version, input_hash, state, run_id, cost_usd, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET batch_id=excluded.batch_id, state=excluded.state, run_id=excluded.run_id,
           cost_usd=excluded.cost_usd, data=excluded.data, updated_at=excluded.updated_at`,
        [
          rec.cache_key,
          rec.batch_id,
          rec.row_id,
          rec.module_id,
          rec.schema_version,
          rec.input_hash,
          rec.state,
          rec.run_id,
          rec.cost_usd,
          JSON.stringify(rec),
          rec.created_at,
          rec.updated_at,
        ],
      );
    },
    async listModuleRunsForRow(rowId) {
      const r = await exec(`SELECT data FROM lead_module_runs WHERE row_id = ? ORDER BY created_at`, [rowId]);
      return r.rows.map((x) => parse<ModuleRunRecord>(x.data));
    },
    async sumBatchCost(batchId) {
      const r = await exec(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM lead_module_runs WHERE batch_id = ?`, [batchId]);
      return Number(r.rows[0]?.c ?? 0);
    },
    async sumRowCostInBatch(batchId, rowId) {
      const r = await exec(
        `SELECT COALESCE(SUM(cost_usd), 0) AS c FROM lead_module_runs WHERE batch_id = ? AND row_id = ?`,
        [batchId, rowId],
      );
      return Number(r.rows[0]?.c ?? 0);
    },
    async saveCompany(c) {
      await exec(
        `INSERT INTO lead_companies (batch_id, row_id, research_status, icp_status, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(batch_id, row_id) DO UPDATE SET research_status=excluded.research_status, icp_status=excluded.icp_status,
           data=excluded.data, updated_at=excluded.updated_at`,
        [c.batch_id, c.row_id, c.research_status, c.icp_status, JSON.stringify(c), new Date().toISOString()],
      );
    },
    async getCompany(batchId, rowId) {
      const r = await exec(`SELECT data FROM lead_companies WHERE batch_id = ? AND row_id = ?`, [batchId, rowId]);
      return r.rows[0] ? parse<CompanyRecord>(r.rows[0].data) : undefined;
    },
    async listCompanies(batchId) {
      const r = await exec(`SELECT data FROM lead_companies WHERE batch_id = ?`, [batchId]);
      return r.rows.map((x) => parse<CompanyRecord>(x.data));
    },
    async deleteRow(rowId) {
      const runs = await exec(`SELECT run_id, data FROM lead_module_runs WHERE row_id = ?`, [rowId]);
      const runIds = new Set<string>();
      for (const x of runs.rows) {
        const rec = parse<ModuleRunRecord>(x.data);
        for (const a of rec.attempts) if (a.run_id) runIds.add(a.run_id);
        if (rec.run_id) runIds.add(rec.run_id);
      }
      const m = await exec(`DELETE FROM lead_module_runs WHERE row_id = ?`, [rowId]);
      const c = await exec(`DELETE FROM lead_companies WHERE row_id = ?`, [rowId]);
      const r = await exec(`DELETE FROM lead_rows WHERE row_id = ?`, [rowId]);
      return { moduleRuns: m.rowsAffected, companies: c.rowsAffected, rows: r.rowsAffected, runIds: [...runIds] };
    },
  };
}
