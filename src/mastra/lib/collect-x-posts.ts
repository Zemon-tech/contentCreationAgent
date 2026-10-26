import type { RawContent } from "../schemas/rawContent";
import { hashString } from "../collectors/types";
import type { ScrapedXPost } from "./x-publisher";
import { getXDiscoveryConfig, type XDiscoveryConfig } from "../config/xDiscovery";
import type { SavedXPostsGateway } from "./x-discovery/stores/savedXPosts";
import { libSqlSavedXPostsGateway } from "./x-discovery/stores/savedXPosts";
import { normalizeUrl } from "./normalize";

/**
 * Read the X/Twitter signal INTO the auto-news-to-RAS pipeline.
 *
 * FIX #5 / FIX #9 — feed-only guarantee: this module NO LONGER scrapes. The X
 * discovery subsystem (lib/x-discovery/runDiscovery.ts, on its own 6h cron)
 * does the scraping and SAVES normalized posts to the saved_x_posts store. The
 * main news workflow only READS those saved posts here. No scraper reference
 * remains in the main workflow's import graph, so a single switch
 *   X_DISCOVERY_ENABLED=false
 * turns the whole X signal off structurally.
 *
 * Design notes:
 * - SIGNAL-ONLY: each saved item was flagged signalOnly at write time, so an X
 *   post can inform ranking but is never cited as a primary source without
 *   corroboration (same policy as Hacker News / Reddit in newsFeeds.ts).
 * - FAIL-SOFT: any gateway error returns an empty result and never throws into
 *   the news run.
 * - NO-OP WHEN DISABLED: returns an empty result WITHOUT touching the store
 *   when the discovery config is off.
 */

export interface CollectXResult {
  items: RawContent[];
  /** Per-account outcome for observability (count by author handle). */
  perAccount: Array<{ handle: string; count: number; error?: string }>;
}

const MIN_TEXT_LEN = 15; // drop one-word / link-only posts that make poor stories

/** Optional account-level signals a caller can thread onto the RawContent. */
export interface PostToRawOpts {
  accountMedianLikes?: number;
  accountMedianReposts?: number;
  accountStatus?: string;
  isOfficialAccount?: boolean;
  accountCredibilityScore?: number;
}

/**
 * Drop x.com/twitter.com/t.co hosts, canonicalize, lowercase host, strip
 * tracking (normalizeUrl already does), and dedupe a list of outbound URLs.
 *
 * `opts.expand` lets a test simulate a t.co -> destination hop with NO network;
 * the real collector passes no expander (t.co links are kept as-is unless they
 * resolve to a dropped host).
 */
export function resolveOutboundUrls(
  urls: string[],
  opts?: { expand?: (tco: string) => string | null },
): string[] {
  const DROP_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "t.co"]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls || []) {
    if (!raw) continue;
    let candidate = raw;
    // Optionally expand a t.co short link to its destination (test-injected).
    if (opts?.expand) {
      try {
        const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, "");
        if (host === "t.co") {
          const dest = opts.expand(candidate);
          if (dest) candidate = dest;
        }
      } catch {
        /* non-URL; normalizeUrl below returns it verbatim */
      }
    }
    const normalized = normalizeUrl(candidate);
    let key = normalized;
    try {
      const u = new URL(normalized);
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      if (DROP_HOSTS.has(host)) continue;
      u.hostname = host;
      key = u.toString();
    } catch {
      /* keep normalized string as the dedupe key */
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function postToRaw(
  handle: string,
  post: ScrapedXPost,
  opts?: PostToRawOpts,
): RawContent | null {
  const text = (post.text || "").replace(/\s+/g, " ").trim();
  if (!text || text.length < MIN_TEXT_LEN) return null;
  if (!post.url) return null;

  const sourceId = `x:${handle.toLowerCase()}`;
  const engagement =
    post.likes != null || post.reposts != null || post.replies != null || post.views != null
      ? {
          ...(post.likes != null ? { likes: post.likes } : {}),
          ...(post.replies != null ? { comments: post.replies } : {}),
          ...(post.reposts != null ? { shares: post.reposts } : {}),
          ...(post.views != null ? { views: post.views } : {}),
        }
      : undefined;

  const outboundUrls = resolveOutboundUrls(post.outbound_urls ?? []);
  const authorHandle = (post.author_handle || handle).toLowerCase();

  return {
    id: `${sourceId}:${hashString(post.url)}`,
    sourceId,
    sourceName: `X/@${handle}`,
    sourceType: "x",
    url: post.url,
    // X posts have no headline; use a trimmed first line so the ranker has a title.
    title: text.length > 120 ? `${text.slice(0, 117)}...` : text,
    content: text,
    author: {
      name: `@${post.author_handle || handle}`,
      handle: post.author_handle || handle,
      url: `https://x.com/${post.author_handle || handle}`,
    },
    ...(post.at ? { publishedAt: post.at } : {}),
    collectedAt: new Date().toISOString(),
    ...(engagement ? { engagement } : {}),
    metadata: {
      collector: "x",
      isRepost: post.is_repost,
      isReply: post.is_reply,
      outboundUrls,
      quoted: post.quoted ?? null,
      threadTexts: post.thread_texts ?? [],
      textTruncated: post.text_truncated ?? false,
      authorHandle,
      engagementRaw: {
        likes: post.likes,
        reposts: post.reposts,
        replies: post.replies,
        views: post.views,
      },
      accountMedianLikes: opts?.accountMedianLikes ?? 0,
      accountMedianReposts: opts?.accountMedianReposts ?? 0,
      isOfficialAccount: opts?.isOfficialAccount ?? false,
      accountCredibilityScore: opts?.accountCredibilityScore ?? 0,
      accountStatus: opts?.accountStatus ?? "candidate",
    },
    // Social posts inform ranking but are never a citable primary source.
    signalOnly: true,
  };
}

export async function collectXPosts(opts?: {
  /** Injectable for tests/demo. Defaults to the real libSQL saved-posts store. */
  savedPosts?: SavedXPostsGateway;
  now?: Date;
  /** Overrides config.savedPostMaxAgeHours for the store-window read. */
  maxAgeHours?: number;
  config?: XDiscoveryConfig;
  log?: (ev: string, data: Record<string, unknown>) => void;
}): Promise<CollectXResult> {
  const config = opts?.config ?? getXDiscoveryConfig();
  const log = opts?.log ?? (() => {});

  // Structural feed-only switch: when disabled we never touch the store.
  if (!config.enabled) {
    log("x.disabled", {});
    return { items: [], perAccount: [] };
  }

  const now = opts?.now ?? new Date();
  const maxAgeHours = opts?.maxAgeHours ?? config.savedPostMaxAgeHours;
  const savedPosts = opts?.savedPosts ?? libSqlSavedXPostsGateway();

  try {
    const items = await savedPosts.recentWithin(maxAgeHours, now);
    // Per-author counts for observability (authorHandle stamped by postToRaw).
    const counts = new Map<string, number>();
    for (const it of items) {
      const handle =
        (typeof it.metadata?.["authorHandle"] === "string" && (it.metadata["authorHandle"] as string)) ||
        it.author?.handle ||
        "unknown";
      counts.set(handle, (counts.get(handle) ?? 0) + 1);
    }
    const perAccount = [...counts.entries()].map(([handle, count]) => ({ handle, count }));
    log("x.read.saved", { items: items.length, accounts: perAccount.length });
    return { items, perAccount };
  } catch (err) {
    // Fail-soft: a store error must never break the news run.
    log("x.read.error", { error: err instanceof Error ? err.message : String(err) });
    return { items: [], perAccount: [] };
  }
}
