import { ExaError } from "exa-js";
import type { LeadStore } from "../../repositories/leadStore";
import { leadLog } from "./log";

/**
 * Process-wide concurrency, rate and budget control for Exa Agent runs
 * (PRD §6, §11). Everything here is shared across ALL companies in a batch.
 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, capped at 60s. */
export function backoffDelayMs(attempt: number, baseMs: number): number {
  const cap = Math.min(60_000, baseMs * 2 ** attempt);
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

// ---------- semaphore (active Exa runs) ----------

export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private max: number) {}

  setMax(max: number): void {
    this.max = Math.max(1, max);
    this.drain();
  }

  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.max && this.waiters.length) {
      this.active++;
      this.waiters.shift()!();
    }
  }
}

/** Spaces out run *starts* (POST /agent/runs counts double against QPS). */
export class RateGate {
  private next = 0;
  constructor(private perSecond: number) {}
  setRate(perSecond: number): void {
    this.perSecond = perSecond;
  }
  async wait(): Promise<void> {
    const interval = 1000 / this.perSecond;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + interval;
    if (at > now) await sleep(at - now);
  }
}

const exaSlots = new Semaphore(1);
const startGate = new RateGate(4);

export function getExaLimiter(maxConcurrent: number, startsPerSecond: number) {
  exaSlots.setMax(maxConcurrent);
  startGate.setRate(startsPerSecond);
  return { slots: exaSlots, gate: startGate };
}

// ---------- errors ----------

export type AbortReason =
  | "exa_no_credits" // 402 NO_MORE_CREDITS / budget exceeded
  | "exa_auth" // 401 / 403 FEATURE_DISABLED: every call would fail
  | "batch_budget" // MAX_COST_PER_BATCH_USD reached
  | "manual";

export class BatchAbortedError extends Error {
  constructor(public readonly reason: AbortReason, detail?: string) {
    super(`batch aborted: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "BatchAbortedError";
  }
}

export interface ClassifiedError {
  kind: "retry" | "abort" | "fail";
  abortReason?: AbortReason;
  statusCode: number | null;
  code: string | null;
  message: string;
}

/**
 * Branch on HTTP status first (Exa guidance), tags second.
 * exa-js throws ExaError{statusCode, code?}; flat `{error, tag}` bodies only
 * surface the tag inside the message, so we also pattern-match it there.
 */
export function classifyExaError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const statusCode =
    err instanceof ExaError
      ? err.statusCode
      : typeof (err as { statusCode?: unknown })?.statusCode === "number"
        ? ((err as { statusCode: number }).statusCode as number)
        : null;
  const code =
    (err instanceof ExaError ? err.code : undefined) ??
    ((err as { code?: unknown })?.code as string | undefined) ??
    message.match(/\b([A-Z][A-Z0-9_]{5,})\b/)?.[1] ??
    null;
  const base = { statusCode, code: typeof code === "string" ? code : null, message: message.slice(0, 500) };

  if (statusCode === null) {
    // Network / DNS / socket failures: the request may or may not have landed.
    return { kind: "retry", ...base };
  }
  if (statusCode === 402) return { kind: "abort", abortReason: "exa_no_credits", ...base };
  if (statusCode === 401) return { kind: "abort", abortReason: "exa_auth", ...base };
  if (statusCode === 403 && /FEATURE_DISABLED/.test(`${code} ${message}`))
    return { kind: "abort", abortReason: "exa_auth", ...base };
  if (statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504)
    return { kind: "retry", ...base };
  return { kind: "fail", ...base };
}

// ---------- batch + company budget control ----------

interface Reservation {
  id: number;
  batchId: string;
  rowId: string;
  amount: number;
}

interface BatchState {
  abortReason: AbortReason | null;
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  companies: Map<string, { spentUsd: number; reservedUsd: number; loaded: boolean }>;
  judgeDisabledReason: string | null;
}

const batches = new Map<string, BatchState>();
let reservationSeq = 0;

export const batchControl = {
  /** (Re)initialise from the store so resumed batches count earlier spend. */
  async init(batchId: string, store: LeadStore, capUsd: number): Promise<void> {
    const spent = await store.sumBatchCost(batchId);
    const prev = batches.get(batchId);
    batches.set(batchId, {
      abortReason: null,
      capUsd,
      spentUsd: spent,
      reservedUsd: prev?.reservedUsd ?? 0,
      companies: prev?.companies ?? new Map(),
      judgeDisabledReason: null,
    });
    for (const c of batches.get(batchId)!.companies.values()) c.loaded = false;
  },

  state(batchId: string): BatchState | undefined {
    return batches.get(batchId);
  },

  abortReason(batchId: string): AbortReason | null {
    return batches.get(batchId)?.abortReason ?? null;
  },

  abort(batchId: string, reason: AbortReason, detail?: string): void {
    const s = batches.get(batchId);
    if (s && !s.abortReason) {
      s.abortReason = reason;
      leadLog("batch-abort", { batchId, reason, detail });
    }
  },

  disableJudge(batchId: string, reason: string): void {
    const s = batches.get(batchId);
    if (s && !s.judgeDisabledReason) s.judgeDisabledReason = reason;
  },

  judgeDisabledReason(batchId: string): string | null {
    return batches.get(batchId)?.judgeDisabledReason ?? null;
  },

  /**
   * Reserve worst-case cost before creating a run. Returns null (and never
   * throws) when either cap would be exceeded; aborts the batch when the
   * BATCH cap is the one that bites.
   */
  async reserve(
    batchId: string,
    rowId: string,
    amount: number,
    companyCapUsd: number,
    store: LeadStore,
  ): Promise<{ ok: true; reservation: Reservation } | { ok: false; reason: string }> {
    const s = batches.get(batchId);
    if (!s) return { ok: false, reason: "batch not initialised" };
    if (s.abortReason) return { ok: false, reason: `batch aborted: ${s.abortReason}` };
    let c = s.companies.get(rowId);
    if (!c || !c.loaded) {
      const spent = await store.sumRowCostInBatch(batchId, rowId);
      c = { spentUsd: spent, reservedUsd: c?.reservedUsd ?? 0, loaded: true };
      s.companies.set(rowId, c);
    }
    if (c.spentUsd + c.reservedUsd + amount > companyCapUsd + 1e-9) {
      return {
        ok: false,
        reason: `company budget: spent $${c.spentUsd.toFixed(3)} + reserved $${c.reservedUsd.toFixed(3)} + needed $${amount.toFixed(3)} > cap $${companyCapUsd}`,
      };
    }
    if (s.spentUsd + s.reservedUsd + amount > s.capUsd + 1e-9) {
      this.abort(batchId, "batch_budget", `needed $${amount.toFixed(3)}`);
      return { ok: false, reason: "batch budget exhausted" };
    }
    c.reservedUsd += amount;
    s.reservedUsd += amount;
    return { ok: true, reservation: { id: ++reservationSeq, batchId, rowId, amount } };
  },

  /** Replace a reservation with the actual cost (0 when the run never started). */
  settle(reservation: Reservation, actualUsd: number): void {
    const s = batches.get(reservation.batchId);
    if (!s) return;
    const c = s.companies.get(reservation.rowId);
    s.reservedUsd = Math.max(0, s.reservedUsd - reservation.amount);
    s.spentUsd += actualUsd;
    if (c) {
      c.reservedUsd = Math.max(0, c.reservedUsd - reservation.amount);
      c.spentUsd += actualUsd;
    }
  },

  /** Remaining company budget (cap - spent - reserved), for contact planning. */
  async companyRemainingUsd(batchId: string, rowId: string, companyCapUsd: number, store: LeadStore): Promise<number> {
    const s = batches.get(batchId);
    if (!s) return 0;
    let c = s.companies.get(rowId);
    if (!c || !c.loaded) {
      const spent = await store.sumRowCostInBatch(batchId, rowId);
      c = { spentUsd: spent, reservedUsd: c?.reservedUsd ?? 0, loaded: true };
      s.companies.set(rowId, c);
    }
    const batchRemaining = s.capUsd - s.spentUsd - s.reservedUsd;
    return Math.max(0, Math.min(companyCapUsd - c.spentUsd - c.reservedUsd, batchRemaining));
  },
};

export type { Reservation };
