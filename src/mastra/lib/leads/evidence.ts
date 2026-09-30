import type { SeedRow } from "../../schemas/lead";

/**
 * Evidence handling for the Sarvam judge (PRD §7, §12).
 * - buildJudgeEvidence: compact JSON of M0–M3 with ALL contact data removed
 *   (no emails, phones, profile URLs) — array indices are preserved so
 *   evidence refs like "M1.team_members[3].title" still resolve.
 * - resolveRef / isGroundedRef: check that a ref points at a real field that
 *   carries an Exa citation in the module's output.grounding.
 */

export type EvidenceModuleId = "M0" | "M1" | "M2" | "M3";
export const JUDGE_MODULES: EvidenceModuleId[] = ["M0", "M1", "M2", "M3"];

export interface ModuleEvidence {
  status: string;
  structured: unknown;
  grounding: unknown;
}

const CONTACT_OR_URL_KEY = /(email|phone|mobile|linkedin|_url$|^url$|_urls$|^socials$|other_profiles|other_urls)/i;

export function stripContacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripContacts);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CONTACT_OR_URL_KEY.test(k)) continue;
      out[k] = stripContacts(v);
    }
    return out;
  }
  return value;
}

export function seedForJudge(row: SeedRow): Record<string, unknown> {
  // Seed mobile/email are never sent to any LLM.
  return {
    company_name: row.company_name,
    sector: row.sector,
    profile: row.profile,
    contact_person: row.contact_person,
    designation: row.designation,
    website_domain: row.website_domain,
    address: row.address,
  };
}

export function buildJudgeEvidence(
  row: SeedRow,
  modules: Partial<Record<EvidenceModuleId, ModuleEvidence | null>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { SEED: seedForJudge(row) };
  const statuses: Record<string, string> = {};
  for (const id of JUDGE_MODULES) {
    const m = modules[id];
    statuses[id] = m?.status ?? "missing";
    out[id] = m?.structured ? stripContacts(m.structured) : null;
  }
  out.module_status = statuses;
  return out;
}

// ---------- refs ----------

/** "M1.team_members[3].title" | "M1.team_members.3.title" | "M1/team_members/3/title" */
export function parseRef(ref: string): { module: string; path: string[] } | null {
  const s = ref.trim().replace(/^\$\.?/, "");
  const m = s.match(/^([A-Za-z][A-Za-z0-9]*)(?:[./](.*))?$/);
  if (!m) return null;
  const module = m[1]!.toUpperCase();
  const rest = (m[2] ?? "").replace(/\[(\d+)\]/g, ".$1").replace(/\//g, ".");
  const path = rest.split(".").map((p) => p.trim()).filter(Boolean);
  return { module, path };
}

export function getAtPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}

function normaliseField(field: string): string[] {
  return field
    .replace(/^\$\.?/, "")
    .replace(/^\//, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\//g, ".")
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
}

const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((seg, i) => seg === b[i]);

/** True when output.grounding has a citation on this field, an ancestor, or a descendant. */
export function groundingSupports(grounding: unknown, path: string[]): boolean {
  if (!Array.isArray(grounding) || path.length === 0) return false;
  for (const entry of grounding) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { field?: unknown; citations?: unknown };
    if (typeof e.field !== "string") continue;
    if (!Array.isArray(e.citations) || e.citations.length === 0) continue;
    const f = normaliseField(e.field);
    if (f.length === 0) continue; // a root-level citation is too vague to back one field
    if (isPrefix(f, path) || isPrefix(path, f)) return true;
  }
  return false;
}

export type RefCheck = { ref: string; valid: boolean; why: string };

/** A ref is valid for "observed" only if it resolves to a non-empty value with an Exa citation. */
export function checkRef(ref: string, modules: Partial<Record<EvidenceModuleId, ModuleEvidence | null>>): RefCheck {
  const parsed = parseRef(ref);
  if (!parsed) return { ref, valid: false, why: "unparseable ref" };
  if (parsed.module === "SEED") return { ref, valid: false, why: "seed CSV is not Exa evidence" };
  if (!JUDGE_MODULES.includes(parsed.module as EvidenceModuleId)) return { ref, valid: false, why: "unknown module" };
  const m = modules[parsed.module as EvidenceModuleId];
  if (!m || !m.structured) return { ref, valid: false, why: "module has no output" };
  if (parsed.path.length === 0) return { ref, valid: false, why: "ref must point at a field" };
  const value = getAtPath(m.structured, parsed.path);
  const empty =
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0);
  if (empty) return { ref, valid: false, why: "field is empty or missing" };
  if (!groundingSupports(m.grounding, parsed.path)) return { ref, valid: false, why: "no Exa citation for field" };
  return { ref, valid: true, why: "ok" };
}
