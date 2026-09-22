import type { RawContent } from "../schemas/rawContent";
import type { Source } from "../schemas/source";
import {
  fetchWithTimeout,
  makeBaseRaw,
  type SourceCollector,
} from "./types";

interface GitHubRelease {
  html_url: string;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  author?: { login?: string; html_url?: string };
  published_at?: string | null;
  prerelease?: boolean;
}

export function parseGitHubRepo(url: string): { owner: string; repo: string } {
  const m = url.match(
    /github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?(?:[\s?#/]|$)/i,
  );
  if (!m) throw new Error(`Cannot parse GitHub repo from URL: ${url}`);
  return { owner: m[1]!, repo: m[2]! };
}

/** Collects public releases via the official GitHub REST API. */
export class GitHubCollector implements SourceCollector {
  readonly collectorId = "github";

  supports(source: Source): boolean {
    return source.type === "github" && !!source.url;
  }

  async collect(
    source: Source,
    opts?: { maxItems?: number },
  ): Promise<RawContent[]> {
    if (!source.url) throw new Error(`GitHub source ${source.id} has no URL`);
    const releases = await fetchGitHubReleases(source.url, opts?.maxItems ?? 10);
    return releases.map((r) =>
      makeBaseRaw({
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        url: r.html_url,
        title: r.name || r.tag_name,
        content: r.body?.slice(0, 8000) || `${r.name || r.tag_name} released.`,
        authorName: r.author?.login,
        authorUrl: r.author?.html_url,
        publishedAt: r.published_at ?? undefined,
        metadata: {
          collector: "github",
          tag: r.tag_name,
          prerelease: r.prerelease ?? false,
        },
      }),
    );
  }
}

export async function fetchGitHubReleases(
  repoUrlOrSlug: string,
  maxItems = 10,
): Promise<GitHubRelease[]> {
  const { owner, repo } = repoUrlOrSlug.includes("github.com")
    ? parseGitHubRepo(repoUrlOrSlug)
    : parseSlug(repoUrlOrSlug);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${Math.min(Math.max(maxItems, 1), 30)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetchWithTimeout(apiUrl, { headers });
  if (res.status === 404) {
    throw new Error(`GitHub repo not found: ${owner}/${repo}`);
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      `GitHub rate limit hit for ${owner}/${repo} — set GITHUB_TOKEN or retry later`,
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API failed (${res.status}) for ${owner}/${repo}`);
  }
  const data = (await res.json()) as GitHubRelease[];
  return data.slice(0, maxItems);
}

function parseSlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Expected "owner/repo" or a github.com URL, got: ${slug}`);
  }
  return { owner: parts[0], repo: parts[1] };
}
