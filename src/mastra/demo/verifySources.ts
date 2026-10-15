/**
 * sources:verify — live verification of EVERY source in the news registry
 * (active, disabled, and their Google News fallbacks), through the real
 * pipeline fetch path (politeFetch: robots.txt respected, per-domain rate
 * limited). Writes docs/source-verification-report.md and prints it.
 *
 *   npx -y tsx src/mastra/demo/verifySources.ts
 *
 * Read-only: changes no ingestion logic and persists no feed-health. Only
 * reports what was actually fetched in THIS run; unreachable sources show the
 * real error.
 */

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    /* .env optional */
  }
}

import fs from "node:fs";
import path from "node:path";
import { NEWS_FEED_SOURCES } from "../config/newsFeeds";
import { getHealth } from "../repositories/feedHealth";
import { politeFetch } from "../lib/http-polite";
import { parseFeedXml } from "../collectors/rss";
import { buildGoogleNewsUrl } from "../lib/google-news-fallback";
import { ingestionConfig } from "../config/ingestion.config";
import { hostOf } from "../lib/article-body";
import type { Source } from "../schemas/source";

const STALE_DAYS = ingestionConfig.health.staleDays;

type StatusLabel = "active" | "disabled_auto" | "disabled_manual" | "fallback";

interface Row {
  name: string;
  region: string;
  url: string;
  status: StatusLabel;
  http: string;
  parsed: string;
  items: number;
  newest: string;
  stale: string;
  notes: string;
}

function newest(items: { pubDate?: string }[]): { iso: string | null; ageDays: number | null } {
  let n = -Infinity;
  for (const i of items) {
    const t = i.pubDate ? Date.parse(i.pubDate) : NaN;
    if (!Number.isNaN(t) && t > n) n = t;
  }
  if (n === -Infinity) return { iso: null, ageDays: null };
  return { iso: new Date(n).toISOString().slice(0, 10), ageDays: (Date.now() - n) / 86_400_000 };
}

async function checkFeed(url: string): Promise<{ http: string; parsed: boolean; items: number; newestIso: string | null; ageDays: number | null; error?: string; blocked: boolean }> {
  const res = await politeFetch(url, { mode: "feed" });
  if (res.blockedByRobots) return { http: "-", parsed: false, items: 0, newestIso: null, ageDays: null, error: "blocked by robots.txt", blocked: true };
  if (!res.ok || !res.body) return { http: res.status === null ? "ERR" : String(res.status), parsed: false, items: 0, newestIso: null, ageDays: null, error: res.error, blocked: false };
  const items = parseFeedXml(res.body);
  const { iso, ageDays } = newest(items);
  return { http: String(res.status), parsed: items.length > 0, items: items.length, newestIso: iso, ageDays, blocked: false };
}

async function main(): Promise<void> {
  const rows: Row[] = [];

  for (const s of NEWS_FEED_SOURCES) {
    const manual = s.active === false;
    const health = await getHealth(s.id).catch(() => undefined);
    const status: StatusLabel = manual ? "disabled_manual" : health?.status === "disabled_auto" ? "disabled_auto" : "active";
    const region = s.region ?? "GLOBAL";
    const noteBits: string[] = [];
    if (s.paywalled) noteBits.push("paywalled, headline only");
    if (s.signalOnly) noteBits.push("signal-only, never cited as primary");
    if (s.note) noteBits.push(s.note);

    if (!s.url) {
      rows.push({ name: s.name, region, url: "(none)", status, http: "-", parsed: "n/a", items: 0, newest: "-", stale: "-", notes: noteBits.join("; ") || "no endpoint" });
      continue;
    }

    const r = await checkFeed(s.url);
    rows.push({
      name: s.name,
      region,
      url: s.url,
      status,
      http: r.error && r.http === "-" ? "ERR" : r.http,
      parsed: r.blocked ? "blocked" : r.parsed ? "yes" : "no",
      items: r.items,
      newest: r.newestIso ?? "-",
      stale: r.ageDays !== null && r.ageDays > STALE_DAYS ? "YES" : "no",
      notes: [r.error, ...noteBits].filter(Boolean).join("; "),
    });

    // For dropped/disabled sources, also verify the Google News fallback live.
    if (manual && ingestionConfig.googleNews.enabled) {
      const domain = fallbackDomain(s);
      const gnUrl = buildGoogleNewsUrl(domain, region as "US" | "IN" | "GLOBAL", s.topics?.[0]);
      const g = await checkFeed(gnUrl);
      rows.push({
        name: `  ↳ ${s.name} — Google News fallback`,
        region,
        url: `news.google.com/rss/search?q=site:${domain}`,
        status: "fallback",
        http: g.error && g.http === "-" ? "ERR" : g.http,
        parsed: g.blocked ? "blocked" : g.parsed ? "yes" : "no",
        items: g.items,
        newest: g.newestIso ?? "-",
        stale: g.ageDays !== null && g.ageDays > STALE_DAYS ? "YES" : "no",
        notes: [g.error, "headline-level discovery"].filter(Boolean).join("; "),
      });
    }
  }

  const istNow = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date());

  const md = render(rows, istNow);
  const outPath = path.resolve(process.cwd(), "docs", "source-verification-report.md");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, "utf8");
  console.log(md);
  console.log(`\nSaved to: ${outPath}`);
}

function fallbackDomain(s: Source): string {
  const host = s.url ? hostOf(s.url) : null;
  if (!host) return s.name.toLowerCase().replace(/\s+/g, "");
  if (host.includes("dowjones")) return "wsj.com";
  if (host.includes("cnn.com")) return "cnn.com";
  return host;
}

function render(rows: Row[], istNow: string): string {
  const feeds = rows.filter((r) => r.status !== "fallback");
  const working = feeds.filter((r) => r.parsed === "yes" && r.stale !== "YES");
  const stale = feeds.filter((r) => r.stale === "YES");
  const dead = feeds.filter((r) => r.status !== "disabled_manual" && (r.parsed === "no" || r.parsed === "blocked"));
  const dropped = feeds.filter((r) => r.status === "disabled_manual");
  const fallbackRows = rows.filter((r) => r.status === "fallback");

  const head = "| Source | Region | Feed URL | Status | HTTP | Parsed | Items | Newest | Stale | Notes |\n|---|---|---|---|---|---|---|---|---|---|";
  const body = rows
    .map((r) => `| ${r.name} | ${r.region} | ${r.url} | ${r.status} | ${r.http} | ${r.parsed} | ${r.items} | ${r.newest} | ${r.stale} | ${r.notes} |`)
    .join("\n");

  const droppedList = dropped
    .map((r) => `- **${r.name}** — ${r.notes || "disabled"}`)
    .join("\n");

  return `# Source Verification Report

**Run (IST):** ${istNow}
**Scope:** every source in the curated news registry (\`src/mastra/config/newsFeeds.ts\`) — active, disabled, and Google News fallbacks. Fetched live through the pipeline's robots-respecting path. Results reflect ONLY what was fetched in this run.

${head}
${body}

## Summary

- **Feed sources checked:** ${feeds.length}
- **Working (parsed, fresh):** ${working.length}
- **Stale (newest > ${STALE_DAYS}d):** ${stale.length}
- **Dead/blocked among enabled:** ${dead.length}
- **Dropped (disabled_manual):** ${dropped.length}
- **Google News fallback rows checked:** ${fallbackRows.length}

### Dropped sources and why
${droppedList || "- none"}

> Note: \`reddit.com\` and \`news.google.com\` return \`User-agent: * → Disallow: /\`, so with robots.txt respected the Reddit feeds and the Google News fallback endpoint show as **blocked** by design (no browser-UA spoofing).
`;
}

main().catch((err) => {
  console.error("sources:verify failed:", err);
  process.exit(1);
});
