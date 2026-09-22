import { z } from "zod";

const AuthorSchema = z.object({
  name: z.string().optional(),
  handle: z.string().optional(),
  url: z.string().optional(),
});

const MediaSchema = z.object({
  type: z.enum(["image", "video", "audio"]),
  url: z.string().optional(),
});

const EngagementSchema = z.object({
  likes: z.number().optional(),
  comments: z.number().optional(),
  shares: z.number().optional(),
  views: z.number().optional(),
});

export const RawContentSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceType: z.string().min(1),
  url: z.string().min(1),
  title: z.string().optional(),
  content: z.string().min(1),
  author: AuthorSchema.optional(),
  /** ISO-8601 timestamp of original publication, when known. */
  publishedAt: z.string().optional(),
  /** ISO-8601 timestamp of collection. */
  collectedAt: z.string(),
  media: z.array(MediaSchema).optional(),
  engagement: EngagementSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RawContent = z.infer<typeof RawContentSchema>;

/**
 * Normalized content. The original raw fields are always preserved;
 * normalization only ADDS cleaned/derived fields.
 */
export const NormalizedContentSchema = RawContentSchema.extend({
  normalizedTitle: z.string(),
  /** Cleaned plain-text body: HTML stripped, whitespace collapsed. */
  normalizedText: z.string(),
  /** sha256 over normalized title + text. Level-2 dedup key. */
  contentHash: z.string(),
  /** Deterministic embedding vector for Level-3 semantic dedup. */
  embedding: z.array(z.number()),
  normalizedUrl: z.string(),
  /**
   * Intelligence timestamps (event time vs discovery time — NOT interchangeable):
   * - eventAt: when the actual event happened (best estimate; defaults to publishedAt).
   * - firstReportedAt: when the event was first publicly reported.
   * - latestUpdateAt: when meaningful new information appeared.
   * - discoveredAt: when our system found the information (= collectedAt).
   */
  eventAt: z.string().optional(),
  firstReportedAt: z.string().optional(),
  latestUpdateAt: z.string().optional(),
  discoveredAt: z.string().optional(),
});

export type NormalizedContent = z.infer<typeof NormalizedContentSchema>;
