import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { imageConfig, type ImageConfig } from "../../config/image.config";
import { downloadAndValidate } from "./validate";
import { hostOf } from "../article-body";
import { searchExa } from "../../tools/exa-tools";
import { withTimeout } from "../timeout";

/** Hard limit on the Exa image search so a slow Exa call can't stall a post. */
const EXA_TIMEOUT_MS = 15_000;

/**
 * Image sourcing (Step 5). Candidate order: FEED image -> Exa image search ->
 * none (text-only). No generation (no Flux). The first candidate that passes
 * deterministic validation is downloaded to IMAGE_DIR (filename = content hash,
 * so the same image is never saved twice) and its LOCAL path is returned for
 * RAS to composite. Rights are never verified here: rightsStatus is always
 * "unverified" and nothing is marked cleared.
 */

export interface ImageResult {
  imageLocalPath: string | null;
  imageSourceUrl: string | null;
  imageAttribution: string | null;
  rightsStatus: "unverified";
  under1080: boolean;
  chosenFrom: "feed" | "exa" | "none";
  candidatesTried: number;
  reason?: string;
}

const TEXT_ONLY: Omit<ImageResult, "candidatesTried"> = {
  imageLocalPath: null,
  imageSourceUrl: null,
  imageAttribution: null,
  rightsStatus: "unverified",
  under1080: false,
  chosenFrom: "none",
};

/**
 * Exa search for the headline. Returns the `image` fields Exa provides AND the
 * matching article URLs — Exa often finds the right article but returns no
 * `image` for it, so the caller falls back to those pages' og:image.
 */
async function exaSearch(headline: string, cfg: ImageConfig): Promise<{ images: string[]; pageUrls: string[] }> {
  if (!process.env.EXA_API_KEY) return { images: [], pageUrls: [] };
  try {
    const res = await withTimeout(EXA_TIMEOUT_MS, "image Exa search", () =>
      searchExa({ query: headline, numResults: cfg.exaCandidates, includeText: false, includeImages: true }),
    );
    const results = (res?.results ?? []) as { image?: string; url?: string }[];
    const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
    return {
      images: results.map((r) => r.image).filter(isHttp),
      pageUrls: results.map((r) => r.url).filter(isHttp),
    };
  } catch {
    return { images: [], pageUrls: [] };
  }
}

/**
 * Pulls the social-share image URLs (og:image, twitter:image) out of an HTML
 * page, resolved against the page URL. Pure — exported for tests.
 */
export function extractMetaImages(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const keys = /^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/i;
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    const key = attr("property") ?? attr("name");
    const content = attr("content");
    const k = key?.[2] ?? key?.[3];
    const v = (content?.[2] ?? content?.[3] ?? "").trim().replace(/&amp;/g, "&");
    if (!k || !v || !keys.test(k)) continue;
    try {
      const abs = new URL(v, pageUrl).toString();
      if (/^https?:\/\//i.test(abs) && !out.includes(abs)) out.push(abs);
    } catch {
      /* malformed URL */
    }
  }
  return out;
}

/**
 * Fetches the article pages IN PARALLEL (each time-boxed, size-capped) and
 * collects their og/twitter images, keeping the input page order so the
 * story's own article still wins over later pages.
 */
async function pageImageCandidates(pageUrls: string[], cfg: ImageConfig): Promise<string[]> {
  const perPage = await Promise.all(pageUrls.map((u) => pageMetaImages(u, cfg)));
  const found: string[] = [];
  for (const list of perPage) for (const u of list) if (!found.includes(u)) found.push(u);
  return found;
}

async function pageMetaImages(pageUrl: string, cfg: ImageConfig): Promise<string[]> {
  const MAX_HTML_BYTES = 1_500_000; // meta tags live in <head>; never read a whole huge page
  const controller = new AbortController();
  // One timer covers headers AND body, so a slow-streaming page can't hang.
  const timer = setTimeout(() => controller.abort(), cfg.downloadTimeoutMs);
  try {
    const res = await fetch(pageUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return [];
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return extractMetaImages(html, res.url || pageUrl);
  } catch {
    return []; // unreachable / timed-out page — the caller tries the others
  } finally {
    clearTimeout(timer);
  }
}

function saveImage(buffer: Buffer, ext: string, cfg: ImageConfig): string {
  fs.mkdirSync(cfg.imageDir, { recursive: true });
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const filePath = path.join(cfg.imageDir, `${hash}.${ext}`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer); // dedup: never save twice
  return filePath;
}

export async function sourceImage(args: {
  headline: string;
  feedCandidateUrls?: string[];
  /** The story's own article URL(s): their og:image is tried if the feed has none. */
  articleUrls?: string[];
  config?: ImageConfig;
}): Promise<ImageResult> {
  const cfg = args.config ?? imageConfig;
  const feed = [...new Set((args.feedCandidateUrls ?? []).filter(Boolean))];
  const articles = [...new Set((args.articleUrls ?? []).filter((u) => /^https?:\/\//i.test(u ?? "")))];
  let tried = 0;
  const attempted = new Set<string>();

  const tryList = async (urls: string[], from: "feed" | "exa"): Promise<ImageResult | null> => {
    for (const url of urls) {
      if (attempted.has(url)) continue;
      attempted.add(url);
      tried++;
      const v = await downloadAndValidate(url, cfg);
      if (v.ok && v.buffer && v.ext) {
        const localPath = saveImage(v.buffer, v.ext, cfg);
        return {
          imageLocalPath: localPath,
          imageSourceUrl: url,
          imageAttribution: hostOf(url),
          rightsStatus: "unverified",
          under1080: !!v.under1080,
          chosenFrom: from,
          candidatesTried: tried,
        };
      }
    }
    return null;
  };

  // Order: feed image -> the story's own article og:image -> Exa image ->
  // og:image of the articles Exa found for the headline.
  const fromFeed = await tryList(feed, "feed");
  if (fromFeed) return fromFeed;

  const fromArticle = await tryList(await pageImageCandidates(articles, cfg), "feed");
  if (fromArticle) return fromArticle;

  const exa = await exaSearch(args.headline, cfg);
  const fromExa = await tryList(exa.images, "exa");
  if (fromExa) return fromExa;

  const exaPages = exa.pageUrls.filter((u) => !articles.includes(u));
  const fromExaPages = await tryList(await pageImageCandidates(exaPages, cfg), "exa");
  if (fromExaPages) return fromExaPages;

  return { ...TEXT_ONLY, candidatesTried: tried, reason: tried === 0 ? "no candidates" : "no candidate passed validation" };
}
