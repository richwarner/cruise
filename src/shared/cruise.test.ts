import { describe, expect, it } from "vitest";

import {
  buildFleet,
  buildInitialPallets,
  buildInitialPlan,
  computePlanCost,
  EARLIEST_START_MINUTES,
  MAX_DRIVING_HOURS,
  ratePerPallet,
  seedInitialDispatchState,
  simulateTrip,
  travelHours,
  TRUCK_CAPACITY,
  validatePlan,
} from "./cruise";
import type { Pallet, Plan, Trip, Truck } from "./types";

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

  it("produces a feasible initial plan covering all 30 pallets", () => {
    const result = validatePlan(state.currentPlan, state.fleet, state.pallets);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.view.trucksUsed).toBeGreaterThan(0);
    expect(result.view.trucksUsed).toBeLessThanOrEqual(state.fleet.length);
    expect(state.pallets).toHaveLength(30);
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
