import { useMemo } from "react";

import type { CityId, OrderEvent, Plan, Truck } from "../../shared/types";

/**
 * Stylized SVG layout of the 5 Portuguese cities used in Cruise. Coordinates
 * are approximate cartographic positions on a 400x600 canvas — not a real map.
 */
const CITY_POSITIONS: Record<CityId, { x: number; y: number; label: string }> = {
  BRA: { x: 130, y: 75, label: "Braga" },
  OPO: { x: 110, y: 155, label: "Porto" },
  COI: { x: 170, y: 270, label: "Coimbra" },
  LIS: { x: 130, y: 400, label: "Lisboa" },
  FAO: { x: 235, y: 540, label: "Faro" },
};

const CITY_ORDER: CityId[] = ["BRA", "OPO", "COI", "LIS", "FAO"];

type CityMapProps = {
  fleet: Truck[];
  currentPlan: Plan;
  pendingOrder?: OrderEvent;
  selectedTripId?: string;
  onSelectTrip?: (tripId: string | undefined) => void;
};

export function CityMap({
  fleet,
  currentPlan,
  pendingOrder,
  selectedTripId,
  onSelectTrip,
}: CityMapProps) {
  const trucksByCity = useMemo(() => {
    const map: Record<CityId, Truck[]> = {
      BRA: [],
      OPO: [],
      COI: [],
      LIS: [],
      FAO: [],
    };
    for (const t of fleet) {
      map[t.startCity].push(t);
    }
    return map;
  }, [fleet]);

  const pendingCities = useMemo(() => {
    if (!pendingOrder) return new Set<CityId>();
    return new Set(pendingOrder.pallets.map((p) => p.pickup));
  }, [pendingOrder]);

  return (
    <svg
      className="city-map"
      viewBox="0 0 400 620"
      role="img"
      aria-label="Portugal fleet map"
      onClick={() => onSelectTrip?.(undefined)}
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
        </marker>
      </defs>

      {currentPlan.trips.map((trip) => {
        const points = trip.stops
          .map((s) => `${CITY_POSITIONS[s.city].x},${CITY_POSITIONS[s.city].y}`)
          .join(" ");
        const isSelected = trip.id === selectedTripId;
        return (
          <g
            key={trip.id}
            className={
              isSelected
                ? "trip-line-group trip-line-group--selected"
                : "trip-line-group"
            }
            onClick={(e) => {
              e.stopPropagation();
              onSelectTrip?.(trip.id === selectedTripId ? undefined : trip.id);
            }}
          >
            {/* Invisible fat stroke that catches clicks / hover. Uses
                pointer-events="stroke" so clicks near the line register
                even though the visible polyline is thin. */}
            <polyline
              className="trip-line-hit"
              points={points}
              fill="none"
              stroke="transparent"
              strokeWidth={16}
              pointerEvents="stroke"
            />
            <polyline
              className={
                isSelected ? "trip-line trip-line--selected" : "trip-line"
              }
              points={points}
              fill="none"
              strokeWidth={isSelected ? 3 : 2}
              markerEnd="url(#arrow)"
              pointerEvents="none"
            >
              <title>
                {trip.id} · {trip.truckId} · {trip.palletIds.length} pallets
              </title>
            </polyline>
          </g>
        );
      })}

      {CITY_ORDER.map((city) => {
        const pos = CITY_POSITIONS[city];
        const trucks = trucksByCity[city];
        const isPending = pendingCities.has(city);
        return (
          <g
            key={city}
            className={isPending ? "city-node city-node--pending" : "city-node"}
            transform={`translate(${pos.x}, ${pos.y})`}
          >
            <circle r={24} className="city-node-halo" />
            <circle r={14} className="city-node-dot" />
            <text
              className="city-node-label"
              x={0}
              y={-30}
              textAnchor="middle"
            >
              {pos.label}
            </text>
            {trucks.length > 0 ? (
              <g
                className="city-node-badge"
                transform={`translate(20, 18)`}
                aria-label={`${trucks.length} truck(s) at ${pos.label}`}
              >
                <rect x={-10} y={-8} width={24} height={16} rx={8} />
                <text x={2} y={3} textAnchor="middle">
                  {trucks.length}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function cityLabel(city: CityId): string {
  return CITY_POSITIONS[city].label;
}

export { CITY_POSITIONS };
