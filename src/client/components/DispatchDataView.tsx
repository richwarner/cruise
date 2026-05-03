import { useMemo } from "react";

import {
  TRAVEL_TIME_MATRIX,
  ratePerPallet,
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
 * Reference data + order book for the Director and planners.
 *
 * The Data tab deliberately avoids anything the Director could flip round to
 * round (pending plan, last round, runtime log live in the Control Room). It
 * is the "lookup table" tab: what orders are in the book, how the fleet is
 * distributed, and the rate / travel matrices planners reason over.
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
