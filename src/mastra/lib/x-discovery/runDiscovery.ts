/**
 * runDiscovery — the X discovery orchestrator (Part B). Runs on its OWN
 * schedule (the runXDiscovery cron), fully separate from the 30-60min news
 * workflow. It searches X for topic-driven queries, learns which accounts are
 * high-signal, visits promoted/pinned profiles within budget, and SAVES the
 * collected posts to storage. The main workflow only ever reads those saved
 * posts; it never calls this.
 *
 * Design invariants enforced here:
 * - FAIL-SOFT everywhere: any throw is caught and turned into an aborted-but-
 *   clean report. Discovery never raises into the caller.
 * - STOP CONDITIONS: a block (login wall / captcha / unusual activity / 429) or
 *   repeated empties ABORTS the X branch immediately, sets an escalating
 *   cooldown, and returns. We NEVER retry in the same session and NEVER try to
 *   solve a block.
 * - BUDGET + PACING: a persisted daily budget (search loads / profile visits)
 *   and randomized per-action / per-query delays, one tab at a time, never
 *   parallel. Every number comes from config.
 * - CODE DECIDES NUMBERS: isOfficialAccount / medians / status are computed in
 *   learning.ts and stamped onto each saved post at SAVE time (FIX #2/#3).
 */

import type { RawContent } from "../../schemas/rawContent";
import type { XDiscoveryConfig } from "../../config/xDiscovery";
import { getXDiscoveryConfig } from "../../config/xDiscovery";
import type {
  ScrapedXPost,
  XScrapeResult,
  XSearchResult,
} from "../x-publisher";
import { postToRaw } from "../collect-x-posts";
import { isOfficialAccount } from "./learning";
import type { QueryGenerate } from "./queryGen";
import { generateQueries as defaultGenerateQueries } from "./queryGen";
import type { DiscoveredAccount, DiscoveredAccountsGateway } from "./stores/discoveredAccounts";
import type { XScrapeHealthGateway } from "./stores/xScrapeHealth";
import type { XBudgetGateway } from "./stores/xBudget";
import { dayKey } from "./stores/xBudget";
import type { SavedXPostsGateway } from "./stores/savedXPosts";

/** Signature of searchXPosts, kept loose so tests can inject a mock. */
export type XSearchFn = (opts: {
  query: string;
  tab: "top" | "latest";
  maxScrolls: number;
  limit: number;
}) => Promise<XSearchResult>;

/** Signature of scrapeXPosts, kept loose so tests can inject a mock. */
export type XScrapeProfileFn = (opts: {
  handle: string;
  limit: number;
  maxScrolls: number;
}) => Promise<XScrapeResult>;

export interface DiscoveryReport {
  /** The queries actually run this session. */
  queries: string[];
  /** Total posts collected (after URL dedupe) and considered for save. */
  postsScraped: number;
  /** Count of distinct accounts touched by upsertFromScrape. */
  accountsTouched: number;
  /** Handles promoted (status === 'promoted') after this run's learning. */
  promoted: string[];
  /** True if the X branch aborted early (block / empty / budget / disabled). */
  aborted: boolean;
  /** Why it aborted / was skipped, when applicable. */
  stopReason?: string;
  /** Budget consumed this session. */
  budgetUsed: { searchLoads: number; profileVisits: number };
  /** Posts dropped because the hard session cap was hit. */
  truncatedCount: number;
  /** True specifically when a block (login/captcha/activity/429) stopped us. */
  blocked: boolean;
}

export interface RunDiscoveryDeps {
  config?: XDiscoveryConfig;
  generateQueries?: (
    topics: string[],
    opts: { generate?: QueryGenerate; config?: XDiscoveryConfig; log?: RunLog },
  ) => Promise<Map<string, string[]>>;
  search?: XSearchFn;
  scrapeProfile?: XScrapeProfileFn;
  accounts: DiscoveredAccountsGateway;
  health: XScrapeHealthGateway;
  budget: XBudgetGateway;
  savedPosts: SavedXPostsGateway;
  now?: Date;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0,1) (tests pass a deterministic value). */
  rng?: () => number;
  log?: RunLog;
}

type RunLog = (ev: string, data: Record<string, unknown>) => void;

const BLOCK_REASONS = new Set(["login_wall", "captcha", "unusual_activity", "http_429"]);

function emptyReport(overrides: Partial<DiscoveryReport> = {}): DiscoveryReport {
  return {
    queries: [],
    postsScraped: 0,
    accountsTouched: 0,
    promoted: [],
    aborted: true,
    budgetUsed: { searchLoads: 0, profileVisits: 0 },
    truncatedCount: 0,
    blocked: false,
    ...overrides,
  };
}

function pickDelay(range: [number, number], rng: () => number): number {
  const [lo, hi] = range;
  if (hi <= lo) return Math.max(0, lo);
  return Math.round(lo + rng() * (hi - lo));
}

export async function runDiscovery(deps: RunDiscoveryDeps): Promise<DiscoveryReport> {
  const config = deps.config ?? getXDiscoveryConfig();
  const log: RunLog = deps.log ?? (() => {});
  const now = deps.now ?? new Date();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = deps.rng ?? Math.random;
  const genQueries = deps.generateQueries ?? defaultGenerateQueries;
  const search = deps.search;
  const scrapeProfile = deps.scrapeProfile;

  // --- gate: disabled ---
  if (!config.enabled) {
    log("x.discovery.disabled", {});
    return emptyReport({ stopReason: "disabled" });
  }

  try {
    const health = await deps.health.load();

    // --- gate: active cooldown ---
    if (health.cooldownUntil) {
      const until = Date.parse(health.cooldownUntil);
      if (Number.isFinite(until) && until > now.getTime()) {
        log("x.discovery.cooldown", { until: health.cooldownUntil, reason: health.lastStopReason });
        return emptyReport({ stopReason: "cooldown" });
      }
    }

    // --- gate: daily budget exhausted ---
    const day = dayKey(now, config.dayBoundaryTz);
    const todayBudget = await deps.budget.today(day);
    if (todayBudget.searchLoads >= config.maxSearchLoadsPerDay) {
      log("x.discovery.budget_exhausted", { day, searchLoads: todayBudget.searchLoads });
      return emptyReport({ stopReason: "budget_exhausted" });
    }

    // --- session start jitter ---
    const jitter = pickDelay(
      [0, Math.max(0, config.actionDelayMsRange[1] * config.startJitterPct)],
      rng,
    );
    if (jitter > 0) await sleep(jitter);

    // --- generate queries for a capped slice of topics ---
    const topics = config.topics.slice(0, config.maxTopicsPerSession);
    const queryMap = await genQueries(topics, { config, log });

    const budgetUsed = { searchLoads: 0, profileVisits: 0 };
    let collectedCount = 0;
    const postsByUrl = new Set<string>();
    // author handle (lower) -> raw scraped posts seen this session (for learning + save)
    const scrapedByAuthor = new Map<string, ScrapedXPost[]>();
    let truncatedCount = 0;
    let aborted = false;
    let blocked = false;
    let stopReason: string | undefined;
    const ranQueries: string[] = [];
    let consecutiveEmpty = health.consecutiveEmpty;

    const blocklist = new Set(config.blocklistHandles.map((h) => h.replace(/^@/, "").toLowerCase()));

    // Flatten topic -> queries into a single sequential list, code-capped.
    const allQueries: string[] = [];
    for (const topic of topics) {
      const qs = (queryMap.get(topic) ?? []).slice(0, config.maxQueriesPerTopic);
      for (const q of qs) allQueries.push(q);
    }

    const accumulatePosts = (posts: ScrapedXPost[]): boolean => {
      // returns true if the hard cap was hit (caller should stop)
      for (const p of posts) {
        if (!p.url) continue;
        if (collectedCount >= config.hardPostCapPerSession) {
          truncatedCount++;
          continue;
        }
        if (postsByUrl.has(p.url)) continue;
        const author = (p.author_handle || "").replace(/^@/, "").toLowerCase();
        if (author && blocklist.has(author)) continue;
        postsByUrl.add(p.url);
        // Stash the raw post under its author for learning + later save mapping.
        const key = author || "unknown";
        const arr = scrapedByAuthor.get(key) ?? [];
        arr.push(p);
        scrapedByAuthor.set(key, arr);
        collectedCount++;
      }
      return collectedCount >= config.hardPostCapPerSession;
    };

    searchLoop: for (const query of allQueries) {
      if (!search) break; // no search fn injected -> nothing to do (demo w/o mock)

      // per-query cooldown
      const lastRun = health.lastQueryRunAt[query];
      if (lastRun) {
        const since = now.getTime() - Date.parse(lastRun);
        if (Number.isFinite(since) && since < config.queryCooldownHours * 3_600_000) {
          log("x.discovery.query_cooldown", { query });
          continue;
        }
      }

      // budget: search loads
      if (todayBudget.searchLoads + budgetUsed.searchLoads >= config.maxSearchLoadsPerDay) {
        log("x.discovery.budget_exhausted_mid", { query });
        aborted = true;
        stopReason = "budget_exhausted";
        break;
      }

      ranQueries.push(query);

      let res: XSearchResult;
      try {
        res = await search({
          query,
          tab: "top",
          maxScrolls: config.maxScrollsPerQuery,
          limit: config.hardPostCapPerSession,
        });
      } catch (err) {
        log("x.discovery.search_error", { query, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      budgetUsed.searchLoads++;
      await deps.budget.incSearch(day);

      // block -> abort the whole branch immediately
      if (res.stopReason && BLOCK_REASONS.has(res.stopReason)) {
        blocked = true;
        aborted = true;
        stopReason = res.stopReason;
        log("x.discovery.blocked", { query, reason: res.stopReason });
        break searchLoop;
      }

      let count = res.success ? res.posts.length : 0;
      if (res.success && res.posts.length) {
        if (accumulatePosts(res.posts)) break searchLoop;
      }

      // Top returned too few -> ONE secondary Latest pass.
      if (count < config.topMinPosts) {
        if (todayBudget.searchLoads + budgetUsed.searchLoads < config.maxSearchLoadsPerDay) {
          let latest: XSearchResult | null = null;
          try {
            latest = await search({
              query,
              tab: "latest",
              maxScrolls: config.maxScrollsPerQuery,
              limit: config.hardPostCapPerSession,
            });
          } catch (err) {
            log("x.discovery.search_error", { query, tab: "latest", error: err instanceof Error ? err.message : String(err) });
          }
          if (latest) {
            budgetUsed.searchLoads++;
            await deps.budget.incSearch(day);
            if (latest.stopReason && BLOCK_REASONS.has(latest.stopReason)) {
              blocked = true;
              aborted = true;
              stopReason = latest.stopReason;
              log("x.discovery.blocked", { query, tab: "latest", reason: latest.stopReason });
              break searchLoop;
            }
            if (latest.success && latest.posts.length) {
              count += latest.posts.length;
              if (accumulatePosts(latest.posts)) break searchLoop;
            }
          }
        }
      }

      // consecutive-empty tracking -> abort at the limit
      if (count === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= config.consecutiveEmptyLimit) {
          aborted = true;
          stopReason = "empty";
          log("x.discovery.empty_limit", { query, consecutiveEmpty });
          break searchLoop;
        }
      } else {
        consecutiveEmpty = 0;
      }

      health.lastQueryRunAt[query] = now.toISOString();

      // per-query delay before the next query
      await sleep(pickDelay(config.queryDelayMsRange, rng));
      // small per-action jitter too
      await sleep(pickDelay(config.actionDelayMsRange, rng));
    }

    // --- learn: fold each author's samples into discovered_accounts ---
    const touched = new Map<string, DiscoveredAccount>();
    for (const [author, posts] of scrapedByAuthor) {
      if (!author || author === "unknown") continue;
      if (blocklist.has(author)) continue;
      try {
        const acct = await deps.accounts.upsertFromScrape(
          author,
          posts.map((p) => ({ likes: p.likes, reposts: p.reposts, text: p.text })),
          now,
        );
        touched.set(author, acct);
      } catch (err) {
        log("x.discovery.learn_error", { handle: author, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // --- profile pass: promoted + pinned, not visited today, within budget ---
    if (scrapeProfile && !blocked) {
      const pinned = config.pinnedHandles.map((h) => h.replace(/^@/, "").toLowerCase());
      const promotedHandles = [...touched.values()]
        .filter((a) => a.status === "promoted")
        .map((a) => a.handle.toLowerCase());
      const toVisit: string[] = [];
      const seenVisit = new Set<string>();
      for (const h of [...promotedHandles, ...pinned]) {
        const key = h.toLowerCase();
        if (seenVisit.has(key) || blocklist.has(key)) continue;
        seenVisit.add(key);
        toVisit.push(h);
      }

      for (const handle of toVisit) {
        const acct = await deps.accounts.get(handle).catch(() => undefined);
        if (acct?.lastProfileVisitDay === day) continue;
        if (
          todayBudget.profileVisits + budgetUsed.profileVisits >=
          config.maxProfileVisitsPerDay
        ) {
          log("x.discovery.profile_budget_exhausted", { handle });
          break;
        }
        let pres: XScrapeResult | null = null;
        try {
          pres = await scrapeProfile({
            handle,
            limit: config.profilePerVisitLimit,
            maxScrolls: config.maxScrollsPerQuery,
          });
        } catch (err) {
          log("x.discovery.profile_error", { handle, error: err instanceof Error ? err.message : String(err) });
        }
        budgetUsed.profileVisits++;
        await deps.budget.incProfile(day);
        await deps.accounts.markProfileVisited(handle, day).catch(() => {});
        // scrapeXPosts surfaces a hard stop as error:'blocked' (scrape.py's
        // stop_reason is folded into error/fix); treat that as a block.
        if (pres && !pres.success && pres.error === "blocked") {
          blocked = true;
          aborted = true;
          stopReason = "blocked";
          log("x.discovery.blocked", { handle, reason: "blocked", phase: "profile" });
          break;
        }
        if (pres?.success && pres.posts.length) {
          accumulatePosts(pres.posts);
          // Re-learn with the richer profile sample.
          try {
            const updated = await deps.accounts.upsertFromScrape(
              handle,
              pres.posts.map((p) => ({ likes: p.likes, reposts: p.reposts, text: p.text })),
              now,
            );
            touched.set(handle.toLowerCase(), updated);
          } catch (err) {
            log("x.discovery.learn_error", { handle, error: err instanceof Error ? err.message : String(err) });
          }
        }
        await sleep(pickDelay(config.actionDelayMsRange, rng));
      }
    }

    // --- map + save: stamp code-decided numbers onto each post (FIX #2/#3) ---
    const toSave: RawContent[] = [];
    for (const [author, posts] of scrapedByAuthor) {
      if (!author || author === "unknown" || blocklist.has(author)) continue;
      const acct = touched.get(author) ?? (await deps.accounts.get(author).catch(() => undefined));
      const official = acct ? isOfficialAccount(acct, config) : false;
      for (const post of posts) {
        const raw = postToRaw(author, post, {
          accountMedianLikes: acct?.medianLikes ?? 0,
          accountMedianReposts: acct?.medianReposts ?? 0,
          accountStatus: acct?.status ?? "candidate",
          isOfficialAccount: official,
          accountCredibilityScore: acct?.credibilityScore ?? 0,
        });
        if (!raw) continue;
        raw.collectedAt = now.toISOString();
        toSave.push(raw);
      }
    }
    if (toSave.length) {
      try {
        await deps.savedPosts.saveMany(toSave);
      } catch (err) {
        log("x.discovery.save_error", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // --- health: escalate on stop, reset on a clean run with posts ---
    health.lastRunAt = now.toISOString();
    if (blocked || (aborted && stopReason === "empty")) {
      const idx = Math.min(health.cooldownLadderIndex, config.stopCooldownHoursLadder.length - 1);
      const hours = config.stopCooldownHoursLadder[idx] ?? config.stopCooldownHoursLadder[config.stopCooldownHoursLadder.length - 1] ?? 12;
      health.cooldownUntil = new Date(now.getTime() + hours * 3_600_000).toISOString();
      health.cooldownLadderIndex = Math.min(
        health.cooldownLadderIndex + 1,
        config.stopCooldownHoursLadder.length - 1,
      );
      health.lastStopReason = stopReason;
      health.consecutiveEmpty = consecutiveEmpty;
    } else {
      // clean run: reset ladder + empties (only if we actually got posts)
      if (toSave.length > 0) {
        health.cooldownLadderIndex = 0;
        health.consecutiveEmpty = 0;
        delete health.cooldownUntil;
        delete health.lastStopReason;
      } else {
        health.consecutiveEmpty = consecutiveEmpty;
      }
    }
    try {
      await deps.health.save(health);
    } catch (err) {
      log("x.discovery.health_save_error", { error: err instanceof Error ? err.message : String(err) });
    }

    const promoted = [...touched.values()].filter((a) => a.status === "promoted").map((a) => a.handle);

    const report: DiscoveryReport = {
      queries: ranQueries,
      postsScraped: toSave.length,
      accountsTouched: touched.size,
      promoted,
      aborted,
      ...(stopReason ? { stopReason } : {}),
      budgetUsed,
      truncatedCount,
      blocked,
    };
    log("x.discovery.done", { ...report });
    return report;
  } catch (err) {
    // Top-level fail-soft: any unexpected throw -> aborted-but-clean report.
    log("x.discovery.fatal", { error: err instanceof Error ? err.message : String(err) });
    return emptyReport({ stopReason: "error" });
  }
}
