import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";

import type { DispatchDirectorAgent } from "../../agents/DispatchDirectorAgent";
import type { TripPlannerAgent } from "../../agents/TripPlannerAgent";
import { dispatchPlannerNames } from "../../shared/dispatch";
import type { DispatchState, PlannerState } from "../../shared/types";

/**
 * React hook for the Cruise route. Owns the primary connection to
 * `DispatchDirectorAgent` and a convenience sub-subscription to the seed-1
 * `TripPlannerAgent` so Phase 3 can keep rendering the single-planner chat
 * from Phase 2. Phase 4 will extend this to all three planner
 * sub-subscriptions for the live PlannerCandidateCards.
 */
export function useDispatchSystem(systemId: string) {
  const [dispatch, setDispatch] = useState<DispatchState | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isResetting, setIsResetting] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    setDispatch(undefined);
    setError(undefined);
    setIsResetting(false);
    setIsResizing(false);
  }, [systemId]);

  const director = useAgent<DispatchDirectorAgent, DispatchState>({
    agent: "DispatchDirectorAgent",
    name: systemId,
    onStateUpdate: setDispatch,
  });

  // Keep Phase 2's single-planner chat working: the Director agent is the
  // parent connection; we subscribe to the seed-1 planner for chat.
  const plannerNames = dispatchPlannerNames(systemId);
  const plannerOne = useAgent<TripPlannerAgent, PlannerState>({
    agent: "DispatchDirectorAgent",
    name: systemId,
    sub: [{ agent: "TripPlannerAgent", name: plannerNames[0] }],
  });

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      const next = await director.stub.getDispatch();
      setDispatch(next);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Dispatch sync failed",
      );
    }
  }, [director]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetDispatch = useCallback(async () => {
    setError(undefined);
    setIsResetting(true);
    try {
      const next = await director.stub.resetDispatch();
      setDispatch(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reset failed");
    } finally {
      setIsResetting(false);
    }
  }, [director]);

  const resizeFleet = useCallback(
    async (size: number) => {
      setError(undefined);
      setIsResizing(true);
      try {
        const next = await director.stub.resizeFleet(size);
        setDispatch(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Resize failed");
      } finally {
        setIsResizing(false);
      }
    },
    [director],
  );

  return {
    director,
    plannerOne,
    dispatch,
    error,
    isResetting,
    isResizing,
    refresh,
    resetDispatch,
    resizeFleet,
  };
}
