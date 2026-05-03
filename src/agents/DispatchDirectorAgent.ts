import {
  Think,
  type ChatResponseResult,
  type StepContext,
  type ToolCallContext,
  type ToolCallResultContext,
  type TurnContext,
} from "@cloudflare/think";
import { callable } from "agents";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import {
  DEFAULT_FLEET_SIZE,
  createInitialDispatchState,
} from "../shared/dispatch";
import {
  buildDirectorPrompt,
  computePlanCost,
  computeRoundCommit,
  makeCandidate,
  tryApplyPlan,
  validatePlan,
} from "../shared/cruise";
import {
  addOrderInputSchema,
  askPlannersInputSchema,
  submitOrderInputSchema,
} from "../shared/schemas";
import type {
  DirectorAction,
  DispatchState,
  OrderEvent,
  Pallet,
  PlannerCandidate,
  PlannerState,
} from "../shared/types";
import {
  createCruiseModel,
  looksLikeAiBindingFailure,
  probeWorkersAI,
} from "./cruiseAgentCore";
import { TripPlannerAgent } from "./TripPlannerAgent";

const MAX_DIRECTOR_ACTIONS = 40;
const MAX_RECENT_ROUNDS = 10;
const MAX_DIRECTOR_TURN_STEPS = 6;
const PLANNER_TIMEOUT_MS = 300_000;
const PLANNER_TIMEOUT_LABEL = `${Math.round(PLANNER_TIMEOUT_MS / 1000)}s`;
/**
 * Once any planner returns a valid candidate, give the slower ones this long
 * to also return a (potentially cheaper) valid plan before we commit. This
 * caps how long a user waits when one planner is pathologically slow while
 * still preserving the "cheapest valid" objective when all three are healthy.
 */
const FIRST_VALID_GRACE_MS = 15_000;

type AddOrderInput = z.infer<typeof addOrderInputSchema>;
type SubmitOrderInput = z.infer<typeof submitOrderInputSchema>;

type AskPlannersResult = {
  ok: boolean;
  winner?: string;
  winnerCost?: number;
  committedSummary?: string;
  candidates: PlannerCandidate[];
  errors: string[];
};

/**
 * Phase 4 Director. Owns dispatch state, spawns three Planner sub-agents in
 * parallel when a new order arrives, and replaces `currentPlan` with the
 * cheapest feasible candidate. Exposes both RPC (client path) and tool (LLM
 * path) entry points for `addOrder`, `askPlanners`, and `submitOrder` so a
 * debug button and the director's own chat turn share one implementation.
 */
export class DispatchDirectorAgent extends Think<Env, DispatchState> {
  initialState = createInitialDispatchState("default");
  maxSteps = MAX_DIRECTOR_TURN_STEPS;

  /**
   * Generation counter bumped at the start of every planner round. Late
   * resolutions from abandoned rounds compare against this to avoid
   * overwriting the current round's `lastRound` (see the grace-window
   * short-circuit in `collectPlannerCandidates`).
   *
   * Initialised lazily in `askPlannersInternal` from the maximum `roundId`
   * already stored in `recentRounds`, so that when a DO evicts and its
   * in-memory counter drops to 0, the next round ID stays strictly greater
   * than any persisted one (otherwise `RoundResult.roundId` collides in the
   * UI's round-history list).
   */
  private currentRoundId = 0;
  private currentRoundIdHydrated = false;

  // ======== RPC (client-facing) ========

  @callable()
  async getDispatch(): Promise<DispatchState> {
    return this.ensureDispatchState();
  }

  @callable()
  async resetDispatch(): Promise<DispatchState> {
    const base = createInitialDispatchState(this.name);
    const state = this.withAction(base, "Reset dispatch", `systemId=${this.name}`);
    this.setState(state);
    this.currentRoundId = 0;
    this.currentRoundIdHydrated = true;
    this.clearMessages();
    await this.resetAllPlanners();
    return state;
  }

  @callable()
  async resizeFleet(size: number): Promise<DispatchState> {
    const normalized = Math.max(1, Math.min(50, Math.floor(size)));
    const base = createInitialDispatchState(this.name, { fleetSize: normalized });
    const state = this.withAction(
      base,
      "Resize fleet",
      `${normalized} truck${normalized === 1 ? "" : "s"}`,
    );
    this.setState(state);
    this.currentRoundId = 0;
    this.currentRoundIdHydrated = true;
    await this.resetAllPlanners();
    return state;
  }

  /**
   * Client entry point for one-shot structured order submission. Adds the
   * order, then runs the full planner round inline — the UI sees state
   * broadcasts at each step via Think's WebSocket.
   */
  @callable()
  async submitOrder(input: SubmitOrderInput): Promise<DispatchState> {
    const parsed = submitOrderInputSchema.parse(input);
    const order = buildOrderEventFromInput(parsed, this.ensureDispatchState());
    await this.addOrderInternal(order);
    await this.askPlannersInternal(order.orderId);
    return this.ensureDispatchState();
  }

  /** Passthrough for the UI when it needs to fetch a planner's state directly. */
  @callable()
  async getPlannerState(plannerName: string): Promise<PlannerState> {
    const planner = await this.subAgent(TripPlannerAgent, plannerName);
    return planner.getPlannerState();
  }

  /**
   * Batch fetch of all planner states for the UI live-thinking panel. Polled
   * from the client during active rounds instead of opening per-planner
   * WebSockets (which cause I/O isolation errors and starve planner-1's LLM
   * call — see the `useDispatchSystem` comment block).
   */
  @callable()
  async getAllPlannerStates(): Promise<PlannerState[]> {
    const state = this.ensureDispatchState();
    const results = await Promise.all(
      state.plannerAgentNames.map(async (name) => {
        try {
          const planner = await this.subAgent(TripPlannerAgent, name);
          return await planner.getPlannerState();
        } catch {
          return {
            plannerId: name,
            plannerThinking: false,
            runtimeEvents: [],
          } satisfies PlannerState;
        }
      }),
    );
    return results;
  }

  // ======== Internal state helpers ========

  private ensureDispatchState(): DispatchState {
    if (this.state.systemId === this.name) {
      // Backfill fields added after the DO first persisted state.
      if (!Array.isArray(this.state.recentRounds)) {
        const patched: DispatchState = {
          ...this.state,
          recentRounds: [],
        };
        this.setState(patched);
        return patched;
      }
      return this.state;
    }
    const state = createInitialDispatchState(this.name);
    this.setState(state);
    return state;
  }

  private withAction(
    state: DispatchState,
    label: string,
    detail?: string,
  ): DispatchState {
    const action: DirectorAction = {
      id: crypto.randomUUID(),
      at: Date.now(),
      label,
      detail,
    };
    return {
      ...state,
      recentDirectorActions: [...state.recentDirectorActions, action].slice(
        -MAX_DIRECTOR_ACTIONS,
      ),
    };
  }

  private recordDirectorAction(label: string, detail?: string) {
    const state = this.ensureDispatchState();
    this.setState(this.withAction(state, label, detail));
  }

  private async resetAllPlanners(): Promise<void> {
    const state = this.ensureDispatchState();
    await Promise.allSettled(
      state.plannerAgentNames.map(async (name) => {
        try {
          const planner = await this.subAgent(TripPlannerAgent, name);
          await planner.resetPlanner();
        } catch {
          // Planner might not be materialized yet — resetting is best-effort.
        }
      }),
    );
  }

  // ======== Core orchestration ========

  /**
   * Append an order's pallets to the order book and set it as the pending
   * order. No planner work happens here — callers always follow with
   * `askPlanners` (directly, or via the LLM's next tool call).
   */
  private async addOrderInternal(order: OrderEvent): Promise<DispatchState> {
    const state = this.ensureDispatchState();

    const known = new Set(state.pallets.map((p) => p.id));
    for (const pallet of order.pallets) {
      if (known.has(pallet.id)) {
        throw new Error(`Pallet id ${pallet.id} already exists in order book.`);
      }
    }

    const next: DispatchState = this.withAction(
      {
        ...state,
        pallets: [...state.pallets, ...order.pallets],
        pendingOrder: order,
      },
      "Added order",
      `${order.orderId} · ${order.pallets.length} pallet(s) · ${order.summary}`,
    );
    this.setState(next);
    return next;
  }

  /**
   * Spawn the three Planner sub-agents in parallel, each with a 180 s timeout.
   * Merge candidates into `lastRound`, pick the cheapest feasible, and commit
   * via `tryApplyPlan`. On full failure (all three infeasible, or timeout,
   * or RPC error), leaves `currentPlan` and `pendingOrder` untouched and
   * records the reasons in the action log — no fallback plan is invented.
   */
  private async askPlannersInternal(
    orderId: string | undefined,
  ): Promise<AskPlannersResult> {
    const entryState = this.ensureDispatchState();
    if (!entryState.pendingOrder) {
      this.recordDirectorAction("askPlanners skipped", "No pending order.");
      return {
        ok: false,
        candidates: [],
        errors: ["No pending order to plan for."],
      };
    }
    if (orderId && entryState.pendingOrder.orderId !== orderId) {
      this.recordDirectorAction(
        "askPlanners orderId mismatch",
        `requested=${orderId} pending=${entryState.pendingOrder.orderId}`,
      );
    }

    const snapshot = entryState;
    const newOrder = entryState.pendingOrder;

    // One-time rehydration: bump `currentRoundId` past the highest persisted
    // roundId so eviction/reload doesn't restart the counter at 0 and cause
    // duplicate RoundResult keys in `recentRounds`.
    if (!this.currentRoundIdHydrated) {
      const maxPersisted = (entryState.recentRounds ?? []).reduce(
        (m, r) => (r.roundId > m ? r.roundId : m),
        0,
      );
      if (maxPersisted > this.currentRoundId) {
        this.currentRoundId = maxPersisted;
      }
      this.currentRoundIdHydrated = true;
    }

    const roundId = ++this.currentRoundId;
    this.setState({
      ...this.withAction(
        entryState,
        "askPlanners start",
        `${snapshot.plannerAgentNames.length} planners for ${newOrder.orderId}`,
      ),
      directorThinking: true,
      lastRound: [],
    });

    const candidates = await this.collectPlannerCandidates(
      snapshot,
      newOrder,
      roundId,
    );

    // Defensive re-validation: trust the candidate's flag but recompute so a
    // buggy planner can't sneak past via a stale validation result.
    const revalidated = candidates.map((c) =>
      this.revalidateCandidate(c, snapshot),
    );

    const stateAfterRound = this.ensureDispatchState();
    const roundIsCurrent = this.currentRoundId === roundId;

    const decision = computeRoundCommit({
      stateAfterRound,
      revalidated,
      newOrder,
      roundId,
      now: Date.now(),
    });

    if (decision.kind === "infeasible") {
      // If *no* candidate actually reached the validator (i.e. every planner
      // either timed out, never submitted a plan, or blew up mid-turn), the
      // most likely cause is the Workers AI binding being unreachable rather
      // than a genuinely infeasible order. Run a cheap probe to confirm so
      // the UI can surface an actionable "restart dev / re-login" chip
      // instead of implying the fleet is overloaded.
      const classified = await this.maybeTagAiUnreachable(revalidated);
      if (roundIsCurrent) {
        const next: DispatchState = this.withAction(
          {
            ...stateAfterRound,
            lastRound: classified,
            directorThinking: false,
          },
          classified.every((c) => c.errorKind === "ai_unreachable")
            ? "askPlanners ai unreachable"
            : "askPlanners infeasible",
          decision.errorDetail,
        );
        this.setState(next);
      }
      return {
        ok: false,
        candidates: classified,
        errors: decision.errors,
      };
    }

    if (decision.kind === "winner_rejected") {
      if (roundIsCurrent) {
        const next: DispatchState = this.withAction(
          {
            ...stateAfterRound,
            lastRound: revalidated,
            directorThinking: false,
          },
          "askPlanners winner rejected",
          decision.errors.slice(0, 2).join("; "),
        );
        this.setState(next);
      }
      return {
        ok: false,
        candidates: revalidated,
        errors: decision.errors,
      };
    }

    if (roundIsCurrent) {
      const priorRounds = decision.appliedState.recentRounds ?? [];
      const next: DispatchState = this.withAction(
        {
          ...decision.appliedState,
          lastRound: revalidated,
          recentRounds: [...priorRounds, decision.roundResult].slice(
            -MAX_RECENT_ROUNDS,
          ),
          directorThinking: false,
        },
        "askPlanners committed",
        decision.summary,
      );
      this.setState(next);
    }

    return {
      ok: true,
      winner: decision.winner.plannerName,
      winnerCost: decision.winner.cost,
      committedSummary: decision.summary,
      candidates: revalidated,
      errors: [],
    };
  }

  /**
   * Fan out to all planners and collect candidates as they resolve, live-
   * broadcasting partial `lastRound` state to the UI. Short-circuits with a
   * grace window once any planner returns valid so a single slow planner
   * can't hold the whole round hostage (see `FIRST_VALID_GRACE_MS`).
   */
  private async collectPlannerCandidates(
    snapshot: DispatchState,
    newOrder: OrderEvent,
    roundId: number,
  ): Promise<PlannerCandidate[]> {
    const plannerNames = snapshot.plannerAgentNames;
    const resolved = new Map<string, PlannerCandidate>();
    let firstValidAt: number | undefined;

    const tasks = plannerNames.map((plannerName, index) =>
      this.runPlannerWithTimeout(plannerName, index + 1, snapshot, newOrder)
        .then((candidate) => {
          // Drop late resolutions from superseded rounds so they can't
          // overwrite a newer round's lastRound (e.g. a 180s timeout
          // resolving long after a grace-commit).
          if (this.currentRoundId !== roundId) return;
          resolved.set(plannerName, candidate);
          if (!firstValidAt && candidate.valid) firstValidAt = Date.now();
          this.broadcastPartialRound(plannerNames, resolved, roundId);
        }),
    );

    const allSettled = Promise.allSettled(tasks);

    while (resolved.size < plannerNames.length) {
      if (firstValidAt !== undefined) {
        const remaining =
          firstValidAt + FIRST_VALID_GRACE_MS - Date.now();
        if (remaining <= 0) break;
        await Promise.race([
          allSettled,
          new Promise((r) => setTimeout(r, remaining)),
        ]);
      } else {
        await Promise.race([
          allSettled,
          new Promise((r) => setTimeout(r, 500)),
        ]);
      }
    }

    const missing = plannerNames.filter((n) => !resolved.has(n));
    if (missing.length > 0) {
      this.recordDirectorAction(
        "askPlanners grace",
        `committing after ${missing.length} planner(s) still running: ${missing.join(", ")}`,
      );
    }

    return plannerNames.map((name) => {
      const candidate = resolved.get(name);
      if (candidate) return candidate;
      return {
        plannerName: name,
        seed: plannerNames.indexOf(name) + 1,
        plan: {
          trips: [],
          unassignedPalletIds: snapshot.pallets.map((p) => p.id),
        },
        valid: false,
        errors: ["skipped: grace window elapsed before planner returned"],
        submittedAt: Date.now(),
      } satisfies PlannerCandidate;
    });
  }

  /**
   * Push the current partial-round state to the UI so candidate cards flip
   * to valid/invalid as each planner returns, rather than all at once.
   * Planners that haven't resolved yet are omitted from `lastRound`.
   */
  private broadcastPartialRound(
    plannerNames: string[],
    resolved: Map<string, PlannerCandidate>,
    roundId: number,
  ): void {
    if (this.currentRoundId !== roundId) return;
    const partial: PlannerCandidate[] = plannerNames
      .map((name) => resolved.get(name))
      .filter((c): c is PlannerCandidate => !!c);
    const current = this.ensureDispatchState();
    this.setState({ ...current, lastRound: partial });
  }

  /**
   * If an entire round came back invalid but *none* of the planners reached
   * the validator (every candidate is `no_plan` / `timeout` / already
   * `ai_unreachable`), run a fast Workers AI probe. When the probe fails,
   * re-tag every candidate as `ai_unreachable` so the chat chip can say
   * "AI binding unreachable" instead of the ambiguous "Round failed".
   *
   * Skips the probe entirely if any candidate is classified `infeasible`
   * — in that case at least one planner did reason successfully and we
   * trust the "real" infeasibility signal.
   */
  private async maybeTagAiUnreachable(
    candidates: PlannerCandidate[],
  ): Promise<PlannerCandidate[]> {
    if (candidates.length === 0) return candidates;
    if (candidates.some((c) => c.errorKind === "infeasible")) {
      return candidates;
    }
    // If every candidate is already ai_unreachable from runPlannerWithTimeout,
    // we already know; skip the probe.
    if (candidates.every((c) => c.errorKind === "ai_unreachable")) {
      return candidates;
    }
    const probe = await probeWorkersAI(this.env);
    if (probe.ok) return candidates;

    this.recordDirectorAction(
      "ai probe failed",
      `${probe.model} · ${probe.ms}ms · ${probe.error.slice(0, 120)}`,
    );
    return candidates.map((c) => ({
      ...c,
      errorKind: "ai_unreachable" as const,
      errors: [...(c.errors ?? []), `AI probe failed: ${probe.error}`],
    }));
  }

  private revalidateCandidate(
    candidate: PlannerCandidate,
    snapshot: DispatchState,
  ): PlannerCandidate {
    if (!candidate.valid) {
      // Preserve classification from `runPlannerWithTimeout` / planner
      // fallback; default to `no_plan` for legacy candidates without a kind.
      return {
        ...candidate,
        errorKind: candidate.errorKind ?? "no_plan",
      } satisfies PlannerCandidate;
    }
    const result = validatePlan(candidate.plan, snapshot.fleet, snapshot.pallets);
    if (!result.ok) {
      // The planner *did* reason and submit a plan, it just violated a hard
      // constraint. That's a true infeasibility for the UI to surface.
      return {
        ...candidate,
        valid: false,
        errors: result.errors,
        errorKind: "infeasible",
        cost: computePlanCost(candidate.plan, snapshot.pallets),
      } satisfies PlannerCandidate;
    }
    return { ...candidate, cost: result.view.totalCost };
  }

  private async runPlannerWithTimeout(
    plannerName: string,
    seed: number,
    snapshot: DispatchState,
    newOrder: OrderEvent,
  ): Promise<PlannerCandidate> {
    const start = Date.now();
    try {
      const planner = await this.subAgent(TripPlannerAgent, plannerName);
      const result = await Promise.race<PlannerCandidate>([
        planner.proposePlan({ seed, snapshot, newOrder }),
        new Promise<PlannerCandidate>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `planner ${plannerName} timed out after ${PLANNER_TIMEOUT_LABEL}`,
                ),
              ),
            PLANNER_TIMEOUT_MS,
          ),
        ),
      ]);
      this.recordDirectorAction(
        `planner ${plannerName} ${result.valid ? "valid" : "invalid"}`,
        `seed=${seed} · ${Date.now() - start}ms${
          result.valid ? ` · €${result.cost}` : ""
        }`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      const isTimeout = message.includes("timed out after");
      const errorKind: PlannerCandidate["errorKind"] = isTimeout
        ? "timeout"
        : looksLikeAiBindingFailure(message)
          ? "ai_unreachable"
          : "no_plan";
      this.recordDirectorAction(
        `planner ${plannerName} error`,
        `${errorKind} · ${message} · ${Date.now() - start}ms`,
      );
      return {
        plannerName,
        seed,
        plan: {
          trips: [],
          unassignedPalletIds: snapshot.pallets.map((p) => p.id),
        },
        valid: false,
        errors: [message],
        errorKind,
        submittedAt: Date.now(),
      };
    }
  }

  // ======== Think harness config ========

  getModel() {
    return createCruiseModel(this.env, this.sessionAffinity);
  }

  getSystemPrompt() {
    return buildDirectorPrompt(this.ensureDispatchState());
  }

  getTools(): ToolSet {
    return {
      inspectDispatch: tool({
        description:
          "Read-only: return the current dispatch state (fleet, pallets, currentPlan, pendingOrder, lastRound). Call this before addOrder if you need to check current truck/pallet counts.",
        inputSchema: z.object({}),
        execute: async () => ({
          ok: true,
          data: this.ensureDispatchState(),
        }),
      }),
      addOrder: tool({
        description:
          "Low-level: append pre-built pallets to the order book. Prefer submitOrder which auto-generates pallet ids. Use addOrder only if the dispatcher explicitly provides pallet ids.",
        inputSchema: addOrderInputSchema,
        execute: async (input: AddOrderInput) => {
          try {
            const parsed = addOrderInputSchema.parse(input);
            const order: OrderEvent = {
              orderId: parsed.orderId,
              summary: parsed.summary,
              pallets: parsed.pallets,
              createdAt: Date.now(),
            };
            await this.addOrderInternal(order);
            return {
              ok: true,
              data: {
                orderId: order.orderId,
                palletCount: order.pallets.length,
              },
            };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : "addOrder failed",
            };
          }
        },
      }),
      submitOrder: tool({
        description:
          "Preferred one-shot: add a new order AND run the planner round in a single call. The Director adds pallets (auto-generating ids like P-<orderId>-<n>), then spawns the three Planner sub-agents and commits the cheapest feasible plan. Returns the winner and cost, or the per-planner errors if all three are infeasible.",
        inputSchema: submitOrderInputSchema,
        execute: async (input: SubmitOrderInput) => {
          try {
            const parsed = submitOrderInputSchema.parse(input);
            const order = buildOrderEventFromInput(parsed, this.ensureDispatchState());
            await this.addOrderInternal(order);
            const result = await this.askPlannersInternal(order.orderId);
            if (result.ok) {
              return {
                ok: true,
                data: {
                  orderId: order.orderId,
                  palletCount: order.pallets.length,
                  winner: result.winner,
                  cost: result.winnerCost,
                  summary: result.committedSummary,
                },
              };
            }
            return {
              ok: false,
              errors: result.errors.slice(0, 5),
              candidates: result.candidates.map(summarizeCandidate),
            };
          } catch (error) {
            return {
              ok: false,
              error:
                error instanceof Error ? error.message : "submitOrder failed",
            };
          }
        },
      }),
      askPlanners: tool({
        description:
          "Spawn the three Planner sub-agents in parallel to propose a new plan covering the pending order. Picks the cheapest feasible candidate and replaces currentPlan. If all three are infeasible, currentPlan is left unchanged and the failure reasons are returned.",
        inputSchema: askPlannersInputSchema,
        execute: async ({ orderId }) => {
          const result = await this.askPlannersInternal(orderId);
          if (result.ok) {
            return {
              ok: true,
              data: {
                winner: result.winner,
                cost: result.winnerCost,
                summary: result.committedSummary,
                candidates: result.candidates.map(summarizeCandidate),
              },
            };
          }
          return {
            ok: false,
            errors: result.errors.slice(0, 5),
            candidates: result.candidates.map(summarizeCandidate),
          };
        },
      }),
    };
  }

  // ======== Think lifecycle hooks ========

  beforeTurn(ctx: TurnContext) {
    const state = this.ensureDispatchState();
    this.setState({ ...state, directorThinking: true });
    this.recordDirectorAction(
      "director beforeTurn",
      ctx.continuation ? "continuation" : "new turn",
    );
  }

  beforeToolCall(ctx: ToolCallContext) {
    this.recordDirectorAction(`director tool: ${ctx.toolName}`, "started");
  }

  afterToolCall(ctx: ToolCallResultContext) {
    this.recordDirectorAction(
      `director tool result: ${ctx.toolName}`,
      ctx.success
        ? `ok in ${Math.round(ctx.durationMs)}ms`
        : `error in ${Math.round(ctx.durationMs)}ms`,
    );
  }

  onStepFinish(ctx: StepContext) {
    this.recordDirectorAction(
      "director onStepFinish",
      `finish: ${ctx.finishReason}`,
    );
  }

  onChatResponse(_result: ChatResponseResult) {
    const state = this.ensureDispatchState();
    this.setState({ ...state, directorThinking: false });
    this.recordDirectorAction("director onChatResponse", "completed");
  }

  onChatError(error: unknown) {
    const state = this.ensureDispatchState();
    this.setState({ ...state, directorThinking: false });
    this.recordDirectorAction(
      "director onChatError",
      error instanceof Error ? error.message : "unknown error",
    );
    return super.onChatError(error);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function buildOrderEventFromInput(
  input: SubmitOrderInput,
  state: DispatchState,
): OrderEvent {
  const existingIds = new Set(state.pallets.map((p) => p.id));
  const pallets: Pallet[] = [];
  for (let i = 1; i <= input.pallets; i++) {
    let id = `P-${input.orderId}-${i}`;
    let suffix = 1;
    while (existingIds.has(id)) {
      id = `P-${input.orderId}-${i}-${suffix++}`;
    }
    existingIds.add(id);
    pallets.push({
      id,
      orderId: input.orderId,
      pickup: input.pickup,
      dropoff: input.dropoff,
    });
  }
  return {
    orderId: input.orderId,
    createdAt: Date.now(),
    pallets,
    summary:
      input.summary ??
      `${input.pallets} pallet${input.pallets === 1 ? "" : "s"} ${input.pickup} -> ${input.dropoff}`,
  };
}

function summarizeCandidate(c: PlannerCandidate) {
  return {
    plannerName: c.plannerName,
    seed: c.seed,
    valid: c.valid,
    cost: c.cost,
    errors: c.errors?.slice(0, 3),
    tripCount: c.plan.trips.length,
  };
}

export { DEFAULT_FLEET_SIZE, makeCandidate };
