import { ingestionConfig, type IngestionConfig } from "../config/ingestion.config";
import { politeFetch } from "./http-polite";
import { extractArticleContent } from "../collectors/web";
import type { Source } from "../schemas/source";

/**
 * fetchArticleBody — the ONE guarded path for fetching article body text.
 *
 * Paywall enforcement is in CODE, not convention: if the source is paywalled
 * OR the URL resolves to a known paywalled domain (so Google-News-fallback and
 * API items that land on wsj.com are caught too), this refuses and returns
 * { body: null, reason: "paywalled" }. No paywall bypass of any kind
 * (archives, caches, mirrors, headless) is attempted. No other code path in
 * the pipeline may fetch article bodies.
 */

/** Hard-paywall article domains. Extend via FEED_PAYWALLED_DOMAINS (comma list). */
export const PAYWALLED_DOMAINS: Set<string> = new Set(
  [
    "wsj.com",
    "dowjones.io",
    "ft.com",
    "bloomberg.com",
    "economist.com",
    "nytimes.com",
    "theinformation.com",
    "the-ken.com",
    "business-standard.com",
    ...(process.env["FEED_PAYWALLED_DOMAINS"]?.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean) ?? []),
  ].map((d) => d.toLowerCase()),
);

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isPaywalledDomain(url: string, domains: Set<string> = PAYWALLED_DOMAINS): boolean {
  const host = hostOf(url);
  if (!host) return false;
  for (const d of domains) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

export interface ArticleBodyResult {
  body: string | null;
  reason?: "paywalled" | "robots" | "error";
  error?: string;
}

export async function fetchArticleBody(
  args: { url: string; source?: Pick<Source, "paywalled"> | null; config?: IngestionConfig; paywalledDomains?: Set<string> },
): Promise<ArticleBodyResult> {
  const cfg = args.config ?? ingestionConfig;
  const domains = args.paywalledDomains ?? PAYWALLED_DOMAINS;

  if (args.source?.paywalled || isPaywalledDomain(args.url, domains)) {
    return { body: null, reason: "paywalled" };
  }

  const res = await politeFetch(args.url, { mode: "scraper", config: cfg });
  if (res.blockedByRobots) return { body: null, reason: "robots" };
  if (!res.ok || !res.body) return { body: null, reason: "error", error: res.error ?? `HTTP ${res.status}` };

  const extracted = extractArticleContent(res.body, args.url);
  return { body: extracted.text };
}
