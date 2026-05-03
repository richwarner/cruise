import { createWorkersAI } from "workers-ai-provider";

import type { ReasoningEffort } from "../shared/personas";

export const CRUISE_MODEL_ID = "@cf/moonshotai/kimi-k2.6";
export const CRUISE_PROBE_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct";

/**
 * Shared Workers AI model factory. The `seed` parameter is passed through as
 * `sessionAffinity` so each Planner lands on an independent model session and
 * the three parallel plans diverge. Director passes its own `sessionAffinity`.
 *
 * `opts.reasoningEffort` lets callers override the default `"low"` budget —
 * currently only used by the per-planner persona machinery so planner-2 can
 * think fast, planner-3 can think hard, and planner-1 sits in the middle.
 */
export function createCruiseModel(
  env: Env,
  seed?: string | number,
  opts?: { reasoningEffort?: ReasoningEffort },
) {
  const workersAi = createWorkersAI({ binding: env.AI });

  return workersAi(CRUISE_MODEL_ID, {
    reasoning_effort: opts?.reasoningEffort ?? "low",
    ...(seed !== undefined ? { sessionAffinity: String(seed) } : {}),
  });
}

// Re-exported from src/shared/personas so existing agent-side imports
// (`from "./cruiseAgentCore"`) keep working without churn.
export {
  PLANNER_PERSONAS,
  plannerPersonaForName,
  plannerPersonaForSeed,
  type PlannerPersona,
  type PlannerPersonaId,
  type ReasoningEffort,
} from "../shared/personas";

export type ProbeResult =
  | { ok: true; ms: number; model: string }
  | { ok: false; ms: number; model: string; error: string; errorName?: string };

/**
 * Fast, low-token sanity check against the Workers AI binding. Shared between
 * `/api/ai-probe` (operator diagnostic) and the Director's pre-commit fallback
 * when an entire planner round came back invalid (so we can distinguish
 * "planners returned infeasible" from "AI binding is down").
 *
 * Uses the cheap llama-3.1-8b model so the round-suspicion probe adds ~1s
 * tail latency at worst and no cost when the AI is healthy.
 */
export async function probeWorkersAI(
  env: Env,
  model: string = CRUISE_PROBE_MODEL_ID,
): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await env.AI.run(model as Parameters<typeof env.AI.run>[0], {
      messages: [
        { role: "system", content: "Reply with exactly one short sentence." },
        { role: "user", content: "Say hello from the AI probe." },
      ],
    } as Parameters<typeof env.AI.run>[1]);
    return { ok: true, ms: Date.now() - start, model };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - start,
      model,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    };
  }
}

/**
 * Heuristic: decide whether a raw error string suggests the Workers AI
 * binding itself is unreachable (auth token 4xx, fetch, gateway 1031) vs
 * a legitimate planner reasoning failure. Used to classify candidates
 * without running a probe.
 */
export function looksLikeAiBindingFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("auth token") ||
    m.includes("401 unauthorized") ||
    m.includes("400 bad request") ||
    m.includes("1031") ||
    m.includes("10000") ||
    m.includes("fetch failed") ||
    m.includes("econnrefused") ||
    m.includes("etimedout")
  );
}
