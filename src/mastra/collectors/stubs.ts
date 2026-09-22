import type { RawContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import type { SourceCollector } from "./types";

/**
 * Placeholders for platforms without official API access configured.
 * NO brittle unauthorized scraping: these throw a clear "not configured"
 * error so the pipeline records the source as unavailable and continues.
 * Plug in an official API client or compliant third-party collector later
 * by replacing the relevant class (same interface).
 */
abstract class UnavailableCollector implements SourceCollector {
  abstract readonly collectorId: string;
  abstract readonly reason: string;
  abstract supports(source: Source): boolean;

  async collect(source: Source): Promise<RawContent[]> {
    throw new Error(
      `${source.name} (${source.type}) unavailable: ${this.reason}`,
    );
  }
}

export class XCollector extends UnavailableCollector {
  readonly collectorId = "x";
  readonly reason =
    "X API access is not configured. Connect the official X API (or a compliant provider) and implement collect() against it.";
  supports(source: Source): boolean {
    return (
      source.type === "social" &&
      /^(x|twitter)$/i.test(source.id.split(/[:_-]/)[0] ?? "")
    );
  }
}

export class LinkedInCollector extends UnavailableCollector {
  readonly collectorId = "linkedin";
  readonly reason =
    "LinkedIn API access is not configured. Connect an official LinkedIn Community Management / Pages API integration.";
  supports(source: Source): boolean {
    return (
      source.type === "social" &&
      /^linkedin$/i.test(source.id.split(/[:_-]/)[0] ?? "")
    );
  }
}

export class InstagramCollector extends UnavailableCollector {
  readonly collectorId = "instagram";
  readonly reason =
    "Instagram Graph API access is not configured. Connect a Meta app with the appropriate permissions.";
  supports(source: Source): boolean {
    return (
      source.type === "social" &&
      /^instagram$/i.test(source.id.split(/[:_-]/)[0] ?? "")
    );
  }
}

export class NewsletterCollector extends UnavailableCollector {
  readonly collectorId = "newsletter";
  readonly reason =
    "No newsletter provider configured. Plug in an inbox/API integration (e.g. Substack RSS, Beehiiv API) per newsletter.";
  supports(source: Source): boolean {
    return source.type === "newsletter";
  }
}

export class ProductHuntCollector extends UnavailableCollector {
  readonly collectorId = "producthunt";
  readonly reason =
    "Product Hunt API token is not configured. Set PRODUCT_HUNT_TOKEN and implement collect() against the official GraphQL API.";
  supports(source: Source): boolean {
    return source.type === "launch";
  }
}

/** Fallback for social sources with no specific collector yet. */
export class GenericSocialStubCollector extends UnavailableCollector {
  readonly collectorId = "social-stub";
  readonly reason =
    "No collector implemented for this social source. Use an official API integration.";
  supports(source: Source): boolean {
    return source.type === "social";
  }
}

export class PodcastStubCollector extends UnavailableCollector {
  readonly collectorId = "podcast-stub";
  readonly reason =
    "No podcast feed configured. Add the show's RSS feed URL to activate collection.";
  supports(source: Source): boolean {
    return source.type === "podcast";
  }
}

export class VideoStubCollector extends UnavailableCollector {
  readonly collectorId = "video-stub";
  readonly reason =
    "YouTube Data API access is not configured. Add channel ID + API key to activate.";
  supports(source: Source): boolean {
    return source.type === "video";
  }
}

export class CommunityStubCollector extends UnavailableCollector {
  readonly collectorId = "community-stub";
  readonly reason =
    "No machine endpoint configured for this community. Add an RSS/API endpoint to activate.";
  supports(source: Source): boolean {
    return source.type === "community";
  }
}
