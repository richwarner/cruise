import { createWorkersAI } from "workers-ai-provider";

export const CRUISE_MODEL_ID = "@cf/moonshotai/kimi-k2.5";

/**
 * Shared Workers AI model factory. The `seed` parameter is passed through as
 * `sessionAffinity` so each Planner lands on an independent model session and
 * the three parallel plans diverge. Director passes its own `sessionAffinity`.
 */
export function createCruiseModel(env: Env, seed?: string | number) {
  const workersAi = createWorkersAI({ binding: env.AI });

  return workersAi(CRUISE_MODEL_ID, {
    reasoning_effort: "low",
    ...(seed !== undefined ? { sessionAffinity: String(seed) } : {}),
  });
}
