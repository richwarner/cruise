export const CITY_IDS = ["LIS", "OPO", "COI", "BRA", "FAO"] as const;
export type CityId = (typeof CITY_IDS)[number];

export type Truck = {
  id: string;
  sizeMeters: 13.5;
  capacity: 30;
  startCity: CityId;
};

export type Pallet = {
  id: string;
  orderId: string;
  pickup: CityId;
  dropoff: CityId;
};

export type TripStop = {
  city: CityId;
  pickupPalletIds: string[];
  dropoffPalletIds: string[];
};

export type Trip = {
  id: string;
  truckId: string;
  /** Planner-chosen start time (minutes after midnight). Must be >= 360 (06:00). */
  startMinutes: number;
  stops: TripStop[];
  palletIds: string[];
};

export type Plan = {
  trips: Trip[];
  unassignedPalletIds: string[];
};

export type PlannerCandidate = {
  plannerName: string;
  seed: number;
  plan: Plan;
  valid: boolean;
  cost?: number;
  errors?: string[];
  submittedAt: number;
};

export type OrderEvent = {
  orderId: string;
  createdAt: number;
  pallets: Pallet[];
  summary: string;
};

export type DirectorAction = {
  id: string;
  at: number;
  label: string;
  detail?: string;
};

export type RuntimeEvent = {
  id: string;
  at: number;
  label: string;
  detail?: string;
};

/**
 * One committed round of planner competition. Appended to
 * `DispatchState.recentRounds` after `tryApplyPlan` succeeds, so the UI can
 * show a session-long cost trend (and so operators can eyeball whether the
 * LLM planners are actually improving the plan over time).
 */
export type RoundResult = {
  roundId: number;
  orderId: string;
  winnerPlanner: string;
  winnerSeed: number;
  /** Plan cost after commit. */
  cost: number;
  /** Plan cost before this round committed (used for delta chips). */
  priorCost: number;
  committedAt: number;
  tripCount: number;
};

export type DispatchState = {
  systemId: string;
  plannerAgentNames: string[];
  fleetSize: number;
  fleet: Truck[];
  pallets: Pallet[];
  /** Tomorrow's working plan. Replaced (not "committed") when planners win. */
  currentPlan: Plan;
  pendingOrder?: OrderEvent;
  lastRound: PlannerCandidate[];
  /** Committed rounds, newest last. Capped to the last ~10 for UI + storage. */
  recentRounds: RoundResult[];
  recentDirectorActions: DirectorAction[];
  directorThinking: boolean;
};

export type PlannerState = {
  plannerId: string;
  systemId?: string;
  snapshot?: DispatchState;
  newOrder?: OrderEvent;
  lastCandidate?: PlannerCandidate;
  lastPromptAt?: number;
  plannerThinking: boolean;
  runtimeEvents: RuntimeEvent[];
};

export type TripLeg = {
  from: CityId;
  to: CityId;
  hours: number;
};

export type TripTimeline = {
  tripId: string;
  truckId: string;
  legs: TripLeg[];
  drivingHours: number;
  serviceHours: number;
  startMinutes: number;
  endMinutes: number;
  loadAfterStop: number[];
  /** Last dropoff city. Display only — no rollover in this prototype. */
  endCity: CityId;
};

export type PlanView = Plan & {
  timelines: TripTimeline[];
  totalCost: number;
  totalDrivingHours: number;
  trucksUsed: number;
};

export type ValidatePlanResult =
  | { ok: true; view: PlanView }
  | { ok: false; errors: string[] };

export type TryApplyPlanResult =
  | { ok: true; state: DispatchState; view: PlanView }
  | { ok: false; errors: string[] };
