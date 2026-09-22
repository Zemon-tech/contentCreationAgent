import type { Source, SourceRole, SourceType } from "../schemas/source";

/**
 * Curated source catalog — the ONLY sources the live pipeline polls.
 * Conventions:
 * - rss/github entries carry machine-fetchable URLs and are active.
 * - web entries carry blog/homepage URLs and are active (single-page fetch).
 * - social/newsletter/podcast/video/community entries WITHOUT a feed URL
 *   are inactive stubs: registered for attribution + future API wiring,
 *   never scraped. Activate individually once an official integration exists.
 * - tier: 1 = every run, 2 = hourly batch, 3 = daily deep sweep.
 * - role: official (first-party, preferred evidence) | news |
 *   signal_creator (signal only, never primary evidence) | community |
 *   academic | launch | other.
 */

interface EntryOpts {
  topics?: string[];
  role?: SourceRole;
  tier?: 1 | 2 | 3;
  authority?: number;
  active?: boolean;
  note?: string;
}

function base(
  id: string,
  name: string,
  type: SourceType,
  authority: number,
  opts: EntryOpts & { url?: string },
): Source {
  return {
    id,
    name,
    type,
    authorityScore: opts.authority ?? authority,
    ...(opts.url ? { url: opts.url } : {}),
    ...(opts.topics ? { topics: opts.topics } : {}),
    active: opts.active ?? true,
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.tier ? { tier: opts.tier } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
}

export function rss(
  id: string,
  name: string,
  url: string,
  authority: number,
  opts: EntryOpts = {},
): Source {
  return base(id, name, "rss", authority, { ...opts, url });
}

export function web(
  id: string,
  name: string,
  url: string,
  authority: number,
  opts: EntryOpts = {},
): Source {
  return base(id, name, "web", authority, { ...opts, url });
}

export function blog(
  id: string,
  name: string,
  url: string,
  authority: number,
  opts: EntryOpts = {},
): Source {
  return base(id, name, "blog", authority, { ...opts, url });
}

export function news(
  id: string,
  name: string,
  url: string | undefined,
  authority: number,
  opts: EntryOpts = {},
): Source {
  return base(id, name, "news", authority, {
    ...opts,
    ...(url ? { url } : {}),
    active: opts.active ?? !!url,
  });
}

export function github(
  id: string,
  name: string,
  repoUrl: string,
  authority: number,
  opts: EntryOpts = {},
): Source {
  return base(id, name, "github", authority, { ...opts, url: repoUrl });
}

export function paper(
  id: string,
  name: string,
  arxivQueryUrl: string,
  authority: number,
  opts: EntryOpts = {},
): Source {
  return base(id, name, "paper", authority, {
    ...opts,
    url: arxivQueryUrl,
    role: opts.role ?? "academic",
  });
}

/** Inactive stub: no machine endpoint yet (social/newsletter/podcast/video). */
export function stub(
  id: string,
  name: string,
  type: SourceType,
  authority: number,
  opts: EntryOpts = {},
): Source {
  return base(id, name, type, authority, {
    ...opts,
    active: false,
    note: opts.note ?? "No official API integration yet — activate once wired.",
  });
}

/** X stub for a handle. */
export function xHandle(
  handle: string,
  topics: string[],
  authority = 50,
  role: SourceRole = "signal_creator",
): Source {
  const h = handle.replace(/^@/, "");
  return stub(`x:${h.toLowerCase()}`, `@${h} (X)`, "social", authority, {
    topics,
    role,
    note: "X API not configured — plug in official X API client to activate.",
  });
}

/** YouTube channel stub (needs channel ID + Data API to activate). */
export function youTube(
  name: string,
  topics: string[],
  authority = 50,
): Source {
  const id = `yt:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return stub(id, `${name} (YouTube)`, "video", authority, {
    topics,
    role: "signal_creator",
    note: "YouTube Data API not configured — needs channel ID + API key.",
  });
}

/** Newsletter stub (activate via Substack/Beehiiv RSS or inbox API). */
export function newsletter(
  name: string,
  feedUrl: string | undefined,
  topics: string[],
  authority = 55,
): Source {
  const id = `newsletter:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (feedUrl) return rss(id, name, feedUrl, authority, { topics, role: "news", tier: 2 });
  return stub(id, name, "newsletter", authority, { topics, role: "news" });
}

/** Podcast stub (activate with its RSS feed URL). */
export function podcast(name: string, topics: string[], authority = 50): Source {
  const id = `podcast:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return stub(id, name, "podcast", authority, { topics, role: "news" });
}

const AI = ["LLMs", "Generative AI"];
const AGENTS = ["AI Agents"];
const CODE = ["AI Coding"];
const INFRA = ["AI Infrastructure"];
const OPEN = ["Open Source AI"];
const RESEARCH = ["AI Research"];
const STARTUPS = ["AI Startups"];

// ---------- 1. Frontier AI / first-party blogs ----------

export const FRONTIER_AI: Source[] = [
  rss("rss:openai", "OpenAI Blog", "https://openai.com/blog/rss.xml", 95, {
    topics: [...AI, ...AGENTS], role: "official", tier: 1,
    note: "Falls back to web fetch of https://openai.com/blog if feed moves.",
  }),
  blog("blog:anthropic", "Anthropic News", "https://www.anthropic.com/news", 93, {
    topics: [...AI, ...RESEARCH, ...AGENTS], role: "official", tier: 1,
  }),
  blog("blog:deepmind", "Google DeepMind Blog", "https://deepmind.google/discover/blog/", 92, {
    topics: [...AI, ...RESEARCH], role: "official", tier: 1,
  }),
  blog("blog:google-ai", "Google AI Blog", "https://blog.google/technology/ai/", 88, {
    topics: [...AI, ...RESEARCH], role: "official", tier: 1,
  }),
  blog("blog:meta-ai", "Meta AI Blog", "https://ai.meta.com/blog/", 87, {
    topics: [...AI, ...RESEARCH, ...OPEN], role: "official", tier: 2,
  }),
  blog("blog:microsoft-ai", "Microsoft AI Blog", "https://blogs.microsoft.com/ai/", 85, {
    topics: [...AI, ...AGENTS], role: "official", tier: 2,
  }),
  blog("blog:xai", "xAI News", "https://x.ai/news", 84, {
    topics: [...AI], role: "official", tier: 2,
  }),
  blog("blog:mistral", "Mistral AI News", "https://mistral.ai/news", 88, {
    topics: [...AI, ...OPEN], role: "official", tier: 1,
  }),
  blog("blog:cohere", "Cohere Blog", "https://cohere.com/blog", 82, {
    topics: [...AI, "LLMs"], role: "official", tier: 2,
  }),
  blog("blog:perplexity", "Perplexity Blog", "https://www.perplexity.ai/blog", 78, {
    topics: [...AI, ...AGENTS], role: "official", tier: 2,
  }),
  blog("blog:huggingface", "Hugging Face Blog", "https://huggingface.co/blog", 88, {
    topics: [...OPEN, ...AI], role: "official", tier: 1,
  }),
  blog("blog:stability", "Stability AI Blog", "https://stability.ai/news", 76, {
    topics: [...AI, ...OPEN], role: "official", tier: 3,
  }),
  blog("blog:nvidia-ai", "NVIDIA AI News", "https://blogs.nvidia.com/blog/category/deep-learning/", 90, {
    topics: [...INFRA, ...AI], role: "official", tier: 1,
  }),
  blog("blog:aws-ai", "AWS AI Blog", "https://aws.amazon.com/blogs/machine-learning/", 85, {
    topics: [...INFRA, ...AI], role: "official", tier: 2,
  }),
  blog("blog:ibm-research", "IBM Research Blog", "https://research.ibm.com/blog", 80, {
    topics: [...RESEARCH, ...AI], role: "official", tier: 3,
  }),
  blog("blog:apple-ml", "Apple ML Research", "https://machinelearning.apple.com", 84, {
    topics: [...RESEARCH, ...AI], role: "official", tier: 2,
  }),
  blog("blog:adobe-research", "Adobe Research", "https://research.adobe.com", 78, {
    topics: [...RESEARCH, "Generative AI"], role: "official", tier: 3,
  }),
  blog("blog:salesforce-ai", "Salesforce AI Research", "https://blog.salesforceairesearch.com", 80, {
    topics: [...RESEARCH, ...AGENTS], role: "official", tier: 2,
  }),
  blog("blog:databricks", "Databricks Blog", "https://www.databricks.com/blog", 82, {
    topics: [...INFRA, ...AI], role: "official", tier: 2,
  }),
  blog("blog:snowflake", "Snowflake Blog", "https://www.snowflake.com/blog/", 78, {
    topics: [...INFRA, ...AI], role: "official", tier: 3,
  }),
];

// ---------- Developer / infrastructure blogs ----------

const DEV = ["AI Coding", "AI Infrastructure"];

export const DEV_INFRA: Source[] = [
  blog("blog:vercel", "Vercel Blog", "https://vercel.com/blog", 82, { topics: DEV, role: "official", tier: 2 }),
  blog("blog:cloudflare", "Cloudflare Blog", "https://blog.cloudflare.com", 85, { topics: DEV, role: "official", tier: 1 }),
  blog("blog:supabase", "Supabase Blog", "https://supabase.com/blog", 80, { topics: DEV, role: "official", tier: 2 }),
  blog("blog:github", "GitHub Blog", "https://github.blog", 86, { topics: DEV, role: "official", tier: 1 }),
  blog("blog:gitlab", "GitLab Blog", "https://about.gitlab.com/blog/", 76, { topics: DEV, role: "official", tier: 3 }),
  blog("blog:stripe-eng", "Stripe Engineering", "https://stripe.com/blog/engineering", 84, { topics: DEV, role: "official", tier: 2 }),
  blog("blog:netflix-tech", "Netflix TechBlog", "https://netflixtechblog.com", 84, { topics: DEV, role: "official", tier: 2 }),
  blog("blog:uber-eng", "Uber Engineering", "https://www.uber.com/blog/engineering", 82, { topics: DEV, role: "official", tier: 3 }),
  blog("blog:discord-eng", "Discord Engineering", "https://discord.com/blog/engineering", 78, { topics: DEV, role: "official", tier: 3 }),
  blog("blog:slack-eng", "Slack Engineering", "https://slack.engineering", 80, { topics: DEV, role: "official", tier: 3 }),
  blog("blog:shopify-eng", "Shopify Engineering", "https://shopify.engineering", 80, { topics: DEV, role: "official", tier: 3 }),
  blog("blog:linkedin-eng", "LinkedIn Engineering", "https://www.linkedin.com/blog/engineering", 78, { topics: DEV, role: "official", tier: 3 }),
  blog("blog:coinbase-eng", "Coinbase Engineering", "https://www.coinbase.com/blog/engineering", 75, { topics: DEV, role: "official", tier: 3 }),
  blog("blog:aws-arch", "AWS Architecture Blog", "https://aws.amazon.com/blogs/architecture/", 82, { topics: DEV, role: "official", tier: 2 }),
  blog("blog:google-dev", "Google Developers Blog", "https://developers.googleblog.com", 84, { topics: DEV, role: "official", tier: 2 }),
  blog("blog:ms-dev", "Microsoft Developer Blog", "https://devblogs.microsoft.com", 82, { topics: DEV, role: "official", tier: 2 }),
  web("web:docker", "Docker Blog", "https://www.docker.com/blog/", 78, { topics: DEV, role: "official", tier: 3 }),
  web("web:kubernetes", "Kubernetes Blog", "https://kubernetes.io/blog/", 80, { topics: DEV, role: "official", tier: 3 }),
  web("web:mongodb", "MongoDB Blog", "https://www.mongodb.com/blog", 76, { topics: DEV, role: "official", tier: 3 }),
  web("web:redis", "Redis Blog", "https://redis.io/blog/", 76, { topics: DEV, role: "official", tier: 3 }),
];

// ---------- AI ecosystem ----------

export const AI_ECOSYSTEM: Source[] = [
  blog("blog:langchain", "LangChain Blog", "https://blog.langchain.com", 84, { topics: [...AGENTS, ...CODE], role: "official", tier: 1 }),
  blog("blog:llamaindex", "LlamaIndex Blog", "https://blog.llamaindex.ai", 80, { topics: [...AGENTS, ...CODE], role: "official", tier: 2 }),
  blog("blog:mastra", "Mastra Blog", "https://mastra.ai/blog", 78, { topics: [...AGENTS, ...CODE], role: "official", tier: 2 }),
  blog("blog:crewai", "CrewAI Blog", "https://blog.crewai.com", 74, { topics: AGENTS, role: "official", tier: 3 }),
  web("web:replicate", "Replicate Blog", "https://replicate.com/blog", 78, { topics: [...INFRA, ...OPEN], role: "official", tier: 2 }),
  web("web:together", "Together AI Blog", "https://www.together.ai/blog", 78, { topics: INFRA, role: "official", tier: 2 }),
  web("web:groq", "Groq Blog", "https://groq.com/news", 78, { topics: INFRA, role: "official", tier: 2 }),
  web("web:fireworks", "Fireworks AI Blog", "https://fireworks.ai/blog", 76, { topics: INFRA, role: "official", tier: 3 }),
  web("web:modal", "Modal Blog", "https://modal.com/blog", 74, { topics: INFRA, role: "official", tier: 3 }),
  web("web:baseten", "Baseten Blog", "https://www.baseten.co/blog", 74, { topics: INFRA, role: "official", tier: 3 }),
  web("web:anyscale", "Anyscale Blog", "https://www.anyscale.com/blog", 74, { topics: INFRA, role: "official", tier: 3 }),
  web("web:wandb", "Weights & Biases Blog", "https://wandb.ai/fully-connected", 76, { topics: [...INFRA, ...RESEARCH], role: "official", tier: 3 }),
  web("web:scale", "Scale AI Blog", "https://scale.com/blog", 76, { topics: [...INFRA, ...AI], role: "official", tier: 3 }),
  web("web:weaviate", "Weaviate Blog", "https://weaviate.io/blog", 74, { topics: INFRA, role: "official", tier: 3 }),
  web("web:pinecone", "Pinecone Blog", "https://www.pinecone.io/blog/", 74, { topics: INFRA, role: "official", tier: 3 }),
  web("web:qdrant", "Qdrant Blog", "https://qdrant.tech/blog/", 74, { topics: INFRA, role: "official", tier: 3 }),
];

// ---------- Research / academic ----------

const ARXIV = (q: string) =>
  `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&start=0&max_results=15&sortBy=submittedDate&sortOrder=descending`;

export const RESEARCH_SOURCES: Source[] = [
  paper("arxiv:cs-ai", "arXiv cs.AI (latest)", ARXIV("cat:cs.AI"), 88, { topics: RESEARCH, tier: 2 }),
  paper("arxiv:cs-cl", "arXiv cs.CL / LLMs (latest)", ARXIV("cat:cs.CL"), 88, { topics: [...RESEARCH, "LLMs"], tier: 1 }),
  paper("arxiv:cs-lg", "arXiv cs.LG (latest)", ARXIV("cat:cs.LG"), 86, { topics: RESEARCH, tier: 2 }),
  paper("arxiv:agents", "arXiv AI agents (latest)", ARXIV("all:\"AI agent\""), 86, { topics: [...RESEARCH, ...AGENTS], tier: 1 }),
  web("web:papers-code", "Papers with Code", "https://paperswithcode.com/latest", 84, { topics: RESEARCH, role: "academic", tier: 2 }),
  web("web:hf-papers", "Hugging Face Papers", "https://huggingface.co/papers", 86, { topics: [...RESEARCH, ...OPEN], role: "academic", tier: 1 }),
  web("web:semantic-scholar", "Semantic Scholar (AI)", "https://www.semanticscholar.org", 80, { topics: RESEARCH, role: "academic", tier: 3 }),
  web("web:openreview", "OpenReview", "https://openreview.net", 82, { topics: RESEARCH, role: "academic", tier: 3 }),
  blog("blog:google-research", "Google Research Blog", "https://research.google/blog/", 88, { topics: RESEARCH, role: "official", tier: 2 }),
  blog("blog:ms-research", "Microsoft Research Blog", "https://www.microsoft.com/en-us/research/blog/", 86, { topics: RESEARCH, role: "official", tier: 2 }),
  blog("blog:nvidia-research", "NVIDIA Research", "https://www.nvidia.com/en-us/research/", 84, { topics: [...RESEARCH, ...INFRA], role: "official", tier: 3 }),
];

// ---------- AI coding tools (first-party) ----------

export const AI_CODING_TOOLS: Source[] = [
  blog("blog:cursor", "Cursor Blog", "https://cursor.com/blog", 82, { topics: CODE, role: "official", tier: 1 }),
  blog("blog:github-copilot", "GitHub Copilot Blog", "https://github.blog/ai-and-ml/", 84, { topics: CODE, role: "official", tier: 1 }),
  blog("blog:replit", "Replit Blog", "https://blog.replit.com", 78, { topics: CODE, role: "official", tier: 2 }),
  blog("blog:sourcegraph", "Sourcegraph Blog", "https://sourcegraph.com/blog", 78, { topics: CODE, role: "official", tier: 2 }),
  web("web:zed", "Zed Blog", "https://zed.dev/blog", 76, { topics: CODE, role: "official", tier: 3 }),
  web("web:continue", "Continue Blog", "https://blog.continue.dev", 74, { topics: [...CODE, ...OPEN], role: "official", tier: 3 }),
  github("github:cline", "Cline releases", "https://github.com/cline/cline", 76, { topics: [...CODE, ...OPEN], role: "official", tier: 2 }),
  github("github:aider", "Aider releases", "https://github.com/Aider-AI/aider", 76, { topics: [...CODE, ...OPEN], role: "official", tier: 3 }),
  github("github:continue", "Continue releases", "https://github.com/continuedev/continue", 76, { topics: [...CODE, ...OPEN], role: "official", tier: 3 }),
];

// ---------- Key open-source repos ----------

export const OSS_REPOS: Source[] = [
  github("github:vllm", "vLLM releases", "https://github.com/vllm-project/vllm", 86, { topics: [...INFRA, ...OPEN], role: "official", tier: 1 }),
  github("github:llamacpp", "llama.cpp releases", "https://github.com/ggerganov/llama.cpp", 84, { topics: [...INFRA, ...OPEN], role: "official", tier: 2 }),
  github("github:ollama", "Ollama releases", "https://github.com/ollama/ollama", 82, { topics: [...INFRA, ...OPEN], role: "official", tier: 2 }),
  github("github:langchain", "LangChain releases", "https://github.com/langchain-ai/langchain", 82, { topics: [...AGENTS, ...OPEN], role: "official", tier: 2 }),
  github("github:transformers", "Transformers releases", "https://github.com/huggingface/transformers", 84, { topics: [...OPEN, ...AI], role: "official", tier: 2 }),
  github("github:pytorch", "PyTorch releases", "https://github.com/pytorch/pytorch", 84, { topics: [...INFRA, ...OPEN], role: "official", tier: 3 }),
  github("github:mastra", "Mastra releases", "https://github.com/mastra-ai/mastra", 78, { topics: [...AGENTS, ...OPEN], role: "official", tier: 2 }),
  github("github:opencode", "OpenCode releases", "https://github.com/sst/opencode", 76, { topics: [...CODE, ...OPEN], role: "official", tier: 3 }),
];
