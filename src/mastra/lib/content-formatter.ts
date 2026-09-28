import type { Story, ContentOpportunity } from "../schemas/story";

export interface FormattedSlideText {
  eyebrow?: string;
  headline: string;
  body: string;
  cta?: string;
}

export interface FormattedPostPayload {
  template_id: string;
  format: "single" | "carousel";
  aspect_ratio: "4:5" | "3:4" | "1:1";
  content: string; // Formatted markdown text payload for Design Agent planner
  structured_slots?: FormattedSlideText;
  caption: string;
  hashtags: string[];
  cover_image_url?: string;
}

/**
 * Formats a verified Story and ContentOpportunity into exact text slots
 * and post copy for the Design Agent templates, with first-class support
 * for the user's test template 'news-brief'.
 */
export function formatStoryForTemplate(
  story: Story,
  opportunity?: ContentOpportunity,
  options?: {
    template_id?: string;
    aspect_ratio?: "4:5" | "3:4" | "1:1";
    cover_image_url?: string;
  },
): FormattedPostPayload {
  const templateId = options?.template_id || "news-brief";
  const aspectRatio = options?.aspect_ratio || "4:5";

  // Derive Eyebrow (max 40 chars)
  const categoryTag = (story.category?.[0] || story.topics?.[0] || "AI").toUpperCase();
  const freshnessTag = story.freshness === "BREAKING" ? "BREAKING" : "FLASH";
  const eyebrow = `${freshnessTag} • ${categoryTag}`.slice(0, 40);

  // Derive Headline (max 110 chars)
  const headline = (opportunity?.hook || story.title).slice(0, 110);

  // Derive Body (max 480 chars for news-brief)
  const narrative = opportunity?.thesis || story.whatHappened;
  const keyFacts = (opportunity?.keyFacts || []).slice(0, 2).map((f) => `• ${f}`).join("\n");
  const bodyText = keyFacts ? `${narrative}\n\n${keyFacts}` : narrative;
  const body = bodyText.slice(0, 480);

  // CTA
  const cta = "Read full coverage at source link in bio.";

  // Formatted content blob for Design Agent's internal planner
  const content = `
# ${headline}

[${eyebrow}]

${body}

Why it matters:
${story.whyItMatters}

Source: ${story.sources[0] || "Primary industry announcement"}
`.trim();

  // Caption for Instagram / social export
  // Hashtags
  const cleanTags = [
    ...story.entities.map((e) => e.replace(/[^a-zA-Z0-9]/g, "")),
    ...story.topics.map((t) => t.replace(/[^a-zA-Z0-9]/g, "")),
    "TechNews",
    "ArtificialIntelligence",
    "AIUpdate",
  ]
    .filter(Boolean)
    .slice(0, 10);

  const hashtagBlock = cleanTags.map((t) => `#${t}`).join(" ");

  // Full Instagram caption copy
  const caption = `
${headline}

${narrative}

Key Takeaways:
${(opportunity?.keyFacts || []).map((f) => `▪ ${f}`).join("\n")}

Why it matters:
${story.whyItMatters}

Source: ${story.sources.join(" | ")}

${hashtagBlock}
`.trim();

  return {
    template_id: templateId,
    format: "single",
    aspect_ratio: aspectRatio,
    content,
    structured_slots: {
      eyebrow,
      headline,
      body,
      cta,
    },
    caption,
    hashtags: cleanTags,
    cover_image_url: options?.cover_image_url,
  };
}
