import type { Source } from "../schemas/source";
import { rss, stub } from "./sourceCatalog1";

/**
 * RSS-first news, primary, and signal feeds for the RAS Instagram pipeline.
 *
 * Replaces the old homepage-"blob" scrapes (The Verge, Inc42, AIM, YourStory,
 * MIT TR, ET Tech, Entrackr were registered as type:"news" pointing at
 * homepages — one low-value item per run). These are proper per-article feeds,
 * each tagged with region / category hints / credibility (authorityScore) /
 * paywalled / signalOnly so the ranker can read them.
 *
 * Every URL here was candidate-verified live (see `npm run feeds:verify`);
 * dead/stale feeds are marked active:false with a note and, where useful, a
 * Google News fallback is available (see lib/google-news-fallback.ts).
 *
 * `signalOnly:true` sources (HN, Reddit, Product Hunt) may inform ranking
 * (coverage/velocity) but must NEVER be cited as a story's primary source.
 */

interface FeedOpts {
  role?: Source["role"];
  tier?: 1 | 2 | 3;
  paywalled?: boolean;
  signalOnly?: boolean;
  active?: boolean;
  note?: string;
}

function feed(
  idKey: string,
  name: string,
  url: string,
  region: "US" | "IN" | "GLOBAL",
  topics: string[],
  authority: number,
  opts: FeedOpts = {},
): Source {
  return rss(`rss:${idKey}`, name, url, authority, {
    topics,
    role: opts.role ?? "news",
    tier: opts.tier ?? 2,
    region,
    ...(opts.paywalled ? { paywalled: true } : {}),
    ...(opts.signalOnly ? { signalOnly: true } : {}),
    ...(opts.active === false ? { active: false } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  });
}

const AI = ["Generative AI", "LLMs"];
const STARTUPS = ["AI Startups"];
const DEEPTECH = ["Deeptech", "AI Research"];
const BIZ = ["Business", "AI Startups"];

// ---------- Converted: homepage scrape -> RSS ----------

export const CONVERTED_FEEDS: Source[] = [
  feed("verge", "The Verge", "https://www.theverge.com/rss/index.xml", "US", AI, 80, { tier: 1 }),
  feed("mittr", "MIT Technology Review", "https://www.technologyreview.com/feed/", "US", AI, 86, { tier: 1 }),
  feed("yourstory", "YourStory", "https://yourstory.com/feed", "IN", STARTUPS, 72),
  feed("inc42", "Inc42", "https://inc42.com/feed/", "IN", STARTUPS, 72),
  feed("aim", "Analytics India Magazine", "https://analyticsindiamag.com/feed/", "IN", AI, 74, {
    active: false, note: "Feed serves HTML to bots (verified dead). Use Google News fallback site:analyticsindiamag.com.",
  }),
  feed("ettech", "Economic Times Tech", "https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms", "IN", BIZ, 72),
  feed("entrackr", "Entrackr", "https://entrackr.com/rss", "IN", STARTUPS, 68, { tier: 3 }),
];

// ---------- Added: US / global ----------

export const US_GLOBAL_FEEDS: Source[] = [
  feed("wsjd", "WSJ Technology", "https://feeds.content.dowjones.io/public/rss/RSSWSJD", "US", [...BIZ, ...AI], 90, {
    tier: 1, paywalled: true, note: "Paywalled — title + summary only, never fetch body.",
  }),
  feed("wsj-markets", "WSJ Markets", "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", "US", BIZ, 88, {
    tier: 2, paywalled: true, note: "Paywalled — title + summary only.",
  }),
  feed("cnn-tech", "CNN Technology", "http://rss.cnn.com/rss/edition_technology.rss", "US", ["Technology"], 70, {
    active: false, note: "CNN public RSS defunct — endpoint returns items frozen ~10 years old. Use Google News fallback site:cnn.com.",
  }),
  feed("cnn-top", "CNN Top Stories", "http://rss.cnn.com/rss/cnn_topstories.rss", "US", ["News"], 66, {
    active: false, tier: 3, note: "Stale (frozen ~2022, legacy rss.cnn.com). Disabled; use edition_technology or Google News fallback.",
  }),
  feed("wired", "Wired", "https://www.wired.com/feed/rss", "US", AI, 80),
  feed("engadget", "Engadget", "https://www.engadget.com/rss.xml", "US", ["Technology"], 72, { tier: 3 }),
  feed("tnw", "The Next Web", "https://thenextweb.com/feed", "US", [...STARTUPS, ...AI], 74),
  feed("siliconangle", "SiliconANGLE", "https://siliconangle.com/feed/", "US", [...AI, "AI Infrastructure"], 74),
  feed("ieee", "IEEE Spectrum", "https://spectrum.ieee.org/feeds/feed.rss", "US", DEEPTECH, 84),
  feed("quanta", "Quanta Magazine", "https://www.quantamagazine.org/feed/", "US", DEEPTECH, 86),
  feed("spacenews", "SpaceNews", "https://spacenews.com/feed/", "US", ["Deeptech", "Space"], 76, { tier: 3 }),
  feed("crunchbase", "Crunchbase News", "https://news.crunchbase.com/feed/", "US", [...STARTUPS, "Funding"], 76),
  feed("bbc-tech", "BBC Technology", "https://feeds.bbci.co.uk/news/technology/rss.xml", "GLOBAL", ["Technology"], 82),
  feed("guardian-tech", "Guardian Technology", "https://www.theguardian.com/technology/rss", "GLOBAL", ["Technology"], 80),
];

// ---------- Added: India ----------

export const INDIA_FEEDS: Source[] = [
  feed("medianama", "MediaNama", "https://www.medianama.com/feed/", "IN", ["Policy", "Technology"], 72, { tier: 3 }),
  feed("livemint-tech", "Livemint Technology", "https://www.livemint.com/rss/technology", "IN", BIZ, 74, { tier: 3 }),
  feed("thehindu-scitech", "The Hindu Sci-Tech", "https://www.thehindu.com/sci-tech/feeder/default.rss", "IN", DEEPTECH, 76, { tier: 3 }),
  feed("bstandard-tech", "Business Standard Tech", "https://www.business-standard.com/rss/technology-108.rss", "IN", BIZ, 72, {
    active: false, tier: 3, note: "HTTP 403 to honest bot UA (verified). Not spoofing a browser. Use Google News fallback site:business-standard.com.",
  }),
  feed("ienexpress-tech", "Indian Express Technology", "https://indianexpress.com/section/technology/feed/", "IN", ["Technology"], 72, { tier: 3 }),
  feed("businesstoday-tech", "Business Today Tech", "https://www.businesstoday.in/rss/technology", "IN", BIZ, 68, { tier: 3 }),
  feed("techcircle", "TechCircle", "https://www.techcircle.in/rss/news", "IN", [...STARTUPS, "Technology"], 66, {
    active: false, tier: 3, note: "No working RSS endpoint found (all variants return HTML). Use Google News fallback site:techcircle.in.",
  }),
  feed("pib", "PIB India", "https://pib.gov.in/rss/lreleng.xml", "IN", ["Policy", "Government"], 70, {
    role: "official", active: false, tier: 3, note: "HTTP 403 to honest bot UA (verified). Use Google News fallback site:pib.gov.in.",
  }),
  feed("isro", "ISRO News", "https://www.isro.gov.in/rss.xml", "IN", ["Deeptech", "Space"], 78, {
    role: "official", active: false, tier: 3, note: "No stable RSS endpoint (404). Use Google News fallback site:isro.gov.in.",
  }),
];

// ---------- Added: primary (official, RSS) ----------

export const PRIMARY_FEEDS: Source[] = [
  feed("hf-blog", "Hugging Face Blog", "https://huggingface.co/blog/feed.xml", "US", [...AI, "Open Source AI"], 88, { role: "official", tier: 1 }),
  feed("nvidia-blog", "NVIDIA Blog", "https://blogs.nvidia.com/feed/", "US", [...AI, "AI Infrastructure"], 90, { role: "official", tier: 1 }),
  feed("deepmind-blog", "Google DeepMind Blog", "https://deepmind.google/blog/rss.xml", "US", [...AI, "AI Research"], 92, { role: "official", tier: 1 }),
];

// ---------- Added: signal-only (never cited as primary source) ----------

export const SIGNAL_FEEDS: Source[] = [
  feed("signal-hn", "Hacker News (front page)", "https://news.ycombinator.com/rss", "GLOBAL", [...STARTUPS, "AI Coding"], 60, {
    role: "community", tier: 1, signalOnly: true,
  }),
  // Reddit disallows all generic bots in robots.txt (`User-agent: * Disallow: /`).
  // With robots respected we cannot poll these — disabled cleanly so they don't
  // churn the run log. Re-enable only via the official Reddit API (not built).
  feed("signal-reddit-ml", "r/MachineLearning", "https://www.reddit.com/r/MachineLearning/.rss", "GLOBAL", ["AI Research"], 55, {
    role: "community", tier: 2, signalOnly: true, active: false,
    note: "Blocked by reddit robots.txt (Disallow: /). Needs the official Reddit API to enable.",
  }),
  feed("signal-reddit-startups", "r/startups", "https://www.reddit.com/r/startups/.rss", "GLOBAL", STARTUPS, 50, {
    role: "community", tier: 3, signalOnly: true, active: false,
    note: "Blocked by reddit robots.txt (Disallow: /). Needs the official Reddit API to enable.",
  }),
  feed("signal-reddit-indiatech", "r/IndiaTech", "https://www.reddit.com/r/IndiaTech/.rss", "IN", ["Technology"], 50, {
    role: "community", tier: 3, signalOnly: true, active: false,
    note: "Blocked by reddit robots.txt (Disallow: /). Needs the official Reddit API to enable.",
  }),
  feed("signal-producthunt", "Product Hunt", "https://www.producthunt.com/feed", "US", [...STARTUPS, ...AI], 55, {
    role: "launch", tier: 2, signalOnly: true,
  }),
];

// ---------- Kept unsupported: Inshorts (no feed/API, never scraped) ----------

export const UNSUPPORTED_FEEDS: Source[] = [
  stub("news:inshorts", "Inshorts", "news", 60, {
    topics: ["News"],
    region: "IN",
    note: "No official RSS or API. Will NOT be scraped. Enable only if an official feed appears.",
  }),
];

/** Old homepage/duplicate entries these feeds replace — forced inactive in sources.ts. */
export const SUPERSEDED_SOURCE_IDS: string[] = [
  "news:theverge",
  "news:mittr",
  "news:yourstory",
  "news:inc42",
  "news:aim",
  "news:ettech",
  "news:entrackr",
  "news:wired",
  "news:tnw",
  "news:siliconangle",
  "blog:deepmind",
  "blog:huggingface",
  "blog:nvidia-ai",
  "rss:hn",
  "rss:hn-show",
  "rss:reddit-ml",
  "rss:reddit-startups",
  "launch:producthunt",
];

export const NEWS_FEED_SOURCES: Source[] = [
  ...CONVERTED_FEEDS,
  ...US_GLOBAL_FEEDS,
  ...INDIA_FEEDS,
  ...PRIMARY_FEEDS,
  ...SIGNAL_FEEDS,
  ...UNSUPPORTED_FEEDS,
];
