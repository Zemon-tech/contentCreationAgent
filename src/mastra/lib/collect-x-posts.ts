import type { RawContent } from "../schemas/rawContent";
import { hashString } from "../collectors/types";
import { scrapeXPosts, type ScrapedXPost } from "./x-publisher";
import { checkXSession } from "./x-publisher";
import { getXWatchConfig, type XWatchConfig } from "../config/xAccounts";

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

function postToRaw(handle: string, post: ScrapedXPost): RawContent | null {
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
    metadata: { collector: "x", isRepost: post.is_repost, isReply: post.is_reply },
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
