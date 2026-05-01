import type {
  CityId,
  DispatchState,
  OrderEvent,
  Pallet,
  Plan,
  PlanView,
  PlannerCandidate,
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
 * Rate card: €/pallet depends only on the route.
 * Formula: round(hours * 6 + 4).
 */
export function ratePerPallet(from: CityId, to: CityId): number {
  if (from === to) return 0;
  return Math.round(travelHours(from, to) * 6 + 4);
}

export function legCost(
  from: CityId,
  to: CityId,
  palletCount: number,
): number {
  return ratePerPallet(from, to) * palletCount;
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

export function computeTripCost(trip: Trip, pallets: Pallet[]): number {
  const byId = new Map(pallets.map((p) => [p.id, p]));
  let total = 0;
  for (const pid of trip.palletIds) {
    const p = byId.get(pid);
    if (!p) continue;
    total += ratePerPallet(p.pickup, p.dropoff);
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

/** First 10 truck start-cities in canonical order. Matches PLAN.md section 5.4. */
const CANONICAL_FLEET_CITIES: CityId[] = [
  "LIS",
  "LIS",
  "OPO",
  "OPO",
  "COI",
  "COI",
  "BRA",
  "BRA",
  "FAO",
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
 * Initial 12-order book, 30 pallets total. Includes origin cities with 3
 * outbound routes (LIS, OPO, COI) so the greedy seeder exercises its
 * multi-route consolidation path.
 */
const INITIAL_ORDERS: SeedOrder[] = [
  { orderId: "O-1", pickup: "LIS", dropoff: "OPO", count: 4 },
  { orderId: "O-2", pickup: "OPO", dropoff: "LIS", count: 3 },
  { orderId: "O-3", pickup: "LIS", dropoff: "COI", count: 2 },
  { orderId: "O-4", pickup: "COI", dropoff: "LIS", count: 2 },
  { orderId: "O-5", pickup: "OPO", dropoff: "BRA", count: 3 },
  { orderId: "O-6", pickup: "BRA", dropoff: "OPO", count: 2 },
  { orderId: "O-7", pickup: "LIS", dropoff: "FAO", count: 3 },
  { orderId: "O-8", pickup: "FAO", dropoff: "LIS", count: 2 },
  { orderId: "O-9", pickup: "COI", dropoff: "BRA", count: 2 },
  { orderId: "O-10", pickup: "BRA", dropoff: "COI", count: 2 },
  { orderId: "O-11", pickup: "OPO", dropoff: "COI", count: 3 },
  { orderId: "O-12", pickup: "COI", dropoff: "OPO", count: 2 },
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
    recentDirectorActions: [],
    directorThinking: false,
  };
}

// =============================================================================
// Sample orders (UI helper)
// =============================================================================

export const SAMPLE_ORDER_TEMPLATES: string[] = [
  "New order O-13: 4 pallets from OPO to FAO, tomorrow.",
  "New order O-14: 3 pallets from LIS to BRA.",
  "New order O-15: 5 pallets from FAO to OPO.",
  "New order O-16: 2 pallets from COI to FAO.",
  "New order O-17: 6 pallets from BRA to LIS.",
];

// =============================================================================
// Prompt builders
// =============================================================================

/**
 * Identical prompt across all three planners. Variation comes only from the
 * per-planner `sessionAffinity` passed to `createCruiseModel`.
 */
export function buildPlannerPrompt(
  snapshot: DispatchState,
  newOrder: OrderEvent | undefined,
): string {
  const fleetLines = snapshot.fleet
    .map((t) => `- ${t.id} @ ${t.startCity} (cap=${t.capacity})`)
    .join("\n");

  const palletLines = snapshot.pallets
    .map(
      (p) => `- ${p.id} ${p.pickup} -> ${p.dropoff} (order ${p.orderId})`,
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

  const newOrderBlock = newOrder
    ? `New order to absorb: ${newOrder.summary} (orderId=${newOrder.orderId}, ${newOrder.pallets.length} pallet(s))`
    : "No new order to absorb — re-plan or re-submit the current plan.";

  return `You are a fleet planner for tomorrow's refrigerated trucking schedule.

Hard rules (your plan is rejected if any of these fail):
- Every pallet in the order book (including the new order's pallets) must appear on exactly one trip.
- Each truck may be used at most once per day and must start at its current startCity.
- A truck carries at most ${TRUCK_CAPACITY} pallets at any point during its trip.
- Total driving time per truck must be <= ${MAX_DRIVING_HOURS}h (service time is separate, 30 min per stop).
- Each trip has a numeric startMinutes in your plan (minutes after midnight), >= 360 (06:00).
- Every dropoff must complete by 18:00 (endMinutes <= 1080).

Objective: minimize the total cost as computed by the rate card (sum over pallets of the rate for their pickup->dropoff route).

Current fleet:
${fleetLines}

Current order book:
${palletLines}

Current plan:
${currentLines || "  (no trips yet)"}

Travel-time matrix (hours):
${matrixLines}

${newOrderBlock}

Use inspectSnapshot if you need the raw state again. Then call submitPlan exactly once with a complete plan covering every pallet. Remember to include startMinutes on every trip. If submitPlan rejects your plan, read the errors and try again.`;
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

  return `You are the dispatch director. You do not produce plans yourself; you delegate to three Planner sub-agents and replace tomorrow's plan with the cheapest feasible candidate they return. There is no commit step and no day rollover — this prototype always plans tomorrow.

When the dispatcher describes a new order in chat (e.g. "New order: 6 pallets Porto -> Faro"):
1. Parse the order into pallets (all with the same pickup/dropoff).
2. Call addOrder to persist it.
3. Call askPlanners to run the three Planner sub-agents in parallel.
4. Report the winner and cost delta in chat. If all three candidates are infeasible, explain each failure and ask the dispatcher how to proceed. Do not invent a plan.

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

/** Shallow compactor for logging snapshots to the action log. */
export function summarizePlan(plan: Plan): string {
  const tripCount = plan.trips.length;
  const trucks = new Set(plan.trips.map((t) => t.truckId)).size;
  const pallets = plan.trips.reduce((s, t) => s + t.palletIds.length, 0);
  return `${tripCount} trip(s), ${trucks} truck(s), ${pallets} pallet(s)`;
}
