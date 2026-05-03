import { useMemo } from "react";

import {
  EARLIEST_START_MINUTES,
  LATEST_END_MINUTES,
  MAX_DRIVING_HOURS,
  SERVICE_HOURS_PER_STOP,
  TRAVEL_TIME_MATRIX,
  TRUCK_CAPACITY,
  ratePerTruckLeg,
} from "../../shared/cruise";
import {
  CITY_IDS,
  type CityId,
  type DispatchState,
  type Pallet,
} from "../../shared/types";
import { cityLabel } from "./CityMap";

type DispatchDataViewProps = {
  dispatch: DispatchState;
};

type OrderSummary = {
  orderId: string;
  pickup: CityId;
  dropoff: CityId;
  count: number;
  isPending: boolean;
};

/**
 * Reference data + order book + validator rulebook for the Director and
 * planners.
 *
 * The Data & Rules tab deliberately avoids anything the Director could flip
 * round to round (pending plan, last round, runtime log live in the Control
 * Room). It is the "lookup table" tab: what orders are in the book, how the
 * fleet is distributed, the rate / travel matrices planners reason over, and
 * the hard constraints `validatePlan` enforces before the Director will
 * commit a plan.
 */
export function DispatchDataView({ dispatch }: DispatchDataViewProps) {
  const orders = useMemo(
    () => summarizeOrders(dispatch.pallets, dispatch.pendingOrder?.orderId),
    [dispatch.pallets, dispatch.pendingOrder?.orderId],
  );
  const fleetByCity = groupFleet(dispatch);

  return (
    <div className="control-room">
      <section className="control-room-section">
        <h3>Orders ({orders.length})</h3>
        {orders.length === 0 ? (
          <div className="control-room-empty">Order book is empty.</div>
        ) : (
          <table className="control-room-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Route</th>
                <th>Pallets</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.orderId}>
                  <td className="control-room-mono">
                    {o.orderId}
                    {o.isPending ? (
                      <span
                        className="data-order-pending"
                        title="Order is pending — planners have not committed a plan yet."
                      >
                        pending
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {o.pickup} → {o.dropoff}
                  </td>
                  <td>{o.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
        <h3>Rate card (€/truck leg)</h3>
        <div className="control-room-matrix">
          <RouteMatrix
            cells={(a, b) => (a === b ? "—" : `€${ratePerTruckLeg(a, b)}`)}
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
        <h3>Business rules</h3>
        <p className="data-rules-caption">
          A plan is only committed if <em>every</em> trip satisfies these
          constraints. Planners that return an infeasible plan are rejected
          and the Director keeps the current plan.
        </p>
        <ul className="data-rules-list">
          <li>
            <strong>Truck capacity.</strong> At no point on a trip may an
            onboard load exceed <code>{TRUCK_CAPACITY}</code> pallets — loads
            are checked after every stop's pickups and drop-offs.
          </li>
          <li>
            <strong>One trip per truck per day.</strong> Each truck can appear
            in at most one trip per planning day. Trucks start where they're
            parked; a trip's first stop must equal the truck's starting city.
          </li>
          <li>
            <strong>Driving window.</strong> Every trip must start no earlier
            than <code>{formatHour(EARLIEST_START_MINUTES)}</code> and finish
            no later than <code>{formatHour(LATEST_END_MINUTES)}</code>, where
            total time is driving hours + {SERVICE_HOURS_PER_STOP}h service
            per stop.
          </li>
          <li>
            <strong>Driving-hour cap.</strong> A trip's total driving time may
            not exceed <code>{MAX_DRIVING_HOURS}h</code> (drivers' hours rule).
          </li>
          <li>
            <strong>Pallet routing.</strong> Each pallet must be picked up in
            its origin city and dropped off in its destination city, on the
            same trip, with drop-off occurring after pickup along the route.
          </li>
          <li>
            <strong>Full coverage.</strong> Every pallet in the order book
            must be carried by exactly one trip — a plan may not leave pallets
            unassigned, and no pallet may ride on two trips.
          </li>
          <li>
            <strong>Pallet manifest consistency.</strong> If a trip declares a
            top-level <code>palletIds</code>, it must exactly match the pallets
            actually picked up across that trip's stops.
          </li>
          <li>
            <strong>Real-world cost.</strong> A plan carrying any pallets must
            have strictly positive cost — zero cost means no truck actually
            drove, which is rejected as physically impossible.
          </li>
        </ul>
      </section>
    </div>
  );
}

function formatHour(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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

/**
 * Collapse the flat pallet list into one row per order, preserving the
 * insertion order of `dispatch.pallets` so freshly submitted orders sort to
 * the bottom (the action log / committed-rounds strip shows newest-last with
 * the same convention).
 */
function summarizeOrders(
  pallets: Pallet[],
  pendingOrderId: string | undefined,
): OrderSummary[] {
  const byId = new Map<string, OrderSummary>();
  for (const p of pallets) {
    const existing = byId.get(p.orderId);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byId.set(p.orderId, {
      orderId: p.orderId,
      pickup: p.pickup,
      dropoff: p.dropoff,
      count: 1,
      isPending: p.orderId === pendingOrderId,
    });
  }
  return [...byId.values()];
}
