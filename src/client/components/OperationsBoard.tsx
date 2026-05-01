import { useState } from "react";

import type { DispatchState } from "../../shared/types";
import { CityMap, cityLabel } from "./CityMap";
import { TripDetail } from "./TripDetail";

type OperationsBoardProps = {
  dispatch: DispatchState;
};

export function OperationsBoard({ dispatch }: OperationsBoardProps) {
  const [selectedTripId, setSelectedTripId] = useState<string | undefined>(
    dispatch.currentPlan.trips[0]?.id,
  );

  const selectedTrip = dispatch.currentPlan.trips.find(
    (t) => t.id === selectedTripId,
  );

  const unassignedCount = dispatch.currentPlan.unassignedPalletIds.length;
  const tripCount = dispatch.currentPlan.trips.length;

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
              <dt>Pallets assigned</dt>
              <dd>
                {dispatch.pallets.length - unassignedCount} /{" "}
                {dispatch.pallets.length}
              </dd>
            </div>
            <div>
              <dt>Fleet</dt>
              <dd>{dispatch.fleet.length} trucks</dd>
            </div>
          </dl>

          {unassignedCount > 0 ? (
            <div className="operations-warning">
              {unassignedCount} pallet{unassignedCount === 1 ? "" : "s"}{" "}
              unassigned
            </div>
          ) : null}

          {dispatch.pendingOrder ? (
            <div className="operations-pending">
              <strong>Pending order</strong>
              <div>{dispatch.pendingOrder.summary}</div>
              <div className="operations-pending-meta">
                {dispatch.pendingOrder.pallets.length} pallet
                {dispatch.pendingOrder.pallets.length === 1 ? "" : "s"}{" "}
                from{" "}
                {[
                  ...new Set(
                    dispatch.pendingOrder.pallets.map((p) =>
                      cityLabel(p.pickup),
                    ),
                  ),
                ].join(", ")}
              </div>
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
