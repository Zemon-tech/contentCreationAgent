import type { RasPayload } from "../../schemas/handoff";
import type { FactPack } from "../../schemas/factpack";
import type { RankInputItem } from "../../schemas/ranking";
import { ACCENT_COLORS } from "../../templates/theme";

/**
 * Build the RAS payload deterministically from the ranked item + fact pack +
 * sourced image. Since we call RAS's render/publish tools directly (not the
 * agent), this fills the render-ready copy too. It NEVER invents details —
 * all copy is drawn from the fact pack; `factPackLimited` keeps it minimal.
 *
 * NOTE: this is template-filled copy, not RAS's LLM editorial voice. Flagged.
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

function accentFor(topics: string[], text: string): Accent {
  const hay = `${topics.join(" ")} ${text}`.toLowerCase();
  if (/breaking|launch|unveil|releases?\b/.test(hay)) return "#F25C3D";
  if (/fund|raise|series [a-e]\b|\$\d|valuation|acqui/.test(hay)) return "#E2A72E";
  if (/deeptech|space|quantum|chip|future|robot/.test(hay)) return "#C7E84A";
  return "#2F7C74";
}

export function buildRasPayload(args: {
  item: RankInputItem;
  factPack: FactPack;
  image: { imageLocalPath: string | null; imageSourceUrl: string | null; imageAttribution: string | null; under1080: boolean };
  suggestedCaptionAngle?: string;
}): RasPayload {
  const { item, factPack, image } = args;
  const topics = item.rawCategories ?? [];
  const accentColor = accentFor(topics, `${item.title} ${factPack.keyFacts.join(" ")}`);

  const categoryTag = (topics.length ? topics : ["AI"]).slice(0, 3).map((t) => safeLatin(t).toUpperCase()).join(" · ");
  const deckLead = clipWords(factPack.keyFacts[0] ?? item.summary, 60);
  const deckHighlight = clipWords(factPack.figures[0] ?? factPack.names[0] ?? "Why it matters", 40);
  const deckTail = clipWords(factPack.keyFacts[1] ?? "", 60);

  const srcLine = factPack.primarySource ?? factPack.sourceUrls[0] ?? item.url;
  const limitNote = factPack.factPackLimited ? " (headline-level; details limited)" : "";
  const caption = clip(
    `${factPack.headline}. ${factPack.keyFacts.slice(0, 2).join(" ")}${limitNote}\n\nSource: ${srcLine}`,
    2000,
  );

  const hashtags = buildHashtags(topics, item.region);

  return {
    headline: factPack.headline,
    factPack,
    sourceUrls: factPack.sourceUrls,
    primaryUrl: item.url,
    region: item.region,
    suggestedFormat: "single",
    suggestedCaptionAngle: safeLatin(args.suggestedCaptionAngle ?? "Why it matters"),
    imageLocalPath: image.imageLocalPath,
    imageSourceUrl: image.imageSourceUrl,
    imageAttribution: image.imageAttribution,
    rightsStatus: "unverified",
    imageUnder1080: image.under1080,
    serifHeadline: clip(factPack.headline, 120),
    categoryTag,
    deckLead,
    deckHighlight,
    deckTail,
    accentColor,
    caption,
    hashtags,
    factPackLimited: factPack.factPackLimited,
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
