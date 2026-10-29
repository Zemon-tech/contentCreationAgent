import type { RasPayload } from "../../schemas/handoff";
import type { FactPack } from "../../schemas/factpack";
import type { RankInputItem, RankedStory } from "../../schemas/ranking";
import type { EditorialCopy } from "./copywriter";
import { ACCENT_COLORS } from "../../templates/theme";

type Fact = RasPayload["facts"][number];

/**
 * Build the RAS payload from the ranked item + fact pack + sourced image. Since
 * we call RAS's render/publish tools directly (not the agent), this fills the
 * render-ready copy too.
 *
 * The five copy fields (serifHeadline, deckLead, deckHighlight, deckTail,
 * caption) come from the LLM editorial copywriter (lib/ras/copywriter.ts) when
 * `args.llmCopy` is supplied; otherwise they are filled deterministically from
 * the fact pack (the fallback — NEVER invents details; `factPackLimited` keeps
 * it minimal). EITHER WAY the output passes through safeLatin + hard length
 * clipping below, so brand-font-unsafe glyphs and over-length strings can never
 * reach the renderer. categoryTag/accentColor/hashtags stay rule-based.
 */

type Accent = (typeof ACCENT_COLORS)[number];

/** Strip to characters the RAS brand fonts can render (no arrows/emoji). */
function safeLatin(text: string): string {
  // RAS brand fonts render safe Latin only — keep ASCII printable + tab/newline,
  // dropping arrows, emoji, triangles and other non-Latin glyphs.
  return (text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&rsquo;|&#8217;/g, "'")
    .replace(/&lsquo;|&#8216;/g, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
    .replace(/&mdash;|&ndash;|&#8212;|&#8211;/g, "-")
    .replace(/&hellip;|&#8230;/g, "...")
    .replace(/&amp;/g, "&")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fit short on-image text (deck lines) by cutting at a WORD boundary with no
 * ellipsis, so a line never ends mid-word ("...for its Mus...").
 */
export function clipWords(text: string, max: number): string {
  const t = safeLatin(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp >= Math.floor(max / 2) ? cut.slice(0, sp) : cut).replace(/[\s,;:-]+$/, "").trim();
}

function clip(text: string, max: number): string {
  const t = safeLatin(text);
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Word-safe clip for the tweet BODY. Cuts at a word boundary with no ellipsis
 * and NEVER emits a mid-word fragment or a partial URL. When the retained
 * window up to `max` has no internal whitespace, the text is a single unbroken
 * token longer than `max` (a URL or one giant word): there is no word boundary
 * to cut on, so the whole fragment is DROPPED (empty string returned) rather
 * than published hard-cut mid-word. Callers treat an empty result as "no usable
 * body" and fall back accordingly. Always returns <= `max`.
 */
function clipTweetBody(text: string, max: number): string {
  const t = safeLatin(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  if (sp <= 0) {
    // No whitespace in the retained window: a single overlong token (URL or one
    // giant word). There is no safe place to break, so drop it entirely instead
    // of publishing a mid-word / partial-URL fragment.
    return "";
  }
  return cut.slice(0, sp).replace(/[\s,;:-]+$/, "").trim();
}

/** Matches an http(s)/www URL token so it can be shielded from hashtag edits
 *  (a '#' inside a URL is a fragment, never an X hashtag). */
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;

/**
 * Enforce the 0-2 hashtag cap on a model-written tweet WITHOUT discarding the
 * rest of the copy: keep the first two X-recognized hashtags in place and strip
 * any extras, regardless of the punctuation in front of them. X treats '#tag'
 * as a hashtag whenever the '#' is NOT preceded by another word character, so
 * tags after '(' or '/' (e.g. "News (#ai) #ml", "News #ai/#ml/#tech") count
 * just like whitespace-separated ones — the old `(^|\s)#...` form missed those.
 * URL fragments ("example.com/p#section") are shielded first so they are never
 * counted or stripped. Collapses the whitespace left by removed tags.
 */
function capHashtags(text: string, maxTags = 2): string {
  // Shield URLs so a '#fragment' inside one is never treated as a hashtag.
  const urls: string[] = [];
  const shielded = text.replace(URL_RE, (u) => {
    urls.push(u);
    return `\u0000${urls.length - 1}\u0000`;
  });

  let seen = 0;
  // A hashtag starts at '#' only when it is not preceded by a word character
  // (so "foo#bar" is not a tag); the '#' itself may follow any punctuation or
  // whitespace. `(^|[^\w#])` captures the single non-word char to preserve it.
  const capped = shielded.replace(/(^|[^\w#])#[A-Za-z0-9_]+/g, (match, pre: string) => {
    seen += 1;
    return seen <= maxTags ? match : pre;
  });

  const restored = capped.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => urls[Number(i)] ?? "");
  return restored.replace(/[ \t]{2,}/g, " ").replace(/ +([.!?,;:])/g, "$1").trim();
}

/**
 * Build the deterministic tweet: the headline is the required body, the
 * attribution/source is an ATOMIC suffix that is appended only when the whole
 * string still fits under `max` — a suffix that does not fit is DROPPED, never
 * published half-cut. The headline body is clipped word-safe as a last resort.
 * Always returns <= `max`.
 */
function buildTweetWithSuffix(headline: string, suffix: string, max: number): string {
  const head = safeLatin(headline);
  const suf = safeLatin(suffix);
  if (suf) {
    const combined = `${head} ${suf}`.trim();
    if (combined.length <= max) return combined;
  }
  // Suffix does not fit (or is empty): publish the word-safe headline alone.
  return clipTweetBody(head, max);
}

/**
 * Normalize a MODEL-written tweet: cap hashtags at 2, then clip word-safe to
 * `max`. Always returns <= `max`.
 */
function clipTweet(text: string, max = 280): string {
  return clipTweetBody(capHashtags(text), max);
}

function accentFor(topics: string[], text: string): Accent {
  const hay = `${topics.join(" ")} ${text}`.toLowerCase();
  if (/breaking|launch|unveil|releases?\b/.test(hay)) return "#F25C3D";
  if (/fund|raise|series [a-e]\b|\$\d|valuation|acqui/.test(hay)) return "#E2A72E";
  if (/deeptech|space|quantum|chip|future|robot/.test(hay)) return "#C7E84A";
  return "#2F7C74";
}

/**
 * Build the authoritative claim set with per-claim provenance.
 *
 * RSS / fact-pack items: each grounded key fact becomes a fact pinned to the
 * best available source — the primary source URL with sourceType 'primary'
 * when one exists, else the first citable source URL with sourceType 'rss'.
 *
 * FIX #8 (X items): pin facts[] to the derived headline against the post URL
 * (or first outbound when no post URL), PLUS one entry per resolved outbound
 * URL. An outbound entry is 'primary' when the story is verified (official /
 * primary / corroborated) else 'x'. The vague "claim sentences" extraction is
 * dropped for X — only the derived headline and real outbound URLs are facts.
 */
function buildFacts(args: {
  isX: boolean;
  factPack: FactPack;
  item: RankInputItem;
  derivedHeadline?: string;
  outboundUrls: string[];
  verified: boolean;
}): Fact[] {
  const { isX, factPack, item, derivedHeadline, outboundUrls, verified } = args;

  if (isX) {
    const headlineClaim = (derivedHeadline || factPack.headline || item.title || "").trim();
    const postUrl = item.url;
    const anchorUrl = postUrl || outboundUrls[0] || "";
    const facts: Fact[] = [];
    if (headlineClaim && anchorUrl) {
      // The headline claim is 'primary' only when the anchor is a resolved
      // outbound source and the story is verified; otherwise it is an X claim.
      const anchorIsOutbound = !postUrl && !!outboundUrls[0];
      facts.push({
        claim: headlineClaim,
        sourceUrl: anchorUrl,
        sourceType: anchorIsOutbound && verified ? "primary" : "x",
      });
    }
    for (const url of outboundUrls) {
      if (!url) continue;
      facts.push({ claim: headlineClaim || url, sourceUrl: url, sourceType: verified ? "primary" : "x" });
    }
    // Dedupe by sourceUrl (keep the first, most authoritative occurrence).
    const seen = new Set<string>();
    return facts.filter((f) => (seen.has(f.sourceUrl) ? false : (seen.add(f.sourceUrl), true)));
  }

  // RSS / fact-pack path: ground each key fact to the best available source.
  const hasPrimary = !!factPack.primarySource;
  const sourceUrl = factPack.primarySource ?? factPack.sourceUrls[0] ?? item.url;
  const sourceType: Fact["sourceType"] = hasPrimary ? "primary" : "rss";
  if (!sourceUrl) return [];
  return factPack.keyFacts
    .map((f) => f.trim())
    .filter(Boolean)
    .map((claim) => ({ claim, sourceUrl, sourceType }));
}

export function buildRasPayload(args: {
  item: RankInputItem;
  factPack: FactPack;
  image: { imageLocalPath: string | null; imageSourceUrl: string | null; imageAttribution: string | null; under1080: boolean };
  suggestedCaptionAngle?: string;
  /** LLM-written copy; when present it overrides the five template fields. */
  llmCopy?: EditorialCopy | null;
  /** Extra citable source URLs (e.g. Exa enrichment) merged into sourceUrls. */
  extraSourceUrls?: string[];
  /** The selected ranked story (carries X-signal/quality fields). */
  story?: RankedStory | null;
  /** The author handle for an X-sourced story (lowercased). */
  authorHandle?: string | null;
  /** True when this story is X-only (no corroborating RSS) — drives attribution. */
  isXOnly?: boolean;
}): RasPayload {
  const { item, factPack, image, llmCopy, story } = args;
  const isX = item.isX === true || story?.item?.isX === true;
  const topics = item.rawCategories ?? [];

  const derivedHeadline = story?.derivedHeadline ?? item.derivedHeadline;
  const hookPotential = story?.hookPotential ?? item.hookPotential;
  const claimRisk = story?.claimRisk ?? item.claimRisk ?? "low";
  const verified = story?.verified ?? false;
  const outboundUrls = story?.outboundUrls ?? item.outboundUrls ?? [];
  const quoted = story?.quoted ?? item.quoted ?? null;

  const authorHandle = (args.authorHandle ?? story?.item?.authorHandle ?? item.authorHandle ?? "").replace(/^@/, "");
  // Attribution only when the X story stands alone (no corroborating RSS).
  const attributionLine = isX && args.isXOnly && authorHandle ? `per @${authorHandle} on X` : null;

  const facts = buildFacts({ isX, factPack, item, derivedHeadline, outboundUrls, verified });

  const accentColor = accentFor(topics, `${item.title} ${factPack.keyFacts.join(" ")}`);

  const categoryTag = (topics.length ? topics : ["AI"]).slice(0, 3).map((t) => safeLatin(t).toUpperCase()).join(" · ");

  const srcLine = factPack.primarySource ?? factPack.sourceUrls[0] ?? item.url;
  const limitNote = factPack.factPackLimited ? " (headline-level; details limited)" : "";

  // Copy: LLM editorial when available, deterministic template otherwise. Both
  // paths pass through safeLatin + hard clipping below as the final backstop.
  // Prefer the derived headline over the raw first line for X items.
  const baseHeadline = isX ? derivedHeadline || factPack.headline : factPack.headline;
  const serifHeadline = clip(llmCopy?.serifHeadline || baseHeadline, 120);
  const deckLead = clipWords(llmCopy?.deckLead || factPack.keyFacts[0] || item.summary, 60);
  const deckHighlight = clipWords(llmCopy?.deckHighlight || factPack.figures[0] || factPack.names[0] || "Why it matters", 40);
  const deckTail = clipWords(llmCopy?.deckTail || factPack.keyFacts[1] || "", 60);
  const caption = clip(
    llmCopy?.caption ||
      `${factPack.headline}. ${factPack.keyFacts.slice(0, 2).join(" ")}${limitNote}\n\nSource: ${srcLine}`,
    2000,
  );

  // Merge any enrichment URLs into the citable source list (deduped).
  const sourceUrls = [...new Set([...factPack.sourceUrls, ...(args.extraSourceUrls ?? [])].map((u) => u.trim()).filter(Boolean))];

  // X caption: prefer the LLM's standalone tweet (normalized — hashtags capped
  // at 2, then clipped word-safe to <= 280); else build deterministically from
  // the derived/base headline + an ATOMIC attribution (X-only) or primary-source
  // suffix that is dropped whole when it does not fit. Either way always <= 280
  // and never a partial URL. NEVER a truncated IG caption.
  const attributionOrSource = attributionLine ?? factPack.primarySource ?? sourceUrls[0] ?? item.url ?? "";
  const xCaption = llmCopy?.xCaption
    ? clipTweet(llmCopy.xCaption, 280)
    : buildTweetWithSuffix(baseHeadline ?? "", attributionOrSource, 280);

  const hashtags = buildHashtags(topics, item.region);

  return {
    headline: isX ? derivedHeadline || factPack.headline : factPack.headline,
    factPack,
    sourceUrls,
    primaryUrl: item.url,
    region: item.region,
    suggestedFormat: "single",
    suggestedCaptionAngle: safeLatin(args.suggestedCaptionAngle ?? "Why it matters"),
    imageLocalPath: image.imageLocalPath,
    imageSourceUrl: image.imageSourceUrl,
    imageAttribution: image.imageAttribution,
    rightsStatus: "unverified",
    imageUnder1080: image.under1080,
    serifHeadline,
    categoryTag,
    deckLead,
    deckHighlight,
    deckTail,
    accentColor,
    caption,
    xCaption,
    hashtags,
    factPackLimited: factPack.factPackLimited,
    // X-signal / quality extensions (empty/default for RSS).
    ...(derivedHeadline ? { derivedHeadline } : {}),
    ...(hookPotential != null ? { hookPotential } : {}),
    facts,
    verified,
    claimRisk,
    outboundUrls,
    quoted,
    attributionLine,
  };
}

function buildHashtags(topics: string[], region: string): string[] {
  const base = new Set<string>(["#AI", "#startups", "#deeptech", "#tech"]);
  if (region === "IN") base.add("#india").add("#indianstartups");
  for (const t of topics) {
    const tag = safeLatin(t).replace(/[^A-Za-z0-9]/g, "");
    if (tag.length >= 2 && tag.length <= 20) base.add(`#${tag}`);
  }
  return [...base].slice(0, 8);
}
