import type { Story, ContentOpportunity } from "../schemas/story";

export interface TemplateRoutingDecision {
  template_id: string;
  format: "single" | "carousel";
  aspect_ratio: "4:5" | "3:4" | "1:1";
  rationale: string;
}

const TEST_TEMPLATE_ID = "news-brief";

/**
 * Phase 2: Template Router.
 * Routes verified news stories to visual templates using OpenRouter with
 * the Typesafe JEV model.
 *
 * Current testing mode: Prioritizes and tests with the user's 'news-brief' template.
 */
export async function routeStoryToTemplate(
  story: Story,
  opportunity?: ContentOpportunity,
  options?: {
    forceTemplateId?: string;
    useTestTemplateOnly?: boolean;
  },
): Promise<TemplateRoutingDecision> {
  // If explicitly requested to test with news-brief, return immediately
  if (options?.forceTemplateId) {
    return {
      template_id: options.forceTemplateId,
      format: options.forceTemplateId === "news-brief" ? "single" : "carousel",
      aspect_ratio: "4:5",
      rationale: `Manual override specified: ${options.forceTemplateId}`,
    };
  }

  // Testing mode specified by user: use news-brief
  if (options?.useTestTemplateOnly !== false) {
    return {
      template_id: TEST_TEMPLATE_ID,
      format: "single",
      aspect_ratio: "4:5",
      rationale: "Selected 'news-brief' single-slide editorial layout for testing.",
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return heuristicRoute(story, opportunity);
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://mastra.ai",
        "X-Title": "News Engine Template Router",
      },
      body: JSON.stringify({
        model: "typesafe/jev",
        messages: [
          {
            role: "system",
            content:
              "You are the visual layout router. Choose the best template for this story. " +
              "Available templates: news-brief (breaking news flash, single slide), " +
              "tech-announcement (bold tech model release, carousel or single), " +
              "360labs-news (editorial newspaper style, carousel), " +
              "keilhq-editorial (quiet long-form reflection). " +
              "Return JSON with keys: template_id, format, aspect_ratio, rationale.",
          },
          {
            role: "user",
            content: `Story: ${JSON.stringify({
              title: story.title,
              classification: story.category?.[0],
              hook: opportunity?.hook,
              thesis: opportunity?.thesis,
            })}`,
          },
        ],
        temperature: 0.1,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as TemplateRoutingDecision;
          if (parsed.template_id) return parsed;
        }
      }
    }
  } catch {
    // OpenRouter fallback to deterministic routing
  }

  return heuristicRoute(story, opportunity);
}

function heuristicRoute(story: Story, opportunity?: ContentOpportunity): TemplateRoutingDecision {
  const classification = (story.category?.[0] || "").toLowerCase();

  if (classification.includes("launch") || classification.includes("announcement")) {
    return {
      template_id: TEST_TEMPLATE_ID,
      format: "single",
      aspect_ratio: "4:5",
      rationale: "Defaulted to news-brief for breaking announcements.",
    };
  }

  return {
    template_id: TEST_TEMPLATE_ID,
    format: "single",
    aspect_ratio: "4:5",
    rationale: "Selected news-brief test template.",
  };
}
