/**
 * Instagram publishing client — Instagram Graph API (Meta).
 *
 * Publishing to Instagram requires an Instagram *Professional* account
 * (Business or Creator) linked to a Facebook Page, plus a long-lived
 * access token with the `instagram_basic` + `instagram_content_publish`
 * (and, for Facebook-login flows, `pages_read_engagement`) permissions.
 *
 * Publishing is ALWAYS a two-step (single) or three-step (carousel) dance:
 *   single image:  create container (image_url) -> media_publish
 *   carousel:      create N item containers (is_carousel_item=true)
 *                  -> create parent container (media_type=CAROUSEL, children)
 *                  -> media_publish
 *
 * Meta fetches `image_url` from its own servers, so every image URL MUST be
 * publicly reachable over HTTPS (localhost / private IPs will fail). See
 * `buildPublicImageUrl` in instagram-publish.ts for how we expose the
 * Design Agent slides.
 *
 * Robustness baked in here:
 * - env validation with actionable messages
 * - bounded retries with exponential backoff on transient (5xx / network /
 *   rate-limit) failures, never on 4xx auth/permission errors
 * - container readiness polling (containers are async: FINISHED / IN_PROGRESS
 *   / ERROR / EXPIRED / PUBLISHED)
 * - typed, structured errors that carry the Graph API error subcode
 * - a dry-run switch so callers can validate a payload without publishing
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
 */

const DEFAULT_GRAPH_VERSION = "v23.0";
const GRAPH_BASE = "https://graph.facebook.com";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface InstagramConfig {
  /** Instagram Professional account id (the IG User id, NOT the @handle). */
  igUserId: string;
  /** Long-lived access token with content-publishing permission. */
  accessToken: string;
  /** Graph API version, e.g. "v23.0". Configurable so it is easy to bump. */
  graphVersion: string;
  /** When true, calls are validated and logged but never actually published. */
  dryRun: boolean;
}

export class InstagramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstagramConfigError";
  }
}

export class InstagramApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly fbtraceId?: string;
  readonly retriable: boolean;
  constructor(
    message: string,
    opts: {
      status: number;
      code?: number;
      subcode?: number;
      fbtraceId?: string;
      retriable: boolean;
    },
  ) {
    super(message);
    this.name = "InstagramApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.subcode = opts.subcode;
    this.fbtraceId = opts.fbtraceId;
    this.retriable = opts.retriable;
  }
}

/**
 * Reads Instagram config from the environment. Does not throw for a missing
 * token/id unless `require` is true — callers that only want to *report*
 * connection status can inspect the partial result.
 */
export function readInstagramConfig(options?: { require?: boolean }): {
  config: InstagramConfig | null;
  missing: string[];
} {
  const igUserId = process.env.INSTAGRAM_ACCOUNT_ID?.trim() || "";
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN?.trim() || "";
  const graphVersion =
    process.env.INSTAGRAM_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
  const dryRun = /^(1|true|yes)$/i.test(process.env.INSTAGRAM_DRY_RUN?.trim() || "");

  const missing: string[] = [];
  if (!igUserId) missing.push("INSTAGRAM_ACCOUNT_ID");
  if (!accessToken) missing.push("INSTAGRAM_ACCESS_TOKEN");

  if (missing.length > 0) {
    if (options?.require) {
      throw new InstagramConfigError(
        `Instagram is not configured. Missing env var(s): ${missing.join(", ")}. ` +
          `Add them to your .env (see .env.example) and restart the dev server.`,
      );
    }
    return { config: null, missing };
  }

  return {
    config: { igUserId, accessToken, graphVersion, dryRun },
    missing: [],
  };
}

// ---------------------------------------------------------------------------
// Low-level Graph API request helper
// ---------------------------------------------------------------------------

interface GraphErrorShape {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/** HTTP statuses / Graph codes we treat as transient and safe to retry. */
function isRetriableStatus(status: number): boolean {
  // 5xx server errors, 429 rate limit. 4xx auth/permission errors are fatal.
  return status >= 500 || status === 429;
}

async function graphRequest<T>(
  config: InstagramConfig,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  opts?: { retries?: number; baseDelayMs?: number },
): Promise<T> {
  const retries = opts?.retries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 800;

  const url = new URL(`${GRAPH_BASE}/${config.graphVersion}/${path}`);
  const body = new URLSearchParams();
  body.set("access_token", config.accessToken);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    body.set(key, String(value));
  }

  // GET puts params on the query string; POST sends them as form body.
  const fetchInit: RequestInit = { method };
  if (method === "GET") {
    for (const [k, v] of body.entries()) url.searchParams.set(k, v);
  } else {
    fetchInit.body = body;
    fetchInit.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url.toString(), fetchInit);
      const text = await res.text();
      let json: (T & GraphErrorShape) | GraphErrorShape = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        // Non-JSON body (e.g. an HTML gateway error page).
      }

      if (!res.ok || (json as GraphErrorShape).error) {
        const err = (json as GraphErrorShape).error;
        const retriable = isRetriableStatus(res.status);
        const apiError = new InstagramApiError(
          err?.message ||
            `Instagram Graph API ${method} /${path} failed (HTTP ${res.status})`,
          {
            status: res.status,
            code: err?.code,
            subcode: err?.error_subcode,
            fbtraceId: err?.fbtrace_id,
            retriable,
          },
        );
        if (retriable && attempt < retries) {
          lastError = apiError;
          await sleep(baseDelayMs * 2 ** attempt);
          continue;
        }
        throw apiError;
      }

      return json as T;
    } catch (error) {
      // Network-level failure (DNS, socket, timeout) — transient, retry.
      if (error instanceof InstagramApiError && !error.retriable) throw error;
      lastError = error;
      if (attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Instagram Graph API request failed: ${String(lastError)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Connection / health check
// ---------------------------------------------------------------------------

export interface InstagramConnectionStatus {
  connected: boolean;
  dryRun: boolean;
  graphVersion: string;
  accountId?: string;
  username?: string;
  accountType?: string;
  /** Remaining API-published posts in the rolling 24h window, if available. */
  publishingLimit?: {
    quotaUsage: number;
    quotaTotal: number;
  };
  missing: string[];
  error?: string;
}

/**
 * Verifies the token can see the configured account and (best-effort) reads
 * the current publishing rate-limit usage. Never throws — returns a status
 * object so tools can surface a clean "not connected" message.
 */
export async function checkInstagramConnection(): Promise<InstagramConnectionStatus> {
  const { config, missing } = readInstagramConfig();
  if (!config) {
    return {
      connected: false,
      dryRun: false,
      graphVersion: DEFAULT_GRAPH_VERSION,
      missing,
      error: `Missing configuration: ${missing.join(", ")}`,
    };
  }

  try {
    const account = await graphRequest<{
      id: string;
      username?: string;
      account_type?: string;
    }>(config, "GET", config.igUserId, {
      fields: "id,username,account_type",
    });

    const status: InstagramConnectionStatus = {
      connected: true,
      dryRun: config.dryRun,
      graphVersion: config.graphVersion,
      accountId: account.id,
      username: account.username,
      accountType: account.account_type,
      missing: [],
    };

    // Best-effort publishing-limit check (non-fatal if it fails).
    try {
      const limit = await graphRequest<{
        data?: { quota_usage?: number; config?: { quota_total?: number } }[];
      }>(config, "GET", `${config.igUserId}/content_publishing_limit`, {
        fields: "quota_usage,config",
      });
      const row = limit.data?.[0];
      if (row) {
        status.publishingLimit = {
          quotaUsage: row.quota_usage ?? 0,
          quotaTotal: row.config?.quota_total ?? 0,
        };
      }
    } catch {
      // Ignore — the primary connection check already succeeded.
    }

    return status;
  } catch (error) {
    const message =
      error instanceof InstagramApiError
        ? `${error.message}${error.subcode ? ` (subcode ${error.subcode})` : ""}`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      connected: false,
      dryRun: config.dryRun,
      graphVersion: config.graphVersion,
      accountId: config.igUserId,
      missing: [],
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Container readiness polling
// ---------------------------------------------------------------------------

type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

async function getContainerStatus(
  config: InstagramConfig,
  containerId: string,
): Promise<{ statusCode: ContainerStatus; status?: string }> {
  const res = await graphRequest<{ status_code?: ContainerStatus; status?: string }>(
    config,
    "GET",
    containerId,
    { fields: "status_code,status" },
  );
  return { statusCode: res.status_code ?? "IN_PROGRESS", status: res.status };
}

/**
 * Waits until a media container finishes processing. Image containers are
 * usually instant, but Meta documents them as asynchronous, so we poll.
 */
async function waitForContainer(
  config: InstagramConfig,
  containerId: string,
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 3_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const { statusCode, status } = await getContainerStatus(config, containerId);
    if (statusCode === "FINISHED") return;
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      throw new InstagramApiError(
        `Media container ${containerId} entered state ${statusCode}: ${status ?? "no detail"}`,
        { status: 400, retriable: false },
      );
    }
    await sleep(pollIntervalMs);
  }
  throw new InstagramApiError(
    `Media container ${containerId} did not finish processing within ${timeoutMs / 1000}s`,
    { status: 504, retriable: false },
  );
}

// ---------------------------------------------------------------------------
// Publish flows
// ---------------------------------------------------------------------------

export interface PublishResult {
  published: boolean;
  dryRun: boolean;
  /** The published media id (absent in dry-run). */
  mediaId?: string;
  /** Permalink to the published post, when it could be fetched. */
  permalink?: string;
  containerIds: string[];
  imageCount: number;
  caption: string;
}

async function createImageContainer(
  config: InstagramConfig,
  imageUrl: string,
  extra: Record<string, string | boolean>,
): Promise<string> {
  const res = await graphRequest<{ id: string }>(
    config,
    "POST",
    `${config.igUserId}/media`,
    { image_url: imageUrl, ...extra },
  );
  if (!res.id) {
    throw new InstagramApiError("Container creation returned no id", {
      status: 502,
      retriable: false,
    });
  }
  return res.id;
}

async function publishContainer(
  config: InstagramConfig,
  creationId: string,
): Promise<string> {
  const res = await graphRequest<{ id: string }>(
    config,
    "POST",
    `${config.igUserId}/media_publish`,
    { creation_id: creationId },
  );
  if (!res.id) {
    throw new InstagramApiError("media_publish returned no media id", {
      status: 502,
      retriable: false,
    });
  }
  return res.id;
}

async function fetchPermalink(
  config: InstagramConfig,
  mediaId: string,
): Promise<string | undefined> {
  try {
    const res = await graphRequest<{ permalink?: string }>(config, "GET", mediaId, {
      fields: "permalink",
    });
    return res.permalink;
  } catch {
    return undefined;
  }
}

/**
 * Publishes one or more public image URLs to Instagram as a single post
 * (1 image) or a carousel (2-10 images). Handles the full container dance,
 * readiness polling, and permalink lookup.
 */
export async function publishImagesToInstagram(params: {
  imageUrls: string[];
  caption: string;
  config?: InstagramConfig;
}): Promise<PublishResult> {
  const config = params.config ?? readInstagramConfig({ require: true }).config!;
  const imageUrls = params.imageUrls.filter((u) => !!u && u.trim().length > 0);
  const caption = params.caption ?? "";

  if (imageUrls.length === 0) {
    throw new InstagramConfigError("No image URLs supplied to publish.");
  }
  if (imageUrls.length > 10) {
    throw new InstagramConfigError(
      `Instagram carousels support at most 10 images (received ${imageUrls.length}).`,
    );
  }

  // Meta fetches images from its own servers — reject unreachable URLs early.
  for (const url of imageUrls) {
    assertPublicHttpsUrl(url);
  }

  if (config.dryRun) {
    return {
      published: false,
      dryRun: true,
      containerIds: [],
      imageCount: imageUrls.length,
      caption,
    };
  }

  // ---- Single image ----
  if (imageUrls.length === 1) {
    const containerId = await createImageContainer(config, imageUrls[0], { caption });
    await waitForContainer(config, containerId);
    const mediaId = await publishContainer(config, containerId);
    const permalink = await fetchPermalink(config, mediaId);
    return {
      published: true,
      dryRun: false,
      mediaId,
      permalink,
      containerIds: [containerId],
      imageCount: 1,
      caption,
    };
  }

  // ---- Carousel ----
  const childIds: string[] = [];
  for (const url of imageUrls) {
    const childId = await createImageContainer(config, url, { is_carousel_item: true });
    childIds.push(childId);
  }
  // Children must finish processing before the parent references them.
  for (const childId of childIds) {
    await waitForContainer(config, childId);
  }

  const parentId = await graphRequest<{ id: string }>(
    config,
    "POST",
    `${config.igUserId}/media`,
    { media_type: "CAROUSEL", children: childIds.join(","), caption },
  ).then((r) => r.id);

  await waitForContainer(config, parentId);
  const mediaId = await publishContainer(config, parentId);
  const permalink = await fetchPermalink(config, mediaId);

  return {
    published: true,
    dryRun: false,
    mediaId,
    permalink,
    containerIds: [...childIds, parentId],
    imageCount: imageUrls.length,
    caption,
  };
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Instagram's servers must be able to fetch the image, so the URL has to be
 * public HTTPS. We reject localhost / private ranges with a clear message
 * pointing at the PUBLIC_BASE_URL / tunnel requirement.
 */
export function assertPublicHttpsUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InstagramConfigError(`Image URL is not a valid URL: "${url}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new InstagramConfigError(
      `Instagram requires public HTTPS image URLs; got "${parsed.protocol}//" for ${url}. ` +
        `Set PUBLIC_BASE_URL to an HTTPS host (or a tunnel like ngrok/Cloudflare) that serves /post-assets.`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (isLocal) {
    throw new InstagramConfigError(
      `Instagram cannot reach a private/local host ("${host}"). Serve the slide over a ` +
        `publicly reachable HTTPS URL (set PUBLIC_BASE_URL to your deployed host or a tunnel).`,
    );
  }
}
