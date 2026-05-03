/**
 * Planner persona table — shared between the server (TripPlannerAgent +
 * buildPlannerPrompt) and the client (Control Room persona chips). Pure
 * data, no runtime imports, safe to pull from either side.
 *
 * The three personas exist to make the three parallel planners diverge on
 * cost and trip count. Same hard constraints for all — only the strategy
 * clause and `reasoningEffort` differ.
 */

export type ReasoningEffort = "low" | "medium" | "high";

export type PlannerPersonaId = 1 | 2 | 3;

export type PlannerPersona = {
  id: PlannerPersonaId;
  /** Short human-readable label, shown in UI chips + logs. */
  label: string;
  /** Keyword used in the planner prompt and tooltips. */
  keyword: string;
  reasoningEffort: ReasoningEffort;
  /**
   * Whether `buildPlannerPrompt` should splice a `SessionTrends` summary
   * into the prompt for this persona. Only the Strategist uses trends —
   * keeping Fast/Deep blind to session history is what lets them diverge
   * from planner-1 when the Strategist converges.
   */
  useSessionTrends: boolean;
  /**
   * Free-text clause appended to `buildPlannerPrompt`. Shapes the
   * planner's optimization bias without touching hard constraints.
   */
  strategyClause: string;
};

/**
 * Canonical persona assignment. Keyed by planner suffix so
 * `${systemId}-planner-1` always lands on persona id 1.
 *
 *  - 1 **Strategist**: medium reasoning, reads the SessionTrends digest,
 *    leans on the plan shape that has been winning.
 *  - 2 **Fast**: low reasoning, quick single-edit extension; no trends.
 *  - 3 **Deep**: high reasoning, explicit alternate-consolidation
 *    exploration; no trends so it doesn't anchor on past winners.
 */
export const PLANNER_PERSONAS: Record<PlannerPersonaId, PlannerPersona> = {
  1: {
    id: 1,
    label: "Strategist",
    keyword: "strategist",
    reasoningEffort: "medium",
    useSessionTrends: true,
    strategyClause:
      "You are the Strategist. Lean on what has worked in this session — " +
      "prefer plan shapes similar to recent winning rounds and the lanes that " +
      "appear most often. When in doubt, extend the current plan with a " +
      "single trip rather than restructuring. Session trends are provided " +
      "below; weigh them against the hard constraints.",
  },
  2: {
    id: 2,
    label: "Fast",
    keyword: "fast",
    reasoningEffort: "low",
    useSessionTrends: false,
    strategyClause:
      "You are the Fast planner. Make the cheapest single edit that absorbs " +
      "the new order — usually extending one existing trip whose truck " +
      "starts at the pickup city. Do not restructure other trips. Ignore " +
      "session history; reason only from the current plan, fleet, and new " +
      "order.",
  },
  3: {
    id: 3,
    label: "Deep",
    keyword: "deep",
    reasoningEffort: "high",
    useSessionTrends: false,
    strategyClause:
      "You are the Deep planner. Before submitting, mentally draft two " +
      "candidate plans — (A) a conservative extension of the current plan " +
      "and (B) one that reassigns or merges at least two existing trips — " +
      "then submit whichever is cheaper and still satisfies every hard " +
      "constraint. Ignore session history; prioritize exploring alternate " +
      "consolidations.",
  },
};

/**
 * Extract the persona id from a stable planner name like
 * `${systemId}-planner-${n}`. Falls back to persona 1 (Strategist) when
 * the suffix is missing or out of range so the pipeline never crashes on
 * a legacy name format.
 */
export function plannerPersonaForName(name: string): PlannerPersona {
  const match = name.match(/-(\d+)$/);
  const raw = match ? Number(match[1]) : 1;
  const id: PlannerPersonaId = raw === 2 || raw === 3 ? raw : 1;
  return PLANNER_PERSONAS[id];
}

/**
 * Same lookup but keyed on the numeric seed the Director uses in the
 * last-round cards. Handy for UI components that see a candidate's
 * `seed` instead of its full name.
 */
export function plannerPersonaForSeed(seed: number): PlannerPersona {
  const id: PlannerPersonaId = seed === 2 || seed === 3 ? seed : 1;
  return PLANNER_PERSONAS[id];
}
