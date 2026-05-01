# Cruise — Build Progress

Tracks execution against [PLAN.md](PLAN.md). Updated as each task completes.

## Phase 1 — Bootstrap + domain rules ✅

- [x] Config files: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `wrangler.jsonc`, `index.html`, `AGENTS.md`, `README.md`, `.gitignore`
- [x] Install npm dependencies (395 packages; node engine warning from vitest is cosmetic)
- [x] `src/shared/messages.ts`
- [x] `src/shared/types.ts` (all domain types including optional compressor hooks)
- [x] `src/shared/schemas.ts` (Zod)
- [x] `src/shared/cruise.ts` (travelHours, rates, simulateTrip, validatePlan, tryApplyPlan, seedInitialDispatchState, buildPlannerPrompt, buildDirectorPrompt)
- [x] `src/shared/cruise.test.ts` — 18 tests, all passing
- [x] `worker-configuration.d.ts` generated via `wrangler types`
- [x] `npm run typecheck` green
- [x] `npm test` green

### Phase 1 adjustments

- Added `exclude: [".chess-agent-ref"]` to `vitest.config.ts` so the reference repo's tests are skipped.
- **Plan realignment (2026-05-01)**: the plan was revised to drop compressor/temperature entirely, rename `committedPlan` → `currentPlan`, add per-trip `startMinutes`, add configurable `fleetSize`, and use an identical prompt across planners. The code was rewritten to match:
  - Removed `CompressorType`, `COMPRESSOR_TYPES`, `compressorType`, `tempRequirement`, `ENABLE_COMPRESSOR_MATCH`.
  - `Trip` now carries `startMinutes`; validator enforces `>= 360` (06:00) and `endMinutes <= 1080` (18:00).
  - `DispatchState.currentPlan` replaces `committedPlan`; `tryApplyPlan` no longer rolls `startCity` forward.
  - `seedInitialDispatchState(systemId, { fleetSize? })` with `buildFleet(n)` supporting `< 10` and `> 10`. Validation throws only when `fleetSize === 10` (the default).
  - Initial order book restored to **12 orders / 30 pallets** including origins with 3 outbound routes. `buildInitialPlan` upgraded to a smarter greedy that consolidates overflow routes onto a single truck via shortest-driving permutation.
  - `buildPlannerPrompt(snapshot, newOrder)` — identical across seeds; seed variation is now purely `sessionAffinity`-based.
  - Added `SAMPLE_ORDER_TEMPLATES` for Phase 5 UI.
  - Tests bumped from 18 to **26 green** (added `buildFleet` size cases, per-trip `startMinutes`, post-18:00 arrival, simulate from `trip.startMinutes`).

## Phase 2 — Planner agent in single-agent mode ✅

- [x] `src/agents/cruiseAgentCore.ts` (`createCruiseModel(env, seed)`, Workers AI model factory)
- [x] `src/agents/TripPlannerAgent.ts` (`Think<Env, PlannerState>`, `proposePlan` RPC, `inspectSnapshot` + `submitPlan` tools, lifecycle hooks)
- [x] `src/server/index.ts` (Hono `/api/health`, re-export `TripPlannerAgent`, fall through to `routeAgentRequest`)
- [x] `src/client/main.tsx`, `src/client/styles.css` (dark theme shell + chat panel styles)
- [x] `src/client/App.tsx` with `/` and `/cruise` routing
- [x] `src/client/routes/LandingRoute.tsx`, `RouteNav.tsx`
- [x] `src/client/routes/CruiseRoute.tsx` (single-planner mode: seeded snapshot, `Run proposePlan` button, candidate summary, runtime events feed, AgentPanel)
- [x] `src/client/components/AgentPanel.tsx` (lifted from chess-agent)
- [x] `src/client/components/MessageParts.tsx` (lifted from chess-agent)
- [x] `src/vite-env.d.ts` (`declare module "@cloudflare/kumo/styles/standalone"`)
- [x] `npm run typecheck` green after Phase 2
- [x] `npm run dev` boots; `/`, `/cruise`, `/api/health` all respond 200

## Smoke-test log

Date: 2026-05-01.

- `npm test` → 26/26 green (after plan realignment).
- `npm run typecheck` → no errors.
- `npm run dev` → vite 8.0.10 on `http://localhost:5175/`.
- `GET /` → 200 (Landing).
- `GET /cruise` → 200 (CruiseRoute; single-planner UI).
- `GET /api/health` → `{"ok":true,"service":"cruise"}`.
- Console warning: "AI bindings always access remote resources…" — expected, Workers AI runs against the remote binding even in dev.

### UI fixes applied after initial smoke test

- Chat panel was expanding past the viewport. `.app-shell` was `min-height: 100vh` → changed to `height: 100vh; overflow: hidden` so the inner grid gets a fixed row height and `.agent-chat-feed` scrolls inside the panel. Landing gets a `landing-shell` escape hatch (`height: auto`) so its long narrative still scrolls normally.
- Planner prompt was exposing compressor/temperature info even though the validator ignores it. Stripped from `buildPlannerPrompt` so the LLM doesn't self-impose constraints the rules engine doesn't enforce.

**Pending manual tests (requires a human in the browser + Workers AI):**

- Chat with the planner at `/cruise`, ask it to run `inspectSnapshot` — verify the tool returns the seeded snapshot (30 pallets, 10 trucks, `currentPlan`).
- Click "Run proposePlan" — verify the planner returns a valid candidate with `startMinutes` on every trip, or infeasible with readable errors.
- Inspect `PlannerState.runtimeEvents` update via the events feed.

## Phase 6 — Deployment checkpoint (early) ✅

Ran ahead of Phases 3–5 to de-risk Cloudflare deploy plumbing.

- `npm run build` → vite production build green (1.05 MB worker, 683 KB client, 240 ms + 834 ms).
- `npm run deploy` → uploaded in 7.4 s, worker startup 55 ms.
- Live URL: **https://cruise.warnerrich.workers.dev**
- Bindings live in production: `env.TripPlannerAgent` (Durable Object), `env.AI` (Workers AI).
- `GET /` → 200. `GET /cruise` → 200. `GET /api/health` → `{"ok":true,"service":"cruise"}`.
- Version ID recorded: `b51b0ba9-e278-4fbb-81ef-95a47dcca658`.
- Deploy warning noted: chunk > 500 kB — acceptable for prototype; revisit if we add more components.

Re-deploy command: `npm run deploy` from repo root (auth via `~/.wrangler/...`).

## Phase 3 — Control Room read-only ✅

- [x] `src/shared/dispatch.ts` — facade for `seedInitialDispatchState` + `plannerNamesFor`.
- [x] `src/agents/DispatchDirectorAgent.ts` — `Think<Env, DispatchState>` stub with `getDispatch` / `resetDispatch` / `resizeFleet` RPCs. No planner spawn or chat tools yet; lifecycle hooks append to `recentDirectorActions` so the Control Room's action log has content when the director is prodded.
- [x] `src/server/index.ts` — re-export `DispatchDirectorAgent` next to `TripPlannerAgent`.
- [x] `wrangler.jsonc` — second DO binding + `v2` migration declaring `new_sqlite_classes: ["DispatchDirectorAgent"]`.
- [x] `worker-configuration.d.ts` regenerated.
- [x] `src/client/hooks/useDispatchSystem.ts` — owns director connection, exposes `dispatch`, `error`, `refresh`, `resetDispatch`, `resizeFleet`, plus a seed-1 `TripPlannerAgent` sub-subscription so the single-planner chat keeps working until Phase 5.
- [x] `CityMap.tsx` — stylised SVG of the 5 Portuguese cities with per-city truck count badges and per-trip polylines (click to select, hover for tooltip).
- [x] `TripDetail.tsx` — selected-trip panel showing start/finish/drive/revenue plus stops and pallet manifest. Falls back gracefully when `simulateTrip` throws.
- [x] `OperationsBoard.tsx` — map + summary stats + unassigned warning + optional pending-order strip + trip inspector.
- [x] `DispatchControlRoom.tsx` — fleet-by-city table, rate card matrix, travel matrix, current-plan KPIs, last-round placeholder, action log.
- [x] `PlannerCandidateCard.tsx` — candidate metadata with validity/winner styling (used only when `lastRound` is populated; Phase 4 wires it up).
- [x] `DispatchControls.tsx` — systemId input (commit on blur/Enter), fleet size stepper, reset button.
- [x] `CruiseRoute.tsx` rewritten — panel toggle (Operations | Control Room) + gear button fallback, Banner on error, single-planner chat unchanged on the right.
- [x] Phase 3 CSS appended to `src/client/styles.css` (dispatch controls, panel tabs, operations board grid, city map nodes/trip lines, control room tables + matrices + log, planner card).
- [x] `npm run typecheck` green.
- [x] `npm test` → 26/26 green (no new tests — Phase 3 is pure UI + thin DO).
- [x] `npm run build` green.
- [x] Redeployed: `https://cruise.warnerrich.workers.dev` — version ID `693bbf0a-2d1e-45a8-bc03-23dfbd9c7985`. `/`, `/cruise`, `/api/health` all respond 200 in production.
- [x] Bindings in prod now include `env.DispatchDirectorAgent` alongside `env.TripPlannerAgent` and `env.AI`.

### Phase 3 notes

- HMR during the route swap briefly surfaced an `@ai-sdk/react` "Maximum update depth exceeded" warning while the worker restarted to pick up the new DO class. Post-restart HMR ticks are clean; fresh page loads (local and prod) do not reproduce it.
- `DispatchDirectorAgent.beforeTurn/beforeToolCall/…` record director actions into the broadcast state so Phase 4 already has a live action-log feed without extra plumbing.
- Control Room's "Last planner round" intentionally shows an empty state in Phase 3 — `dispatch.lastRound` is always `[]` until Phase 4 writes to it.

## Phase 4 — Director with parallel planners ✅

- [x] `src/shared/schemas.ts` — added `askPlannersInputSchema` and `submitOrderInputSchema` for the new tool/RPC surface.
- [x] `src/agents/DispatchDirectorAgent.ts` fleshed out:
  - RPC: `submitOrder` (structured one-shot), `getPlannerState(name)` (passthrough); existing `getDispatch`/`resetDispatch`/`resizeFleet` keep working.
  - Internals: `addOrderInternal` (de-dupe pallet ids, append to order book, set `pendingOrder`); `askPlannersInternal` (parallel spawn via `this.subAgent(TripPlannerAgent, name)`, 30 s `Promise.race` timeout per planner, defensive `validatePlan` re-run on each candidate, cheapest-cost winner, `tryApplyPlan`, broadcast state at each step).
  - Tools for the Director's own LLM turn: `inspectDispatch`, `addOrder`, `askPlanners`. `getSystemPrompt` now delegates to `buildDirectorPrompt` so it tracks current fleet/pending/lastRound summaries.
  - On failure: no fallback plan, no state mutation to `currentPlan`/`pendingOrder`; action log records each planner's error.
- [x] Planner reset on dispatch reset/resize: `resetAllPlanners()` best-effort walks `plannerAgentNames` and calls `resetPlanner()` on each sub.
- [x] `src/client/hooks/useDispatchSystem.ts` rewritten with three `TripPlannerAgent` sub-subscriptions (keyed by `plannerId`), `planners` array, `plannerStates` record, `submitOrder` wrapper, and `generateSampleOrderText` helper reading `SAMPLE_ORDER_TEMPLATES`.
- [x] `src/client/components/DispatchControls.tsx` gained a "Submit test order" button (fixed `4 × OPO → FAO` order; orderId randomised per click so repeated rounds don't collide).
- [x] `src/client/components/DispatchControlRoom.tsx` highlights the winning candidate (cheapest valid) in `Last planner round`.
- [x] `src/client/routes/CruiseRoute.tsx` — wires the whole pipeline together, adds a live round-status pill in the board header ("Planners thinking…", "Director thinking…", "Pending: O-xxx"), and passes the seed-1 planner's runtime events into the debug chat.
- [x] `cruise.test.ts` already covers the one-trip-per-truck rule added in this phase per PLAN §10.4; kept suite at 26/26.
- [x] `npm run typecheck` green.
- [x] `npm test` green.
- [x] `npm run build` green.
- [x] Deployed: `https://cruise.warnerrich.workers.dev` — version ID `ea0d4d31-1d93-4bc8-8f98-bc2a171f4818`. `/`, `/cruise`, `/api/health` all respond 200.

### Phase 4 notes

- The Director re-runs `validatePlan` on every candidate before choosing a winner, so a buggy planner that returns `valid: true` with a stale validation can't slip past. Matches PLAN §8.5's "validation gate is always on" rule.
- Planner timeouts are tagged as invalid candidates (`errors: ["planner X timed out after 30s"]`) so the Control Room renders a red card with a readable reason instead of hanging the round.
- Dev-only: HMR during the mid-refactor briefly threw `getHttpUrl` inside `useAgentChat` because `useAgent` was re-initialising between saves. Fresh page loads (local + prod) render cleanly.

**Pending manual tests (requires a human in the browser + Workers AI):**

- From `/cruise`, click "Submit test order" with default fleet size 10 → verify three `PlannerCandidateCard`s appear in the Control Room, one gets a WINNER badge, the `currentPlan` on the map updates, and the action log records a `askPlanners committed` entry.
- Repeat with fleet size 3 (via the fleet stepper) to force all-infeasible; verify three red cards appear, `currentPlan` stays unchanged, the status pill reverts to "Pending: O-…", and no commit is logged.
- Open the planner-1 chat; ask "inspect your snapshot" and verify the planner's runtime timeline shows `inspectSnapshot` tool calls on the right side of the panel.

## Phase 5

Pending human sign-off on Phase 4 manual tests before starting Phase 5 (Director chat + full chat-target toggle UX).
