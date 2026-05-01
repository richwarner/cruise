import { useMemo, useState } from "react";

import type { DispatchState } from "../../shared/types";
import { CityMap, cityLabel } from "./CityMap";
import { TripDetail } from "./TripDetail";

type OperationsBoardProps = {
  dispatch: DispatchState;
  onViewLastRound?: () => void;
};

export function OperationsBoard({
  dispatch,
  onViewLastRound,
}: OperationsBoardProps) {
  const [selectedTripId, setSelectedTripId] = useState<string | undefined>(
    dispatch.currentPlan.trips[0]?.id,
  );

  const selectedTrip = dispatch.currentPlan.trips.find(
    (t) => t.id === selectedTripId,
  );

  const assignedCount = useMemo(() => {
    const ids = new Set<string>();
    for (const t of dispatch.currentPlan.trips) {
      for (const pid of t.palletIds) ids.add(pid);
    }
    return ids.size;
  }, [dispatch.currentPlan]);
  const unplannedCount = dispatch.pallets.length - assignedCount;
  const tripCount = dispatch.currentPlan.trips.length;

  const lastRound = dispatch.lastRound;
  const allInvalid =
    lastRound.length > 0 && lastRound.every((c) => !c.valid);
  const pendingOrderId = dispatch.pendingOrder?.orderId;
  const roundFailedForPending =
    !!pendingOrderId && allInvalid;

  return (
    <div className="operations-board">
      <div className="operations-board-map">
        <CityMap
          fleet={dispatch.fleet}
          currentPlan={dispatch.currentPlan}
          pendingOrder={dispatch.pendingOrder}
          selectedTripId={selectedTripId}
          onSelectTrip={setSelectedTripId}
        />
      </div>

      <div className="operations-board-side">
        <section className="operations-summary">
          <h3>Today's plan</h3>
          <dl>
            <div>
              <dt>Trips</dt>
              <dd>{tripCount}</dd>
            </div>
            <div>
              <dt>Pallets planned</dt>
              <dd>
                {assignedCount} / {dispatch.pallets.length}
              </dd>
            </div>
            <div>
              <dt>Fleet</dt>
              <dd>{dispatch.fleet.length} trucks</dd>
            </div>
          </dl>

          {unplannedCount > 0 && !dispatch.pendingOrder ? (
            <div className="operations-warning">
              {unplannedCount} pallet{unplannedCount === 1 ? "" : "s"} not on
              any trip
            </div>
          ) : null}

          {dispatch.pendingOrder ? (
            <div
              className={
                roundFailedForPending
                  ? "operations-pending operations-pending--failed"
                  : "operations-pending"
              }
            >
              <strong>
                {roundFailedForPending ? "Round failed" : "Pending order"}
              </strong>
              <div>{dispatch.pendingOrder.summary}</div>
              <div className="operations-pending-meta">
                {dispatch.pendingOrder.pallets.length} pallet
                {dispatch.pendingOrder.pallets.length === 1 ? "" : "s"} from{" "}
                {[
                  ...new Set(
                    dispatch.pendingOrder.pallets.map((p) =>
                      cityLabel(p.pickup),
                    ),
                  ),
                ].join(", ")}
              </div>
              {roundFailedForPending ? (
                <>
                  <div className="operations-pending-reasons">
                    {lastRound.map((c) => (
                      <div key={c.plannerName}>
                        <strong>{c.plannerName}:</strong>{" "}
                        {c.errors?.[0] ?? "no plan submitted"}
                      </div>
                    ))}
                  </div>
                  {dispatch.recentDirectorActions.length > 0 ? (
                    <details className="operations-pending-actions">
                      <summary>
                        Last {Math.min(8, dispatch.recentDirectorActions.length)}{" "}
                        director action(s)
                      </summary>
                      <ol>
                        {dispatch.recentDirectorActions
                          .slice(-8)
                          .reverse()
                          .map((a) => (
                            <li key={a.id}>
                              <span>{a.label}</span>
                              {a.detail ? <em>{a.detail}</em> : null}
                            </li>
                          ))}
                      </ol>
                    </details>
                  ) : null}
                  {onViewLastRound ? (
                    <button
                      type="button"
                      className="operations-pending-button"
                      onClick={onViewLastRound}
                    >
                      View full round in Control Room →
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </section>

        {selectedTrip ? (
          <TripDetail trip={selectedTrip} dispatch={dispatch} />
        ) : (
          <div className="operations-empty">
            {tripCount === 0
              ? "No trips scheduled."
              : "Click a route to inspect trip details."}
          </div>
        )}
      </div>
    </div>
  );
}
