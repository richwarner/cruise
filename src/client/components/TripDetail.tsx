import {
  computeTripCost,
  formatMinutes,
  simulateTrip,
} from "../../shared/cruise";
import type { DispatchState, Trip } from "../../shared/types";
import { cityLabel } from "./CityMap";

type TripDetailProps = {
  trip: Trip;
  dispatch: DispatchState;
};

export function TripDetail({ trip, dispatch }: TripDetailProps) {
  const truck = dispatch.fleet.find((t) => t.id === trip.truckId);
  const palletById = new Map(dispatch.pallets.map((p) => [p.id, p]));
  const cost = computeTripCost(trip, dispatch.pallets);

  let timeline: ReturnType<typeof simulateTrip> | undefined;
  let simError: string | undefined;
  try {
    timeline = simulateTrip(trip, dispatch.fleet);
  } catch (err) {
    simError = err instanceof Error ? err.message : "simulation failed";
  }

  return (
    <div className="trip-detail">
      <header className="trip-detail-header">
        <div>
          <span className="trip-detail-id">{trip.id}</span>
          <span className="trip-detail-sep">·</span>
          <span className="trip-detail-truck">{trip.truckId}</span>
        </div>
        <div className="trip-detail-meta">
          {truck ? `${truck.sizeMeters}m · cap ${truck.capacity}` : "—"}
        </div>
      </header>

      <dl className="trip-detail-stats">
        <div>
          <dt>Start</dt>
          <dd>{formatMinutes(trip.startMinutes)}</dd>
        </div>
        <div>
          <dt>Finish</dt>
          <dd>{timeline ? formatMinutes(timeline.endMinutes) : "—"}</dd>
        </div>
        <div>
          <dt>Drive</dt>
          <dd>{timeline ? `${timeline.drivingHours.toFixed(2)} h` : "—"}</dd>
        </div>
        <div>
          <dt>Revenue</dt>
          <dd>€{cost.toFixed(0)}</dd>
        </div>
      </dl>

      {simError ? <div className="trip-detail-error">{simError}</div> : null}

      <section className="trip-detail-stops">
        <h4>Stops</h4>
        <ol>
          {trip.stops.map((stop, i) => {
            const kinds: string[] = [];
            if (stop.pickupPalletIds.length > 0) {
              kinds.push(`pickup ${stop.pickupPalletIds.length}`);
            }
            if (stop.dropoffPalletIds.length > 0) {
              kinds.push(`dropoff ${stop.dropoffPalletIds.length}`);
            }
            return (
              <li key={`${stop.city}-${i}`}>
                <span className="trip-stop-city">{cityLabel(stop.city)}</span>
                <span className="trip-stop-kinds">
                  {kinds.join(" · ") || "pass-through"}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="trip-detail-manifest">
        <h4>Manifest ({trip.palletIds.length})</h4>
        <ul>
          {trip.palletIds.map((pid) => {
            const pal = palletById.get(pid);
            return (
              <li key={pid}>
                <span className="trip-manifest-id">{pid}</span>
                {pal ? (
                  <span className="trip-manifest-route">
                    {cityLabel(pal.pickup)} → {cityLabel(pal.dropoff)}
                  </span>
                ) : (
                  <span className="trip-manifest-route trip-manifest-missing">
                    unknown pallet
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
