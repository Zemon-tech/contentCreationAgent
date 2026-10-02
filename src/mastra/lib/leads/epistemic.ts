import type { CriterionOutcome, IcpJudgement } from "../../schemas/lead";
import { checkRef, type EvidenceModuleId, type ModuleEvidence } from "./evidence";

/**
 * Epistemic rule enforced in CODE (PRD §7):
 * - an `observed` claim needs >= 1 ref to a real, Exa-cited module field,
 *   otherwise it is downgraded to `hypothesis`;
 * - a criterion decided met / not_met without a valid ref becomes `unknown`;
 * - a trigger without a valid ref is not reported as a trigger; it is kept
 *   as a hypothesis claim instead.
 */

export interface EnforcedJudgement {
  criteria: Record<string, CriterionOutcome>;
  triggers: IcpJudgement["triggers"];
  claims: (IcpJudgement["claims"][number] & { downgraded: boolean })[];
  pain_track: IcpJudgement["pain_track"];
  pain_hypothesis: string | null;
  ops_summary: string | null;
  downgrades: number;
}

export function enforceEpistemics(
  j: IcpJudgement,
  modules: Partial<Record<EvidenceModuleId, ModuleEvidence | null>>,
): EnforcedJudgement {
  const hasValid = (refs: string[]) => refs.some((r) => checkRef(r, modules).valid);
  let downgrades = 0;

  const criteria: Record<string, CriterionOutcome> = {};
  for (const [id, c] of Object.entries(j.criteria)) {
    if (c.result !== "unknown" && !hasValid(c.evidence_refs)) {
      downgrades++;
      criteria[id] = {
        result: "unknown",
        reason: `downgraded from ${c.result}: no Exa-cited evidence ref. ${c.reason}`.slice(0, 600),
        evidence_refs: c.evidence_refs,
        decided_by: "code_downgrade",
      };
    } else {
      criteria[id] = { ...c, decided_by: "sarvam" };
    }
  }

  const claims: EnforcedJudgement["claims"] = j.claims.map((c) => {
    if (c.epistemic === "observed" && !hasValid(c.evidence_refs)) {
      downgrades++;
      return { ...c, epistemic: "hypothesis", downgraded: true };
    }
    return { ...c, downgraded: false };
  });

  const triggers: IcpJudgement["triggers"] = [];
  for (const t of j.triggers) {
    if (hasValid(t.evidence_refs)) triggers.push(t);
    else {
      downgrades++;
      claims.push({ text: `Possible trigger (${t.type}): ${t.text}`, epistemic: "hypothesis", evidence_refs: t.evidence_refs, downgraded: true });
    }
  }

  return {
    criteria,
    triggers,
    claims,
    pain_track: j.pain_track,
    pain_hypothesis: j.pain_hypothesis,
    ops_summary: j.ops_summary,
    downgrades,
  };
}
