import type { LeadConfig } from "../../config/leadConfig";
import { LEAD_MODULES } from "../../config/leadModules";
import type { CompanyPerson, ContactPlan, ContactValue, PlannedPerson, SeedRow } from "../../schemas/lead";
import { isDecisionMakerTitle } from "./icp";

/**
 * Contact planning (PRD §5.1, §11) and merging of researched contacts with
 * the seed CSV. Seed values are never overwritten: the seed contact is kept
 * as its own person with source_type = seed_csv, and a mismatch with
 * researched values is flagged `conflict = true` on both.
 */

export function personKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(dr|mr|mrs|ms|prof)\.?\s+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type M1Person = { name?: unknown; title?: unknown; function?: unknown; linkedin_url?: unknown; is_founder?: unknown };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const PRIORITY_FUNCTIONS = new Set(["product", "engineering", "operations", "data", "design", "leadership"]);

function leaderRank(p: PlannedPerson): number {
  if (isDecisionMakerTitle(p.title)) return 0;
  if (p.source === "seed_csv") return 1;
  if (/product|cto|technology|engineering/i.test(p.title ?? "")) return 2;
  return 3;
}

export function planContacts(input: {
  row: SeedRow;
  m1: unknown;
  config: LeadConfig;
  remainingUsd: number;
}): ContactPlan {
  const { row, config } = input;
  const m1 = (input.m1 ?? {}) as { leaders?: M1Person[]; team_members?: M1Person[] };
  const seen = new Set<string>();
  const leaders: PlannedPerson[] = [];
  for (const l of m1.leaders ?? []) {
    const name = str(l.name);
    if (!name || seen.has(personKey(name))) continue;
    seen.add(personKey(name));
    leaders.push({
      key: personKey(name),
      name,
      title: str(l.title),
      function: "leadership",
      linkedin_url: str(l.linkedin_url),
      is_leader: true,
      source: "exa_m1",
    });
  }
  if (row.contact_person && !seen.has(personKey(row.contact_person))) {
    seen.add(personKey(row.contact_person));
    leaders.push({
      key: personKey(row.contact_person),
      name: row.contact_person,
      title: row.designation,
      function: null,
      linkedin_url: null,
      is_leader: true,
      source: "seed_csv",
    });
  }
  leaders.sort((a, b) => leaderRank(a) - leaderRank(b));
  leaders.splice(15); // M4 schema cap

  const team: PlannedPerson[] = [];
  for (const t of m1.team_members ?? []) {
    const name = str(t.name);
    if (!name || seen.has(personKey(name))) continue;
    seen.add(personKey(name));
    team.push({
      key: personKey(name),
      name,
      title: str(t.title),
      function: str(t.function),
      linkedin_url: str(t.linkedin_url),
      is_leader: false,
      source: "exa_m1",
    });
  }
  // Priority when caps bite: product/tech/ops first, then the rest (stable order).
  team.sort((a, b) => Number(!PRIORITY_FUNCTIONS.has(a.function ?? "")) - Number(!PRIORITY_FUNCTIONS.has(b.function ?? "")));

  const reasons: string[] = [];
  let teamPlanned = team;
  if (teamPlanned.length > config.maxTeamContactsPerCompany) {
    reasons.push(`LEAD_MAX_TEAM_CONTACTS_PER_COMPANY=${config.maxTeamContactsPerCompany}`);
    teamPlanned = teamPlanned.slice(0, config.maxTeamContactsPerCompany);
  }

  const m4Cost = (people: PlannedPerson[]) => (people.length ? LEAD_MODULES.M4.worstCaseCostUsd({ row, people }, config) : 0);
  const chunk = (people: PlannedPerson[]) => {
    const out: PlannedPerson[][] = [];
    for (let i = 0; i < people.length; i += config.teamChunkSize) out.push(people.slice(i, i + config.teamChunkSize));
    return out;
  };
  const m5Cost = (people: PlannedPerson[]) =>
    chunk(people).reduce((sum, c) => sum + LEAD_MODULES.M5.worstCaseCostUsd({ row, people: c }, config), 0);

  let plannedLeaders = leaders;
  while (plannedLeaders.length && m4Cost(plannedLeaders) > input.remainingUsd) plannedLeaders = plannedLeaders.slice(0, -1);
  if (plannedLeaders.length < leaders.length) reasons.push("company budget (leaders)");

  const leftover = input.remainingUsd - m4Cost(plannedLeaders);
  let n = teamPlanned.length;
  while (n > 0 && m5Cost(teamPlanned.slice(0, n)) > leftover) n--;
  if (n < teamPlanned.length) reasons.push("company budget (team)");
  teamPlanned = teamPlanned.slice(0, n);

  return {
    leaders: plannedLeaders,
    team_chunks: chunk(teamPlanned),
    contacts_truncated: reasons.length > 0,
    truncation_reason: reasons.length ? reasons.join("; ") : null,
    estimated_worst_case_usd: Number((m4Cost(plannedLeaders) + m5Cost(teamPlanned)).toFixed(4)),
  };
}

// ---------- merging ----------

type RawContact = { value?: unknown; type?: unknown; source_url?: unknown };
type RawPersonContacts = {
  input_name?: unknown;
  emails?: RawContact[];
  phones?: RawContact[];
  linkedin_url?: unknown;
  x_url?: unknown;
  other_profiles?: { platform?: unknown; url?: unknown }[];
};

function toValues(list: RawContact[] | undefined, kind: "email" | "phone"): ContactValue[] {
  const out: ContactValue[] = [];
  const seen = new Set<string>();
  for (const c of list ?? []) {
    const value = str(c?.value);
    if (!value) continue;
    const norm = kind === "email" ? value.toLowerCase() : value.replace(/[^\d+]/g, "");
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ value, type: str(c.type), source_url: str(c.source_url), source_type: "exa_agent" });
  }
  return out;
}

const normEmail = (v: string) => v.trim().toLowerCase();
const normPhone = (v: string) => v.replace(/\D/g, "").slice(-10);

export function mergePeople(input: {
  row: SeedRow;
  m1: unknown;
  contactOutputs: unknown[]; // M4 + every M5 chunk structured output
}): { people: CompanyPerson[]; companyContacts: { emails: ContactValue[]; phones: ContactValue[] }; conflict: boolean } {
  const m1 = (input.m1 ?? {}) as { leaders?: M1Person[]; team_members?: M1Person[] };
  const byKey = new Map<string, CompanyPerson>();
  const add = (p: M1Person, isLeader: boolean) => {
    const name = str(p.name);
    if (!name) return;
    const key = personKey(name);
    if (byKey.has(key)) return;
    byKey.set(key, {
      key,
      name,
      title: str(p.title),
      function: isLeader ? "leadership" : str(p.function),
      linkedin_url: str(p.linkedin_url),
      x_url: null,
      other_profiles: [],
      emails: [],
      phones: [],
      is_leader: isLeader,
      is_founder: typeof p.is_founder === "boolean" ? p.is_founder : null,
      source_type: "exa_agent",
      source_urls: [],
      conflict: false,
    });
  };
  for (const l of m1.leaders ?? []) add(l, true);
  for (const t of m1.team_members ?? []) add(t, false);

  const companyContacts = { emails: [] as ContactValue[], phones: [] as ContactValue[] };
  for (const out of input.contactOutputs) {
    const o = (out ?? {}) as { people?: RawPersonContacts[]; company_contacts?: { emails?: RawContact[]; phones?: RawContact[] } };
    for (const rp of o.people ?? []) {
      const name = str(rp.input_name);
      if (!name) continue;
      const key = personKey(name);
      let person = byKey.get(key);
      if (!person) {
        // Contacts for the seed contact person (researched copy; seed copy stays separate).
        person = {
          key,
          name,
          title: key === personKey(input.row.contact_person ?? "") ? input.row.designation : null,
          function: null,
          linkedin_url: null,
          x_url: null,
          other_profiles: [],
          emails: [],
          phones: [],
          is_leader: true,
          is_founder: null,
          source_type: "exa_agent",
          source_urls: [],
          conflict: false,
        };
        byKey.set(key, person);
      }
      person.emails = mergeValues(person.emails, toValues(rp.emails, "email"), normEmail);
      person.phones = mergeValues(person.phones, toValues(rp.phones, "phone"), normPhone);
      person.linkedin_url = person.linkedin_url ?? str(rp.linkedin_url);
      person.x_url = person.x_url ?? str(rp.x_url);
      for (const op of rp.other_profiles ?? []) {
        const url = str(op?.url);
        if (url && !person.other_profiles.some((x) => x.url === url)) person.other_profiles.push({ platform: str(op.platform), url });
      }
      for (const v of [...person.emails, ...person.phones]) if (v.source_url && !person.source_urls.includes(v.source_url)) person.source_urls.push(v.source_url);
    }
    if (o.company_contacts) {
      companyContacts.emails = mergeValues(companyContacts.emails, toValues(o.company_contacts.emails, "email"), normEmail);
      companyContacts.phones = mergeValues(companyContacts.phones, toValues(o.company_contacts.phones, "phone"), normPhone);
    }
  }

  // Seed contact: its own record, never overwritten.
  let conflict = false;
  const row = input.row;
  if (row.contact_person || row.email || row.mobile) {
    const seedName = row.contact_person ?? "(seed contact)";
    const key = personKey(seedName);
    const researched = byKey.get(key);
    if (researched) {
      const emailClash =
        !!row.email && researched.emails.length > 0 && !researched.emails.some((e) => normEmail(e.value) === normEmail(row.email!));
      const phoneClash =
        !!row.mobile && researched.phones.length > 0 && !researched.phones.some((p) => normPhone(p.value) === normPhone(row.mobile!));
      conflict = emailClash || phoneClash;
      researched.conflict = conflict;
    }
    byKey.set(`seed:${key}`, {
      key: `seed:${key}`,
      name: seedName,
      title: row.designation,
      function: null,
      linkedin_url: null,
      x_url: null,
      other_profiles: [],
      emails: row.email ? [{ value: row.email, type: null, source_url: null, source_type: "seed_csv" }] : [],
      phones: row.mobile ? [{ value: row.mobile, type: null, source_url: null, source_type: "seed_csv" }] : [],
      is_leader: isDecisionMakerTitle(row.designation),
      is_founder: null,
      source_type: "seed_csv",
      source_urls: [],
      conflict,
    });
  }

  return { people: [...byKey.values()], companyContacts, conflict };
}

function mergeValues(a: ContactValue[], b: ContactValue[], norm: (v: string) => string): ContactValue[] {
  const out = [...a];
  for (const v of b) if (!out.some((x) => norm(x.value) === norm(v.value))) out.push(v);
  return out;
}
