# Cruise Contributor Guide

## Purpose

Cruise is a prototype tool that plans tomorrow's shipments for a small refrigerated trucking fleet. A human dispatcher chats with an AI Director; when a new order arrives, the Director spawns three Planner workers in parallel, each of which re-plans tomorrow's trips to absorb the new order. The Director validates each plan against business constraints in `src/shared/cruise.ts` and picks the lowest-cost feasible plan as the new state.

The app runs on Cloudflare Workers with Durable Objects, the Agents SDK, Workers AI, Hono, React, WebSocket RPC, and Kumo. It mirrors the stack and "Director Mode" patterns of [chess-agent](https://github.com/deloreyj/chess-agent).

## Commands

- `npm run dev` starts the Cloudflare Vite dev server.
- `npm run typecheck` verifies TypeScript.
- `npm test` runs Vitest.
- `npm run build` builds the Worker and React app.
- `npm run deploy` deploys with Wrangler.
- `npm run typegen` regenerates `worker-configuration.d.ts` from `wrangler.jsonc`.

## Architecture rules

- Keep the workshop code small, explicit, and easy to teach.
- Use `src/shared/cruise.ts` as the single source of truth for plan feasibility and cost. Nothing else validates plans.
- **Cost model is per-truck-leg, not per-pallet.** `ratePerTruckLeg(from, to) = round(50 + 120 * hours)` charges a fixed euro amount for a truck driving a leg regardless of how full it is. Trip cost is the sum of its driving legs; plan cost is the sum of its trips. Consolidating pallets onto fewer trucks / fewer legs is the main lever planners have to reduce cost.
- The LLM can request actions through narrow tools, but `cruise.ts` validates every proposed plan before it is persisted. "Model suggests, `cruise.ts` decides." The Director re-runs `validatePlan` on every planner candidate even when the planner reports `valid: true`.
- Use the Agent WebSocket connection for RPC, chat, and state broadcasts. No REST API for planning.
- Use Kumo via granular imports and standalone styles.
- Prefer shared types and schemas from `src/shared` over duplicated shapes.
- Add comments for Cloudflare Agents, Durable Objects, Workers bindings, and LLM safety boundaries. Avoid comments that restate obvious code.
- No deterministic fallback. If the Director cannot find a feasible plan after running all three Planners, it reports the failure to chat and does not mutate `currentPlan` or `pendingOrder`.
- **Client opens exactly one WebSocket: to the Director.** No per-planner `useAgent` subscriptions from the browser — they cause `useAgentChat` render loops and starve the target planner's LLM call. Planner state reaches the UI via the Director's broadcast `lastRound` + a 1 Hz `getAllPlannerStates` RPC poll.

## Concurrency rules (Phase 4/5 lessons)

- Planner timeouts: individual planners get up to 300 s; once any planner returns valid, a `FIRST_VALID_GRACE_MS = 300_000` (5 min) window caps how long we wait for cheaper alternatives. With the two limits equal, the Director effectively waits for every planner unless one hits its hard timeout.
- Round-id guard: every `askPlannersInternal` bumps `this.currentRoundId`. Partial-round broadcasts and final commits check the id before calling `setState`; late resolutions from superseded rounds are dropped.
- Grace-skipped planners render with `errors: ["skipped: grace window elapsed before planner returned"]`, not a fabricated timeout.

## Domain invariants

- Fleet: configurable size (default 10), 13.5 m, 30-pallet capacity each. `startCity` is persisted but **does not roll forward** at end of day — this prototype always plans tomorrow from the current snapshot.
- Cities: Lisboa (LIS), Porto (OPO), Coimbra (COI), Braga (BRA), Faro (FAO).
- Day window: trucks start earliest 06:00 (`startMinutes >= 360`); every dropoff must complete by 18:00 (`endMinutes <= 1080`).
- Driving cap: total driving time per truck per day ≤ 9 h.
- Service time: 30 minutes per pickup or dropoff stop, counted in the working day but not against the driving cap.
- Per-leg capacity: a truck must never hold more than 30 pallets between two consecutive stops.
- One trip per truck per day.
- Coverage: every pallet in the order book is on exactly one trip. No deferrals.
- `Trip.startMinutes` is planner-chosen (any valid time in `[360, …]` where `endMinutes <= 1080`).
- Compressor/temperature matching is **out of scope**. It was removed from types, prompts, and validator — don't re-introduce it without an explicit plan update.

## Initial assumptions

- `cruise.ts` seed data is deterministic: 6 orders / 12 pallets, 10 trucks across 5 cities. Lives in code; no separate seed script required.
- The Director LLM parses free-text orders like "New order: 3 pallets Porto → Faro" and calls the **`submitOrder` tool** (preferred). `addOrder` + `askPlanners` are kept as low-level escape hatches for explicit pallet ids.
- Planner sub-agents are stable per system: `${systemId}-planner-1..3`. All three share an identical prompt; variation comes from per-planner `sessionAffinity` passed to `createCruiseModel`.
- Deterministic components (validator, initial plan seed) and stochastic components (LLM planners) are kept in separate modules so the LLM layer can be swapped without breaking rules logic.
