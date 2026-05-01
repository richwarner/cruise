import { describe, expect, it } from "vitest";

import {
  buildFleet,
  buildInitialPallets,
  buildInitialPlan,
  computePlanCost,
  computeRoundCommit,
  EARLIEST_START_MINUTES,
  MAX_DRIVING_HOURS,
  pickCheapestFeasible,
  ratePerPallet,
  seedInitialDispatchState,
  simulateTrip,
  travelHours,
  TRUCK_CAPACITY,
  validatePlan,
} from "./cruise";
import type {
  OrderEvent,
  Pallet,
  Plan,
  PlannerCandidate,
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

describe("ratePerPallet", () => {
  it("matches worked examples from PLAN.md", () => {
    expect(ratePerPallet("LIS", "OPO")).toBe(22);
    expect(ratePerPallet("OPO", "BRA")).toBe(9);
  });

  it("returns 0 for same-city", () => {
    expect(ratePerPallet("LIS", "LIS")).toBe(0);
  });
});

describe("buildFleet", () => {
  it("produces 10 trucks in canonical order by default", () => {
    const fleet = buildFleet(10);
    expect(fleet).toHaveLength(10);
    expect(fleet.map((t) => t.startCity)).toEqual([
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
    ]);
  });

  it("takes the first N entries when fleetSize < 10", () => {
    const fleet = buildFleet(3);
    expect(fleet).toHaveLength(3);
    expect(fleet.map((t) => t.startCity)).toEqual(["LIS", "LIS", "OPO"]);
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
  it("sums rates for every pallet on every trip", () => {
    const fleet = buildFleet(10);
    const pallets = buildInitialPallets();
    const plan = buildInitialPlan(fleet, pallets);
    const byId = new Map(pallets.map((p) => [p.id, p]));
    let expected = 0;
    for (const t of plan.trips) {
      for (const pid of t.palletIds) {
        const pallet = byId.get(pid)!;
        expected += ratePerPallet(pallet.pickup, pallet.dropoff);
      }
    }
    expect(computePlanCost(plan, pallets)).toBe(expected);
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
    // Same cost → lower seed wins → seed=1
    expect(winner?.seed).toBe(1);
    expect(winner?.plannerName).toBe("p-C");
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
