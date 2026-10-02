import type { LeadConfig } from "./leadConfig";
import type { PlannedPerson, SeedRow } from "../schemas/lead";

/**
 * Declarative registry of Exa Agent research modules (PRD §5).
 * Split / merge / re-tune modules here without touching workflow code.
 * Bump `schemaVersion` whenever a prompt or schema changes: it is part of the
 * cache key, so old results are not reused for a different question.
 */

export type ExaEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "auto";
export type LeadModuleId = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6";

/** Fixed-effort prices (exa.ai/docs/admin/pricing, verified 2026-09-30). */
export const EXA_FIXED_EFFORT_PRICE_USD: Record<Exclude<ExaEffort, "auto">, number> = {
  minimal: 0.012,
  low: 0.025,
  medium: 0.1,
  high: 0.5,
  xhigh: 1.0,
};

/** Upper bounds per person baked into the contact schemas (drives worst-case cost). */
export const CONTACT_LIMITS = { emailsPerPerson: 3, phonesPerPerson: 2, companyEmails: 3, companyPhones: 2 };

export interface ModuleContext {
  row: SeedRow;
  /** M0 structured output (identity) once resolved. */
  identity?: Record<string, unknown> | null;
  /** People to enrich (M4 leaders / one M5 chunk). */
  people?: PlannedPerson[];
}

export interface LeadModuleDef {
  id: LeadModuleId;
  stepId: string;
  title: string;
  schemaVersion: string;
  effort: ExaEffort;
  /** Config key holding budget.maxCostDollars for auto-effort modules. */
  budgetKey?: "m1BudgetUsd" | "m5BudgetUsd" | "m6BudgetUsd";
  /** Exa Connect providers to attach (e.g. ["fiber"]). Part of the cache key. */
  dataSources?(config: LeadConfig): string[];
  dependsOn: LeadModuleId[];
  chunked: boolean;
  systemPrompt: string;
  buildQuery(ctx: ModuleContext): string;
  buildInputData(ctx: ModuleContext): Record<string, unknown>[];
  outputSchema(ctx: ModuleContext): Record<string, unknown>;
  /** Worst-case $ for one run, used for reservation before creating it. */
  worstCaseCostUsd(ctx: ModuleContext, config: LeadConfig): number;
}

// ---------- JSON Schema helpers (nullable = may be unverifiable) ----------

const nStr = (description?: string, extra: Record<string, unknown> = {}) => ({
  type: ["string", "null"],
  ...(description ? { description } : {}),
  ...extra,
});
const nUrl = (description?: string) => nStr(description, { format: "uri" });
const nInt = (description?: string) => ({ type: ["integer", "null"], ...(description ? { description } : {}) });
const nNum = (description?: string) => ({ type: ["number", "null"], ...(description ? { description } : {}) });
const nBool = (description?: string) => ({ type: ["boolean", "null"], ...(description ? { description } : {}) });
const nEnum = (values: string[], description?: string) => ({
  type: ["string", "null"],
  enum: [...values, null],
  ...(description ? { description } : {}),
});
const arr = (items: Record<string, unknown>, maxItems: number, description?: string) => ({
  type: "array",
  maxItems,
  items,
  ...(description ? { description } : {}),
});
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const nObj = (properties: Record<string, unknown>, description?: string) => ({
  type: ["object", "null"],
  additionalProperties: false,
  properties,
  ...(description ? { description } : {}),
});

export const PERSON_FUNCTIONS = [
  "leadership",
  "product",
  "engineering",
  "design",
  "operations",
  "sales",
  "marketing",
  "customer_success",
  "finance",
  "hr_people",
  "data",
  "other",
];

const EVIDENCE_RULES =
  "Evidence rules: research ONLY the single company identified in input.data (match on official domain AND name; never merge data about similarly named companies). " +
  "Report only facts supported by public sources you actually found. If a field cannot be verified, return null or an empty array: absence of evidence is null, never a guess. " +
  "Never invent people, numbers, dates or URLs. Never construct email addresses from naming patterns. Prefer the company's own site, official registries, reputable press and current profiles.";

// ---------- small accessors ----------

function idStr(identity: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = identity?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function companyRef(ctx: ModuleContext): Record<string, unknown> {
  return {
    company_name: idStr(ctx.identity, "brand_name") ?? idStr(ctx.identity, "legal_name") ?? ctx.row.company_name,
    legal_name: idStr(ctx.identity, "legal_name"),
    official_domain: idStr(ctx.identity, "official_domain") ?? ctx.row.website_domain,
    hq_city: idStr(ctx.identity, "hq_city"),
    hq_country: idStr(ctx.identity, "hq_country"),
    sector: idStr(ctx.identity, "sector") ?? ctx.row.sector,
    description: idStr(ctx.identity, "description"),
  };
}

function companyLabel(ctx: ModuleContext): string {
  const ref = companyRef(ctx);
  return `${String(ref.company_name)}${ref.official_domain ? ` (${String(ref.official_domain)})` : ""}`;
}

const contactValue = (formatKind: "email" | "phone", types: string[]) =>
  obj(
    {
      value: { type: "string", format: formatKind },
      type: nEnum(types),
      source_url: nUrl("Public page where this value appears, if any."),
    },
    ["value"],
  );

function personContactSchema(maxPeople: number) {
  return obj(
    {
      people: arr(
        obj(
          {
            input_name: { type: "string", description: "Exactly the name given in input.data for this person." },
            emails: arr(contactValue("email", ["work", "personal", "generic"]), CONTACT_LIMITS.emailsPerPerson),
            phones: arr(contactValue("phone", ["mobile", "direct", "company"]), CONTACT_LIMITS.phonesPerPerson),
            linkedin_url: nUrl(),
            x_url: nUrl(),
            other_profiles: arr(obj({ platform: nStr(), url: { type: "string", format: "uri" } }, ["url"]), 5),
          },
          ["input_name"],
        ),
        Math.max(1, maxPeople),
      ),
    },
    ["people"],
  );
}

function contactWorstCase(people: number, config: LeadConfig, includeCompany: boolean): number {
  const perPerson =
    CONTACT_LIMITS.emailsPerPerson * config.emailRateUsd + CONTACT_LIMITS.phonesPerPerson * config.phoneRateUsd;
  const company = includeCompany
    ? CONTACT_LIMITS.companyEmails * config.emailRateUsd + CONTACT_LIMITS.companyPhones * config.phoneRateUsd
    : 0;
  return people * perPerson + company;
}

const peopleInput = (ctx: ModuleContext) => {
  const ref = companyRef(ctx);
  return (ctx.people ?? []).map((p) => ({
    name: p.name,
    title: p.title,
    linkedin_url: p.linkedin_url,
    company_name: ref.company_name,
    company_domain: ref.official_domain,
  }));
};

// ---------- modules ----------

const M0: LeadModuleDef = {
  id: "M0",
  stepId: "lead-m0-identity",
  title: "Identity & profile",
  schemaVersion: "m0.v1",
  effort: "low",
  dependsOn: [],
  chunked: false,
  systemPrompt:
    `You verify the identity of one startup. ${EVIDENCE_RULES} ` +
    "The input website may be blank or wrong: confirm the real official domain from evidence. " +
    "identity_confidence: high = official site plus at least one independent source agree with the input name/sector; " +
    "medium = likely match, partially verified; low = you cannot confidently identify ONE matching company.",
  buildQuery: () =>
    "Resolve the identity of the startup described in input.data. Confirm its official website domain, legal and brand name, " +
    "a short factual description, HQ city and country, founded year, sector, company LinkedIn page and official social profiles, " +
    "and rate how confident the identification is.",
  buildInputData: (ctx) => [
    {
      company_name: ctx.row.company_name,
      sector: ctx.row.sector,
      profile: ctx.row.profile,
      website_domain: ctx.row.website_domain,
      address: ctx.row.address,
      contact_person: ctx.row.contact_person,
      designation: ctx.row.designation,
      // Only the domain of the seed email: a strong identity hint without sharing the address.
      seed_email_domain: ctx.row.email?.includes("@") ? ctx.row.email.split("@").pop()?.toLowerCase() ?? null : null,
    },
  ],
  outputSchema: () =>
    obj(
      {
        official_domain: nStr("Bare domain, e.g. example.com"),
        legal_name: nStr(),
        brand_name: nStr(),
        description: nStr("1-3 factual sentences", { maxLength: 600 }),
        hq_city: nStr(),
        hq_country: nStr(),
        founded_year: nInt(),
        sector: nStr(),
        company_linkedin_url: nUrl(),
        socials: obj({
          x_url: nUrl(),
          instagram_url: nUrl(),
          youtube_url: nUrl(),
          facebook_url: nUrl(),
          other_urls: arr({ type: "string", format: "uri" }, 5),
        }),
        input_website_matches: nBool("Whether the input website domain is the official domain."),
        identity_confidence: { type: "string", enum: ["high", "medium", "low"] },
        identity_confidence_reason: { type: "string", maxLength: 300 },
      },
      ["identity_confidence", "identity_confidence_reason"],
    ),
  worstCaseCostUsd: () => EXA_FIXED_EFFORT_PRICE_USD.low,
};

const M1: LeadModuleDef = {
  id: "M1",
  stepId: "lead-m1-team",
  title: "Founders & team",
  schemaVersion: "m1.v1",
  effort: "auto",
  budgetKey: "m1BudgetUsd",
  dependsOn: ["M0"],
  chunked: false,
  systemPrompt:
    `You map the people and teams of one startup. ${EVIDENCE_RULES} ` +
    "Include only people whose CURRENT role at this company is supported by a current source. " +
    "Do not return contact details (emails/phones) in this task.",
  buildQuery: (ctx) =>
    `For ${companyLabel(ctx)} described in input.data: identify founders and current leaders (name, current title, LinkedIn profile URL), ` +
    "and as many current team members as are publicly identifiable (name, title, function/department, LinkedIn URL). " +
    "List the functional teams that exist, and estimate current team size as a range with its basis (e.g. LinkedIn employee count, careers page, press) and confidence.",
  buildInputData: (ctx) => [companyRef(ctx)],
  outputSchema: () =>
    obj(
      {
        leaders: arr(
          obj(
            {
              name: { type: "string" },
              title: nStr(),
              is_founder: nBool(),
              linkedin_url: nUrl(),
            },
            ["name"],
          ),
          15,
          "Founders and leaders (CEO, COO, CTO, Chief of Staff, Head of Ops/Product, etc.).",
        ),
        team_members: arr(
          obj(
            {
              name: { type: "string" },
              title: nStr(),
              function: nEnum(PERSON_FUNCTIONS),
              linkedin_url: nUrl(),
            },
            ["name"],
          ),
          60,
          "Current non-leader team members.",
        ),
        functional_teams: arr(obj({ name: { type: "string" }, headcount_estimate: nInt() }, ["name"]), 15),
        team_size_estimate: obj({
          low: nInt(),
          high: nInt(),
          basis: nStr(undefined, { maxLength: 300 }),
          confidence: nEnum(["high", "medium", "low"]),
        }),
      },
      ["leaders", "team_members"],
    ),
  worstCaseCostUsd: (_ctx, config) => config.m1BudgetUsd,
};

const M2: LeadModuleDef = {
  id: "M2",
  stepId: "lead-m2-signals",
  title: "Funding, revenue & hiring",
  schemaVersion: "m2.v1",
  effort: "medium",
  dependsOn: ["M0"],
  chunked: false,
  systemPrompt: `You collect business signals for one startup. ${EVIDENCE_RULES} Revenue must be null unless a source states or clearly supports it.`,
  buildQuery: (ctx) =>
    `For ${companyLabel(ctx)} described in input.data: list funding rounds (date, stage, amount, investors, source), any revenue figure with its basis, ` +
    "open roles count and departments hiring, careers page URL, and recent (last 12 months) hiring, launch, expansion, funding or new-executive news with dates.",
  buildInputData: (ctx) => [companyRef(ctx)],
  outputSchema: () =>
    obj(
      {
        funding_rounds: arr(
          obj({
            date: nStr("YYYY-MM or YYYY-MM-DD"),
            stage: nStr(),
            amount_value: nNum(),
            amount_currency: nStr("ISO 4217"),
            investors: arr({ type: "string" }, 10),
            source_url: nUrl(),
          }),
          10,
        ),
        revenue_estimate: nObj({
          value: nNum(),
          currency: nStr(),
          period: nStr("e.g. FY2025, ARR, monthly"),
          basis: nStr(undefined, { maxLength: 300 }),
          confidence: nEnum(["high", "medium", "low"]),
        }),
        hiring: obj({
          open_roles_count: nInt(),
          departments_hiring: arr({ type: "string" }, 10),
          careers_page_url: nUrl(),
          job_board_urls: arr({ type: "string", format: "uri" }, 5),
        }),
        recent_news: arr(
          obj(
            {
              date: nStr(),
              type: nEnum(["hiring", "launch", "expansion", "funding", "new_executive", "partnership", "other"]),
              headline: { type: "string", maxLength: 300 },
              source_url: nUrl(),
            },
            ["headline"],
          ),
          10,
        ),
      },
      ["funding_rounds", "recent_news"],
    ),
  worstCaseCostUsd: () => EXA_FIXED_EFFORT_PRICE_USD.medium,
};

const M3: LeadModuleDef = {
  id: "M3",
  stepId: "lead-m3-tools",
  title: "Tools & platforms",
  schemaVersion: "m3.v1",
  effort: "medium",
  dependsOn: ["M0"],
  chunked: false,
  systemPrompt:
    `You identify the software tools a startup uses and public signals about tooling pain. ${EVIDENCE_RULES} ` +
    "evidence_type: stated_by_company (their site/blog/team says so), job_post (listed in a job ad), site_or_docs (detected on their site or docs), " +
    "third_party (review sites, integrations directories), inferred (weak indirect signal; use sparingly).",
  buildQuery: (ctx) =>
    `For ${companyLabel(ctx)} described in input.data: list tools and platforms it uses (name, category, evidence type, source), and public complaints or signals ` +
    "about tool sprawl, documentation, meetings, coordination, onboarding or operational chaos (e.g. in job posts, founder posts, reviews).",
  buildInputData: (ctx) => [companyRef(ctx)],
  outputSchema: () =>
    obj(
      {
        tools: arr(
          obj(
            {
              name: { type: "string" },
              category: nStr("e.g. communication, docs/wiki, project management, CRM, analytics, dev tooling"),
              evidence_type: {
                type: "string",
                enum: ["stated_by_company", "job_post", "site_or_docs", "third_party", "inferred"],
              },
              source_url: nUrl(),
            },
            ["name", "evidence_type"],
          ),
          40,
        ),
        tooling_signals: arr(
          obj(
            {
              signal_type: {
                type: "string",
                enum: [
                  "tool_complaint",
                  "docs_pain",
                  "meeting_overload",
                  "coordination_pain",
                  "onboarding_pain",
                  "process_chaos",
                  "other",
                ],
              },
              text: { type: "string", maxLength: 300 },
              date: nStr(),
              source_url: nUrl(),
            },
            ["signal_type", "text"],
          ),
          15,
        ),
      },
      ["tools", "tooling_signals"],
    ),
  worstCaseCostUsd: () => EXA_FIXED_EFFORT_PRICE_USD.medium,
};

const CONTACT_RULES =
  "Return only contact details that are publicly available or returned by Exa contact enrichment for THIS person at THIS company. " +
  "Never guess an email from a naming pattern. Label each value's type. Match every person back by input_name exactly as given.";

const M4: LeadModuleDef = {
  id: "M4",
  stepId: "lead-m4-leader-contacts",
  title: "Leader contacts",
  schemaVersion: "m4.v1",
  effort: "medium",
  dependsOn: ["M1"],
  chunked: false,
  systemPrompt: `You find contact details for company leaders. ${EVIDENCE_RULES} ${CONTACT_RULES}`,
  buildQuery: (ctx) =>
    `For each person in input.data (leaders at ${companyLabel(ctx)}), find work/personal emails, phone numbers, LinkedIn, X and other public profiles. ` +
    "Also return the company's generic public contact emails and phone numbers.",
  buildInputData: peopleInput,
  outputSchema: (ctx) => {
    const base = personContactSchema(ctx.people?.length ?? 1) as { properties: Record<string, unknown>; required: string[] };
    return {
      ...base,
      properties: {
        ...base.properties,
        company_contacts: obj({
          emails: arr(contactValue("email", ["generic", "work"]), CONTACT_LIMITS.companyEmails),
          phones: arr(contactValue("phone", ["company", "direct", "mobile"]), CONTACT_LIMITS.companyPhones),
        }),
      },
    };
  },
  worstCaseCostUsd: (ctx, config) =>
    EXA_FIXED_EFFORT_PRICE_USD.medium + contactWorstCase(ctx.people?.length ?? 0, config, true),
};

const M5: LeadModuleDef = {
  id: "M5",
  stepId: "lead-m5-team-contacts",
  title: "Team contacts",
  schemaVersion: "m5.v1",
  effort: "auto",
  budgetKey: "m5BudgetUsd",
  dependsOn: ["M1"],
  chunked: true,
  systemPrompt: `You find contact details for team members of one company. ${EVIDENCE_RULES} ${CONTACT_RULES}`,
  buildQuery: (ctx) =>
    `For each person in input.data (team members at ${companyLabel(ctx)}), find work/personal emails, phone numbers, LinkedIn, X and other public profiles.`,
  buildInputData: peopleInput,
  outputSchema: (ctx) => personContactSchema(ctx.people?.length ?? 1),
  // budget.maxCostDollars may not cap contact-enrichment charges (Exa bills them "on top"), so add both.
  worstCaseCostUsd: (ctx, config) => config.m5BudgetUsd + contactWorstCase(ctx.people?.length ?? 0, config, false),
};

// ---------- M6: social activity (company + founders) ----------

const platformActivity = (platform: string) =>
  nObj(
    {
      profile_url: nUrl(`The ${platform} profile/page URL that was checked.`),
      followers: nInt("Follower count, if shown."),
      total_posts: nInt("Lifetime post count, ONLY if the platform displays it (X, Instagram). null for LinkedIn."),
      posts_last_90_days: nInt("Number of posts in the last 90 days, if it can be counted."),
      last_post_date: nStr("Date of the most recent post, YYYY-MM-DD. null if unknown."),
    },
    `${platform} activity. null when no ${platform} account was found.`,
  );

const activityBlock = () =>
  obj({ linkedin: platformActivity("LinkedIn"), x: platformActivity("X"), instagram: platformActivity("Instagram") });

const M6: LeadModuleDef = {
  id: "M6",
  stepId: "lead-m6-social-activity",
  title: "Social activity",
  schemaVersion: "m6.v1",
  effort: "auto",
  budgetKey: "m6BudgetUsd",
  dependsOn: ["M0", "M1"],
  chunked: false,
  dataSources: (config) => config.m6DataSources,
  systemPrompt:
    `You measure how active a startup and its founders are on social media. ${EVIDENCE_RULES} ` +
    "Only report an account when it clearly belongs to this company or this person (match name, company and role). " +
    "Dates and counts must come from the account itself or a data provider, never estimated. " +
    "When a LinkedIn data provider is available, use it for LinkedIn posts. " +
    "Do not return emails or phone numbers.",
  buildQuery: (ctx) =>
    `For ${companyLabel(ctx)} and for each person in input.data (its founders/leaders), report activity on LinkedIn, X (Twitter) and Instagram: ` +
    "the profile URL, follower count, lifetime post count where the platform shows it, number of posts in the last 90 days, and the date of the most recent post. " +
    "Use the known profile URLs in input.data when given; otherwise find the official accounts.",
  buildInputData: (ctx) => {
    const ref = companyRef(ctx);
    const socials = (ctx.identity?.socials ?? {}) as Record<string, unknown>;
    const company = {
      entity: "company",
      name: ref.company_name,
      official_domain: ref.official_domain,
      linkedin_url: idStr(ctx.identity, "company_linkedin_url"),
      x_url: typeof socials.x_url === "string" ? socials.x_url : null,
      instagram_url: typeof socials.instagram_url === "string" ? socials.instagram_url : null,
    };
    const people = (ctx.people ?? []).map((p) => ({
      entity: "person",
      name: p.name,
      title: p.title,
      linkedin_url: p.linkedin_url,
      company_name: ref.company_name,
    }));
    return [company, ...people];
  },
  outputSchema: (ctx) =>
    obj(
      {
        company: activityBlock(),
        people: arr(
          obj(
            {
              input_name: { type: "string", description: "Exactly the name given in input.data for this person." },
              linkedin: platformActivity("LinkedIn"),
              x: platformActivity("X"),
              instagram: platformActivity("Instagram"),
            },
            ["input_name"],
          ),
          Math.max(1, ctx.people?.length ?? 1),
        ),
      },
      ["company", "people"],
    ),
  // Connect provider calls (e.g. Fiber credits) are billed on top of the run budget.
  worstCaseCostUsd: (_ctx, config) =>
    config.m6BudgetUsd + (config.m6DataSources.length ? config.m6ConnectReserveUsd : 0),
};

export const LEAD_MODULES: Record<LeadModuleId, LeadModuleDef> = { M0, M1, M2, M3, M4, M5, M6 };

/** Sarvam judgement step version (part of its cache key). */
export const S1_SCHEMA_VERSION = "s1.v1";
