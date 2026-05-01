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
- Deploy blocker discovered: the inherited `"experimental"` compatibility flag is dev-only and is rejected by the deploy API. Removed from `wrangler.jsonc` → config now just `["nodejs_compat"]`.

### Phase 4 stabilization (2026-05-01, post first end-to-end smoke)

The first live round surfaced four independent issues. All four are fixed and the new architecture is the one reflected in the current codebase (and re-deployed to `cruise.warnerrich.workers.dev`, version ID `772056c6-978f-4ce1-8b5f-4a9622626050`).

1. **Cloudflare AI gateway returned `1031`** after the Workers Paid upgrade. Was an OAuth token invalidation from a long-running `wrangler tail`, not an account issue. Re-login (`npx wrangler login`) + a dev-server restart cleared it. Added `/api/ai-probe` diagnostic endpoint in `src/server/index.ts` that directly calls `env.AI.run(model, …)` and returns timing so future AI-binding regressions can be isolated from Think/agent layers in seconds.

2. **React "Maximum update depth exceeded" render loop** from `@ai-sdk/react`'s `useAgentChat`. Rooted in a single `useAgent` sub-subscription to a planner DO plus `useAgentChat` targeted at the same stub — the store kept firing on every Director state broadcast. **Fix:** removed all per-planner WebSocket sub-subscriptions from the client. `useDispatchSystem` now keeps exactly one connection (to the Director).

3. **Planner-1 never returned when subscribed to it.** Whichever planner the client opened a WebSocket against appeared to starve its own LLM call — consistently saw planner-1 time out while planners 2 and 3 completed. Combined with (2), the cleanest fix was to drop the AgentPanel for Phase 4 and replace it with a read-only `PlannerActivityPanel` fed by 1 Hz polling of a new `DispatchDirectorAgent.getAllPlannerStates()` batch RPC. No sub-WebSockets means no starvation and no render loop; the trade-off is we don't have a chat surface in Phase 4 (Phase 5 adds it back, targeted at the Director).

4. **`Promise.all` forced a 120s wait even when 2/3 planners were valid at ~15s.** Replaced with `collectPlannerCandidates` in `DispatchDirectorAgent.ts`:
   - Fan out all three, but collect results as they resolve and broadcast partial `lastRound` state live (each resolution calls `broadcastPartialRound`).
   - `FIRST_VALID_GRACE_MS = 15_000`: once the first valid candidate arrives, wait at most 15 s for a cheaper one, then commit.
   - `PLANNER_TIMEOUT_MS` bumped from `30_000` → `120_000` as a hard ceiling, since Kimi K2.5 reasoning at ~4 KB prompt is regularly 30–90 s.
   - **Round-id guard:** `DispatchDirectorAgent.currentRoundId` bumped at the start of each round. Every partial-round broadcast and every final `setState` commit checks `this.currentRoundId === roundId` before touching state. Late resolutions from abandoned rounds (e.g. a planner that finally times out at T=120 s well after the winner was grace-committed at T=30 s) are silently dropped, so they can't overwrite the UI.

Order-book simplifications made in the same pass to speed up LLM reasoning:

- `INITIAL_ORDERS`: 12 orders / 30 pallets → 6 orders / 12 pallets (route coverage unchanged).
- `TEST_ORDER_PALLETS`: 4 → 2.
- `buildPlannerPrompt` now groups pallets by order (`"Order O-1: 3 pallet(s) LIS->OPO (ids O-1-P1, O-1-P2, O-1-P3)"`) instead of one line per pallet. Prompt length dropped ~3937 → ~2979 chars.

Live trace restored via batch polling (no sub-WebSockets):

- New RPC `DispatchDirectorAgent.getAllPlannerStates(): Promise<PlannerState[]>` fans out to `this.subAgent(TripPlannerAgent, name).getPlannerState()` across all planners.
- `useDispatchSystem` polls this RPC every 1000 ms **only while `directorThinking || isSubmittingOrder`**, stops on idle. One final poll on round completion so the last events are captured.
- `PlannerActivityPanel` renders a pulsing card per planner with the most recent runtime events (timestamps + label + truncated detail) under the Trips/Cost row. Winner keeps the "WINNER" badge.

Suite + build still green at 26/26 tests, typecheck, `npm run build`. Version `772056c6-978f-4ce1-8b5f-4a9622626050` is live.

**Phase 4 manual verification (confirmed by user 2026-05-01):**

- Submit test order → within ~30 s a valid plan commits, Operations board updates (14/14 pallets, planner-3 marked WINNER at €289 / 6 trips).
- Grace-skipped planners render as invalid cards with `skipped: grace window elapsed before planner returned` (no longer mislabelled as 120 s timeouts).
- Live per-planner event trace ticks in every second under each card.

## Phase 5 — Director chat ✅

Live at `https://cruise.warnerrich.workers.dev`, version `58a11465-012d-4f7a-b56c-7af55f1e99d9`.

- [x] **`submitOrder` tool** added to `DispatchDirectorAgent.getTools()`. Wraps the existing `submitOrder` RPC: auto-generates pallet ids via `buildOrderEventFromInput`, calls `addOrderInternal` + `askPlannersInternal`, returns the winner + cost or per-planner errors. This is the preferred LLM path; `addOrder` is kept as a low-level escape hatch.
- [x] **`buildDirectorPrompt` rewritten** (`src/shared/cruise.ts`) with:
  - City code table with aliases (`OPO = Porto / Oporto`, `LIS = Lisbon / Lisboa`, etc.) so the LLM reliably maps free-text names to `CityId`s.
  - Four-step workflow: parse → generate `orderId` → call `submitOrder` → report winner or ask for guidance on infeasible rounds.
  - Prose-answer branch for open questions ("why did planner-2 fail?") using `inspectDispatch`.
- [x] **`DirectorChatPanel`** (`src/client/components/DirectorChatPanel.tsx`) — thin wrapper around `AgentPanel` with Director-specific copy, placeholder (`"New order: 2 pallets Lisbon to Braga…"`), and runtime events wired to `dispatch.recentDirectorActions`.
- [x] **`CruiseRoute.tsx` right-column tab toggle** — `Director Chat | Planner Activity`. Default is Chat. Both panels share the single Director WebSocket from the existing `useAgent` call; no sub-agent subscriptions opened from the client.
- [x] CSS fix for `.runtime-timeline` (was unstyled → grew unbounded → pushed the chat composer out of the panel). Now max-height 140 px with internal scroll. `.agent-chat-feed` lost its `min-height: 200px` floor so it can shrink gracefully when the timeline is visible.
- [x] `npm run typecheck` green. `npm test` → 26/26. `npm run build` green. Deploy green (after re-login because the long-running `wrangler tail` from earlier invalidated the OAuth token).

### Phase 5 scope cut

Per-planner chat target was cut from this phase. Evidence from Phase 4 showed that opening any sub-planner WebSocket starves that planner's LLM call. The Planner Activity tab (1 Hz RPC polling, no sub-subscription) already surfaces per-planner runtime events + candidate stats, so the dedicated chat target isn't essential for the demo. Revisit later with a guard (e.g. disable the planner-target tab while a round is running).

**Phase 5 manual verification (pending user):**

- From the Director chat: "New order: 3 pallets Porto to Faro" → verify the Director calls `submitOrder` with `pickup="OPO"`, `dropoff="FAO"`, `pallets=3`; runtime timeline shows `director tool: submitOrder` → result; final chat message reports the winning planner and cost.
- "Why did planner-2 fail?" after a round → verify Director calls `inspectDispatch` and answers in prose without adding an order.
- Submit test order button still works alongside chat (both paths share the `submitOrder` RPC).

## Phase 6 — Director chat polish ✅

Live at `https://cruise.warnerrich.workers.dev`, version `fa7ef948-194a-4a88-88d3-4b8fd4627a50`.

- [x] **Winner chip in the Director chat header.** `DirectorChatPanel` now renders a `.director-round-chip` via `AgentPanel.headerAccessory`. Green `planner-N · €cost · orderId` when the latest round committed, red `Round failed` with a tooltip listing the infeasible planners otherwise. Pulled from `dispatch.lastRound` + `dispatch.pendingOrder`; no extra RPCs.
- [x] **`pickCheapestFeasible` helper extracted** (`src/shared/cruise.ts`). Pure function shared between `DispatchDirectorAgent.askPlannersInternal` (grace-commit path) and the UI winner chip, so both stay in lockstep. Deterministic tie-break: cost → lower seed → plannerName lexicographic.
- [x] **7 new unit tests** in `src/shared/cruise.test.ts`: empty round, all-infeasible, cheapest-valid, broken `valid=true + cost=undefined`, partial grace-window list (2 of 3 candidates), deterministic ties, and ignoring candidates flagged `valid=false` even if they have a suspiciously low cost. 33/33 tests green.
- [x] **Suggested-prompt buttons** in the chat empty state. `AgentPanel` accepts `suggestedPrompts={ label, text }[]` and renders them as pill buttons that `sendMessage({ text })` on click (disabled while streaming). `DirectorChatPanel` seeds three demo prompts (two order submissions + "inspect current plan").
- [x] `npm run typecheck`, `npm test` (33/33), `npm run build`, `npx wrangler deploy` all green.

## Phase 7 — Round history + commit regression ✅

Live at `https://cruise.warnerrich.workers.dev`, version `fc6f180f-fc43-456e-bf20-b1abfc22b33d`.

- [x] **`RoundResult` type + `recentRounds` on `DispatchState`.** Capped at the last 10 rounds. Backfilled in `ensureDispatchState` for older persisted DOs so existing Director instances don't 500 after the upgrade.
- [x] **Round-history strip in the Director chat.** New `afterHeader` slot on `AgentPanel` renders a horizontal list of `.director-round-pill` chips between the header and the runtime timeline. Each pill shows `orderId · €cost · ±€delta · planner short name`, colored green for cost down, red for up. Pills scroll horizontally when the session runs long.
- [x] **`computeRoundCommit` pure helper** (`src/shared/cruise.ts`). Factored the branching logic out of `DispatchDirectorAgent.askPlannersInternal` into a deterministic function that returns one of `{ infeasible | winner_rejected | committed }`. Eliminates duplicated math (delta/summary/roundResult build) and makes the agent method easier to read.
- [x] **Infeasible-round regression tests.** Three new vitest cases in `src/shared/cruise.test.ts` drive the helper directly:
  - All-planners-infeasible → `kind: "infeasible"` with each planner name in `errorDetail` (captures the fleet=2 demo scenario).
  - Single candidate with no error list → "no plan" sentinel flows through.
  - Commit happy path → `RoundResult` has correct `roundId`, `committedAt`, `tripCount`, and `priorCost === cost` for a no-op commit.
- [x] **36/36 tests green**, typecheck clean, build + deploy green.

## Phase 8 backlog

- **Per-planner chat target** (see Phase 5 scope cut). Requires a guard that disables the planner-target tab while a round is running so we don't re-introduce planner starvation.
- **Round history pill click-through.** Clicking a pill could scroll the chat transcript to the corresponding "committed" message or open a detail popover with the per-planner candidates archived for that round.
- **Cost sparkline above the pill strip.** Once we have 5+ rounds, a 60 × 12 px inline sparkline across the strip would make the "plan is improving" story pop in the demo.
