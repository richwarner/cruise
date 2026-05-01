# Cruise

Prototype shipment-orchestration demo. A human dispatcher chats with an AI Director; when a new order arrives, the Director spawns three Planner workers in parallel, each re-plans tomorrow's trips to absorb the new order, and the Director commits the lowest-cost feasible plan.

Built on Cloudflare Workers, Durable Objects, the Agents SDK, Workers AI, Hono, React, and Kumo. Architecturally mirrors [deloreyj/chess-agent](https://github.com/deloreyj/chess-agent).

See [PLAN.md](PLAN.md) for the full design, [AGENTS.md](AGENTS.md) for contributor rules, and [PROGRESS.md](PROGRESS.md) for build status.

## Quick start

```bash
npm install
npm run typegen     # generates worker-configuration.d.ts
npm test
npm run dev         # then open http://localhost:5173/cruise
```

## Layout

- `src/shared/cruise.ts` — pure constraints + cost + seed data.
- `src/agents/` — `DispatchDirectorAgent` and `TripPlannerAgent` Durable Objects.
- `src/client/` — React SPA routed at `/cruise`.
- `src/server/index.ts` — Hono + `routeAgentRequest` entry point.
