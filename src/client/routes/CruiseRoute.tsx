import { Banner } from "@cloudflare/kumo/components/banner";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { GearIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";

import { DispatchControlRoom } from "../components/DispatchControlRoom";
import { DispatchControls, TEST_ORDER } from "../components/DispatchControls";
import { OperationsBoard } from "../components/OperationsBoard";
import { PlannerActivityPanel } from "../components/PlannerActivityPanel";
import { useDispatchSystem } from "../hooks/useDispatchSystem";
import { RouteNav } from "./RouteNav";

const DEFAULT_SYSTEM_ID = "cruise-workshop";

type PanelView = "operations" | "control-room";

/**
 * Phase 4 route: end-to-end new-order flow via the Director's `submitOrder`
 * RPC, with live planner sub-subscriptions driving the Control Room cards.
 * The chat panel on the right still talks to planner-1 as a debug channel;
 * Phase 5 swaps it for the Director chat + chat-target toggle.
 */
export function CruiseRoute() {
  const [systemId, setSystemId] = useState(DEFAULT_SYSTEM_ID);
  const [panelView, setPanelView] = useState<PanelView>("operations");

  const {
    dispatch,
    plannerStates,
    error,
    isResetting,
    isResizing,
    isSubmittingOrder,
    resetDispatch,
    resizeFleet,
    submitOrder,
  } = useDispatchSystem(systemId);

  const runTestOrder = useCallback(() => {
    void submitOrder({
      ...TEST_ORDER,
      orderId: `O-${Date.now().toString(36).slice(-5).toUpperCase()}`,
    });
  }, [submitOrder]);

  const directorThinking = dispatch?.directorThinking ?? false;
  const lastRound = dispatch?.lastRound ?? [];
  const roundAllInvalid =
    lastRound.length > 0 && lastRound.every((c) => !c.valid);
  const roundStatus = buildRoundStatus(
    directorThinking,
    isSubmittingOrder,
    dispatch?.pendingOrder?.orderId,
    roundAllInvalid,
  );
  const roundStatusIsError =
    !!dispatch?.pendingOrder && roundAllInvalid && !isSubmittingOrder;

  return (
    <main className="app-shell cruise-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Phase 4 — Director with parallel planners</p>
          <h1>Cruise · Dispatch Director</h1>
          <p>
            Submit a test order to fan three Planner sub-agents out in parallel;
            the cheapest valid plan replaces tomorrow's schedule. Shrink the
            fleet to force infeasible rounds.
          </p>
        </div>
        <div className="app-header-actions">
          <RouteNav active="cruise" />
          <DispatchControls
            systemId={systemId}
            onSystemIdChange={setSystemId}
            fleetSize={dispatch?.fleet.length ?? 0}
            onResizeFleet={resizeFleet}
            onReset={resetDispatch}
            onSubmitTestOrder={runTestOrder}
            isResetting={isResetting}
            isResizing={isResizing}
            isSubmittingOrder={isSubmittingOrder}
          />
        </div>
      </header>

      <div className="game-layout cruise-layout">
        <LayerCard className="panel board-panel">
          <div className="board-panel-header">
            <div className="board-panel-header-left">
              <PanelTabs view={panelView} onChange={setPanelView} />
              {roundStatus ? (
                <span
                  className="board-panel-status"
                  data-active="true"
                  data-variant={roundStatusIsError ? "error" : "info"}
                >
                  {roundStatus}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="board-panel-gear"
              title="Toggle panel"
              onClick={() =>
                setPanelView((v) =>
                  v === "operations" ? "control-room" : "operations",
                )
              }
            >
              <GearIcon size={18} weight="bold" />
            </button>
          </div>

          {error ? <Banner variant="error" description={error} /> : null}

          {!dispatch ? (
            <div className="board-panel-loading">Connecting to director…</div>
          ) : panelView === "operations" ? (
            <OperationsBoard
              dispatch={dispatch}
              onViewLastRound={() => setPanelView("control-room")}
            />
          ) : (
            <DispatchControlRoom dispatch={dispatch} />
          )}
        </LayerCard>

        <PlannerActivityPanel
          dispatch={dispatch}
          plannerStates={plannerStates}
          isSubmittingOrder={isSubmittingOrder}
        />
      </div>
    </main>
  );
}

function buildRoundStatus(
  directorThinking: boolean,
  isSubmittingOrder: boolean,
  pendingOrderId: string | undefined,
  roundAllInvalid: boolean,
): string | null {
  if (isSubmittingOrder) return `Planners running${pendingOrderId ? ` for ${pendingOrderId}` : ""}…`;
  if (directorThinking) return "Director thinking…";
  if (pendingOrderId && roundAllInvalid) {
    return `Round failed: ${pendingOrderId}`;
  }
  if (pendingOrderId) return `Pending: ${pendingOrderId}`;
  return null;
}

function PanelTabs({
  view,
  onChange,
}: {
  view: PanelView;
  onChange: (next: PanelView) => void;
}) {
  return (
    <div className="panel-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={view === "operations"}
        className={
          view === "operations" ? "panel-tab panel-tab--active" : "panel-tab"
        }
        onClick={() => onChange("operations")}
      >
        Operations
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "control-room"}
        className={
          view === "control-room" ? "panel-tab panel-tab--active" : "panel-tab"
        }
        onClick={() => onChange("control-room")}
      >
        Control Room
      </button>
    </div>
  );
}
