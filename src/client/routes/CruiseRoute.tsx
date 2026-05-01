import { Banner } from "@cloudflare/kumo/components/banner";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { GearIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { AgentPanel } from "../components/AgentPanel";
import { DispatchControlRoom } from "../components/DispatchControlRoom";
import { DispatchControls } from "../components/DispatchControls";
import { OperationsBoard } from "../components/OperationsBoard";
import { useDispatchSystem } from "../hooks/useDispatchSystem";
import { RouteNav } from "./RouteNav";

const DEFAULT_SYSTEM_ID = "cruise-workshop";

type PanelView = "operations" | "control-room";

/**
 * Phase 3 route: read-only Control Room.
 *
 * Left side: map + trip inspector OR Control Room tables, driven by the
 * DispatchDirectorAgent's broadcast state. Right side: single-planner chat
 * (unchanged from Phase 2) for direct prompt debugging until Phase 5 swaps
 * in the director chat.
 */
export function CruiseRoute() {
  const [systemId, setSystemId] = useState(DEFAULT_SYSTEM_ID);
  const [panelView, setPanelView] = useState<PanelView>("operations");

  const {
    plannerOne,
    dispatch,
    error,
    isResetting,
    isResizing,
    refresh,
    resetDispatch,
    resizeFleet,
  } = useDispatchSystem(systemId);

  return (
    <main className="app-shell cruise-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Phase 3 — Control Room (read-only)</p>
          <h1>Cruise · Dispatch Director</h1>
          <p>
            Seeded dispatch state from the Director DO. Toggle the panel for
            the Operations map or the Control Room tables.
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
            isResetting={isResetting}
            isResizing={isResizing}
          />
        </div>
      </header>

      <div className="game-layout cruise-layout">
        <LayerCard className="panel board-panel">
          <div className="board-panel-header">
            <PanelTabs view={panelView} onChange={setPanelView} />
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
            <OperationsBoard dispatch={dispatch} />
          ) : (
            <DispatchControlRoom dispatch={dispatch} />
          )}
        </LayerCard>

        <AgentPanel
          agent={plannerOne}
          title="Planner Chat"
          description="Single-planner debug channel. Phase 5 replaces this with the Director chat + chat target toggle."
          placeholder="Ask planner-1 to inspectSnapshot or describe a plan tweak…"
          showRuntimeTimeline={false}
          onResponseComplete={refresh}
          emptyTitle="Single-planner debug mode."
          emptyDescription="Try: 'call inspectSnapshot then submit a plan that uses one truck per outbound route.'"
        />
      </div>
    </main>
  );
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
