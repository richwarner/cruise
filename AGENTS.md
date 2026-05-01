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
- The LLM can request actions through narrow tools, but `cruise.ts` validates every proposed plan before it is persisted. "Model suggests, `cruise.ts` decides."
- Use the Agent WebSocket connection for RPC, chat, and state broadcasts. There is no REST API for planning.
- Use Kumo via granular imports and standalone styles.
- Prefer shared types and schemas from `src/shared` over duplicated shapes.
- Add comments for Cloudflare Agents, Durable Objects, Workers bindings, and LLM safety boundaries. Avoid comments that restate obvious code.
- No deterministic fallback. If the Director cannot find a feasible plan after running all three Planners, it reports the failure to chat and does not mutate `committedPlan`.

## Domain invariants

- Fleet: 10 trucks, 13.5 m, 30-pallet capacity each. Tomorrow's start-of-day location per truck is persisted state.
- Cities: Lisboa (LIS), Porto (OPO), Coimbra (COI), Braga (BRA), Faro (FAO).
- Day window: trucks start earliest 06:00; every dropoff must be complete by 18:00.
- Driving cap: total driving time per truck per day ≤ 9 hours.
- Service time: 30 minutes per pickup or dropoff stop, counted in the working day but not against the driving cap.
- Per-leg capacity: a truck must never hold more than 30 pallets between two consecutive stops.
- Coverage: every pallet in the order book is on exactly one trip. No deferrals.
- End-of-day rollover: when a plan is committed, each truck's `startCity` advances to the last dropoff city of its trip.
- Compressor/temperature tier matching is deferred to a follow-up phase. The types carry an optional `compressorType` / `tempRequirement` hook, but v1 ignores them.

## Initial assumptions

- `cruise.ts` seed data is deterministic and lives in code. A `scripts/seed.ts` can regenerate a randomized order book but is not required.
- The Director LLM parses free-text orders like "New order: 6 pallets Porto → Faro" and calls `addOrder` then `askPlanners`.
- Planner sub-agents are stable per system: `${systemId}-planner-1..3`.
