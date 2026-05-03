import { CITY_IDS } from "./types";
import type {
  CityId,
  DispatchState,
  OrderEvent,
  Pallet,
  Plan,
  PlanView,
  PlannerCandidate,
  RoundResult,
  TripLeg,
  TripTimeline,
  Trip,
  TripStop,
  Truck,
  TryApplyPlanResult,
  ValidatePlanResult,
} from "./types";

// =============================================================================
// Constants
// =============================================================================

/** Truck capacity in euro pallets. Per brief, all trucks are 13.5m and carry 30. */
export const TRUCK_CAPACITY = 30;
/** Maximum driving hours per truck per day. Service time is separate. */
export const MAX_DRIVING_HOURS = 9;
/** Earliest start, minutes past midnight. 06:00. */
export const EARLIEST_START_MINUTES = 6 * 60;
/** Latest dropoff, minutes past midnight. 18:00. */
export const LATEST_END_MINUTES = 18 * 60;
/** Service time per stop in hours (30 minutes). */
export const SERVICE_HOURS_PER_STOP = 0.5;

/**
 * City-to-city travel times in hours, rounded to 0.25h. Symmetric.
 * See PLAN.md section 5.2 for justification.
 */
export const TRAVEL_TIME_MATRIX: Record<CityId, Record<CityId, number>> = {
  LIS: { LIS: 0, OPO: 3.0, COI: 2.0, BRA: 3.75, FAO: 2.75 },
  OPO: { LIS: 3.0, OPO: 0, COI: 1.25, BRA: 0.75, FAO: 5.75 },
  COI: { LIS: 2.0, OPO: 1.25, COI: 0, BRA: 1.75, FAO: 4.75 },
  BRA: { LIS: 3.75, OPO: 0.75, COI: 1.75, BRA: 0, FAO: 6.5 },
  FAO: { LIS: 2.75, OPO: 5.75, COI: 4.75, BRA: 6.5, FAO: 0 },
};

// =============================================================================
// Primitives
// =============================================================================

export function travelHours(from: CityId, to: CityId): number {
  return TRAVEL_TIME_MATRIX[from][to];
}

/**
 * Rate card: €/truck-leg depends only on the route.
 *
 * The business model is "whole truck or nothing" — a truck driving a leg
 * charges the same whether it's carrying 1 pallet or 30, so planners
 * should consolidate aggressively to drive €/pallet down. The formula is
 * a rough model of Portuguese refrigerated trucking: a fixed per-leg
 * dispatch overhead plus a driving-hours rate that approximates truck +
 * driver + fuel + refrigeration (~€120/h all-in).
 */
export function ratePerTruckLeg(from: CityId, to: CityId): number {
  if (from === to) return 0;
  return Math.round(50 + 120 * travelHours(from, to));
}

// =============================================================================
// Trip simulation
// =============================================================================

/**
 * Walk a trip stop-by-stop, returning driving legs, per-stop loads, and a
 * timeline anchored at trip.startMinutes. Does not enforce constraints —
 * validatePlan layers those on.
 */
export function simulateTrip(trip: Trip, fleet: Truck[]): TripTimeline {
  const truck = fleet.find((t) => t.id === trip.truckId);
  if (!truck) {
    throw new Error(`Unknown truck ${trip.truckId} in trip ${trip.id}`);
  }

  const legs: TripLeg[] = [];
  const loadAfterStop: number[] = [];
  let load = 0;
  let drivingHours = 0;
  let previousCity: CityId | null = null;

  for (const stop of trip.stops) {
    if (previousCity !== null && previousCity !== stop.city) {
      const h = travelHours(previousCity, stop.city);
      legs.push({ from: previousCity, to: stop.city, hours: h });
      drivingHours += h;
    }

    load += stop.pickupPalletIds.length;
    load -= stop.dropoffPalletIds.length;
    loadAfterStop.push(load);

    previousCity = stop.city;
  }

  const serviceHours = SERVICE_HOURS_PER_STOP * trip.stops.length;
  const startMinutes = trip.startMinutes;
  const endMinutes = Math.round(
    startMinutes + (drivingHours + serviceHours) * 60,
  );

  const endCity = previousCity ?? truck.startCity;

  return {
    tripId: trip.id,
    truckId: trip.truckId,
    legs,
    drivingHours,
    serviceHours,
    startMinutes,
    endMinutes,
    loadAfterStop,
    endCity,
  };
}

// =============================================================================
// Cost
// =============================================================================

/**
 * Canonical set of pallets carried by a trip, derived from the per-stop
 * `pickupPalletIds`. This is the single source of truth the simulator and
 * validator use; `trip.palletIds` is a denormalisation that planners sometimes
 * forget to populate, so we do not rely on it here.
 */
export function tripCarriedPalletIds(trip: Trip): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const stop of trip.stops) {
    for (const pid of stop.pickupPalletIds) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      ids.push(pid);
    }
  }
  return ids;
}

/**
 * Per-trip cost = sum of per-truck-leg rates across the trip's driving legs.
 * Pallet count has no effect on cost (full-truck-or-nothing model), so the
 * `pallets` argument is unused; it's retained so all cost functions share a
 * consistent `(trip, pallets)` signature and callers don't need to fan out.
 *
 * Walks the stops inline to emit a leg whenever consecutive stops sit in
 * different cities — mirrors the driving-leg logic in `simulateTrip` without
 * needing a fleet lookup (this helper is called from the UI and from tests
 * where the fleet isn't always in scope).
 */
export function computeTripCost(trip: Trip, _pallets: Pallet[]): number {
  void _pallets;
  let total = 0;
  let previousCity: CityId | null = null;
  for (const stop of trip.stops) {
    if (previousCity !== null && previousCity !== stop.city) {
      total += ratePerTruckLeg(previousCity, stop.city);
    }
    previousCity = stop.city;
  }
  return total;
}

export function computePlanCost(plan: Plan, pallets: Pallet[]): number {
  return plan.trips.reduce((sum, t) => sum + computeTripCost(t, pallets), 0);
}

// =============================================================================
// Validation
// =============================================================================

export function validatePlan(
  plan: Plan,
  fleet: Truck[],
  pallets: Pallet[],
): ValidatePlanResult {
  const errors: string[] = [];
  const trucksById = new Map(fleet.map((t) => [t.id, t]));
  const palletsById = new Map(pallets.map((p) => [p.id, p]));
  const timelines: TripTimeline[] = [];

  const palletAssignments = new Map<string, string>();
  const trucksUsed = new Set<string>();

  for (const trip of plan.trips) {
    if (trip.stops.length === 0) {
      errors.push(`Trip ${trip.id} has no stops.`);
      continue;
    }

    const truck = trucksById.get(trip.truckId);
    if (!truck) {
      errors.push(`Trip ${trip.id} references unknown truck ${trip.truckId}.`);
      continue;
    }

    if (trucksUsed.has(trip.truckId)) {
      errors.push(
        `Truck ${trip.truckId} appears in more than one trip on the same day.`,
      );
    }
    trucksUsed.add(trip.truckId);

    if (trip.stops[0].city !== truck.startCity) {
      errors.push(
        `Trip ${trip.id} starts at ${trip.stops[0].city}, but truck ${truck.id} is at ${truck.startCity}.`,
      );
    }

    if (trip.startMinutes < EARLIEST_START_MINUTES) {
      errors.push(
        `Trip ${trip.id} starts at ${formatMinutes(trip.startMinutes)} (earliest allowed is 06:00).`,
      );
    }

    const pickedUpInTrip = new Set<string>();
    for (let i = 0; i < trip.stops.length; i++) {
      const stop = trip.stops[i];

      for (const pid of stop.pickupPalletIds) {
        const pallet = palletsById.get(pid);
        if (!pallet) {
          errors.push(`Trip ${trip.id} picks up unknown pallet ${pid}.`);
          continue;
        }
        if (pallet.pickup !== stop.city) {
          errors.push(
            `Pallet ${pid} pickup city is ${pallet.pickup} but picked up at ${stop.city} on trip ${trip.id}.`,
          );
        }
        if (palletAssignments.has(pid)) {
          errors.push(
            `Pallet ${pid} assigned to multiple trips (${palletAssignments.get(pid)} and ${trip.id}).`,
          );
        } else {
          palletAssignments.set(pid, trip.id);
        }
        pickedUpInTrip.add(pid);
      }

      for (const pid of stop.dropoffPalletIds) {
        const pallet = palletsById.get(pid);
        if (!pallet) {
          errors.push(`Trip ${trip.id} drops off unknown pallet ${pid}.`);
          continue;
        }
        if (pallet.dropoff !== stop.city) {
          errors.push(
            `Pallet ${pid} dropoff city is ${pallet.dropoff} but dropped at ${stop.city} on trip ${trip.id}.`,
          );
        }
        if (!pickedUpInTrip.has(pid)) {
          errors.push(
            `Pallet ${pid} dropped off before it was picked up on trip ${trip.id}.`,
          );
        }
      }
    }

    if (trip.palletIds.length > 0) {
      const carried = tripCarriedPalletIds(trip);
      const carriedSet = new Set(carried);
      const declaredSet = new Set(trip.palletIds);
      const missingInDeclared = carried.filter((id) => !declaredSet.has(id));
      const extraInDeclared = trip.palletIds.filter(
        (id) => !carriedSet.has(id),
      );
      if (missingInDeclared.length > 0 || extraInDeclared.length > 0) {
        errors.push(
          `Trip ${trip.id} palletIds (${trip.palletIds.join(",") || "-"}) ` +
            `disagrees with stop pickups (${carried.join(",") || "-"}). ` +
            `Fill trip.palletIds with every pallet picked up on this trip.`,
        );
      }
    }

    let timeline: TripTimeline;
    try {
      timeline = simulateTrip(trip, fleet);
    } catch (err) {
      errors.push(
        `Trip ${trip.id}: ${err instanceof Error ? err.message : "simulation failed"}`,
      );
      continue;
    }

    for (let i = 0; i < timeline.loadAfterStop.length; i++) {
      const load = timeline.loadAfterStop[i];
      if (load > TRUCK_CAPACITY) {
        errors.push(
          `Trip ${trip.id} exceeds capacity ${TRUCK_CAPACITY} at stop ${i + 1} (load=${load}).`,
        );
      }
      if (load < 0) {
        errors.push(
          `Trip ${trip.id} drops pallets that were never loaded (stop ${i + 1}, load=${load}).`,
        );
      }
    }

    if (timeline.drivingHours > MAX_DRIVING_HOURS + 1e-6) {
      errors.push(
        `Trip ${trip.id} drives ${timeline.drivingHours.toFixed(2)}h (>${MAX_DRIVING_HOURS}h cap).`,
      );
    }

    if (timeline.endMinutes > LATEST_END_MINUTES) {
      errors.push(
        `Trip ${trip.id} finishes at ${formatMinutes(timeline.endMinutes)} (>18:00).`,
      );
    }

    timelines.push(timeline);
  }

  const assigned = new Set(palletAssignments.keys());
  for (const p of pallets) {
    if (!assigned.has(p.id)) {
      errors.push(`Pallet ${p.id} is not assigned to any trip.`);
    }
  }

  if (plan.unassignedPalletIds.length > 0) {
    errors.push(
      `Plan leaves ${plan.unassignedPalletIds.length} pallet(s) unassigned.`,
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const totalCost = computePlanCost(plan, pallets);

  // Sanity floor: a plan that moves real pallets cannot cost €0 under the
  // per-truck-leg rate card. Every carried pallet needs its trip to include
  // at least one driving leg (pickup city -> dropoff city), so zero cost
  // means either (a) a pallet with pickup === dropoff snuck past the schema
  // refinement, or (b) a trip with all stops in the same city somehow got
  // validated. Either way, refuse to commit.
  const carriedPalletCount = pallets.length - plan.unassignedPalletIds.length;
  if (totalCost === 0 && carriedPalletCount > 0) {
    return {
      ok: false,
      errors: [
        `Plan claims to move ${carriedPalletCount} pallet(s) at €0 — under the per-truck-leg rate card every carried pallet's trip must include at least one driving leg. Check that stop pickup cities differ from stop dropoff cities.`,
      ],
    };
  }

  const totalDrivingHours = timelines.reduce((s, t) => s + t.drivingHours, 0);

  return {
    ok: true,
    view: {
      ...plan,
      timelines,
      totalCost,
      totalDrivingHours,
      trucksUsed: trucksUsed.size,
    },
  };
}

// =============================================================================
// Apply plan (replace current plan)
// =============================================================================

/**
 * Validate the plan and, if feasible, return a new DispatchState with the plan
 * set as `currentPlan`. No startCity rollover — this prototype plans tomorrow
 * only and never advances the day.
 */
export function tryApplyPlan(
  state: DispatchState,
  plan: Plan,
): TryApplyPlanResult {
  const result = validatePlan(plan, state.fleet, state.pallets);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }

  return {
    ok: true,
    view: result.view,
    state: {
      ...state,
      currentPlan: plan,
      pendingOrder: undefined,
    },
  };
}

// =============================================================================
// Seed data — fleet
// =============================================================================

/**
 * First 10 truck start-cities in canonical order. Weighted toward the two
 * biggest demand centres (Lisbon + Porto) and lean elsewhere, so the
 * initial state isn't a boring 2-per-city grid. The Director and planners
 * have to reason about imbalance from turn one.
 *
 *   LIS × 3, OPO × 3, BRA × 2, COI × 1, FAO × 1
 */
const CANONICAL_FLEET_CITIES: CityId[] = [
  "LIS",
  "LIS",
  "LIS",
  "OPO",
  "OPO",
  "OPO",
  "BRA",
  "BRA",
  "COI",
  "FAO",
];

/** Round-robin cycle used when fleetSize > 10. */
const FLEET_CYCLE_CITIES: CityId[] = ["LIS", "OPO", "COI", "BRA", "FAO"];

/**
 * Build a fleet of N trucks. For fleetSize ≤ 10 we take the first N entries of
 * the canonical list; beyond 10 we round-robin across the five cities. Truck
 * ids are zero-padded (T01, T02, ...).
 */
export function buildFleet(fleetSize: number): Truck[] {
  const size = Math.max(1, Math.floor(fleetSize));
  const trucks: Truck[] = [];
  for (let i = 0; i < size; i++) {
    const city =
      i < CANONICAL_FLEET_CITIES.length
        ? CANONICAL_FLEET_CITIES[i]
        : FLEET_CYCLE_CITIES[(i - CANONICAL_FLEET_CITIES.length) % FLEET_CYCLE_CITIES.length];
    trucks.push({
      id: `T${String(i + 1).padStart(2, "0")}`,
      sizeMeters: 13.5,
      capacity: 30,
      startCity: city,
    });
  }
  return trucks;
}

// =============================================================================
// Seed data — orders
// =============================================================================

type SeedOrder = {
  orderId: string;
  pickup: CityId;
  dropoff: CityId;
  count: number;
};

/**
 * Initial 6-order book, 12 pallets total. Kept intentionally small so the
 * LLM planners have a short pallet list to reason and emit. Still covers
 * all five cities so the travel-matrix and multi-dropoff paths are exercised.
 */
const INITIAL_ORDERS: SeedOrder[] = [
  { orderId: "O-1", pickup: "LIS", dropoff: "OPO", count: 3 },
  { orderId: "O-2", pickup: "OPO", dropoff: "LIS", count: 2 },
  { orderId: "O-3", pickup: "OPO", dropoff: "BRA", count: 2 },
  { orderId: "O-4", pickup: "BRA", dropoff: "OPO", count: 1 },
  { orderId: "O-5", pickup: "LIS", dropoff: "FAO", count: 2 },
  { orderId: "O-6", pickup: "COI", dropoff: "LIS", count: 2 },
];

export function buildInitialPallets(): Pallet[] {
  const pallets: Pallet[] = [];
  for (const order of INITIAL_ORDERS) {
    for (let i = 1; i <= order.count; i++) {
      pallets.push({
        id: `${order.orderId}-P${i}`,
        orderId: order.orderId,
        pickup: order.pickup,
        dropoff: order.dropoff,
      });
    }
  }
  return pallets;
}

// =============================================================================
// Seed data — initial plan (deterministic greedy)
// =============================================================================

/**
 * Build a deterministic initial plan: group pallets by route (pickup→dropoff),
 * then for each origin city assign solo routes to separate trucks and
 * consolidate overflow onto the remaining truck with a multi-dropoff trip.
 * Ordering among destinations within the combined trip is chosen to minimize
 * total driving hours via full permutation (cities per combo ≤ 3 in practice).
 *
 * Unassigned pallets go into `unassignedPalletIds` (happens when a city has no
 * truck, e.g. with a shrunk fleet).
 */
export function buildInitialPlan(fleet: Truck[], pallets: Pallet[]): Plan {
  type Route = { dest: CityId; pallets: Pallet[] };

  const byRoute = new Map<string, Pallet[]>();
  for (const p of pallets) {
    const key = `${p.pickup}->${p.dropoff}`;
    const list = byRoute.get(key) ?? [];
    list.push(p);
    byRoute.set(key, list);
  }

  const routesByOrigin = new Map<CityId, Route[]>();
  for (const [key, ps] of byRoute) {
    const [pickup, dropoff] = key.split("->") as [CityId, CityId];
    const list = routesByOrigin.get(pickup) ?? [];
    list.push({ dest: dropoff, pallets: ps });
    routesByOrigin.set(pickup, list);
  }

  const trucksByCity = new Map<CityId, Truck[]>();
  for (const t of fleet) {
    const list = trucksByCity.get(t.startCity) ?? [];
    list.push(t);
    trucksByCity.set(t.startCity, list);
  }

  const trips: Trip[] = [];
  const unassigned: string[] = [];
  let tripIdx = 1;
  const makeTripId = () => `TR-${String(tripIdx++).padStart(3, "0")}`;

  const originOrder = [...routesByOrigin.keys()].sort();

  for (const city of originOrder) {
    const routes = routesByOrigin.get(city)!;
    const trucks = [...(trucksByCity.get(city) ?? [])];

    if (trucks.length === 0) {
      for (const r of routes) for (const p of r.pallets) unassigned.push(p.id);
      continue;
    }

    // Deterministic sort: larger volume first, then destination ascending.
    const sorted = [...routes].sort((a, b) => {
      if (b.pallets.length !== a.pallets.length) {
        return b.pallets.length - a.pallets.length;
      }
      return a.dest.localeCompare(b.dest);
    });

    if (sorted.length <= trucks.length) {
      for (let i = 0; i < sorted.length; i++) {
        const route = sorted[i];
        const truck = trucks[i];
        const pickupIds = route.pallets.map((p) => p.id);
        trips.push({
          id: makeTripId(),
          truckId: truck.id,
          startMinutes: EARLIEST_START_MINUTES,
          stops: [
            { city, pickupPalletIds: pickupIds, dropoffPalletIds: [] },
            { city: route.dest, pickupPalletIds: [], dropoffPalletIds: pickupIds },
          ],
          palletIds: pickupIds,
        });
      }
      continue;
    }

    // More routes than trucks: first (trucks.length - 1) routes get solo
    // trucks; remaining routes combine onto the last truck.
    const soloCount = trucks.length - 1;
    for (let i = 0; i < soloCount; i++) {
      const route = sorted[i];
      const truck = trucks[i];
      const pickupIds = route.pallets.map((p) => p.id);
      trips.push({
        id: makeTripId(),
        truckId: truck.id,
        startMinutes: EARLIEST_START_MINUTES,
        stops: [
          { city, pickupPalletIds: pickupIds, dropoffPalletIds: [] },
          { city: route.dest, pickupPalletIds: [], dropoffPalletIds: pickupIds },
        ],
        palletIds: pickupIds,
      });
    }

    const combined = sorted.slice(soloCount);
    const comboTruck = trucks[soloCount];
    const allPallets = combined.flatMap((r) => r.pallets);
    const comboIds = allPallets.map((p) => p.id);

    const destOrder = pickShortestDestOrder(
      city,
      combined.map((r) => r.dest),
    );

    const stops: TripStop[] = [
      { city, pickupPalletIds: comboIds, dropoffPalletIds: [] },
    ];
    for (const dest of destOrder) {
      const route = combined.find((r) => r.dest === dest)!;
      stops.push({
        city: dest,
        pickupPalletIds: [],
        dropoffPalletIds: route.pallets.map((p) => p.id),
      });
    }

    trips.push({
      id: makeTripId(),
      truckId: comboTruck.id,
      startMinutes: EARLIEST_START_MINUTES,
      stops,
      palletIds: comboIds,
    });
  }

  return { trips, unassignedPalletIds: unassigned };
}

function pickShortestDestOrder(origin: CityId, destinations: CityId[]): CityId[] {
  if (destinations.length <= 1) return [...destinations];

  let best: CityId[] = [...destinations];
  let bestHours = Infinity;

  for (const perm of permute(destinations)) {
    let total = travelHours(origin, perm[0]);
    for (let i = 1; i < perm.length; i++) {
      total += travelHours(perm[i - 1], perm[i]);
    }
    if (total < bestHours) {
      bestHours = total;
      best = perm;
    }
  }
  return best;
}

function permute<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permute(rest)) {
      result.push([arr[i], ...p]);
    }
  }
  return result;
}

// =============================================================================
// Seed data — DispatchState
// =============================================================================

/** Stable planner names for a given system. */
export function plannerNamesFor(systemId: string, count = 3): string[] {
  return Array.from({ length: count }, (_, i) => `${systemId}-planner-${i + 1}`);
}

export function seedInitialDispatchState(
  systemId: string,
  opts: { fleetSize?: number } = {},
): DispatchState {
  const fleetSize = opts.fleetSize ?? 10;
  const fleet = buildFleet(fleetSize);
  const pallets = buildInitialPallets();
  const plan = buildInitialPlan(fleet, pallets);

  // At the default fleet size the seeded plan must be feasible. Throw at
  // module init so infeasibility is caught before the first chat turn.
  if (fleetSize === 10) {
    const verification = validatePlan(plan, fleet, pallets);
    if (!verification.ok) {
      throw new Error(
        `Seeded initial plan is infeasible at fleetSize=10: ${verification.errors.join("; ")}`,
      );
    }
  }

  return {
    systemId,
    plannerAgentNames: plannerNamesFor(systemId),
    fleetSize,
    fleet,
    pallets,
    currentPlan: plan,
    lastRound: [],
    recentRounds: [],
    recentDirectorActions: [],
    directorThinking: false,
  };
}

// =============================================================================
// Sample orders (UI helper)
// =============================================================================

export const SAMPLE_ORDER_TEMPLATES: string[] = [
  "New order O-7: 2 pallets from OPO to FAO, tomorrow.",
  "New order O-8: 2 pallets from LIS to BRA.",
  "New order O-9: 2 pallets from FAO to OPO.",
  "New order O-10: 1 pallet from COI to FAO.",
  "New order O-11: 3 pallets from BRA to LIS.",
];

// =============================================================================
// Prompt builders
// =============================================================================

/**
 * Minimal persona contract the prompt builder needs. Kept structural so we
 * don't take a runtime dependency from `src/shared/cruise.ts` onto the
 * agent-side `PLANNER_PERSONAS` map (shared code stays free of the `agents/`
 * layer, tests stay lightweight).
 */
export type PlannerPromptPersona = {
  id: 1 | 2 | 3;
  label: string;
  strategyClause: string;
  useSessionTrends: boolean;
};

/**
 * Render a SessionTrends snapshot as a bulleted block suitable for the
 * Strategist planner's prompt. Returns an empty string when there's
 * nothing useful yet (no committed rounds and no obvious busiest lane),
 * so the prompt stays compact on a fresh session.
 */
export function formatSessionTrendsForPrompt(trends: SessionTrends): string {
  if (
    trends.totalRounds === 0 &&
    trends.busiestLanes.length === 0
  ) {
    return "";
  }

  const lines: string[] = [];

  if (trends.totalRounds > 0) {
    const top = trends.plannerWins[0];
    lines.push(
      `- Rounds committed this session: ${trends.totalRounds}` +
        (top ? ` (top planner: ${top.planner}, ${top.wins} win(s))` : ""),
    );
    lines.push(
      `- Cost trend: €${trends.costTrend.first.toFixed(0)} → €${trends.costTrend.last.toFixed(0)} ` +
        `(${trends.costTrend.direction}, avg Δ/round €${trends.avgDeltaPerRound.toFixed(0)})`,
    );
  }

  if (trends.busiestLanes.length > 0) {
    const laneStr = trends.busiestLanes
      .map((l) => `${l.lane}×${l.count}`)
      .join(", ");
    lines.push(`- Busiest lanes in the order book: ${laneStr}`);
  }

  lines.push(
    `- Current plan: ${trends.currentPlanStats.trips} trips on ` +
      `${trends.currentPlanStats.trucksUsed} truck(s), ` +
      `${trends.currentPlanStats.palletsCovered} pallets covered, ` +
      `€${trends.currentPlanStats.cost.toFixed(0)}`,
  );

  return lines.join("\n");
}

/**
 * Turn prompt for a single planner. Shared scaffolding (hard rules, state
 * snapshot) is identical across all three; the persona-specific
 * `strategyClause` and optional SessionTrends block are what make
 * planner-1 / 2 / 3 diverge on cost and trip count.
 */
export function buildPlannerPrompt(
  snapshot: DispatchState,
  newOrder: OrderEvent | undefined,
  persona?: PlannerPromptPersona,
  trends?: SessionTrends,
): string {
  const fleetLines = snapshot.fleet
    .map((t) => `- ${t.id} @ ${t.startCity} (cap=${t.capacity})`)
    .join("\n");

  const palletLines = groupPalletsByOrder(snapshot.pallets)
    .map(
      (g) =>
        `- Order ${g.orderId}: ${g.ids.length} pallet(s) ${g.pickup}->${g.dropoff} (ids ${g.ids.join(", ")})`,
    )
    .join("\n");

  const currentLines = snapshot.currentPlan.trips
    .map(
      (t) =>
        `- Trip ${t.id} on ${t.truckId} start ${formatMinutes(t.startMinutes)}: ${t.stops.map((s) => s.city).join(" -> ")} carrying ${t.palletIds.length} pallet(s)`,
    )
    .join("\n");

  const matrixLines = Object.entries(TRAVEL_TIME_MATRIX)
    .map(
      ([from, row]) =>
        `  ${from}: ${Object.entries(row)
          .map(([to, h]) => `${to}=${h}h`)
          .join(", ")}`,
    )
    .join("\n");

  const rateMatrixLines = (CITY_IDS as readonly CityId[])
    .map(
      (from) =>
        `  ${from}: ${(CITY_IDS as readonly CityId[])
          .filter((to) => to !== from)
          .map((to) => `${to}=€${ratePerTruckLeg(from, to)}`)
          .join(", ")}`,
    )
    .join("\n");

  const newOrderBlock = newOrder
    ? `New order to absorb: ${newOrder.summary} (orderId=${newOrder.orderId}, ${newOrder.pallets.length} pallet(s))`
    : "No new order to absorb — re-plan or re-submit the current plan.";

  const personaBlock = persona
    ? `\nPersona: ${persona.label}. ${persona.strategyClause}\n`
    : "";

  const trendsBlock =
    persona?.useSessionTrends && trends
      ? (() => {
          const body = formatSessionTrendsForPrompt(trends);
          return body ? `\nSession trends so far:\n${body}\n` : "";
        })()
      : "";

  return `You are a fleet planner for tomorrow's refrigerated trucking schedule.
${personaBlock}${trendsBlock}
Hard rules (your plan is rejected if any of these fail):
- Every pallet in the order book (including the new order's pallets) must appear on exactly one trip. Use exactly the pallet ids listed below.
- Each truck may be used at most once per day and must start at its current startCity.
- A truck carries at most ${TRUCK_CAPACITY} pallets at any point during its trip.
- Total driving time per truck must be <= ${MAX_DRIVING_HOURS}h (service time is separate, 30 min per stop).
- Each trip has a numeric startMinutes in your plan (minutes after midnight), >= 360 (06:00).
- Every dropoff must complete by 18:00 (endMinutes <= 1080).

Objective: minimize total cost. Cost is charged per truck leg at a fixed rate (see the rate card below) — a full truck and an empty truck cost the same for the same leg. Consolidate aggressively: fewer trucks and fewer driving legs win. Combine pallets headed the same direction onto one truck whenever capacity allows, and chain multi-stop trips so one truck covers several orders.

Current fleet:
${fleetLines}

Current order book (every pallet id must appear somewhere in your plan):
${palletLines}

Current plan:
${currentLines || "  (no trips yet)"}

Travel-time matrix (hours):
${matrixLines}

Rate card (€/truck leg, independent of pallet count):
${rateMatrixLines}

${newOrderBlock}

Call inspectSnapshot at most once if you need to double-check the raw state. Then call submitPlan with a complete plan covering every pallet id above, each trip carrying its own startMinutes. If submitPlan returns ok:false, the errors will tell you exactly what to fix — adjust and call submitPlan again (you have several retries).`;
}

export function buildDirectorPrompt(state: DispatchState): string {
  const fleetSummary = state.fleet
    .map((t) => `${t.id}@${t.startCity}`)
    .join(", ");
  const pendingLine = state.pendingOrder
    ? `Pending order: ${state.pendingOrder.summary} (orderId=${state.pendingOrder.orderId})`
    : "No pending order.";
  const lastRoundLine =
    state.lastRound.length === 0
      ? "No planner rounds yet."
      : `Last planner round: ${state.lastRound
          .map((c) => `${c.plannerName}=${c.valid ? `€${c.cost}` : "infeasible"}`)
          .join(", ")}.`;

  return `You are the dispatch director for a 5-city Portuguese refrigerated trucking network. You do not produce plans yourself; you delegate to three Planner sub-agents and replace tomorrow's plan with the cheapest feasible candidate they return. There is no commit step and no day rollover — this prototype always plans tomorrow.

Cities and their codes (use the 3-letter code in every tool call):
  LIS = Lisbon / Lisboa
  OPO = Porto / Oporto
  COI = Coimbra
  BRA = Braga
  FAO = Faro

When the dispatcher describes a new order in chat (e.g. "New order: 3 pallets Porto -> Faro" or "2 from Lisbon to Braga"):
1. Map the city names to codes.
2. Generate an orderId that does not collide with existing orders (e.g. O-7, O-8, ...).
3. Call **submitOrder** with { orderId, pickup, dropoff, pallets, summary }. This single tool adds the order AND runs the planner round.
4. Read the tool result and reply in one or two sentences: if ok, report the winning planner, its cost, and the delta versus the prior plan. If all three planners were infeasible, list each planner's first error and ask the dispatcher how to proceed (e.g. add trucks). Do not invent a plan of your own.

If the dispatcher asks an open question (e.g. "why did planner-2 fail?", "how many pallets are on TR-003?"), use inspectDispatch to read state and answer in prose.

Only use addOrder + askPlanners separately if the dispatcher gives you explicit pallet ids. Otherwise always prefer submitOrder.

Current state:
  Fleet (${state.fleetSize} trucks): ${fleetSummary}
  Pallet count: ${state.pallets.length}
  ${pendingLine}
  ${lastRoundLine}`;
}

// =============================================================================
// Helpers
// =============================================================================

export function makeCandidate(
  plannerName: string,
  seed: number,
  plan: Plan,
  result: ValidatePlanResult,
  pallets: Pallet[],
): PlannerCandidate {
  if (result.ok) {
    return {
      plannerName,
      seed,
      plan,
      valid: true,
      cost: result.view.totalCost,
      submittedAt: Date.now(),
    };
  }

  return {
    plannerName,
    seed,
    plan,
    valid: false,
    errors: result.errors,
    submittedAt: Date.now(),
    cost: computePlanCost(plan, pallets),
  };
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = Math.floor(minutes % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Group pallets back into their originating orders for compact prompt
 * rendering. Preserves input pallet order so the list is deterministic.
 */
function groupPalletsByOrder(pallets: Pallet[]): Array<{
  orderId: string;
  pickup: CityId;
  dropoff: CityId;
  ids: string[];
}> {
  const groups = new Map<
    string,
    { orderId: string; pickup: CityId; dropoff: CityId; ids: string[] }
  >();
  for (const p of pallets) {
    const existing = groups.get(p.orderId);
    if (existing) {
      existing.ids.push(p.id);
    } else {
      groups.set(p.orderId, {
        orderId: p.orderId,
        pickup: p.pickup,
        dropoff: p.dropoff,
        ids: [p.id],
      });
    }
  }
  return Array.from(groups.values());
}

/**
 * Given a revalidated round of candidates, return the cheapest valid one or
 * `null` if none are feasible. Pure function so the Director commit logic +
 * the UI winner-chip can share one source of truth (and so we can unit-test
 * grace-commit scenarios without spinning up a DO).
 *
 * Ties are broken by the candidate's declared `seed` (lower first), then by
 * `plannerName` lexicographically, so results are deterministic.
 */
export function pickCheapestFeasible(
  candidates: PlannerCandidate[],
): (PlannerCandidate & { valid: true; cost: number }) | null {
  const valid = candidates.filter(
    (c): c is PlannerCandidate & { valid: true; cost: number } =>
      c.valid && typeof c.cost === "number",
  );
  if (valid.length === 0) return null;
  return valid.reduce((best, c) => {
    if (c.cost < best.cost) return c;
    if (c.cost > best.cost) return best;
    // Tie on cost: prefer fewer trips (less fleet utilisation / lower
    // operational overhead).
    const cTrips = c.plan.trips.length;
    const bestTrips = best.plan.trips.length;
    if (cTrips < bestTrips) return c;
    if (cTrips > bestTrips) return best;
    if (c.seed < best.seed) return c;
    if (c.seed > best.seed) return best;
    return c.plannerName < best.plannerName ? c : best;
  });
}

/**
 * Result of deciding what to do with a completed planner round.
 *
 *  - `infeasible`: every candidate was invalid (or the list was empty).
 *    The Director should keep `currentPlan` unchanged, stash `revalidated`
 *    into `lastRound`, and surface an error chip.
 *  - `winner_rejected`: a valid winner existed but `tryApplyPlan` failed
 *    (e.g. constraint drift between the planner's validation and the
 *    Director's revalidation). Same "keep plan, surface error" handling.
 *  - `committed`: the winner's plan was successfully applied. The Director
 *    should setState to `appliedState` (already containing the winning plan)
 *    and append `roundResult` to `recentRounds`.
 */
export type RoundCommitDecision =
  | {
      kind: "infeasible";
      errorDetail: string;
      errors: string[];
    }
  | {
      kind: "winner_rejected";
      winner: PlannerCandidate & { valid: true; cost: number };
      errors: string[];
    }
  | {
      kind: "committed";
      winner: PlannerCandidate & { valid: true; cost: number };
      appliedState: DispatchState;
      summary: string;
      roundResult: RoundResult;
    };

/**
 * Pure decision function for a planner round. Extracted from
 * `DispatchDirectorAgent.askPlannersInternal` so we can unit-test the
 * infeasible / winner-rejected / committed branches without spinning up a
 * Durable Object. Callers stay responsible for writing the result back to
 * state and emitting director actions.
 */
export function computeRoundCommit(args: {
  stateAfterRound: DispatchState;
  revalidated: PlannerCandidate[];
  newOrder: OrderEvent;
  roundId: number;
  now: number;
}): RoundCommitDecision {
  const { stateAfterRound, revalidated, newOrder, roundId, now } = args;
  const winner = pickCheapestFeasible(revalidated);

  if (winner === null) {
    const errorDetail = revalidated
      .map(
        (c) =>
          `${c.plannerName}: ${c.errors?.slice(0, 2).join("; ") ?? "no plan"}`,
      )
      .join(" | ");
    return {
      kind: "infeasible",
      errorDetail,
      errors: revalidated.flatMap((c) => c.errors ?? []),
    };
  }

  const priorCost = computePlanCost(
    stateAfterRound.currentPlan,
    stateAfterRound.pallets,
  );
  const applied = tryApplyPlan(stateAfterRound, winner.plan);

  if (!applied.ok) {
    return {
      kind: "winner_rejected",
      winner,
      errors: applied.errors,
    };
  }

  const delta = winner.cost - priorCost;
  const deltaText = `${delta >= 0 ? "+" : ""}€${delta.toFixed(0)} vs prior`;
  const summary = `${winner.plannerName} @ €${winner.cost.toFixed(0)} (${deltaText})`;

  const roundResult: RoundResult = {
    roundId,
    orderId: newOrder.orderId,
    winnerPlanner: winner.plannerName,
    winnerSeed: winner.seed,
    cost: winner.cost,
    priorCost,
    committedAt: now,
    tripCount: winner.plan.trips.length,
  };

  return {
    kind: "committed",
    winner,
    appliedState: applied.state,
    summary,
    roundResult,
  };
}

/** Shallow compactor for logging snapshots to the action log. */
export function summarizePlan(plan: Plan): string {
  const tripCount = plan.trips.length;
  const trucks = new Set(plan.trips.map((t) => t.truckId)).size;
  const pallets = plan.trips.reduce((s, t) => s + t.palletIds.length, 0);
  return `${tripCount} trip(s), ${trucks} truck(s), ${pallets} pallet(s)`;
}

/**
 * Read-only summary of the current session, derived live from the same
 * `recentRounds` + `currentPlan` + `pallets` we already persist. No extra
 * state is stored — the Control Room panel and the Strategist planner
 * prompt both recompute from this function whenever they need a snapshot.
 */
export type SessionTrends = {
  totalRounds: number;
  plannerWins: Array<{ planner: string; wins: number; pctOfRounds: number }>;
  costTrend: {
    first: number;
    last: number;
    delta: number;
    direction: "down" | "up" | "flat";
  };
  /** Mean of (cost - priorCost) across `recentRounds`. */
  avgDeltaPerRound: number;
  /** Top pickup→dropoff lanes across pallets, most-used first. */
  busiestLanes: Array<{ lane: string; count: number }>;
  currentPlanStats: {
    trips: number;
    trucksUsed: number;
    palletsCovered: number;
    cost: number;
  };
};

const BUSIEST_LANES_CAP = 3;

/**
 * Compute a `SessionTrends` snapshot from `DispatchState`. Pure function.
 * Safe to call on a fresh dispatch state (no rounds yet) — returns a
 * well-formed trends object with zeros and empty arrays.
 */
export function computeSessionTrends(state: DispatchState): SessionTrends {
  const rounds = state.recentRounds ?? [];
  const totalRounds = rounds.length;

  // Planner win tally. Iterate in insertion order so ties break stably
  // toward the planner that won first.
  const winCounts = new Map<string, number>();
  for (const r of rounds) {
    winCounts.set(r.winnerPlanner, (winCounts.get(r.winnerPlanner) ?? 0) + 1);
  }
  const plannerWins = Array.from(winCounts.entries())
    .map(([planner, wins]) => ({
      planner,
      wins,
      pctOfRounds: totalRounds === 0 ? 0 : wins / totalRounds,
    }))
    .sort((a, b) => b.wins - a.wins || a.planner.localeCompare(b.planner));

  const first = rounds[0]?.cost ?? 0;
  const last = rounds[rounds.length - 1]?.cost ?? 0;
  const delta = last - first;
  const direction: SessionTrends["costTrend"]["direction"] =
    delta < 0 ? "down" : delta > 0 ? "up" : "flat";

  const avgDeltaPerRound =
    totalRounds === 0
      ? 0
      : rounds.reduce((sum, r) => sum + (r.cost - r.priorCost), 0) / totalRounds;

  const laneCounts = new Map<string, number>();
  for (const p of state.pallets) {
    const lane = `${p.pickup}->${p.dropoff}`;
    laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
  }
  const busiestLanes = Array.from(laneCounts.entries())
    .map(([lane, count]) => ({ lane, count }))
    .sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane))
    .slice(0, BUSIEST_LANES_CAP);

  const trucksUsed = new Set(state.currentPlan.trips.map((t) => t.truckId)).size;
  const palletsCovered =
    state.pallets.length - state.currentPlan.unassignedPalletIds.length;

  return {
    totalRounds,
    plannerWins,
    costTrend: { first, last, delta, direction },
    avgDeltaPerRound,
    busiestLanes,
    currentPlanStats: {
      trips: state.currentPlan.trips.length,
      trucksUsed,
      palletsCovered,
      cost: computePlanCost(state.currentPlan, state.pallets),
    },
  };
}
