import type { RawContent } from "../schemas/rawContent";
import { hashString } from "../collectors/types";
import { scrapeXPosts, type ScrapedXPost } from "./x-publisher";
import { checkXSession } from "./x-publisher";
import { getXWatchConfig, type XWatchConfig } from "../config/xAccounts";
import { normalizeUrl } from "./normalize";

/**
 * Collect posts from the watched X accounts and normalize them into
 * RawContent items the auto-news-to-RAS pipeline can rank like any feed item.
 *
 * Design notes:
 * - SIGNAL-ONLY: every item is flagged signalOnly so an X post can inform
 *   ranking but is never cited as a story's primary source without
 *   corroboration (same policy as Hacker News / Reddit in newsFeeds.ts).
 * - FAIL-SOFT: a scrape failure (session not logged in, markup change, a bad
 *   handle) must never block the news run. Failures are logged and skipped;
 *   the function always resolves, returning whatever it managed to collect.
 * - NO-OP WHEN DISABLED: returns [] immediately when the watch config is off,
 *   so the default feed-only behavior is unchanged unless X watching is on.
 */

export interface CollectXResult {
  items: RawContent[];
  /** Per-account outcome for observability (count or skip reason). */
  perAccount: Array<{ handle: string; count: number; error?: string }>;
  /** True if the X session wasn't ready, so nothing was scraped. */
  sessionNotReady?: boolean;
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
  config?: XWatchConfig;
  /** Injectable for tests. Defaults to the real scraper. */
  scrape?: typeof scrapeXPosts;
  /** Injectable for tests. Defaults to the real session check. */
  checkSession?: typeof checkXSession;
  log?: (ev: string, data: Record<string, unknown>) => void;
}): Promise<CollectXResult> {
  const config = opts?.config ?? getXWatchConfig();
  const scrape = opts?.scrape ?? scrapeXPosts;
  const check = opts?.checkSession ?? checkXSession;
  const log = opts?.log ?? (() => {});

  if (!config.enabled || config.handles.length === 0) {
    return { items: [], perAccount: [] };
  }

  // One session check up front: if the automation browser isn't logged in,
  // skip the whole X signal cleanly rather than failing every account.
  try {
    const session = await check();
    if (!session.loggedIn) {
      log("x.session.not_ready", { message: session.message });
      return { items: [], perAccount: [], sessionNotReady: true };
    }
  } catch (err) {
    log("x.session.check_failed", { error: err instanceof Error ? err.message : String(err) });
    return { items: [], perAccount: [], sessionNotReady: true };
  }

  const items: RawContent[] = [];
  const perAccount: CollectXResult["perAccount"] = [];

  // Sequential on purpose: all accounts share ONE automation browser, so
  // concurrent scrapes would fight over the same tab.
  for (const handle of config.handles) {
    try {
      const res = await scrape({
        handle,
        limit: config.perAccountLimit,
        includeReplies: false,
        maxScrolls: config.maxScrolls,
      });
      if (!res.success) {
        perAccount.push({ handle, count: 0, error: res.error || res.message });
        log("x.account.failed", { handle, error: res.error || res.message });
        continue;
      }
      let kept = 0;
      for (const post of res.posts) {
        const raw = postToRaw(handle, post);
        if (raw) {
          items.push(raw);
          kept++;
        }
      }
      perAccount.push({ handle, count: kept });
      log("x.account.collected", { handle, posts: res.posts.length, kept });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      perAccount.push({ handle, count: 0, error: msg });
      log("x.account.error", { handle, error: msg });
    }
  }

  return { items, perAccount };
}
