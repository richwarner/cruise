import {
  CITY_IDS,
  type CityId,
  type DispatchState,
} from "../../shared/types";
import {
  TRAVEL_TIME_MATRIX,
  computePlanCost,
  ratePerPallet,
} from "../../shared/cruise";
import { cityLabel } from "./CityMap";
import { PlannerCandidateCard } from "./PlannerCandidateCard";

type DispatchControlRoomProps = {
  dispatch: DispatchState;
};

export function DispatchControlRoom({ dispatch }: DispatchControlRoomProps) {
  const fleetByCity = groupFleet(dispatch);
  const revenue = computePlanCost(dispatch.currentPlan, dispatch.pallets);

  return (
    <div className="control-room">
      <section className="control-room-section">
        <h3>Fleet ({dispatch.fleet.length})</h3>
        <table className="control-room-table">
          <thead>
            <tr>
              <th>City</th>
              <th>Trucks</th>
              <th>IDs</th>
            </tr>
          </thead>
          <tbody>
            {(CITY_IDS as readonly CityId[]).map((c) => (
              <tr key={c}>
                <td>{cityLabel(c)}</td>
                <td>{fleetByCity[c]?.length ?? 0}</td>
                <td className="control-room-mono">
                  {(fleetByCity[c] ?? [])
                    .map((t) => t.id.replace(/^TRK-/, ""))
                    .join(", ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="control-room-section">
        <h3>Rate card (€/pallet)</h3>
        <div className="control-room-matrix">
          <RouteMatrix
            cells={(a, b) => (a === b ? "—" : `€${ratePerPallet(a, b)}`)}
          />
        </div>
      </section>

      <section className="control-room-section">
        <h3>Travel matrix (hours)</h3>
        <div className="control-room-matrix">
          <RouteMatrix
            cells={(a, b) => (a === b ? "—" : `${TRAVEL_TIME_MATRIX[a][b]}h`)}
          />
        </div>
      </section>

      <section className="control-room-section">
        <h3>Current plan</h3>
        <dl className="control-room-kv">
          <div>
            <dt>Trips</dt>
            <dd>{dispatch.currentPlan.trips.length}</dd>
          </div>
          <div>
            <dt>Pallets</dt>
            <dd>
              {dispatch.pallets.length -
                dispatch.currentPlan.unassignedPalletIds.length}{" "}
              / {dispatch.pallets.length}
            </dd>
          </div>
          <div>
            <dt>Revenue</dt>
            <dd>€{revenue.toFixed(0)}</dd>
          </div>
        </dl>
      </section>

      <section className="control-room-section">
        <h3>Last planner round</h3>
        {dispatch.lastRound.length === 0 ? (
          <div className="control-room-empty">
            Awaiting first order — no planner round has run yet.
          </div>
        ) : (
          <div className="control-room-candidates">
            {dispatch.lastRound.map((c) => (
              <PlannerCandidateCard
                key={c.plannerName}
                candidate={c}
                isWinner={false}
              />
            ))}
          </div>
        )}
      </section>

      <section className="control-room-section">
        <h3>Runtime action log</h3>
        {dispatch.recentDirectorActions.length === 0 ? (
          <div className="control-room-empty">No director actions yet.</div>
        ) : (
          <ul className="control-room-log">
            {[...dispatch.recentDirectorActions]
              .slice(-12)
              .reverse()
              .map((e) => (
                <li key={e.id}>
                  <span className="control-room-log-time">
                    {new Date(e.at).toLocaleTimeString()}
                  </span>
                  <span className="control-room-log-label">{e.label}</span>
                  {e.detail ? (
                    <span className="control-room-log-detail">{e.detail}</span>
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RouteMatrix({
  cells,
}: {
  cells: (from: CityId, to: CityId) => string;
}) {
  const ids = CITY_IDS as readonly CityId[];
  return (
    <table className="control-room-table control-room-matrix-table">
      <thead>
        <tr>
          <th></th>
          {ids.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ids.map((a) => (
          <tr key={a}>
            <th>{a}</th>
            {ids.map((b) => (
              <td key={b}>{cells(a, b)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function groupFleet(dispatch: DispatchState) {
  const map: Partial<Record<CityId, typeof dispatch.fleet>> = {};
  for (const t of dispatch.fleet) {
    (map[t.startCity] ??= []).push(t);
  }
  return map;
}
