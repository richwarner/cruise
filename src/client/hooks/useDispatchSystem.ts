import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DispatchDirectorAgent } from "../../agents/DispatchDirectorAgent";
import { dispatchPlannerNames } from "../../shared/dispatch";
import { SAMPLE_ORDER_TEMPLATES } from "../../shared/cruise";
import type { DispatchState, PlannerState } from "../../shared/types";

const PLANNER_POLL_INTERVAL_MS = 1_000;

type SubmitOrderInput = {
  orderId: string;
  pickup: DispatchState["pallets"][number]["pickup"];
  dropoff: DispatchState["pallets"][number]["dropoff"];
  pallets: number;
  summary?: string;
};

/**
 * Primary React hook for the `/cruise` route. Owns:
 *  - a single connection to `DispatchDirectorAgent` for broadcast state + RPC;
 *  - top-level RPC wrappers (`submitOrder`, `resetDispatch`, `resizeFleet`);
 *  - a pure-client helper that picks a random sample order template.
 *
 * We intentionally do NOT open any sub-subscriptions to planner DOs from the
 * client. Two reasons: (1) multiple concurrent sub-agent WebSockets trigger
 * "Cannot perform I/O on behalf of a different Durable Object" errors in the
 * agents runtime; (2) even a single `useAgent` + `useAgentChat` aimed at one
 * planner starves that planner's LLM call (we consistently saw planner-1
 * never return while planners 2 and 3 completed). Planner activity is
 * surfaced via `dispatch.lastRound`, which the Director broadcasts through
 * its primary WebSocket. The Director chat in Phase 5 will be the single
 * chat channel for the whole system.
 */
export function useDispatchSystem(systemId: string) {
  const [dispatch, setDispatch] = useState<DispatchState | undefined>(undefined);
  const [plannerStates, setPlannerStates] = useState<PlannerState[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isResetting, setIsResetting] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);

  const plannerNames = useMemo(
    () => dispatchPlannerNames(systemId),
    [systemId],
  );

  useEffect(() => {
    setDispatch(undefined);
    setPlannerStates([]);
    setError(undefined);
    setIsResetting(false);
    setIsResizing(false);
    setIsSubmittingOrder(false);
  }, [systemId]);

  const director = useAgent<DispatchDirectorAgent, DispatchState>({
    agent: "DispatchDirectorAgent",
    name: systemId,
    onStateUpdate: setDispatch,
  });

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      const next = await director.stub.getDispatch();
      setDispatch(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dispatch sync failed");
    }
  }, [director]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live "thinking" display: poll each planner's state while a round is
  // active so the UI can render runtime events + last reasoning trace. We
  // intentionally avoid opening WebSocket sub-subscriptions (see comment
  // block above). One poll settles after the round ends so the final
  // runtime events are displayed.
  const roundActive = isSubmittingOrder || (dispatch?.directorThinking ?? false);
  const roundActiveRef = useRef(roundActive);
  roundActiveRef.current = roundActive;

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await director.stub.getAllPlannerStates();
        if (!cancelled) setPlannerStates(next);
      } catch {
        // Best-effort: swallow transient errors; next tick will retry.
      }
    };

    if (!roundActive) {
      void poll();
      return;
    }

    void poll();
    const id = window.setInterval(poll, PLANNER_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      if (roundActiveRef.current === false) return;
      void poll();
    };
  }, [director, roundActive]);

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

  const submitOrder = useCallback(
    async (input: SubmitOrderInput) => {
      setError(undefined);
      setIsSubmittingOrder(true);
      try {
        const next = await director.stub.submitOrder(input);
        setDispatch(next);
        return { ok: true as const, dispatch: next };
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : "submitOrder failed";
        setError(message);
        return { ok: false as const, error: message };
      } finally {
        setIsSubmittingOrder(false);
      }
    },
    [director],
  );

  const generateSampleOrderText = useCallback(() => {
    const i = Math.floor(Math.random() * SAMPLE_ORDER_TEMPLATES.length);
    return SAMPLE_ORDER_TEMPLATES[i];
  }, []);

  return {
    director,
    plannerNames,
    dispatch,
    plannerStates,
    error,
    isResetting,
    isResizing,
    isSubmittingOrder,
    refresh,
    resetDispatch,
    resizeFleet,
    submitOrder,
    generateSampleOrderText,
  };
}
