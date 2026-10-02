/**
 * ICP verdict rule (PRD §8) — the ONE place to change qualification logic.
 * Defaults are [PROPOSED] pending owner decision OPEN-1 / OPEN-2.
 */

export type CriterionId =
  | "team_size"
  | "startup_tech_enabled"
  | "multiple_functional_teams"
  | "early_stage"
  | "problem_fit_signals"
  | "current_trigger"
  | "decision_maker"
  | "social_activity";

export const ICP_RULES = {
  /** D3 [LOCKED]: team size 5–50 inclusive. */
  teamSize: { min: 5, max: 50 },

  /** Qualified = ALL `requireMet` met AND at least `minMet` of `anyOf` met. */
  qualified: {
    requireMet: ["team_size", "decision_maker"] as CriterionId[],
    anyOf: ["multiple_functional_teams", "problem_fit_signals", "current_trigger", "social_activity"] as CriterionId[],
    minMet: 2,
  },

  /** Not qualified when ANY of these criteria is not_met. */
  disqualifyIfNotMet: ["team_size", "startup_tech_enabled"] as CriterionId[],

  /**
   * Cannot be Qualified (falls to Needs review) when ANY of these is not_met.
   * social_activity not_met = company AND founders dormant everywhere we found them.
   */
  blockQualifiedIfNotMet: ["social_activity"] as CriterionId[],

  /**
   * Social activity (M6), by days since the most recent post on any platform:
   *   <= activeWithinDays  -> active
   *   <= dormantAfterDays  -> low_activity
   *   >  dormantAfterDays  -> dormant
   * social_activity is met when the company OR any founder is active.
   */
  activity: { activeWithinDays: 30, dormantAfterDays: 180 },

  /** Titles that count as an identified decision-maker (criterion 7). */
  decisionMakerTitlePatterns: [
    /\bfounder\b/i,
    /\bco-?founder\b/i,
    /\bceo\b/i,
    /chief executive/i,
    /\bcoo\b/i,
    /chief operating/i,
    /chief of staff/i,
    /head of (ops|operations)/i,
    /\b(vp|director)\b.*\boperations\b/i,
    /\bmanaging director\b/i,
  ],
} as const;
