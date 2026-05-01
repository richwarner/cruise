import { plannerNamesFor, seedInitialDispatchState } from "./cruise";
import type { DispatchState } from "./types";

/**
 * Thin facade over `seedInitialDispatchState` so Director/Planner agents and
 * the React hook all import the same entry point for a fresh state. Analogous
 * to chess-agent's `src/shared/system.ts`.
 */
export function createInitialDispatchState(
  systemId: string,
  opts: { fleetSize?: number } = {},
): DispatchState {
  return seedInitialDispatchState(systemId, opts);
}

export function dispatchPlannerNames(systemId: string): string[] {
  return plannerNamesFor(systemId);
}

export const DEFAULT_FLEET_SIZE = 10;
