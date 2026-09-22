import type { Source } from "../schemas/source";
import { blog, news, newsletter, podcast, rss, stub, web, youTube } from "./sourceCatalog1";

const STARTUPS = ["AI Startups"];
const AI = ["LLMs", "Generative AI"];
const DEV = ["AI Coding", "AI Infrastructure"];
const BIZ = ["AI Startups", "Generative AI"];

// ---------- 2. Venture capital / investment intelligence ----------

const VC = ["AI Startups"];

export const VC_SOURCES: Source[] = [
  web("web:a16z", "a16z", "https://a16z.com", 88, { topics: VC, role: "news", tier: 1 }),
  web("web:a16z-future", "a16z Future", "https://future.a16z.com", 85, { topics: VC, role: "news", tier: 2 }),
  web("web:sequoia", "Sequoia Capital", "https://www.sequoiacap.com", 85, { topics: VC, role: "news", tier: 2 }),
  web("web:accel", "Accel Insights", "https://www.accel.com/insights", 82, { topics: VC, role: "news", tier: 2 }),
  web("web:firstround", "First Round Review", "https://review.firstround.com", 84, { topics: [...VC, ...DEV], role: "news", tier: 1 }),
  web("web:nfx", "NFX Blog", "https://www.nfx.com", 80, { topics: VC, role: "news", tier: 2 }),
  web("web:bessemer-cloud", "Bessemer State of the Cloud", "https://www.bvp.com/atlas", 80, { topics: VC, role: "news", tier: 3 }),
  web("web:lightspeed", "Lightspeed Beacon", "https://lsvp.com/beacon/", 78, { topics: VC, role: "news", tier: 3 }),
  web("web:contrary", "Contrary Research", "https://contrary.com/research", 80, { topics: VC, role: "news", tier: 2 }),
  web("web:redpoint", "Redpoint Research", "https://www.redpoint.com/research/", 78, { topics: VC, role: "news", tier: 3 }),
  web("web:tomasz", "Tomasz Tunguz", "https://tomtunguz.com", 82, { topics: VC, role: "news", tier: 2 }),
  web("web:eladgil", "Elad Gil", "https://blog.eladgil.com", 84, { topics: VC, role: "news", tier: 2 }),
  web("web:greylock", "Greylock", "https://greylock.com", 80, { topics: VC, role: "news", tier: 3 }),
  web("web:menlo", "Menlo Ventures", "https://menlovc.com", 78, { topics: VC, role: "news", tier: 3 }),
  web("web:lux", "Lux Capital", "https://www.luxcapital.com", 76, { topics: VC, role: "news", tier: 3 }),
  web("web:conviction", "Conviction", "https://www.conviction.com", 76, { topics: VC, role: "news", tier: 3 }),
  web("web:radical", "Radical Ventures", "https://radical.vc", 78, { topics: VC, role: "news", tier: 3 }),
  podcast("a16z Podcast", VC),
  podcast("Lenny's Podcast", [...VC, "AI Coding"]),
  podcast("The Twenty Minute VC", VC),
  podcast("Acquired", BIZ),
];

// ---------- 3. Startup / YC / founder ecosystem ----------

export const STARTUP_SOURCES: Source[] = [
  rss("rss:hn", "Hacker News", "https://news.ycombinator.com/rss", 88, {
    topics: [...STARTUPS, ...DEV], role: "community", tier: 1,
  }),
  rss("rss:hn-show", "Show HN", "https://news.ycombinator.com/showrss", 82, {
    topics: [...STARTUPS], role: "launch", tier: 2,
  }),
  web("web:yc", "Y Combinator Blog", "https://www.ycombinator.com/blog", 85, { topics: STARTUPS, role: "news", tier: 2 }),
  web("web:yc-library", "YC Startup Library", "https://www.ycombinator.com/library", 82, { topics: STARTUPS, role: "news", tier: 3 }),
  web("web:indiehackers", "Indie Hackers", "https://www.indiehackers.com", 75, { topics: STARTUPS, role: "community", tier: 3 }),
  web("web:saastr", "SaaStr", "https://www.saastr.com", 78, { topics: STARTUPS, role: "news", tier: 3 }),
  web("web:betalist", "BetaList", "https://betalist.com", 72, { topics: [...STARTUPS], role: "launch", tier: 3 }),
  stub("launch:producthunt", "Product Hunt", "launch", 80, {
    topics: [...STARTUPS, ...AI], role: "launch", tier: 1,
    note: "Product Hunt API token not configured (PRODUCT_HUNT_TOKEN).",
  }),
  stub("launch:peerlist", "Peerlist", "launch", 65, { topics: STARTUPS, role: "launch" }),
  stub("launch:devhunt", "DevHunt", "launch", 65, { topics: [...STARTUPS, ...DEV], role: "launch" }),
];

// ---------- 4. Major technology news ----------

export const TECH_NEWS: Source[] = [
  rss("rss:techcrunch-ai", "TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/", 84, {
    topics: [...AI, ...STARTUPS], role: "news", tier: 1,
  }),
  rss("rss:techcrunch", "TechCrunch", "https://techcrunch.com/feed/", 82, {
    topics: [...STARTUPS, ...AI], role: "news", tier: 1,
  }),
  news("news:theverge", "The Verge", "https://www.theverge.com", 80, { topics: [...AI], role: "news", tier: 1 }),
  rss("rss:ars", "Ars Technica", "https://arstechnica.com/feed/", 82, {
    topics: [...AI, ...DEV], role: "news", tier: 1,
    note: "Homepage bot-blocks direct fetch; feed is the collectable endpoint.",
  }),
  news("news:mittr", "MIT Technology Review", "https://www.technologyreview.com", 86, { topics: [...AI], role: "news", tier: 1 }),
  news("news:wired", "Wired", "https://www.wired.com", 80, { topics: [...AI], role: "news", tier: 2 }),
  rss("rss:venturebeat", "VentureBeat", "https://venturebeat.com/feed/", 80, {
    topics: [...AI, ...STARTUPS], role: "news", tier: 1,
  }),
  news("news:theregister", "The Register", "https://www.theregister.com", 76, { topics: [...DEV, ...AI], role: "news", tier: 2 }),
  news("news:bloomberg-tech", "Bloomberg Technology", "https://www.bloomberg.com/technology", 84, {
    topics: BIZ, role: "news", tier: 1,
    note: "Paywall/bot-blocked for direct fetch — use exaScrape for full text.",
  }),
  news("news:reuters-tech", "Reuters Technology", "https://www.reuters.com/technology/", 84, {
    topics: BIZ, role: "news", tier: 1,
    note: "Bot-blocked for direct fetch — use exaScrape for full text.",
  }),
  news("news:axios-tech", "Axios Technology", "https://www.axios.com/technology", 78, { topics: BIZ, role: "news", tier: 2 }),
  news("news:tnw", "The Next Web", "https://thenextweb.com", 74, { topics: [...STARTUPS, ...AI], role: "news", tier: 2 }),
  news("news:sifted", "Sifted (EU startups)", "https://sifted.eu", 76, { topics: STARTUPS, role: "news", tier: 2 }),
  news("news:techeu", "Tech.eu", "https://tech.eu", 74, { topics: STARTUPS, role: "news", tier: 3 }),
  news("news:siliconangle", "SiliconANGLE", "https://siliconangle.com", 74, { topics: [...AI, ...DEV], role: "news", tier: 2 }),
  news("news:zdnet", "ZDNET", "https://www.zdnet.com", 74, { topics: [...AI, ...DEV], role: "news", tier: 3 }),
  news("news:qz-tech", "Quartz Technology", "https://qz.com/technology", 72, { topics: BIZ, role: "news", tier: 3 }),
];

// ---------- 5/8. AI newsletters (feed where it exists, stub otherwise) ----------

export const AI_NEWSLETTERS: Source[] = [
  newsletter("TLDR AI", undefined, AI, 78),
  newsletter("Ben's Bites", undefined, AI, 75),
  newsletter("The Rundown AI", undefined, AI, 75),
  newsletter("The Batch (DeepLearning.AI)", undefined, [...AI, "AI Research"], 80),
  newsletter("Import AI", "https://jack-clark.net/feed", [...AI, "AI Research"], 78),
  newsletter("Last Week in AI", undefined, AI, 72),
  newsletter("Latent Space", undefined, [...AI, ...DEV], 76),
  newsletter("The Neuron", undefined, AI, 72),
  newsletter("Superhuman AI", undefined, AI, 70),
  newsletter("The Sequence", undefined, [...AI, "AI Research"], 74),
  newsletter("Lenny's Newsletter", "https://www.lennysnewsletter.com/feed", [...STARTUPS, ...DEV], 82),
  newsletter("Not Boring", "https://www.notboring.co/feed", [...STARTUPS, ...AI], 80),
  newsletter("The Generalist", undefined, STARTUPS, 78),
  newsletter("Stratechery", undefined, BIZ, 82),
  newsletter("Every", undefined, [...AI, ...STARTUPS], 78),
  newsletter("Big Technology", undefined, [...AI, ...BIZ], 78),
  newsletter("The Pragmatic Engineer", "https://blog.pragmaticengineer.com/feed", DEV, 84),
  newsletter("ByteByteGo", "https://blog.bytebytego.com/feed", DEV, 82),
  newsletter("One Useful Thing (Ethan Mollick)", undefined, AI, 78),
  newsletter("Benedict Evans", undefined, BIZ, 80),
  newsletter("The Diff", undefined, BIZ, 76),
  newsletter("Platformer", undefined, [...AI, ...BIZ], 76),
];

// ---------- 6/7. Developer / engineering news + newsletters ----------

export const DEV_NEWS: Source[] = [
  rss("rss:lobsters", "Lobsters", "https://lobste.rs/rss", 80, { topics: DEV, role: "community", tier: 1 }),
  rss("rss:devto", "DEV Community", "https://dev.to/feed", 76, { topics: DEV, role: "community", tier: 2 }),
  rss("rss:changelog", "Changelog", "https://changelog.com/feed", 78, { topics: DEV, role: "news", tier: 2 }),
  podcast("Changelog", DEV),
  podcast("Software Engineering Daily", DEV),
  podcast("Latent Space", [...AI, ...DEV]),
  web("web:thenewstack", "The New Stack", "https://thenewstack.io", 78, { topics: DEV, role: "news", tier: 2 }),
  web("web:infoq", "InfoQ", "https://www.infoq.com", 78, { topics: DEV, role: "news", tier: 2 }),
  web("web:hackernoon", "HackerNoon", "https://hackernoon.com", 72, { topics: DEV, role: "community", tier: 3 }),
  web("web:freecodecamp", "freeCodeCamp", "https://www.freecodecamp.org/news/", 75, { topics: DEV, role: "community", tier: 3 }),
  web("web:dailydev", "daily.dev", "https://daily.dev", 74, { topics: DEV, role: "community", tier: 3 }),
  newsletter("TLDR", undefined, DEV, 80),
  newsletter("JavaScript Weekly", undefined, DEV, 76),
  newsletter("Python Weekly", undefined, DEV, 74),
];

// ---------- 18/19. Podcasts + video (stubs; activate with feed/API) ----------

export const SHOWS: Source[] = [
  podcast("No Priors", AI),
  podcast("The Cognitive Revolution", AI),
  podcast("Lex Fridman Podcast", AI),
  podcast("Dwarkesh Podcast", AI),
  podcast("AI Engineer", [...AI, ...DEV]),
  podcast("All-In Podcast", BIZ),
  podcast("My First Million", STARTUPS),
  podcast("TBPN", [...AI, ...STARTUPS]),
  youTube("Fireship", [...DEV, ...AI]),
  youTube("Theo", DEV),
  youTube("ThePrimeagen", DEV),
  youTube("Matt Wolfe", AI),
  youTube("AI Explained", AI),
  youTube("Yannic Kilcher", [...AI, "AI Research"]),
  youTube("Two Minute Papers", [...AI, "AI Research"]),
  youTube("Andrej Karpathy", [...AI, "AI Research"]),
  youTube("DeepLearningAI", AI),
  youTube("Y Combinator", STARTUPS),
  youTube("NetworkChuck", DEV),
  youTube("3Blue1Brown", ["AI Research"]),
];

// ---------- 20. Communities (machine-readable first) ----------

export const COMMUNITIES: Source[] = [
  rss("rss:reddit-llama", "r/LocalLLaMA", "https://www.reddit.com/r/LocalLLaMA/.rss", 72, {
    topics: [...AI, "Open Source AI"], role: "community", tier: 2,
  }),
  rss("rss:reddit-ml", "r/MachineLearning", "https://www.reddit.com/r/MachineLearning/.rss", 74, {
    topics: ["AI Research"], role: "community", tier: 2,
  }),
  rss("rss:reddit-programming", "r/programming", "https://www.reddit.com/r/programming/.rss", 72, {
    topics: DEV, role: "community", tier: 3,
  }),
  rss("rss:reddit-startups", "r/startups", "https://www.reddit.com/r/startups/.rss", 68, {
    topics: STARTUPS, role: "community", tier: 3,
  }),
  rss("rss:reddit-artificial", "r/artificial", "https://www.reddit.com/r/artificial/.rss", 68, {
    topics: AI, role: "community", tier: 3,
  }),
  stub("community:discord-ai", "Discord developer communities", "community", 55, {
    topics: DEV, role: "community",
  }),
  stub("community:langchain", "LangChain community", "community", 60, {
    topics: ["AI Agents"], role: "community",
  }),
];

// ---------- 17. India tech / AI / startup ----------

export const INDIA_SOURCES: Source[] = [
  news("news:yourstory", "YourStory", "https://yourstory.com", 72, { topics: STARTUPS, role: "news", tier: 2 }),
  news("news:inc42", "Inc42", "https://inc42.com", 72, { topics: STARTUPS, role: "news", tier: 2 }),
  news("news:entrackr", "Entrackr", "https://entrackr.com", 68, { topics: STARTUPS, role: "news", tier: 3 }),
  news("news:aim", "Analytics India Magazine", "https://analyticsindiamag.com", 74, {
    topics: [...AI], role: "news", tier: 2,
  }),
  news("news:theken", "The Ken", "https://the-ken.com", 78, { topics: [...STARTUPS, ...BIZ], role: "news", tier: 3 }),
  news("news:ettech", "ET Tech", "https://economictimes.indiatimes.com/tech", 72, { topics: [...STARTUPS, ...BIZ], role: "news", tier: 3 }),
  news("news:vccircle", "VCCircle", "https://www.vccircle.com", 70, { topics: STARTUPS, role: "news", tier: 3 }),
];

// ---------- 22. Security ----------

const SEC = ["AI Infrastructure"];

export const SECURITY_SOURCES: Source[] = [
  rss("rss:krebs", "Krebs on Security", "https://krebsonsecurity.com/feed/", 84, { topics: SEC, role: "news", tier: 2 }),
  rss("rss:bleeping", "BleepingComputer", "https://www.bleepingcomputer.com/feed/", 80, { topics: SEC, role: "news", tier: 2 }),
  rss("rss:projectzero", "Google Project Zero", "https://googleprojectzero.blogspot.com/feeds/posts/default", 86, {
    topics: SEC, role: "official", tier: 3,
  }),
  web("web:cisa", "CISA Alerts", "https://www.cisa.gov/news-events/cybersecurity-advisories", 82, { topics: SEC, role: "official", tier: 3 }),
];

// ---------- 26/27/28. Product, design, business, creators ----------

export const MORE_SOURCES: Source[] = [
  blog("blog:figma", "Figma Blog", "https://www.figma.com/blog/", 76, { topics: [...STARTUPS], role: "official", tier: 3 }),
  blog("blog:linear", "Linear Blog", "https://linear.app/blog", 76, { topics: [...STARTUPS, ...DEV], role: "official", tier: 3 }),
  blog("blog:notion", "Notion Blog", "https://www.notion.so/blog", 74, { topics: STARTUPS, role: "official", tier: 3 }),
  news("news:ft-tech", "FT Technology", "https://www.ft.com/technology", 82, { topics: BIZ, role: "news", tier: 2 }),
  news("news:fortune-tech", "Fortune Technology", "https://fortune.com/section/tech/", 78, { topics: BIZ, role: "news", tier: 3 }),
  news("news:forbes-tech", "Forbes Tech", "https://www.forbes.com/technology/", 76, { topics: BIZ, role: "news", tier: 3 }),
  news("news:bi-tech", "Business Insider Tech", "https://www.businessinsider.com/tech", 74, { topics: BIZ, role: "news", tier: 3 }),
  newsletter("StrictlyVC", undefined, STARTUPS, 78),
  newsletter("Axios Pro Rata", undefined, STARTUPS, 78),
  newsletter("Term Sheet", undefined, STARTUPS, 76),
  web("web:futurepedia", "Futurepedia", "https://www.futurepedia.io", 68, { topics: [...AI], role: "launch", tier: 3 }),
  web("web:taaft", "There's An AI For That", "https://theresanaiforthat.com", 68, { topics: [...AI], role: "launch", tier: 3 }),
];
