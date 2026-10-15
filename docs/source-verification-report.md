# Source Verification Report

**Run (IST):** Thursday, 15 October 2026 at 12:16:01 pm IST
**Scope:** every source in the curated news registry (`src/mastra/config/newsFeeds.ts`) — active, disabled, and Google News fallbacks. Fetched live through the pipeline's robots-respecting path. Results reflect ONLY what was fetched in this run.

| Source | Region | Feed URL | Status | HTTP | Parsed | Items | Newest | Stale | Notes |
|---|---|---|---|---|---|---|---|---|---|
| The Verge | US | https://www.theverge.com/rss/index.xml | active | 200 | yes | 10 | 2026-10-14 | no |  |
| MIT Technology Review | US | https://www.technologyreview.com/feed/ | active | 200 | yes | 10 | 2026-10-14 | no |  |
| YourStory | IN | https://yourstory.com/feed | active | 200 | yes | 20 | 2026-10-15 | no |  |
| Inc42 | IN | https://inc42.com/feed/ | active | 200 | yes | 24 | 2026-10-15 | no |  |
| Analytics India Magazine | IN | https://analyticsindiamag.com/feed/ | disabled_manual | 200 | no | 0 | - | no | Feed serves HTML to bots (verified dead). Use Google News fallback site:analyticsindiamag.com. |
|   ↳ Analytics India Magazine — Google News fallback | IN | news.google.com/rss/search?q=site:analyticsindiamag.com | fallback | ERR | blocked | 0 | - | no | blocked by robots.txt; headline-level discovery |
| Economic Times Tech | IN | https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms | active | 200 | yes | 50 | 2026-10-15 | no |  |
| Entrackr | IN | https://entrackr.com/rss | active | 200 | yes | 50 | 2026-10-15 | no |  |
| WSJ Technology | US | https://feeds.content.dowjones.io/public/rss/RSSWSJD | active | 200 | yes | 40 | 2026-10-15 | no | paywalled, headline only; Paywalled — title + summary only, never fetch body. |
| WSJ Markets | US | https://feeds.content.dowjones.io/public/rss/RSSMarketsMain | active | 200 | yes | 61 | 2026-10-15 | no | paywalled, headline only; Paywalled — title + summary only. |
| CNN Technology | US | http://rss.cnn.com/rss/edition_technology.rss | disabled_manual | 200 | yes | 12 | 2016-11-18 | YES | CNN public RSS defunct — endpoint returns items frozen ~10 years old. Use Google News fallback site:cnn.com. |
|   ↳ CNN Technology — Google News fallback | US | news.google.com/rss/search?q=site:cnn.com | fallback | ERR | blocked | 0 | - | no | blocked by robots.txt; headline-level discovery |
| CNN Top Stories | US | http://rss.cnn.com/rss/cnn_topstories.rss | disabled_manual | 200 | yes | 69 | 2023-05-01 | YES | Stale (frozen ~2022, legacy rss.cnn.com). Disabled; use edition_technology or Google News fallback. |
|   ↳ CNN Top Stories — Google News fallback | US | news.google.com/rss/search?q=site:cnn.com | fallback | ERR | blocked | 0 | - | no | blocked by robots.txt; headline-level discovery |
| Wired | US | https://www.wired.com/feed/rss | active | 200 | yes | 50 | 2026-10-15 | no |  |
| Engadget | US | https://www.engadget.com/rss.xml | active | 200 | yes | 20 | 2026-10-14 | no |  |
| The Next Web | US | https://thenextweb.com/feed | active | 200 | yes | 10 | 2026-10-14 | no |  |
| SiliconANGLE | US | https://siliconangle.com/feed/ | active | 200 | yes | 30 | 2026-10-15 | no |  |
| IEEE Spectrum | US | https://spectrum.ieee.org/feeds/feed.rss | active | 200 | yes | 30 | 2026-10-14 | no |  |
| Quanta Magazine | US | https://www.quantamagazine.org/feed/ | active | 200 | yes | 5 | 2026-10-14 | no |  |
| SpaceNews | US | https://spacenews.com/feed/ | active | 200 | yes | 13 | 2026-10-14 | no |  |
| Crunchbase News | US | https://news.crunchbase.com/feed/ | active | 200 | yes | 10 | 2026-10-14 | no |  |
| BBC Technology | GLOBAL | https://feeds.bbci.co.uk/news/technology/rss.xml | active | 200 | yes | 21 | 2026-10-15 | no |  |
| Guardian Technology | GLOBAL | https://www.theguardian.com/technology/rss | active | 200 | yes | 32 | 2026-10-15 | no |  |
| MediaNama | IN | https://www.medianama.com/feed/ | active | 200 | yes | 10 | 2026-10-15 | no |  |
| Livemint Technology | IN | https://www.livemint.com/rss/technology | active | 200 | yes | 35 | 2026-10-15 | no |  |
| The Hindu Sci-Tech | IN | https://www.thehindu.com/sci-tech/feeder/default.rss | active | 200 | yes | 60 | 2026-10-15 | no |  |
| Business Standard Tech | IN | https://www.business-standard.com/rss/technology-108.rss | disabled_manual | 403 | no | 0 | - | no | HTTP 403; HTTP 403 to honest bot UA (verified). Not spoofing a browser. Use Google News fallback site:business-standard.com. |
|   ↳ Business Standard Tech — Google News fallback | IN | news.google.com/rss/search?q=site:business-standard.com | fallback | ERR | blocked | 0 | - | no | blocked by robots.txt; headline-level discovery |
| Indian Express Technology | IN | https://indianexpress.com/section/technology/feed/ | active | 200 | yes | 200 | 2026-10-15 | no |  |
| Business Today Tech | IN | https://www.businesstoday.in/rss/technology | active | 200 | yes | 114 | 2026-10-15 | no |  |
| TechCircle | IN | https://www.techcircle.in/rss/news | disabled_manual | 200 | no | 0 | - | no | No working RSS endpoint found (all variants return HTML). Use Google News fallback site:techcircle.in. |
|   ↳ TechCircle — Google News fallback | IN | news.google.com/rss/search?q=site:techcircle.in | fallback | ERR | blocked | 0 | - | no | blocked by robots.txt; headline-level discovery |
| PIB India | IN | https://pib.gov.in/rss/lreleng.xml | disabled_manual | 403 | no | 0 | - | no | HTTP 403; HTTP 403 to honest bot UA (verified). Use Google News fallback site:pib.gov.in. |
|   ↳ PIB India — Google News fallback | IN | news.google.com/rss/search?q=site:pib.gov.in | fallback | ERR | blocked | 0 | - | no | blocked by robots.txt; headline-level discovery |
| ISRO News | IN | https://www.isro.gov.in/rss.xml | disabled_manual | 404 | no | 0 | - | no | HTTP 404; No stable RSS endpoint (404). Use Google News fallback site:isro.gov.in. |
|   ↳ ISRO News — Google News fallback | IN | news.google.com/rss/search?q=site:isro.gov.in | fallback | ERR | blocked | 0 | - | no | blocked by robots.txt; headline-level discovery |
| Hugging Face Blog | US | https://huggingface.co/blog/feed.xml | active | 200 | yes | 876 | 2026-10-14 | no |  |
| NVIDIA Blog | US | https://blogs.nvidia.com/feed/ | active | 200 | yes | 18 | 2026-10-15 | no |  |
| Google DeepMind Blog | US | https://deepmind.google/blog/rss.xml | active | 200 | yes | 100 | 2026-10-14 | no |  |
| Hacker News (front page) | GLOBAL | https://news.ycombinator.com/rss | active | 200 | yes | 30 | 2026-10-15 | no | signal-only, never cited as primary |
| r/MachineLearning | GLOBAL | https://www.reddit.com/r/MachineLearning/.rss | active | ERR | blocked | 0 | - | no | blocked by robots.txt; signal-only, never cited as primary |
| r/startups | GLOBAL | https://www.reddit.com/r/startups/.rss | active | ERR | blocked | 0 | - | no | blocked by robots.txt; signal-only, never cited as primary |
| r/IndiaTech | IN | https://www.reddit.com/r/IndiaTech/.rss | active | ERR | blocked | 0 | - | no | blocked by robots.txt; signal-only, never cited as primary |
| Product Hunt | US | https://www.producthunt.com/feed | active | 200 | yes | 50 | 2026-10-14 | no | signal-only, never cited as primary |
| Inshorts | IN | (none) | disabled_manual | - | n/a | 0 | - | - | No official RSS or API. Will NOT be scraped. Enable only if an official feed appears. |

## Summary

- **Feed sources checked:** 39
- **Working (parsed, fresh):** 28
- **Stale (newest > 7d):** 2
- **Dead/blocked among enabled:** 3
- **Dropped (disabled_manual):** 8
- **Google News fallback rows checked:** 7

### Dropped sources and why
- **Analytics India Magazine** — Feed serves HTML to bots (verified dead). Use Google News fallback site:analyticsindiamag.com.
- **CNN Technology** — CNN public RSS defunct — endpoint returns items frozen ~10 years old. Use Google News fallback site:cnn.com.
- **CNN Top Stories** — Stale (frozen ~2022, legacy rss.cnn.com). Disabled; use edition_technology or Google News fallback.
- **Business Standard Tech** — HTTP 403; HTTP 403 to honest bot UA (verified). Not spoofing a browser. Use Google News fallback site:business-standard.com.
- **TechCircle** — No working RSS endpoint found (all variants return HTML). Use Google News fallback site:techcircle.in.
- **PIB India** — HTTP 403; HTTP 403 to honest bot UA (verified). Use Google News fallback site:pib.gov.in.
- **ISRO News** — HTTP 404; No stable RSS endpoint (404). Use Google News fallback site:isro.gov.in.
- **Inshorts** — No official RSS or API. Will NOT be scraped. Enable only if an official feed appears.

> Note: `reddit.com` and `news.google.com` return `User-agent: * → Disallow: /`, so with robots.txt respected the Reddit feeds and the Google News fallback endpoint show as **blocked** by design (no browser-UA spoofing).
