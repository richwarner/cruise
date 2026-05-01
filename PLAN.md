# Cruise — Implementation Plan

Prototype tool that plans tomorrow's shipments for a small refrigerated trucking fleet. A human dispatcher chats with an AI Director; when a new order arrives, the Director spawns three Planner workers in parallel, each re-plans tomorrow's trips to absorb the new order, and the Director validates each plan, discards infeasible ones, and commits the lowest-cost survivor.

Mirrors the stack and "Director Mode" structure of [deloreyj/chess-agent](https://github.com/deloreyj/chess-agent) 1:1, with chess swapped for logistics.

> Scope note: **Compressor/temperature tier matching is out of scope.** Trucks and pallets carry no temperature attributes. The plan covers tomorrow's shipments only — there is no end-of-day commit/rollover. Constraints in scope: per-leg capacity (30 pallets), 9h driving cap, 30-min service time per pickup/dropoff stop, 18:00 deadline, 06:00 earliest start, one trip per truck per day. Each truck's start time is planner-chosen (≥ 06:00).

---

## 1. Reference repo analysis (chess-agent)

The reference lives at [deloreyj/chess-agent](https://github.com/deloreyj/chess-agent). Key patterns Cruise mirrors:

### Tech stack (from [package.json](.chess-agent-ref/package.json))

- Runtime: Cloudflare Workers (`wrangler 4.86`, `compatibility_date: 2026-04-28`, `nodejs_compat`).
- Agents: `agents 0.11.6` + `@cloudflare/think 0.4.1` (Think base class handles chat, tool calls, streaming, state broadcast).
- Storage: Durable Objects with SQLite-backed Think persistence (see migration `v1` in [wrangler.jsonc](.chess-agent-ref/wrangler.jsonc)).
- Model: Workers AI via `workers-ai-provider 3.1.12`, model `@cf/moonshotai/kimi-k2.5` (`chessAgentCore.ts:10`).
- Server: `hono 4.12.15` for `/api/health`; `routeAgentRequest` handles `/agents/*`.
- Client: React 19 + Vite 8 + Cloudflare Vite plugin + `agents/vite` for decorator support ([vite.config.ts](.chess-agent-ref/vite.config.ts)).
- UI kit: `@cloudflare/kumo` (granular imports) + `@cloudflare/ai-chat/react` (`useAgentChat`) + `@phosphor-icons/react`.
- Validation: `zod 4.3.6`.
- Tests: `vitest 4.1.5` (Node runtime, see [vitest.config.ts](.chess-agent-ref/vitest.config.ts)).

### Director Mode spawning and coordination

The reference `SystemDirectorAgent` (`src/agents/SystemDirectorAgent.ts`) shows the shape but only spawns **one** sub-agent sequentially:

- `getPlayer()` uses `this.subAgent(SystemPlayerAgent, playerAgentName)` (`SystemDirectorAgent.ts:195-197`).
- The director calls `player.applyUserMove()` / `player.takeAgentTurnIfNeeded()` as typed RPC stubs (`SystemDirectorAgent.ts:92-101`).
- The director mirrors player state into its own state via `mirrorPlayerState()` (`src/shared/system.ts:69-81`) so the UI can render both with one subscription.
- Action log: `withAction()` + `recordDirectorAction()` (`SystemDirectorAgent.ts:226-240`, `401-404`) push `DirectorAction` entries capped at `MAX_DIRECTOR_ACTIONS = 40`.
- Server-initiated LLM turn hides its synthetic user message by prefixing the id with `INTERNAL_TURN_MESSAGE_ID_PREFIX` (`src/shared/messages.ts:1-5`), filtered client-side in `AgentPanel.tsx:194-196`.

Cruise's new pattern: **three sub-agents in parallel** via the same `subAgent()` primitive, then `await Promise.all(stubs.map((s) => s.proposePlan(...)))`. Not in the reference, but composes cleanly on top of it.

### Control Room UI structure

- Route file: `src/client/routes/SystemRoute.tsx`.
- Two-column layout inside `.game-layout.system-layout`: left panel toggles between `Board` and `SystemControlRoom` via a gear icon (`SystemRoute.tsx:76-106`); right panel is an `AgentPanel` that toggles chat target.
- `SystemControlRoom` renders sections for Persona, Theme, Strategy Memory, Player Trends, and `recentDirectorActions` as a time-stamped `<ol>` (`SystemRoute.tsx:165-234`).

### Director / Player toggle and chat wiring

- Local state: `const [chatTarget, setChatTarget] = useState<ChatTarget>("director")` (`SystemRoute.tsx:23`).
- Conditional `AgentPanel` mount with distinct `key` so each re-mounts with its own `useAgentChat` history (`SystemRoute.tsx:108-133`).
- Hook `useChessSystem` (`src/client/hooks/useChessSystem.ts`) owns one `useAgent` for the director AND a second `useAgent` subscription to the sub-agent using the `sub: [{ agent, name }]` option (`useChessSystem.ts:49-58`). This is the pattern Cruise extends to **three** planner sub-subscriptions.

### Where the chess rules live

- `src/shared/chess.ts` — pure module wrapping `chess.js`: `createInitialGameState`, `createGameView`, `tryApplyMove`, `getLegalMoves`, `createAgentTurnPrompt`. No DO dependencies.
- Invariant from `AGENTS.md:17-23` and `PLAN.md:127-133`: *"The LLM suggests. chess.js decides."* Every tool call validates through `chess.js` before `setState`.
- `AGENTS.md:31`: **"No deterministic fallback move. If the agent cannot produce a valid move after retries, return a clear error."** Cruise inherits this: no fallback plan; Director reports failure to chat.

This module is the direct analogue of the `cruise.ts` rules module in Section 4.

---

## 2. Tech stack & repo layout

Stack is identical to chess-agent (pin the same versions in `package.json`). Only the domain modules, agent classes, route, and hook change.

```txt
cruise/
├── AGENTS.md                       # adapted from chess-agent AGENTS.md
├── PLAN.md                         # this document
├── README.md
├── index.html
├── package.json                    # same deps as chess-agent package.json
├── tsconfig.json
├── vite.config.ts                  # plugins: agents(), react(), cloudflare()
├── vitest.config.ts
├── worker-configuration.d.ts       # generated via `wrangler types`
├── wrangler.jsonc                  # DO bindings + v1 SQLite migration + AI binding
└── src/
    ├── client/
    │   ├── App.tsx                 # routes /, /cruise
    │   ├── main.tsx
    │   ├── styles.css
    │   ├── components/
    │   │   ├── AgentPanel.tsx      # lifted unchanged from chess-agent
    │   │   ├── MessageParts.tsx    # lifted unchanged
    │   │   ├── CityMap.tsx         # NEW: 5-city SVG map + truck/trip overlays
    │   │   ├── OperationsBoard.tsx # NEW: the "board" — cities, trucks, trips
    │   │   ├── DispatchControlRoom.tsx  # NEW: rates, fleet, action log, last round
    │   │   ├── PlannerCandidateCard.tsx # NEW: per-planner summary card
    │   │   └── DispatchControls.tsx     # NEW: systemId input, reset, fleet size selector, "Generate sample order" button
    │   ├── hooks/
    │   │   └── useDispatchSystem.ts     # NEW: Director + 3 Planner subscriptions
    │   └── routes/
    │       ├── LandingRoute.tsx
    │       ├── CruiseRoute.tsx     # NEW: panelView + chatTarget toggles
    │       └── RouteNav.tsx
    ├── server/
    │   └── index.ts                # re-export DispatchDirectorAgent, TripPlannerAgent
    ├── agents/
    │   ├── cruiseAgentCore.ts      # createCruiseModel(env, seed) factory
    │   ├── DispatchDirectorAgent.ts
    │   └── TripPlannerAgent.ts
    └── shared/
        ├── cruise.ts               # pure rules + cost + seeders + prompt builders
        ├── cruise.test.ts          # Vitest, covers validation + cost + seed
        ├── dispatch.ts             # createInitialDispatchState, helpers (system.ts analogue)
        ├── messages.ts             # INTERNAL_TURN_MESSAGE_ID_PREFIX re-used
        ├── schemas.ts              # Zod for tool inputs and RPC payloads
        └── types.ts                # all domain types
```

`wrangler.jsonc` mirrors [chess-agent's wrangler.jsonc](.chess-agent-ref/wrangler.jsonc):

- `name`: `cruise`.
- `durable_objects.bindings`: `DispatchDirectorAgent`, `TripPlannerAgent`.
- `migrations[].new_sqlite_classes`: same two names under `tag: "v1"`.
- `ai.binding`: `AI`.
- `assets.run_worker_first`: `["/api/*", "/agents/*"]`.
- `assets.not_found_handling`: `"single-page-application"`.

---

## 3. Data model & types

All shapes live in `src/shared/types.ts`; Zod mirrors in `src/shared/schemas.ts`. No temperature/compressor attributes — out of scope for this prototype.

```ts
export type CityId = "LIS" | "OPO" | "COI" | "BRA" | "FAO";

export type Truck = {
  id: string;
  sizeMeters: 13.5;
  capacity: 30;                 // euro pallets
  startCity: CityId;            // anticipated start-of-day location
};

export type Pallet = {
  id: string;
  orderId: string;
  pickup: CityId;
  dropoff: CityId;
};
```

```ts
export type StopKind = "pickup" | "dropoff";
export type TripStop = {
  city: CityId;
  pickupPalletIds: string[];    // pallets boarded at this stop
  dropoffPalletIds: string[];   // pallets unloaded at this stop
};

export type Trip = {
  id: string;
  truckId: string;
  startMinutes: number;         // planner-chosen start time, minutes after midnight; must be >= 360 (06:00)
  stops: TripStop[];            // first stop city must equal truck.startCity
  palletIds: string[];          // convenience: union of all stop pickups
};
```

```ts
export type Plan = {
  trips: Trip[];
  unassignedPalletIds: string[]; // must be empty for feasible plan
};

export type PlannerCandidate = {
  plannerName: string;          // e.g. `${systemId}-planner-1`
  seed: number;                 // 1..3
  plan: Plan;
  valid: boolean;
  cost?: number;                // only if valid
  errors?: string[];            // only if invalid
  submittedAt: number;
};
```

```ts
export type OrderEvent = {
  orderId: string;
  createdAt: number;
  pallets: Pallet[];            // already assigned pallet ids
  summary: string;              // one-line for action log / chat
};

export type DirectorAction = {
  id: string;
  at: number;
  label: string;
  detail?: string;
};

export type DispatchState = {
  systemId: string;
  plannerAgentNames: string[];  // 3 stable names
  fleetSize: number;            // configurable from UI; default 10
  fleet: Truck[];
  pallets: Pallet[];            // full order book for tomorrow
  currentPlan: Plan;            // tomorrow's working plan; replaced (not "committed") when planners win
  pendingOrder?: OrderEvent;    // transient: set between addOrder and askPlanners; cleared after the round
  lastRound: PlannerCandidate[]; // last 3 results, kept for UI
  recentDirectorActions: DirectorAction[];
  directorThinking: boolean;
};

export type PlannerState = {
  plannerId: string;            // matches Agent `name`
  lastCandidate?: PlannerCandidate;
  lastPromptAt?: number;
  plannerThinking: boolean;
};
```

### Derived view types (computed, not persisted)

```ts
export type TripTimeline = {
  tripId: string;
  legs: { from: CityId; to: CityId; hours: number }[];
  drivingHours: number;          // sum of leg hours
  serviceHours: number;          // 0.5 × stops.length
  startMinutes: number;          // minutes after midnight, >= 06:00 (planner-chosen, taken from trip.startMinutes)
  endMinutes: number;            // must be <= 18:00
  loadAfterStop: number[];       // pallet count after each stop, each ≤ 30
  endCity: CityId;               // last dropoff city; display only (no rollover in v1)
};

export type PlanView = Plan & {
  timelines: TripTimeline[];
  totalCost: number;
  totalDrivingHours: number;
  trucksUsed: number;
};
```

---

## 4. `cruise.ts` rules module

Pure functions only. No DO imports. Analogue of [chess.ts](.chess-agent-ref/src/shared/chess.ts). Signatures:

```ts
// --- Geometry & rates ---
travelHours(from: CityId, to: CityId): number;           // lookup in TRAVEL_TIME_MATRIX
ratePerPallet(from: CityId, to: CityId): number;         // € per pallet, v1 ignores compressor
legCost(from: CityId, to: CityId, palletCount: number): number;

// --- Trip simulation ---
simulateTrip(trip: Trip, fleet: Truck[]): TripTimeline;
computeTripCost(trip: Trip, pallets: Pallet[]): number;
computePlanCost(plan: Plan, pallets: Pallet[]): number;

// --- Validation ---
validatePlan(
  plan: Plan,
  fleet: Truck[],
  pallets: Pallet[],
): { ok: true; view: PlanView } | { ok: false; errors: string[] };

// --- Orchestration helpers ---
tryApplyPlan(
  state: DispatchState,
  plan: Plan,
): { ok: true; state: DispatchState } | { ok: false; errors: string[] };

// --- Seed & prompts ---
seedInitialDispatchState(systemId: string): DispatchState;
buildPlannerPrompt(snapshot: DispatchState, newOrder: OrderEvent, seed: number): string;
buildDirectorPrompt(state: DispatchState): string;
```

### Constraint checks implemented by `validatePlan`

Each returns an error string on failure; all errors are collected before returning so the Director can show every reason.

- **Coverage**: every pallet id in `pallets` appears on exactly one trip; `plan.unassignedPalletIds` must be empty. (Brief: "All orders must be fulfilled… no 'defer to next day' option.")
- **One trip per truck per day**: each `truckId` appears on at most one trip in `plan.trips`. (Resolved decision; previously implied, now enforced explicitly.)
- **Origin**: `trip.stops[0].city === fleet[truckId].startCity`.
- **Stop integrity**: for each pallet, its pickup stop precedes its dropoff stop in the trip; pickup stop city equals `pallet.pickup`; dropoff stop city equals `pallet.dropoff`.
- **Per-leg capacity**: `simulateTrip` produces `loadAfterStop[]`; each entry must be ≤ 30. (Brief: "at no point on a trip may the truck hold more than 30 pallets simultaneously.")
- **Driving-time cap**: `timeline.drivingHours ≤ 9`.
- **Delivery deadline**: `trip.startMinutes` is provided by the plan; validator enforces `360 ≤ trip.startMinutes` (06:00) and `timeline.endMinutes ≤ 1080` (18:00). Each truck's start time is planner-chosen.
- **Service time**: `serviceHours = 0.5 × stops.length`, counted in `endMinutes` but not against the 9h driving cap. No additional service time at the depot/start.

### `tryApplyPlan` behavior

On success: returns a new `DispatchState` with `currentPlan = plan` and `pendingOrder = undefined`. **No `startCity` rollover** — this prototype plans tomorrow only and never advances the day, so each truck's `startCity` remains as seeded.

### Tests in `cruise.test.ts`

- `validatePlan` accepts the seeded feasible plan.
- Rejects a plan that leaves a pallet unassigned.
- Rejects over-capacity leg (31 pallets mid-trip).
- Rejects trip starting at a city the truck is not at.
- Rejects dropoff before pickup for the same pallet.
- Rejects >9h driving.
- Rejects arrival after 18:00.
- Rejects a trip with `startMinutes < 360` (before 06:00).
- Rejects a plan that places the same `truckId` on two trips (one trip per truck per day).
- `computePlanCost` matches hand-computed sum for the seeded plan.

---

## 5. Seed data

All seeds live in `cruise.ts` as exported `const` values so tests and the UI can read them without running `seed.ts`. A `scripts/seed.ts` file can regenerate the order book with a different RNG, but is optional.

### 5.1 Cities

Five Portuguese cities: `LIS` Lisboa, `OPO` Porto, `COI` Coimbra, `BRA` Braga, `FAO` Faro.

### 5.2 Travel-time matrix (hours, symmetric, rounded to 0.25h)

Realistic truck travel times by highway. Stored as `TRAVEL_TIME_MATRIX: Record<CityId, Record<CityId, number>>`.

- LIS ↔ OPO: 3.00
- LIS ↔ COI: 2.00
- LIS ↔ BRA: 3.75
- LIS ↔ FAO: 2.75
- OPO ↔ COI: 1.25
- OPO ↔ BRA: 0.75
- OPO ↔ FAO: 5.75
- COI ↔ BRA: 1.75
- COI ↔ FAO: 4.75
- BRA ↔ FAO: 6.50
- Same city: 0.00

Sanity: a round trip OPO→LIS→OPO is 6.00h driving, under the 9h cap. OPO→FAO one-way is 5.75h, so an OPO-start truck can do OPO→FAO→LIS only if total ≤ 9h driving: 5.75 + 2.75 = 8.50h — feasible. OPO→FAO→OPO is 11.5h — infeasible, validator must reject.

### 5.3 Rate card

`€/pallet` depends on route only. Proposed formula, encoded as a flat lookup `RATE_PER_PALLET: Record<CityId, Record<CityId, number>>`:

```txt
ratePerPallet(from, to) = round(travelHours(from, to) * 6 + 4)
```

Worked examples:
- LIS→OPO (3.00h): `round(3.00 * 6 + 4) = 22 €/pallet`
- OPO→BRA (0.75h): `round(0.75 * 6 + 4) = 9 €/pallet`
- LIS→FAO (2.75h): `round(2.75 * 6 + 4) = 21 €/pallet` (stored as `20` or `21`, fix at seed time)

### 5.4 Initial fleet (configurable; default 10 trucks, 2 per city)

Distribution balanced across cities. Default 10 trucks:

- `T01` LIS
- `T02` LIS
- `T03` OPO
- `T04` OPO
- `T05` COI
- `T06` COI
- `T07` BRA
- `T08` BRA
- `T09` FAO
- `T10` FAO

All have `sizeMeters: 13.5`, `capacity: 30`.

`seedInitialDispatchState(systemId, opts?: { fleetSize?: number })` parameterizes the fleet size. When `fleetSize < 10`, take the first N entries of the canonical list above (so `fleetSize: 3` yields `T01, T02, T03` — useful for forcing infeasibility demos). When `fleetSize > 10`, round-robin add extra trucks across cities (`T11` LIS, `T12` OPO, …). The UI's fleet-size selector calls `resizeFleet(n)` on the Director, which re-seeds dispatch with the new size.

### 5.5 Initial order book

**Volume target**: 30 pallets spread across 12 orders, mixing short and long routes so planning is non-trivial but a feasible plan exists using ~5–6 of the 10 trucks. Exact pallet ids and quantities belong in `cruise.ts` as a `const INITIAL_PALLETS: Pallet[]`. Sketch (actual pallet-per-order counts chosen so total = 30):

- `O-1` LIS→OPO ×4
- `O-2` OPO→LIS ×3
- `O-3` LIS→COI ×2
- `O-4` COI→LIS ×2
- `O-5` OPO→BRA ×3
- `O-6` BRA→OPO ×2
- `O-7` LIS→FAO ×3
- `O-8` FAO→LIS ×2
- `O-9` COI→BRA ×2
- `O-10` BRA→COI ×2
- `O-11` OPO→COI ×3
- `O-12` COI→OPO ×2

### 5.6 Initial feasible plan

`seedInitialDispatchState()` runs a tiny deterministic greedy (city-by-city, largest-order-first, single trip per truck, respecting capacity and the 9h cap) to produce `currentPlan`. Each generated trip gets `startMinutes: 360` (06:00) by default; the planner LLM may pick later starts in subsequent rounds. The plan is then fed back through `validatePlan` at module init; if validation fails, the module throws so the dev notices at boot rather than at first chat turn. The `cruise.test.ts` suite asserts the seeded plan is valid and caches its cost.

---

## 6. Agents

Two Durable Object classes, both extending `Think<Env, State>` for chat, streaming, tool execution, and state broadcasts. Both use the shared model factory.

### 6.1 Model factory — `src/agents/cruiseAgentCore.ts`

Analogous to [chessAgentCore.ts](.chess-agent-ref/src/agents/chessAgentCore.ts):

```ts
export const CRUISE_MODEL_ID = "@cf/moonshotai/kimi-k2.5";

export function createCruiseModel(env: Env, seed?: string | number) {
  const workersAi = createWorkersAI({ binding: env.AI });
  return workersAi(CRUISE_MODEL_ID, {
    reasoning_effort: "low",
    ...(seed ? { sessionAffinity: String(seed) } : {}),
  });
}
```

The Director passes `this.sessionAffinity`; each Planner passes its numeric `seed` (1..3) so the three requests land on independent model sessions and diverge.

### 6.2 `TripPlannerAgent` — `src/agents/TripPlannerAgent.ts`

`extends Think<Env, PlannerState>`. One instance per planner slot. Stable names are allocated by the Director as `${systemId}-planner-${i}` for i in 1..3.

**@callable RPC (invoked by Director):**

- `proposePlan({ seed, snapshot, newOrder }): Promise<PlannerCandidate>` — resets the planner's prior candidate, stores `snapshot` and `newOrder` on `PlannerState`, runs one Think turn (model created with `createCruiseModel(env, seed)` so `sessionAffinity` differs across the three planners) with the identical prompt from `buildPlannerPrompt(snapshot, newOrder)`, and returns the candidate produced by the `submitPlan` tool. If no `submitPlan` was called, returns `{ valid: false, errors: ["planner did not submit a plan"] }`. Caller wraps this in a 30-second timeout (Section 6.4).
- `getPlannerState(): PlannerState` — for the UI's sub-subscription.

**Tools the planner's LLM can call:**

- `inspectSnapshot` — read-only; returns a compact JSON of fleet, pallets, `currentPlan`, rates, travel matrix, and the new order.
- `submitPlan({ plan })` — mutating; validates via `cruise.ts.validatePlan`, stores the resulting `PlannerCandidate` on state. If invalid, returns `{ ok: false, errors }` so the LLM can retry within its `maxSteps` budget. If valid, also computes cost.

**System prompt (built by `buildPlannerPrompt(snapshot, newOrder)`):**

All three planners receive an **identical prompt**. Variation between them comes only from the per-planner `sessionAffinity` passed to `createCruiseModel(env, seed)`. The prompt does not mention the seed.

- Role: "You are a fleet planner for tomorrow's refrigerated trucking schedule."
- Rules: all pallets in the order book plus the new order must be delivered tomorrow; per-leg capacity 30; driving time ≤ 9h; one trip per truck per day; each trip starts at its truck's `startCity`; `trip.startMinutes` ≥ 06:00 (360); all deliveries done by 18:00 (1080).
- Single objective: "Minimize total cost as computed by `computePlanCost`."
- Instructs the model to call `inspectSnapshot` at most once, then `submitPlan` exactly once with a full plan covering every pallet id.

**Turn shape:** Director invokes `proposePlan` via RPC stub. The planner writes an internal `INTERNAL_TURN_MESSAGE_ID_PREFIX` message (same pattern as `SystemPlayerAgent.ts:250-258`) so the planner's chat transcript shows the request but the UI's Planner Chat panel hides it.

### 6.3 `DispatchDirectorAgent` — `src/agents/DispatchDirectorAgent.ts`

`extends Think<Env, DispatchState>`. One instance per `systemId`. Initial state from `seedInitialDispatchState(this.name)`.

**@callable RPC (invoked by the React client):**

- `getDispatch(): DispatchState` — simple read.
- `resetDispatch(): DispatchState` — re-seeds, clears chat, clears planner states.
- `resizeFleet(size: number): DispatchState` — re-seeds dispatch with a new fleet size (Section 5.4). Clears `lastRound` and any pending order; `currentPlan` is regenerated by the greedy seeder so the UI immediately shows a feasible state.
- `submitOrder(input): DispatchState` — top-level entry point when the dispatcher uses a structured form. Internally calls `addOrder` then `askPlanners`. Broadcasts state after every step.
- `getPlannerState(name): PlannerState` — passthrough for UI fallback.

**Tools (for the Director's own chat turns):**

- `inspectDispatch` — returns the current `DispatchState`.
- `addOrder({ pallets, summary })` — appends pallets to `state.pallets`, sets `pendingOrder`, logs action. Pure state mutation, no planner spawn.
- `askPlanners({ orderId })` — spawns 3 sub-agents in parallel:

```ts
const names = this.state.plannerAgentNames;
const planners = names.map((n) => this.subAgent(TripPlannerAgent, n));
const snapshot = this.state; // captured after addOrder
const newOrder = this.state.pendingOrder!;
const candidates = await Promise.all(
  planners.map((p, i) =>
    p.proposePlan({ seed: i + 1, snapshot, newOrder }),
  ),
);
```

Then: merge candidates into `lastRound`, run `validatePlan` on each (belt-and-braces — the planner already validated), pick the lowest-cost valid candidate, call `tryApplyPlan`. On success, `setState` with `currentPlan` replaced (no `startCity` rollover), `pendingOrder` cleared, log a `DirectorAction` describing the winning planner and cost delta, and write an assistant chat message. On full failure, log and write an assistant message with aggregated errors — **no fallback plan**, mirroring `AGENTS.md:31`.

**System prompt (built by `buildDirectorPrompt(state)`):**

Text similar to `SystemDirectorAgent.ts:249-270`. Key rules:
- "You are the dispatch director. You do not produce plans yourself; you delegate to three Planner sub-agents and replace tomorrow's plan with the cheapest feasible candidate they return. There is no commit step and no day rollover — this prototype always plans tomorrow."
- When the dispatcher types something like "New order: 6 pallets Porto → Faro", parse it, call `addOrder`, then `askPlanners`, then report the winner (or failure) in chat.
- "If askPlanners reports that no plan is feasible, explain the failure and ask the dispatcher how to proceed. Do not invent a plan."
- Include current fleet summary, pending orders, and last round's outcome in the prompt.

### 6.4 Parallel-spawn contract

The spawn pattern is the one new pattern beyond chess-agent. Documented in code with a comment block. Key properties:

- `this.subAgent(Class, name)` returns a typed RPC stub (from `agents`), same as `getPlayer()` in `SystemDirectorAgent.ts:195-197`.
- Calling `stub.proposePlan(...)` hits the Durable Object over internal RPC; three distinct DOs (different `name`) run concurrently.
- `Promise.all` races them. A hung planner will block the whole round; we wrap each call in a **30-second** `Promise.race` timeout and tag that candidate as `{ valid: false, errors: ["timeout"] }`.
- Planner names are stable per system (`${systemId}-planner-1..3`) so the client's `sub: [{ agent, name }]` subscriptions remain connected across rounds and accumulate history.

### 6.5 State broadcast discipline

Every `DispatchState` mutation on the Director calls `setState` so connected clients re-render. `addOrder`, `askPlanners` (twice: once with `directorThinking: true` at start, once with results at end), `tryApplyPlan`, and `resizeFleet` all emit state. The Planner similarly broadcasts `plannerThinking` on entry to `proposePlan` and its `lastCandidate` on exit, which the client consumes via sub-subscriptions.

### 6.6 Internal-turn message hiding

Cruise reuses `INTERNAL_TURN_MESSAGE_ID_PREFIX` from [messages.ts](.chess-agent-ref/src/shared/messages.ts). The Director uses it when it drives its own LLM turn (for chat-driven order entry); the Planner uses it for every `proposePlan` call.

---

## 7. Control Room UI

Route: `/cruise`. Component tree mirrors [SystemRoute.tsx](.chess-agent-ref/src/client/routes/SystemRoute.tsx).

```txt
CruiseRoute
├── header
│   ├── RouteNav (active="cruise")
│   └── DispatchControls (systemId input, reset, fleet size selector, "Generate sample order" button)
├── LayerCard.board-panel
│   ├── board-panel-header
│   │   ├── DispatchStatus (directorThinking? planner round status?)
│   │   └── panel-toggle (gear icon)  -> panelView: "operations" | "control-room"
│   ├── Banner (on error)
│   └── EITHER OperationsBoard(dispatch) OR DispatchControlRoom(dispatch)
└── EITHER AgentPanel(directorAgent) OR AgentPanel(plannerAgents[i])
       with chatTarget toggle in headerAccessory
```

### 7.1 `OperationsBoard`

The "chess board" analogue — the visual primary view.

Subscribes to: `dispatch.fleet`, `dispatch.currentPlan`, `dispatch.pendingOrder`, `dispatch.pallets`.

Renders:
- `CityMap`: absolute-positioned SVG with 5 city nodes (Lisboa, Porto, Coimbra, Braga, Faro) arranged roughly as in Portugal. Nodes sized to show truck badges for trucks whose `startCity` equals that city.
- Trip overlays: for each trip in `currentPlan`, draw an arrowed polyline through its ordered stops. Clicking a trip selects it; a side subpanel shows `TripDetail` (truck id, pallet manifest, timeline from `simulateTrip`, cost, planner-chosen `startMinutes`).
- Pending-orders pulse: if `pendingOrder` exists, the source city pulses and the order summary appears as a callout.
- Unassigned pallets palette: shown only if `currentPlan.unassignedPalletIds` is non-empty (should always be empty in steady state; shown as a red warning strip if not).

Interaction is read-only; the user cannot drag pallets onto trucks. All mutations go through the chat / order submission path.

### 7.2 `DispatchControlRoom`

Shown when panel toggled to "control-room". Kumo `LayerCard` + `Text` sections:

1. **Fleet summary** — table of `dispatch.fleetSize` trucks with id, startCity, capacity used today (0..30).
2. **Rate card** — 5×5 table of `ratePerPallet` with diagonal struck out.
3. **Travel-time matrix** — 5×5 hours table.
4. **Last planner round** — three `PlannerCandidateCard`s side-by-side:
   - Planner name, seed, winner badge if chosen.
   - Cost (or "infeasible" in red).
   - Trip count, trucks used, total driving hours.
   - Error list for infeasible candidates.
   - Diff vs. previous `currentPlan` (trips added/removed/modified — computed client-side).
5. **Runtime Action Log** — scrollable `<ol>` of `recentDirectorActions` (same shape as `SystemRoute.tsx:215-232`), capped at 40.

### 7.3 `PlannerCandidateCard`

Stateless component; props: `candidate: PlannerCandidate`, `current: Plan`, `isWinner: boolean`. Renders a `LayerCard` with badge, numeric summary, and a collapsible trip list.

### 7.3a `DispatchControls`

Header strip with four controls:

- **systemId input** — text input + "Open" button to switch dispatch sessions.
- **Reset** — calls `resetDispatch()` on the Director.
- **Fleet size selector** — number input (or +/- stepper) bound to `dispatch.fleetSize`. Default 10. On change, calls `resizeFleet(n)` on the Director, which re-seeds dispatch with the new fleet (Section 5.4) and broadcasts state. Useful for forcing infeasibility demos by shrinking to e.g. 3 trucks.
- **Generate sample order** — button that picks a random pre-canned order template (e.g. `"New order O-13: 4 pallets from OPO to FAO, tomorrow."`) and inserts it into the Director chat composer (`AgentPanel`'s textarea) — does **not** auto-send, so the dispatcher can edit before pressing send. Implemented by writing into a shared composer ref / state owned by `CruiseRoute` and passed down to `AgentPanel` as a `prefillText` prop.

The pre-canned templates live in `src/shared/cruise.ts` as `SAMPLE_ORDER_TEMPLATES: string[]` so the same list is reachable from tests if needed.

### 7.4 State subscription — `useDispatchSystem(systemId)`

Analogue of [useChessSystem.ts](.chess-agent-ref/src/client/hooks/useChessSystem.ts). Shape:

```ts
const director = useAgent<DispatchDirectorAgent, DispatchState>({
  agent: "DispatchDirectorAgent",
  name: systemId,
  onStateUpdate: setDispatch,
});

const plannerAgents = [1, 2, 3].map((i) =>
  useAgent<TripPlannerAgent, PlannerState>({
    agent: "DispatchDirectorAgent",
    name: systemId,
    sub: [{ agent: "TripPlannerAgent", name: `${systemId}-planner-${i}` }],
    onStateUpdate: (next) => setPlanner(i, next),
  }),
);
```

Returns `{ director, plannerAgents, dispatch, planners, submitOrder, resetDispatch, resizeFleet, generateSampleOrderText, refreshDispatch, error }`. `generateSampleOrderText()` is a pure client helper that reads `SAMPLE_ORDER_TEMPLATES` from `src/shared/cruise.ts`; `resizeFleet(n)` proxies to the Director RPC.

### 7.5 Kumo imports

Same granular-import discipline as chess-agent: `Button`, `LayerCard`, `Text`, `Banner`, `Textarea` from `@cloudflare/kumo/components/*`. Standalone stylesheet imported in `main.tsx`: `import "@cloudflare/kumo/styles/standalone";`.

---

## 8. Director ↔ Planner toggle and chat

Same two-toggle pattern as chess-agent: a panel-view toggle (gear) and a chat-target toggle.

### 8.1 Panel view toggle

`const [panelView, setPanelView] = useState<"operations" | "control-room">("operations")`. Gear button swaps `OperationsBoard` ↔ `DispatchControlRoom` in the left panel (`CruiseRoute.tsx`). Same shape as `SystemRoute.tsx:76-106`.

### 8.2 Chat-target toggle

Three choices (expanding the chess toggle from 2 to 4, all on one segmented control):

- `director` — chats with `DispatchDirectorAgent`.
- `planner-1` — chats with the seed-1 `TripPlannerAgent`.
- `planner-2`
- `planner-3`

Planner chats are read-mostly: each panel shows the last `proposePlan` turn as a transcript, including the `inspectSnapshot` and `submitPlan` tool calls. The user can still type to a planner for debugging ("why did you split that trip?"), but that is a free-form debug chat, not part of the Director flow.

### 8.3 How chat messages route

- `AgentPanel` is the same component from chess-agent (`AgentPanel.tsx`). The `agent` prop is the agent the panel's `useAgentChat` binds to.
- For `director` target, `agent = director` (the primary `useAgent` result).
- For `planner-N`, `agent = plannerAgents[N-1]` (the sub-subscription result).
- Each panel gets a unique `key` (e.g. `director`, `planner-1-${plannerAgentName}`) so switching targets remounts the chat.

### 8.4 Director-driven chat flow (what makes this "Director Mode")

When the user types `"New order: 6 pallets Porto → Faro"` into Director Chat:

1. `AgentPanel` calls `useAgentChat.sendMessage({ text })` which streams to the Director over its WebSocket.
2. Director receives it as a normal user turn and runs its LLM with the tools described in 6.3.
3. The model calls `addOrder` (parsing pallets/cities from the text), then `askPlanners`.
4. `askPlanners` runs the 3 parallel planners, validates, picks the winner, commits via `tryApplyPlan`, logs actions, and returns `{ winner, committedCost, rejectedPlans }` to the model.
5. The model writes a final assistant message ("Committed planner 2's plan at €312 (−€18 vs prior). Planner 1 was infeasible: driving time >9h on T04.").

### 8.5 Planner chats are debug-only

Planner chats are debug-only. The validation gate inside `submitPlan` is **always on** in every code path: there is no way to persist an invalid plan, whether the user is chatting with the Director or directly with a planner. The brief's "Planner mode" (no validation gate) is explicitly out of scope per the resolved decisions in Section 11.

---

## 9. End-to-end flow walkthrough

Scenario: the committed plan is the seeded one. Dispatcher types into Director Chat:

> "New order O-13: 4 pallets from OPO to FAO, tomorrow."

```mermaid
sequenceDiagram
    participant U as Dispatcher (Director Chat)
    participant D as DispatchDirectorAgent
    participant P1 as Planner-1
    participant P2 as Planner-2
    participant P3 as Planner-3
    participant C as cruise.ts
    participant UI as CruiseRoute (React)

    U->>D: sendMessage("New order O-13: 4 pallets OPO->FAO")
    D->>D: LLM turn, tool call addOrder({ orderId:"O-13", pallets:[4x] })
    D->>D: setState (pendingOrder, +4 pallets, action log)
    D-->>UI: state broadcast
    D->>D: LLM tool call askPlanners({ orderId:"O-13" })
    D->>D: setState (directorThinking: true)
    D->>P1: subAgent(TripPlannerAgent, "...-planner-1").proposePlan(seed=1)
    D->>P2: subAgent(TripPlannerAgent, "...-planner-2").proposePlan(seed=2)
    D->>P3: subAgent(TripPlannerAgent, "...-planner-3").proposePlan(seed=3)
    par planners run in parallel
      P1->>C: validatePlan via submitPlan tool
      P1-->>D: PlannerCandidate { valid:true, cost:312 }
      P2->>C: validatePlan
      P2-->>D: PlannerCandidate { valid:false, errors:["T04 driving>9h"] }
      P3->>C: validatePlan
      P3-->>D: PlannerCandidate { valid:true, cost:298 }
    end
    D->>C: validatePlan(best candidate) again for safety
    D->>C: tryApplyPlan(state, P3.plan)
    D->>D: setState (currentPlan=P3, pendingOrder=undefined, lastRound=[...], action log, directorThinking:false)
    D-->>UI: state broadcast -> OperationsBoard re-renders
    D-->>U: assistant message: "Switched tomorrow's plan to planner 3 at €298 (-€14 vs prior). Planner 2 infeasible: T04 driving >9h."
```

### Functions and components named at each step

1. `AgentPanel` → `useAgentChat.sendMessage` (client).
2. Director Think harness receives text turn → `DispatchDirectorAgent.getTools()` → `addOrder.execute`.
3. `addOrder` → `this.setState({ ...state, pallets:[...], pendingOrder, recentDirectorActions:[...] })`.
4. Next tool call: `askPlanners.execute` → parallel `subAgent(TripPlannerAgent, name).proposePlan(...)`.
5. Each `TripPlannerAgent.proposePlan` → internal Think turn → LLM calls `inspectSnapshot` then `submitPlan`.
6. `submitPlan.execute` → `cruise.validatePlan` → stores `PlannerCandidate` on `PlannerState` → returns to model → RPC response.
7. Back on the Director, `askPlanners` collects 3 candidates, calls `cruise.validatePlan` again defensively, picks lowest `cost` from valid ones.
8. `cruise.tryApplyPlan(state, winner.plan)` → returns `{ ok:true, state:next }` with `currentPlan` replaced. No `startCity` rollover (this prototype always plans tomorrow).
9. `this.setState(next)` broadcasts → client `onStateUpdate` fires in `useDispatchSystem` → `OperationsBoard` re-renders trip overlays → `PlannerCandidateCard`s show the three candidates with the winner badge → `Runtime Action Log` updates.
10. Director's final assistant text is streamed through `useAgentChat` and rendered by `MessageParts` in the Director `AgentPanel`.

### Failure case

If all three candidates are invalid:
- No `tryApplyPlan` call. `currentPlan` is unchanged. `pendingOrder` remains set.
- `setState` still broadcasts `lastRound` (so the UI shows 3 red cards) and adds a `DirectorAction` with the aggregated errors.
- Director writes: "No feasible plan for order O-13. Reasons: Planner 1: driving>9h on T03; Planner 2: capacity breach on T01 leg 2; Planner 3: arrival after 18:00. How do you want to proceed?"
- Per `AGENTS.md:31`, no fallback plan is committed.

---

## 10. Build phases

Ordered, each phase ends in a working checkpoint (`npm run typecheck && npm test && npm run dev` green).

### Phase 1 — Bootstrap + domain rules (no agents, no UI)

Goal: `cruise.ts` is correct and tested.

1. Copy `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `wrangler.jsonc`, `index.html`, `worker-configuration.d.ts`, `AGENTS.md` shell from chess-agent. Update names.
2. Add `src/shared/types.ts`, `src/shared/schemas.ts`, `src/shared/cruise.ts` with all signatures from Section 4 and seed data from Section 5.
3. Implement `travelHours`, `ratePerPallet`, `computeTripCost`, `computePlanCost`, `simulateTrip`, `validatePlan`, `tryApplyPlan`, `seedInitialDispatchState`, and a deterministic greedy seeder.
4. Write `src/shared/cruise.test.ts` covering every bullet in Section 4's test list.
5. `npm run typecheck && npm test` green.

### Phase 2 — Planner agent in single-agent mode

Goal: `/cruise` lets the user chat with one planner directly; the Control Room is read-only.

1. Add `src/agents/cruiseAgentCore.ts`.
2. Add `src/agents/TripPlannerAgent.ts` with `PlannerState`, `proposePlan` RPC, `inspectSnapshot` and `submitPlan` tools, prompt from `buildPlannerPrompt`.
3. Add `src/server/index.ts` re-exporting `TripPlannerAgent` only for now.
4. Wire `wrangler.jsonc` DO binding + migration for `TripPlannerAgent`.
5. Add minimal `CruiseRoute.tsx` that connects via `useAgent<TripPlannerAgent>` and renders a single `AgentPanel`.
6. Manual test via `npm run dev`: chat with the planner, ask it to `proposePlan` for the seeded state; confirm validation errors bubble back to the model.

### Phase 3 — Control Room read-only

Goal: visual parity with the brief's Control Room spec, driven by the seeded state.

1. Add `src/shared/dispatch.ts` with `createInitialDispatchState`.
2. Add `OperationsBoard`, `CityMap`, `DispatchControlRoom`, `PlannerCandidateCard`, `DispatchControls` components.
3. Wire `CruiseRoute.tsx` panel toggle (`operations | control-room`).
4. For this phase, the dispatch state source is a second DO — `DispatchDirectorAgent` stub — that only exposes `getDispatch` and `resetDispatch`; planners are not spawned yet. This lets the UI render the seeded plan, fleet, and empty action log.
5. Add `/cruise` to `App.tsx` and a `RouteNav` entry.

### Phase 4 — Director with parallel workers

Goal: end-to-end new-order flow works.

1. Flesh out `DispatchDirectorAgent` with `addOrder`, `askPlanners` (parallel, 30s timeout per planner), `submitOrder` RPC, `resizeFleet` RPC, `buildDirectorPrompt`.
2. Add 3-planner allocation (`plannerAgentNames`) to `createInitialDispatchState`.
3. Add the action log and `lastRound` updates.
4. Add the **one-trip-per-truck-per-day** validator test alongside the rest of `cruise.test.ts`.
5. Update `useDispatchSystem` with 3 sub-subscriptions; render `PlannerCandidateCard`s with live updates.
6. Manual test: submit an order via a debug button (`DispatchControls.submitTestOrder()`); verify the three candidates appear, the winner is chosen, the board updates, the action log records the round. Test the all-infeasible path by shrinking the fleet to 3 trucks via the fleet-size selector.

### Phase 5 — Director chat + full toggle UX

Goal: full "Director Mode" UX from the brief.

1. Director's own LLM turn: the `addOrder` tool parses order text; the system prompt teaches it the "New order:" format.
2. Chat target toggle with all 4 targets (`director`, `planner-1..3`); planner panels show the last `proposePlan` transcript.
3. Failure messages in chat when all candidates are invalid.
4. Empty-state hints, "Thinking…" indicators, error banners.
5. **Generate Sample Order** button in `DispatchControls` that prefills the Director chat composer from `SAMPLE_ORDER_TEMPLATES`.
6. **Fleet size selector** in `DispatchControls` wired to `resizeFleet(n)`.
7. Polish: Kumo styling pass; timeline preview inside `TripDetail`.

### Phase 6 — Deployment checkpoint

`npm run build && npm run deploy`. Smoke test the production worker URL. Record any Workers AI latency surprises.

---

## 11. Resolved decisions

The original open questions were resolved by the dispatcher before implementation. Recording them here so the rationale is visible to future contributors.

| #   | Question                         | Resolution                                                                                                                                          |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Compressor/temperature follow-up | Out of scope. No `compressorType`/`tempRequirement` in code, types, schemas, prompts, or tests. Phase 7 deleted.                                    |
| 2   | End-of-day rollover              | No commit semantics. The prototype always plans tomorrow; `startCity` never advances. State holds `currentPlan`, not `committedPlan`.               |
| 3   | Earliest trip start              | Per-truck variable. `Trip.startMinutes` is planner-chosen; validator enforces `>= 360` (06:00) and `endMinutes <= 1080` (18:00).                    |
| 4   | Service time at start/end        | None at the depot. 30 minutes per pickup or dropoff stop only.                                                                                      |
| 5   | One trip per truck per day       | Validator enforces it explicitly (Section 4).                                                                                                       |
| 6   | Planner-mode validation          | Validation gate is always on. There is no path that persists an invalid plan, including direct planner chat (Section 8.5).                          |
| 7   | Order entry                      | UI button "Generate sample order" prefills the Director chat composer from `SAMPLE_ORDER_TEMPLATES` (Section 7.3a). User can edit before sending.   |
| 8   | Planner timeout                  | 30 seconds per planner (Section 6.4).                                                                                                               |
| 9   | Seed variation strategy          | All three planners get an identical prompt that optimizes total cost. Variation comes only from per-planner `sessionAffinity` on the model.         |
| 10  | Order-book regeneration          | Deterministic baked-in seed. No UI seed selector.                                                                                                   |
| 11  | Map accuracy                     | Stylized SVG layout of Portugal. No real map tiles, no API keys.                                                                                    |
| 12  | Fleet size                       | Configurable from the UI. `DispatchControls` exposes a fleet-size selector wired to `resizeFleet(n)` on the Director. Default 10.                   |

---

## Appendix A — `.gitignore` addendum

`/.chess-agent-ref/` is the cloned reference repo. It is kept out of source control:

```txt
.chess-agent-ref/
node_modules/
dist/
.wrangler/
```

