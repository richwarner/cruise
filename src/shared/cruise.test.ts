import { describe, expect, it } from "vitest";

import {
  buildFleet,
  buildInitialPallets,
  buildInitialPlan,
  computePlanCost,
  computeRoundCommit,
  computeSessionTrends,
  EARLIEST_START_MINUTES,
  MAX_DRIVING_HOURS,
  pickCheapestFeasible,
  ratePerTruckLeg,
  seedInitialDispatchState,
  simulateTrip,
  travelHours,
  TRUCK_CAPACITY,
  validatePlan,
} from "./cruise";
import {
  palletSchema,
  submitOrderInputSchema,
} from "./schemas";
import type {
  DispatchState,
  OrderEvent,
  Pallet,
  Plan,
  PlannerCandidate,
  RoundResult,
  Trip,
  Truck,
} from "./types";

describe("travel-time matrix", () => {
  it("is symmetric", () => {
    const cities = ["LIS", "OPO", "COI", "BRA", "FAO"] as const;
    for (const a of cities) {
      for (const b of cities) {
        expect(travelHours(a, b)).toBe(travelHours(b, a));
      }
    }
  });

  it("same city is zero", () => {
    expect(travelHours("LIS", "LIS")).toBe(0);
  });
});

describe("ratePerTruckLeg", () => {
  it("applies the €50 + €120/h formula", () => {
    // LIS -> OPO is 3h → round(50 + 120*3) = 410
    expect(ratePerTruckLeg("LIS", "OPO")).toBe(410);
    // OPO -> BRA is 0.75h → round(50 + 120*0.75) = 140
    expect(ratePerTruckLeg("OPO", "BRA")).toBe(140);
    // LIS -> FAO is 2.75h → round(50 + 120*2.75) = 380
    expect(ratePerTruckLeg("LIS", "FAO")).toBe(380);
  });

  it("returns 0 for same-city (no driving)", () => {
    expect(ratePerTruckLeg("LIS", "LIS")).toBe(0);
  });

  it("is symmetric (cost is per leg, direction doesn't matter in the rate card)", () => {
    expect(ratePerTruckLeg("LIS", "FAO")).toBe(ratePerTruckLeg("FAO", "LIS"));
  });
});

describe("buildFleet", () => {
  it("produces the canonical demand-weighted 10-truck fleet", () => {
    const fleet = buildFleet(10);
    expect(fleet).toHaveLength(10);
    expect(fleet.map((t) => t.startCity)).toEqual([
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
    ]);

    // Counts we rely on in the demo + prompts: LIS=3, OPO=3, BRA=2, COI=1, FAO=1.
    const counts = fleet.reduce<Record<string, number>>((acc, t) => {
      acc[t.startCity] = (acc[t.startCity] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ LIS: 3, OPO: 3, BRA: 2, COI: 1, FAO: 1 });
  });

  it("covers all five cities at fleetSize=10 so no city is stranded", () => {
    const fleet = buildFleet(10);
    const cities = new Set(fleet.map((t) => t.startCity));
    expect(cities.size).toBe(5);
  });

  it("takes the first N entries when fleetSize < 10", () => {
    const fleet = buildFleet(3);
    expect(fleet).toHaveLength(3);
    expect(fleet.map((t) => t.startCity)).toEqual(["LIS", "LIS", "LIS"]);
  });

  it("round-robins when fleetSize > 10", () => {
    const fleet = buildFleet(13);
    expect(fleet.slice(10).map((t) => t.startCity)).toEqual([
      "LIS",
      "OPO",
      "COI",
    ]);
  });
});

describe("seedInitialDispatchState", () => {
  const systemId = "test-system";
  const state = seedInitialDispatchState(systemId);

  it("produces a feasible initial plan covering all 12 pallets", () => {
    const result = validatePlan(state.currentPlan, state.fleet, state.pallets);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.view.trucksUsed).toBeGreaterThan(0);
    expect(result.view.trucksUsed).toBeLessThanOrEqual(state.fleet.length);
    expect(state.pallets).toHaveLength(12);
  });

  it("assigns every pallet", () => {
    const assigned = new Set(
      state.currentPlan.trips.flatMap((t) => t.palletIds),
    );
    for (const p of state.pallets) {
      expect(assigned.has(p.id)).toBe(true);
    }
    expect(state.currentPlan.unassignedPalletIds).toHaveLength(0);
  });

  it("has stable 3 planner agent names", () => {
    expect(state.plannerAgentNames).toEqual([
      `${systemId}-planner-1`,
      `${systemId}-planner-2`,
      `${systemId}-planner-3`,
    ]);
  });

  it("totalCost is positive and deterministic", () => {
    const a = computePlanCost(state.currentPlan, state.pallets);
    const b = computePlanCost(state.currentPlan, state.pallets);
    expect(a).toBeGreaterThan(0);
    expect(a).toBe(b);
  });

  it("defaults fleetSize to 10 and records it on state", () => {
    expect(state.fleetSize).toBe(10);
    expect(state.fleet).toHaveLength(10);
  });

  it("does not throw at fleetSize != 10 even if plan is infeasible", () => {
    expect(() => seedInitialDispatchState("shrunk", { fleetSize: 3 })).not.toThrow();
  });
});

describe("validatePlan", () => {
  const fleet = buildFleet(10);
  const pallets = buildInitialPallets();
  const validPlan = buildInitialPlan(fleet, pallets);

  it("accepts the seeded plan", () => {
    const result = validatePlan(validPlan, fleet, pallets);
    expect(result.ok).toBe(true);
  });

  it("rejects a plan that leaves a pallet unassigned", () => {
    const stripped: Plan = {
      ...validPlan,
      trips: validPlan.trips.slice(0, -1),
    };
    const result = validatePlan(stripped, fleet, pallets);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes("not assigned"))).toBe(true);
  });

  it("rejects a trip starting at the wrong city", () => {
    const firstTrip = validPlan.trips[0];
    const badTrip: Trip = {
      ...firstTrip,
      stops: firstTrip.stops.map((s, i) =>
        i === 0 ? { ...s, city: "FAO" } : s,
      ),
    };
    const plan: Plan = {
      ...validPlan,
      trips: [badTrip, ...validPlan.trips.slice(1)],
    };
    const result = validatePlan(plan, fleet, pallets);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes("starts at"))).toBe(true);
  });

  it("rejects a trip with startMinutes < 360 (before 06:00)", () => {
    const badTrip: Trip = { ...validPlan.trips[0], startMinutes: 300 };
    const plan: Plan = {
      ...validPlan,
      trips: [badTrip, ...validPlan.trips.slice(1)],
    };
    const result = validatePlan(plan, fleet, pallets);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes("earliest"))).toBe(true);
  });

  it("rejects a dropoff before pickup for the same pallet", () => {
    const pid = validPlan.trips[0].palletIds[0];
    const badTrip: Trip = {
      ...validPlan.trips[0],
      stops: [
        {
          city: validPlan.trips[0].stops[1].city,
          pickupPalletIds: [],
          dropoffPalletIds: [pid],
        },
        {
          city: validPlan.trips[0].stops[0].city,
          pickupPalletIds: [pid],
          dropoffPalletIds: [],
        },
      ],
    };
    const plan: Plan = {
      ...validPlan,
      trips: [badTrip, ...validPlan.trips.slice(1)],
    };
    const result = validatePlan(plan, fleet, pallets);
    expect(result.ok).toBe(false);
  });

  it("rejects an over-capacity leg", () => {
    const lisTruck: Truck = fleet.find((t) => t.startCity === "LIS")!;
    const bigOrder: Pallet[] = Array.from({ length: 31 }, (_, i) => ({
      id: `BIG-${i}`,
      orderId: "BIG",
      pickup: "LIS",
      dropoff: "OPO",
    }));
    const bigTrip: Trip = {
      id: "TR-BIG",
      truckId: lisTruck.id,
      startMinutes: EARLIEST_START_MINUTES,
      stops: [
        {
          city: "LIS",
          pickupPalletIds: bigOrder.map((p) => p.id),
          dropoffPalletIds: [],
        },
        {
          city: "OPO",
          pickupPalletIds: [],
          dropoffPalletIds: bigOrder.map((p) => p.id),
        },
      ],
      palletIds: bigOrder.map((p) => p.id),
    };
    const plan: Plan = { trips: [bigTrip], unassignedPalletIds: [] };
    const result = validatePlan(plan, [lisTruck], bigOrder);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes("capacity"))).toBe(true);
  });

  it("rejects a trip that exceeds the 9h driving cap", () => {
    const opoTruck: Truck = {
      id: "T-LONG",
      sizeMeters: 13.5,
      capacity: 30,
      startCity: "OPO",
    };
    const pallet: Pallet = {
      id: "LONG-1",
      orderId: "LONG",
      pickup: "OPO",
      dropoff: "FAO",
    };
    const returnPallet: Pallet = {
      id: "LONG-2",
      orderId: "LONG",
      pickup: "FAO",
      dropoff: "OPO",
    };
    const trip: Trip = {
      id: "TR-LONG",
      truckId: opoTruck.id,
      startMinutes: EARLIEST_START_MINUTES,
      stops: [
        { city: "OPO", pickupPalletIds: ["LONG-1"], dropoffPalletIds: [] },
        {
          city: "FAO",
          pickupPalletIds: ["LONG-2"],
          dropoffPalletIds: ["LONG-1"],
        },
        { city: "OPO", pickupPalletIds: [], dropoffPalletIds: ["LONG-2"] },
      ],
      palletIds: ["LONG-1", "LONG-2"],
    };
    const plan: Plan = { trips: [trip], unassignedPalletIds: [] };
    const result = validatePlan(plan, [opoTruck], [pallet, returnPallet]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const timeline = simulateTrip(trip, [opoTruck]);
    expect(timeline.drivingHours).toBeGreaterThan(MAX_DRIVING_HOURS);
    expect(result.errors.some((e) => e.includes("drives"))).toBe(true);
  });

  it("rejects when a truck appears in two trips on the same day", () => {
    const pid1 = validPlan.trips[0].palletIds[0];
    const duplicate: Trip = {
      ...validPlan.trips[0],
      id: "TR-DUP",
      palletIds: [pid1],
      stops: validPlan.trips[0].stops,
    };
    const plan: Plan = {
      ...validPlan,
      trips: [...validPlan.trips, duplicate],
    };
    const result = validatePlan(plan, fleet, pallets);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(
      result.errors.some((e) => e.includes("more than one trip")),
    ).toBe(true);
  });

  it("rejects a trip whose declared palletIds disagree with stop pickups", () => {
    const firstTrip = validPlan.trips[0];
    const bogus: Trip = {
      ...firstTrip,
      palletIds: [...firstTrip.palletIds, "GHOST-PALLET"],
    };
    const plan: Plan = {
      ...validPlan,
      trips: [bogus, ...validPlan.trips.slice(1)],
    };
    const result = validatePlan(plan, fleet, pallets);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(
      result.errors.some((e) => e.includes("disagrees with stop pickups")),
    ).toBe(true);
  });

  it("rejects a plan whose total cost is €0 while carrying pallets", () => {
    // A single-city trip with no driving legs and a degenerate (pickup ===
    // dropoff) pallet sneaks past the per-stop checks but costs €0 under
    // the per-truck-leg rate card. The validator's sanity floor must catch
    // this even when the order schema would normally refuse to create such
    // a pallet.
    const lisTruck: Truck = {
      id: "T-ZERO",
      sizeMeters: 13.5,
      capacity: 30,
      startCity: "LIS",
    };
    const zeroPallet: Pallet = {
      id: "ZERO-1",
      orderId: "ZERO",
      pickup: "LIS",
      dropoff: "LIS",
    };
    const trip: Trip = {
      id: "TR-ZERO",
      truckId: lisTruck.id,
      startMinutes: EARLIEST_START_MINUTES,
      stops: [
        { city: "LIS", pickupPalletIds: ["ZERO-1"], dropoffPalletIds: [] },
        { city: "LIS", pickupPalletIds: [], dropoffPalletIds: ["ZERO-1"] },
      ],
      palletIds: ["ZERO-1"],
    };
    const plan: Plan = { trips: [trip], unassignedPalletIds: [] };
    const result = validatePlan(plan, [lisTruck], [zeroPallet]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(
      result.errors.some((e) =>
        e.includes("per-truck-leg rate card"),
      ),
    ).toBe(true);
  });

  it("accepts a trip with empty palletIds when stop pickups are complete", () => {
    const planWithEmpty: Plan = {
      ...validPlan,
      trips: validPlan.trips.map((t) => ({ ...t, palletIds: [] })),
    };
    const result = validatePlan(planWithEmpty, fleet, pallets);
    expect(result.ok).toBe(true);
  });

  it("rejects a trip whose last dropoff lands after 18:00", () => {
    // OPO→FAO is 5.75h driving; with a late start the endMinutes > 18:00.
    const opoTruck: Truck = fleet.find((t) => t.startCity === "OPO")!;
    const p: Pallet = {
      id: "LATE-1",
      orderId: "LATE",
      pickup: "OPO",
      dropoff: "FAO",
    };
    const trip: Trip = {
      id: "TR-LATE",
      truckId: opoTruck.id,
      startMinutes: 13 * 60, // 13:00 — 5.75h driving + 1h service = 19:45
      stops: [
        { city: "OPO", pickupPalletIds: ["LATE-1"], dropoffPalletIds: [] },
        { city: "FAO", pickupPalletIds: [], dropoffPalletIds: ["LATE-1"] },
      ],
      palletIds: ["LATE-1"],
    };
    const plan: Plan = { trips: [trip], unassignedPalletIds: [] };
    const result = validatePlan(plan, [opoTruck], [p]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((e) => e.includes("18:00"))).toBe(true);
  });
});

describe("computePlanCost", () => {
  it("sums the per-truck-leg rate across each trip's driving legs", () => {
    const fleet = buildFleet(10);
    const pallets = buildInitialPallets();
    const plan = buildInitialPlan(fleet, pallets);
    let expected = 0;
    for (const t of plan.trips) {
      let prev: (typeof t.stops)[number]["city"] | null = null;
      for (const stop of t.stops) {
        if (prev !== null && prev !== stop.city) {
          expected += ratePerTruckLeg(prev, stop.city);
        }
        prev = stop.city;
      }
    }
    expect(computePlanCost(plan, pallets)).toBe(expected);
  });

  // Regression: cost must come from the stops, not from `trip.palletIds` or
  // `pallets`. Under the per-truck-leg model a planner could populate stops
  // correctly but leave `trip.palletIds` empty and still get a real cost.
  it("is independent of trip.palletIds (cost comes from the driving legs)", () => {
    const fleet = buildFleet(10);
    const pallets = buildInitialPallets();
    const plan = buildInitialPlan(fleet, pallets);
    const planWithEmptyPalletIds: Plan = {
      ...plan,
      trips: plan.trips.map((t) => ({ ...t, palletIds: [] })),
    };
    const expected = computePlanCost(plan, pallets);
    expect(expected).toBeGreaterThan(0);
    expect(computePlanCost(planWithEmptyPalletIds, pallets)).toBe(expected);
  });

  it("charges the same for a full truck as for a half-full truck (consolidation incentive)", () => {
    const lisTruck: Truck = {
      id: "T-CONS",
      sizeMeters: 13.5,
      capacity: 30,
      startCity: "LIS",
    };
    const soloPallet: Pallet = {
      id: "SOLO-1",
      orderId: "SOLO",
      pickup: "LIS",
      dropoff: "OPO",
    };
    const fullLoadPallets: Pallet[] = Array.from({ length: 10 }, (_, i) => ({
      id: `FULL-${i}`,
      orderId: "FULL",
      pickup: "LIS",
      dropoff: "OPO",
    }));
    const buildLisOpoTrip = (pids: string[]): Trip => ({
      id: "TR-CONS",
      truckId: lisTruck.id,
      startMinutes: EARLIEST_START_MINUTES,
      stops: [
        { city: "LIS", pickupPalletIds: pids, dropoffPalletIds: [] },
        { city: "OPO", pickupPalletIds: [], dropoffPalletIds: pids },
      ],
      palletIds: pids,
    });
    const soloCost = computePlanCost(
      { trips: [buildLisOpoTrip(["SOLO-1"])], unassignedPalletIds: [] },
      [soloPallet],
    );
    const fullCost = computePlanCost(
      {
        trips: [buildLisOpoTrip(fullLoadPallets.map((p) => p.id))],
        unassignedPalletIds: [],
      },
      fullLoadPallets,
    );
    expect(soloCost).toBe(fullCost);
    expect(soloCost).toBe(ratePerTruckLeg("LIS", "OPO"));
  });
});

describe("simulateTrip", () => {
  it("computes end city as the last stop's city", () => {
    const fleet = buildFleet(10);
    const pallets = buildInitialPallets();
    const plan = buildInitialPlan(fleet, pallets);
    const trip = plan.trips[0];
    const timeline = simulateTrip(trip, fleet);
    expect(timeline.endCity).toBe(trip.stops[trip.stops.length - 1].city);
  });

  it("uses trip.startMinutes as the timeline start", () => {
    const fleet = buildFleet(10);
    const pallets = buildInitialPallets();
    const plan = buildInitialPlan(fleet, pallets);
    const trip = { ...plan.trips[0], startMinutes: 7 * 60 };
    const timeline = simulateTrip(trip, fleet);
    expect(timeline.startMinutes).toBe(7 * 60);
  });

  it("records load after each stop never exceeding capacity", () => {
    const fleet = buildFleet(10);
    const pallets = buildInitialPallets();
    const plan = buildInitialPlan(fleet, pallets);
    for (const trip of plan.trips) {
      const timeline = simulateTrip(trip, fleet);
      for (const load of timeline.loadAfterStop) {
        expect(load).toBeLessThanOrEqual(TRUCK_CAPACITY);
        expect(load).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("pickCheapestFeasible", () => {
  const candidate = (
    seed: number,
    valid: boolean,
    cost: number | undefined,
    name = `p-${seed}`,
  ): PlannerCandidate => ({
    plannerName: name,
    seed,
    plan: { trips: [], unassignedPalletIds: [] },
    valid: valid as true,
    cost: cost as number,
    submittedAt: 0,
    errors: valid ? undefined : ["infeasible"],
  });

  it("returns null when no candidates", () => {
    expect(pickCheapestFeasible([])).toBeNull();
  });

  it("returns null when all candidates are infeasible", () => {
    const round = [
      candidate(1, false, undefined),
      candidate(2, false, undefined),
      candidate(3, false, undefined),
    ];
    expect(pickCheapestFeasible(round)).toBeNull();
  });

  it("picks the cheapest valid candidate", () => {
    const round = [
      candidate(1, true, 500),
      candidate(2, true, 300),
      candidate(3, true, 400),
    ];
    const winner = pickCheapestFeasible(round);
    expect(winner?.seed).toBe(2);
    expect(winner?.cost).toBe(300);
  });

  it("skips candidates marked valid but missing cost", () => {
    const round = [
      candidate(1, true, undefined), // broken: claims valid but no cost
      candidate(2, true, 450),
    ];
    const winner = pickCheapestFeasible(round);
    expect(winner?.seed).toBe(2);
  });

  it("handles a partial grace-window round (fewer than 3 candidates)", () => {
    // Grace-commit scenario: planner-1 valid, planner-3 still running so only
    // two candidates in the list when the winner is picked.
    const round = [candidate(1, true, 420), candidate(3, true, 400)];
    const winner = pickCheapestFeasible(round);
    expect(winner?.seed).toBe(3);
    expect(winner?.cost).toBe(400);
  });

  it("breaks ties deterministically by seed then plannerName", () => {
    const round = [
      candidate(2, true, 400, "p-B"),
      candidate(2, true, 400, "p-A"),
      candidate(1, true, 400, "p-C"),
    ];
    const winner = pickCheapestFeasible(round);
    // Same cost, same (0) trip count → lower seed wins → seed=1
    expect(winner?.seed).toBe(1);
    expect(winner?.plannerName).toBe("p-C");
  });

  it("breaks cost ties by preferring the candidate with fewer trips", () => {
    const tripsOfLength = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `TR-${i}`,
        truckId: `T-${i}`,
        startMinutes: 360,
        stops: [
          { city: "LIS" as const, pickupPalletIds: [], dropoffPalletIds: [] },
        ],
        palletIds: [],
      }));
    const round: PlannerCandidate[] = [
      // Same cost, different trip counts, seed ordering would otherwise pick
      // seed=1 — the tiebreak must prefer the leaner plan (seed=3, 5 trips).
      {
        plannerName: "p-1",
        seed: 1,
        plan: { trips: tripsOfLength(8), unassignedPalletIds: [] },
        valid: true,
        cost: 1230,
        submittedAt: 0,
      },
      {
        plannerName: "p-2",
        seed: 2,
        plan: { trips: tripsOfLength(7), unassignedPalletIds: [] },
        valid: true,
        cost: 1230,
        submittedAt: 0,
      },
      {
        plannerName: "p-3",
        seed: 3,
        plan: { trips: tripsOfLength(5), unassignedPalletIds: [] },
        valid: true,
        cost: 1230,
        submittedAt: 0,
      },
    ];
    const winner = pickCheapestFeasible(round);
    expect(winner?.seed).toBe(3);
    expect(winner?.plan.trips.length).toBe(5);
  });

  it("ignores infeasible candidates even when they are cheaper-looking", () => {
    const round = [
      candidate(1, false, 100), // "cost" attached but invalid
      candidate(2, true, 500),
    ];
    const winner = pickCheapestFeasible(round);
    expect(winner?.seed).toBe(2);
    expect(winner?.cost).toBe(500);
  });
});

describe("computeRoundCommit", () => {
  function makeOrder(): OrderEvent {
    return {
      orderId: "O-TEST-1",
      createdAt: 0,
      summary: "test order",
      pallets: [
        {
          id: "O-TEST-1#1",
          orderId: "O-TEST-1",
          pickup: "LIS",
          dropoff: "OPO",
        },
      ],
    };
  }

  function makeSeededState() {
    // Large fleet so the baseline plan is trivially feasible.
    return seedInitialDispatchState("test-system", { fleetSize: 10 });
  }

  function invalidCandidate(plannerName: string, seed: number): PlannerCandidate {
    return {
      plannerName,
      seed,
      plan: { trips: [], unassignedPalletIds: ["O-TEST-1#1"] },
      valid: false,
      errors: [`${plannerName}: infeasible with fleet=2`],
      submittedAt: 0,
    };
  }

  it("returns 'infeasible' when every candidate is invalid (fleet=2 regression)", () => {
    // Phase 6 regression: the demo can shrink to fleet=2 and still send a
    // multi-pallet order. All three planners should fail and the Director
    // should NOT replace `currentPlan` — that's how the red "Round failed"
    // chip in DirectorChatPanel gets populated.
    const state = makeSeededState();
    const revalidated = [
      invalidCandidate("trip-planner-1", 1),
      invalidCandidate("trip-planner-2", 2),
      invalidCandidate("trip-planner-3", 3),
    ];

    const decision = computeRoundCommit({
      stateAfterRound: state,
      revalidated,
      newOrder: makeOrder(),
      roundId: 7,
      now: 1000,
    });

    expect(decision.kind).toBe("infeasible");
    if (decision.kind !== "infeasible") return;
    expect(decision.errorDetail).toContain("trip-planner-1");
    expect(decision.errorDetail).toContain("trip-planner-3");
    // Each planner contributed at least one error string.
    expect(decision.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("returns 'infeasible' with 'no plan' sentinel when a candidate has no error list", () => {
    const state = makeSeededState();
    const revalidated = [
      {
        plannerName: "trip-planner-1",
        seed: 1,
        plan: { trips: [], unassignedPalletIds: [] },
        valid: false,
        submittedAt: 0,
      } satisfies PlannerCandidate,
    ];

    const decision = computeRoundCommit({
      stateAfterRound: state,
      revalidated,
      newOrder: makeOrder(),
      roundId: 1,
      now: 0,
    });

    expect(decision.kind).toBe("infeasible");
    if (decision.kind !== "infeasible") return;
    expect(decision.errorDetail).toContain("no plan");
  });

  it("commits the seeded baseline plan and emits a RoundResult", () => {
    // Using the seeded baseline plan as the "winner" — it's by construction
    // feasible, so `tryApplyPlan` should succeed and `computeRoundCommit`
    // should return a fully-formed RoundResult for the UI timeline.
    const state = makeSeededState();
    const baselinePlan = state.currentPlan;

    const winner: PlannerCandidate = {
      plannerName: "trip-planner-2",
      seed: 42,
      plan: baselinePlan,
      valid: true,
      cost: computePlanCost(baselinePlan, state.pallets),
      submittedAt: 0,
    };
    const revalidated = [
      invalidCandidate("trip-planner-1", 1),
      winner,
      invalidCandidate("trip-planner-3", 3),
    ];

    const decision = computeRoundCommit({
      stateAfterRound: state,
      revalidated,
      newOrder: makeOrder(),
      roundId: 12,
      now: 9_876_543_210,
    });

    expect(decision.kind).toBe("committed");
    if (decision.kind !== "committed") return;

    expect(decision.winner.plannerName).toBe("trip-planner-2");
    expect(decision.roundResult).toMatchObject({
      roundId: 12,
      orderId: "O-TEST-1",
      winnerPlanner: "trip-planner-2",
      winnerSeed: 42,
      committedAt: 9_876_543_210,
      tripCount: baselinePlan.trips.length,
    });
    // Cost math: priorCost and cost agree because we're "committing" the
    // existing plan — delta is zero.
    expect(decision.roundResult.cost).toBe(decision.roundResult.priorCost);
    expect(decision.summary).toContain("trip-planner-2");
    expect(decision.summary).toContain("+€0 vs prior");
    // Applied state should still carry priors (recentRounds untouched here —
    // the director is responsible for appending roundResult).
    expect(decision.appliedState.recentRounds).toEqual(state.recentRounds);
  });
});

describe("computeSessionTrends", () => {
  function stateWithRounds(rounds: RoundResult[]): DispatchState {
    const base = seedInitialDispatchState("trends-test", { fleetSize: 10 });
    return { ...base, recentRounds: rounds };
  }

  function round(
    roundId: number,
    winner: string,
    cost: number,
    priorCost: number,
  ): RoundResult {
    return {
      roundId,
      orderId: `O-${roundId}`,
      winnerPlanner: winner,
      winnerSeed: Number(winner.match(/(\d+)$/)?.[1] ?? 0),
      cost,
      priorCost,
      committedAt: 1_000_000 + roundId,
      tripCount: 6,
    };
  }

  it("returns zero-populated trends on an empty session", () => {
    const state = stateWithRounds([]);
    const trends = computeSessionTrends(state);

    expect(trends.totalRounds).toBe(0);
    expect(trends.plannerWins).toEqual([]);
    expect(trends.costTrend).toEqual({
      first: 0,
      last: 0,
      delta: 0,
      direction: "flat",
    });
    expect(trends.avgDeltaPerRound).toBe(0);
    // Busiest lanes populate from seeded pallets even without committed rounds.
    expect(trends.busiestLanes.length).toBeGreaterThan(0);
    expect(trends.currentPlanStats.trips).toBeGreaterThan(0);
    expect(trends.currentPlanStats.cost).toBeGreaterThan(0);
  });

  it("summarizes a single committed round", () => {
    const state = stateWithRounds([round(1, "planner-2", 500, 450)]);
    const trends = computeSessionTrends(state);

    expect(trends.totalRounds).toBe(1);
    expect(trends.plannerWins).toEqual([
      { planner: "planner-2", wins: 1, pctOfRounds: 1 },
    ]);
    expect(trends.costTrend).toEqual({
      first: 500,
      last: 500,
      delta: 0,
      direction: "flat",
    });
    expect(trends.avgDeltaPerRound).toBe(50);
  });

  it("aggregates multi-round stats with mixed winners and descending cost", () => {
    const state = stateWithRounds([
      round(1, "planner-1", 500, 450),
      round(2, "planner-3", 480, 500),
      round(3, "planner-1", 430, 480),
      round(4, "planner-2", 410, 430),
    ]);
    const trends = computeSessionTrends(state);

    expect(trends.totalRounds).toBe(4);
    // Sorted by wins desc, then name asc.
    expect(trends.plannerWins).toEqual([
      { planner: "planner-1", wins: 2, pctOfRounds: 0.5 },
      { planner: "planner-2", wins: 1, pctOfRounds: 0.25 },
      { planner: "planner-3", wins: 1, pctOfRounds: 0.25 },
    ]);
    // first round cost = 500, last round cost = 410 → delta -90, direction down.
    expect(trends.costTrend.first).toBe(500);
    expect(trends.costTrend.last).toBe(410);
    expect(trends.costTrend.delta).toBe(-90);
    expect(trends.costTrend.direction).toBe("down");
    // Mean of (500-450, 480-500, 430-480, 410-430) = (50 - 20 - 50 - 20) / 4 = -10.
    expect(trends.avgDeltaPerRound).toBe(-10);
  });

  it("marks cost trend as 'up' when the session is drifting more expensive", () => {
    const state = stateWithRounds([
      round(1, "planner-1", 400, 380),
      round(2, "planner-1", 460, 420),
    ]);
    const trends = computeSessionTrends(state);

    expect(trends.costTrend.direction).toBe("up");
    expect(trends.costTrend.delta).toBe(60);
  });

  it("reports busiest lanes from the pallet book", () => {
    const state = stateWithRounds([]);
    const trends = computeSessionTrends(state);

    // Most common lane in the seeded book should appear first and counts
    // should be monotonically non-increasing.
    for (let i = 1; i < trends.busiestLanes.length; i++) {
      expect(trends.busiestLanes[i - 1].count).toBeGreaterThanOrEqual(
        trends.busiestLanes[i].count,
      );
    }
    // Cap at 3 entries.
    expect(trends.busiestLanes.length).toBeLessThanOrEqual(3);
  });
});

describe("input schemas", () => {
  it("palletSchema rejects pickup === dropoff", () => {
    const bad = palletSchema.safeParse({
      id: "P-1",
      orderId: "O-1",
      pickup: "LIS",
      dropoff: "LIS",
    });
    expect(bad.success).toBe(false);
  });

  it("palletSchema accepts pickup !== dropoff", () => {
    const good = palletSchema.safeParse({
      id: "P-1",
      orderId: "O-1",
      pickup: "LIS",
      dropoff: "OPO",
    });
    expect(good.success).toBe(true);
  });

  it("submitOrderInputSchema rejects pickup === dropoff", () => {
    const bad = submitOrderInputSchema.safeParse({
      orderId: "O-1",
      pickup: "LIS",
      dropoff: "LIS",
      pallets: 2,
    });
    expect(bad.success).toBe(false);
  });
});
