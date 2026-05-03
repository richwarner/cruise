# Cruise

Prototype shipment-orchestration demo. A human dispatcher chats with an AI **Director**; when a new order arrives, the Director fans out to three **Planner** workers in parallel. Each planner re-plans tomorrow's trips to absorb the order, a deterministic validator gates every proposal, and the Director commits the cheapest feasible plan.

Built on Cloudflare Workers, Durable Objects, the Agents SDK, Workers AI (Kimi K2.6 by default), Hono, React, and Kumo. Architecturally mirrors [deloreyj/chess-agent](https://github.com/deloreyj/chess-agent).

Live: **https://cruise.warnerrich.workers.dev**

See [PLAN.md](PLAN.md) for the full design, [AGENTS.md](AGENTS.md) for contributor rules, and [PROGRESS.md](PROGRESS.md) for build status.

## Quick start

```bash
npm install
npm run typegen     # generates worker-configuration.d.ts
npm test
npm run dev         # open http://localhost:5173/cruise
```

The first `npm run dev` warns that `env.AI` bindings hit Cloudflare even in local dev. That's expected — Workers AI has no local emulation.

## Using the app

At `/cruise`:

1. The **Operations** tab (left) shows the 5-city Portugal map with today's plan.
2. The **Director Chat** tab (right) is the primary interaction surface. Type:
   - `"New order: 3 pallets Porto to Faro"` — Director parses, calls `submitOrder`, runs three planners in parallel, commits the winner.
   - `"Why did planner-2 fail?"` — Director calls `inspectDispatch`, answers in prose.
3. The **Planner Activity** tab shows each planner's live reasoning trace (1 Hz poll of `getAllPlannerStates`).
4. **Submit test order** in the header is a fast debug path equivalent to typing a canned order.
5. **Fleet size** stepper shrinks/grows the fleet. Drop it to 2 to force all-infeasible rounds and see the red "Round failed" banner.

## Architecture in one paragraph

`DispatchDirectorAgent` is a `Think<Env, DispatchState>` Durable Object. It owns the fleet, orders, and current plan, and exposes both RPCs (for the UI) and tools (for its own LLM turn): `inspectDispatch`, `addOrder`, `askPlanners`, `submitOrder`. When a round runs, it uses `this.subAgent(TripPlannerAgent, name)` to call three planner DOs in parallel via `proposePlan`. Planners get a snapshot + new order, run one chat turn with their own `submitPlan` tool, and return a candidate. The Director re-runs `validatePlan` on every candidate (LLMs can't sneak past the validator), picks the cheapest valid, and replaces `currentPlan`. A 5 min grace window after the first valid candidate + a round-id guard prevent slow planners from blocking the commit or stomping on newer rounds.

## Deploy

```bash
npm run deploy       # wrangler deploy
```

If you see `code: 9109 Invalid access token`, re-run `npx wrangler login`. The token tends to rotate out when a long-running `wrangler tail` is active.

## Useful diagnostic endpoints

Cruise exposes two worker-routed endpoints so you can isolate failure modes without the UI:

- `GET /api/health` → `{"ok":true,"service":"cruise"}`
- `GET /api/ai-probe?model=<model>` → calls `env.AI.run(model, …)` directly and returns timing. Use this when you suspect the Cloudflare AI gateway is returning `1031` / `10000` errors before spending time debugging the Agents SDK layers. Default model: `@cf/meta/llama-3.1-8b-instruct`.

## Layout

- `src/shared/cruise.ts` — pure constraints, cost, validator, seed data, prompt builders.
- `src/shared/schemas.ts` — Zod schemas for tool input (`addOrder`, `submitOrder`, `askPlanners`, `submitPlan`).
- `src/shared/types.ts` — `DispatchState`, `PlannerState`, `CityId`, `Trip`, etc.
- `src/agents/DispatchDirectorAgent.ts` — Director DO (state broadcast, tool surface, parallel planner orchestration, grace window, round-id guard).
- `src/agents/TripPlannerAgent.ts` — Planner DO (`proposePlan` RPC, `inspectSnapshot` + `submitPlan` tools).
- `src/agents/cruiseAgentCore.ts` — Workers AI model factory.
- `src/client/routes/CruiseRoute.tsx` — the `/cruise` route: left panel (Operations | Control Room), right panel (Director Chat | Planner Activity).
- `src/client/hooks/useDispatchSystem.ts` — single `useAgent` connection to the Director plus 1 Hz polling of `getAllPlannerStates` while a round is active.
- `src/server/index.ts` — Hono: `/api/health`, `/api/ai-probe`, fall through to `routeAgentRequest`.
