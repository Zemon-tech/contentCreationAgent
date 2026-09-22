import type { Analysis, Classification } from "../schemas/analysis";
import type { IndustryConfig } from "../config/industry";
import type { NormalizedContent } from "../schemas/rawContent";
import { tokenize } from "./embeddings";

/** Well-known products/models count as entities for matching purposes. */
export const PRODUCT_ENTITIES = [
  "GPT",
  "Claude",
  "Gemini",
  "Grok",
  "Llama",
  "Copilot",
  "Cursor",
  "vLLM",
];

/**
 * Topic matches when the full phrase appears, or every long part (>3
 * chars) appears as a whole token (with singular/plural tolerance).
 * Short parts like "AI" are ignored on their own to avoid noise.
 */
export function topicMatches(topic: string, lower: string, tokens: Set<string>): boolean {
  const t = topic.toLowerCase();
  if (lower.includes(t)) return true;
  const parts = t.split(/[\s-]+/).filter((w) => w.length > 3);
  if (parts.length === 0) return false;
  return parts.every(
    (p) =>
      tokens.has(p) ||
      tokens.has(`${p}s`) ||
      (p.endsWith("s") && tokens.has(p.slice(0, -1))),
  );
}

const CLASSIFICATION_RULES: { classification: Classification; patterns: RegExp[] }[] = [
  {
    classification: "funding",
    patterns: [/rais\w*\s+\$|series\s+[a-d]\b|funding round|valued at/i],
  },
  {
    classification: "acquisition",
    patterns: [/acqui\w+|merger|acquired by|buyout/i],
  },
  {
    classification: "product_launch",
    patterns: [/launch\w*|introducing|now available|now generally available|ships today/i],
  },
  {
    classification: "announcement",
    patterns: [/announc\w+|unveil\w*|releases? (v?\d|new)|we'?re (launching|releasing|introducing)/i],
  },
  {
    classification: "research",
    patterns: [/paper|arxiv|study finds|researchers|benchmark|peer-?reviewed/i],
  },
  {
    classification: "tutorial",
    patterns: [/how to|tutorial|guide to|step-?by-?step|getting started/i],
  },
  {
    classification: "opinion",
    patterns: [/\b(opinion|op-?ed|hot take|i think|why .* (matters|matters not)|rant)\b/i],
  },
  {
    classification: "controversy",
    patterns: [/backlash|lawsuit|suing|controvers\w+|criticism|scandal/i],
  },
  {
    classification: "technical_update",
    patterns: [/changelog|patch|bugfix|deprecat\w+|migration guide|release notes/i],
  },
  {
    classification: "company_update",
    patterns: [/hiring|joins? as|leadership|restructur\w+|layoffs?/i],
  },
  {
    classification: "industry_trend",
    patterns: [/trend|state of|report:|survey|forecast|market/i],
  },
  {
    classification: "community_discussion",
    patterns: [/reddit|hacker news|discussion|ama\b|thread/i],
  },
];

const NOVELTY_PATTERNS = [
  /\b(first|new|novel|breakthrough|sota|state-of-the-art|record)\b/i,
  /\b(announc|launch|introduc|unveil|release)\w*/i,
];

const LOW_VALUE_PATTERNS = [
  /\b(sports|football|premier league|basketball|match report|transfer news)\b/i,
  /\b(recipe|horoscope|celebrity gossip)\b/i,
];

/**
 * Deterministic heuristic analyzer. Used as the offline/testable fallback
 * AND as the pre-score for LLM enrichment. The LLM (aggregatorAgent) only
 * handles interpretation — relevance/novelty/impact/content-potential
 * judgment — never fact invention.
 */
export function analyzeContent(
  item: NormalizedContent,
  industry: IndustryConfig,
): Analysis {
  const haystack = `${item.normalizedTitle}\n${item.normalizedText}`;
  const lower = haystack.toLowerCase();
  const tokens = new Set(tokenize(haystack));

  const topics = industry.topics.filter((t) => topicMatches(t, lower, tokens));

  const keywordHits = industry.keywords.filter((k) =>
    lower.includes(k.toLowerCase()),
  );
  const companyEntities = industry.entities.filter((e) =>
    lower.includes(e.toLowerCase()),
  );
  const productEntities = PRODUCT_ENTITIES.filter((e) =>
    lower.includes(e.toLowerCase()),
  );
  const entities = [...new Set([...companyEntities, ...productEntities])];

  let classification: Classification = "other";
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) {
      classification = rule.classification;
      break;
    }
  }

  const isExcluded =
    industry.excludedTopics?.some((t) => lower.includes(t.toLowerCase())) ??
    false;
  const isLowValue = LOW_VALUE_PATTERNS.some((p) => p.test(haystack));

  // Relevance: industry signal density.
  let relevance = Math.min(
    10,
    keywordHits.length * 1.5 + entities.length * 1.2 + topics.length * 0.8,
  );
  if (entities.length === 0 && keywordHits.length === 0 && topics.length === 0) {
    relevance = isLowValue || isExcluded ? 0.5 : 2;
  }
  if (isExcluded) relevance = Math.min(relevance, 1);

  const novelty = Math.min(
    10,
    3 +
      NOVELTY_PATTERNS.filter((p) => p.test(haystack)).length * 2 +
      (classification === "research" ||
      classification === "product_launch" ||
      classification === "announcement"
        ? 2
        : 0),
  );

  const impact =
    classification === "acquisition" || classification === "funding"
      ? Math.min(10, 6 + entities.length)
      : classification === "product_launch" || classification === "announcement"
        ? Math.min(10, 5 + entities.length * 0.8)
        : Math.min(10, 2 + topics.length * 0.7 + entities.length * 0.5);

  const lengthBonus = Math.min(2, item.normalizedText.length / 2000);
  const audienceInterest = Math.min(
    10,
    2 + entities.length * 0.8 + topics.length * 0.5 + lengthBonus,
  );
  const contentPotential = Math.min(
    10,
    2 +
      novelty * 0.4 +
      (classification === "opinion" || classification === "controversy"
        ? 2
        : 0) +
      lengthBonus,
  );

  const sourceIsPrimary =
    item.sourceType === "github" ||
    classification === "announcement" ||
    classification === "product_launch" ||
    classification === "research";
  const confidence = Math.min(
    0.95,
    0.5 +
      (sourceIsPrimary ? 0.2 : 0) +
      Math.min(0.2, entities.length * 0.05) +
      (item.publishedAt ? 0.05 : 0),
  );

  const summary = makeSummary(item);
  return {
    contentId: item.id,
    classification,
    topics,
    entities,
    relevance: round1(relevance),
    novelty: round1(novelty),
    impact: round1(impact),
    audienceInterest: round1(audienceInterest),
    contentPotential: round1(contentPotential),
    confidence: round1(confidence),
    summary,
    whyItMatters: makeWhyItMatters(classification, entities, topics, industry),
    possibleAngles: makeAngles(classification, entities),
    heuristic: true,
  };
}

export function analyzeBatch(
  items: NormalizedContent[],
  industry: IndustryConfig,
): Analysis[] {
  return items.map((i) => analyzeContent(i, industry));
}

function makeSummary(item: NormalizedContent): string {
  const first = item.normalizedText.split(/(?<=[.!?])\s+/)[0] ?? "";
  const base = first.length > 40 ? first : item.normalizedText.slice(0, 220);
  return `${item.normalizedTitle} — ${base}`.slice(0, 500);
}

function makeWhyItMatters(
  classification: Classification,
  entities: string[],
  topics: string[],
  industry: IndustryConfig,
): string {
  const who = entities.length > 0 ? entities.join(", ") : "industry players";
  const what = topics.length > 0 ? topics.join(", ") : industry.name;
  const frames: Record<Classification, string> = {
    announcement: `${who} made an official move relevant to ${what}; primary-source signal worth covering quickly.`,
    product_launch: `New capability from ${who} in ${what}; developers need to know what changed and how to use it.`,
    research: `New evidence in ${what} from ${who}; useful for technical depth and authority content.`,
    funding: `Capital flowing to ${who} signals momentum in ${what}; startup-ecosystem angle.`,
    acquisition: `Consolidation involving ${who} reshapes ${what}; explain winners, losers, alternatives.`,
    company_update: `${who} changed organizationally; context for their ${what} roadmap.`,
    technical_update: `Practical change for builders on ${who}'s stack in ${what}.`,
    industry_trend: `Directional data on ${what}; good for analysis and commentary formats.`,
    opinion: `A viewpoint on ${what}; useful as a debate hook if grounded in stronger sources.`,
    tutorial: `Hands-on ${what} material; evergreen how-to potential.`,
    controversy: `Disputed claims around ${who} in ${what}; needs primary-source verification before covering.`,
    community_discussion: `Community signal on ${what}; sentiment check, not a primary fact source.`,
    other: `Possibly relevant to ${what}; verify against primary sources before use.`,
  };
  return frames[classification];
}

function makeAngles(classification: Classification, entities: string[]): string[] {
  const who = entities[0] ?? "the team";
  const base = [
    "What changed?",
    `Why ${industry_agnostic_audience()} should care`,
    "Industry impact",
  ];
  const extra: Record<Classification, string[]> = {
    announcement: [`What ${who} actually shipped`, "What to try first"],
    product_launch: ["Hands-on first look", "How it compares to alternatives"],
    research: ["Key result, simply explained", "What it unlocks next"],
    funding: ["Why investors bet here", "What the money buys"],
    acquisition: ["Why this deal happened", "What changes for users"],
    company_update: ["Reading between the lines", "What it means for the roadmap"],
    technical_update: ["Upgrade guide", "Breaking changes to watch"],
    industry_trend: ["The data behind the trend", "Counter-arguments"],
    opinion: ["Steel-manning the take", "Where the take is wrong"],
    tutorial: ["The 5-minute version", "Common pitfalls"],
    controversy: ["What is verified vs alleged", "All sides, with sources"],
    community_discussion: ["What the community gets right", "Signal vs noise"],
    other: ["Background context", "Related developments"],
  };
  return [...base, ...(extra[classification] ?? [])].slice(0, 5);

  function industry_agnostic_audience(): string {
    return "developers";
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
