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

import { INTERNAL_TURN_MESSAGE_ID_PREFIX } from "../shared/messages";
import { submitPlanInputSchema } from "../shared/schemas";
import {
  buildPlannerPrompt,
  computeSessionTrends,
  makeCandidate,
  validatePlan,
} from "../shared/cruise";
import type {
  DispatchState,
  OrderEvent,
  Plan,
  PlannerCandidate,
  PlannerState,
} from "../shared/types";
import {
  createCruiseModel,
  plannerPersonaForName,
} from "./cruiseAgentCore";

// Planner budget: inspectSnapshot + a handful of submitPlan retries when
// validation rejects the first attempt. Default Think maxSteps is 10; 4 was
// too tight — a planner often needs 2–4 retries to land a feasible 30+ pallet
// plan with startMinutes on every trip.
const MAX_PLANNER_TURN_STEPS = 8;
const MAX_RUNTIME_EVENTS = 30;

/**
 * Cap on how many characters of the model's final assistant message we
 * ship back to the Director (and on to the UI) when the planner bails
 * without calling submitPlan. Models occasionally paste the whole plan
 * inline — enough headroom to see the shape without ballooning DO state.
 */
const MAX_ASSISTANT_TAIL_CHARS = 600;

type ProposePlanArgs = {
  seed: number;
  snapshot: DispatchState;
  newOrder?: OrderEvent;
};

/**
 * A single fleet planner. One Think turn per proposePlan call, driven by the
 * Director. Produces a PlannerCandidate by calling submitPlan, which is the
 * only way plan state is persisted — matches the "Model suggests, cruise.ts
 * decides" invariant from AGENTS.md.
 */
export class TripPlannerAgent extends Think<Env, PlannerState> {
  initialState: PlannerState = {
    plannerId: "default",
    plannerThinking: false,
    runtimeEvents: [],
  };
  maxSteps = MAX_PLANNER_TURN_STEPS;

  /** RPC: read current planner state for UI sub-subscriptions. */
  @callable()
  getPlannerState(): PlannerState {
    return this.ensurePlannerState();
  }

  /** RPC: clear state for a fresh round. */
  @callable()
  resetPlanner(): PlannerState {
    const next: PlannerState = {
      plannerId: this.name,
      plannerThinking: false,
      runtimeEvents: [],
    };
    this.setState(next);
    this.clearMessages();
    return next;
  }

  /**
   * RPC: Director asks for a candidate plan. We set thinking=true, stash the
   * snapshot + newOrder on state (so the submitPlan tool can read them), run
   * one Think turn driven by an internal prompt, and return whatever candidate
   * the tool produced. If no candidate is produced, return an infeasible one.
   */
  @callable()
  async proposePlan(args: ProposePlanArgs): Promise<PlannerCandidate> {
    const base = this.ensurePlannerState();

    const prepared: PlannerState = {
      ...base,
      plannerId: this.name,
      systemId: args.snapshot.systemId,
      snapshot: args.snapshot,
      newOrder: args.newOrder,
      lastCandidate: undefined,
      plannerThinking: true,
      lastPromptAt: Date.now(),
    };
    this.setState(prepared);

    try {
      const persona = plannerPersonaForName(this.name);
      const trends = persona.useSessionTrends
        ? computeSessionTrends(args.snapshot)
        : undefined;
      const prompt = buildPlannerPrompt(
        args.snapshot,
        args.newOrder,
        persona,
        trends,
      );
      console.log(
        `[planner:${this.name}] proposePlan start seed=${args.seed} persona=${persona.label} reasoning=${persona.reasoningEffort} promptLen=${prompt.length}`,
      );

      const result = await this.saveMessages([
        {
          id: `${INTERNAL_TURN_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: prompt }],
        },
      ]);
      console.log(
        `[planner:${this.name}] saveMessages returned status=${result.status} requestId=${result.requestId}`,
      );

      let after = this.ensurePlannerState();
      let messageCount = this.getMessages().length;
      let lastMessage = this.getMessages().at(-1);
      console.log(
        `[planner:${this.name}] post-turn lastCandidate=${
          after.lastCandidate ? after.lastCandidate.valid : "none"
        } messages=${messageCount} lastRole=${lastMessage?.role}`,
      );
      if (after.lastCandidate) {
        return after.lastCandidate;
      }

      let assistantTail = extractAssistantText(lastMessage);
      if (assistantTail) {
        console.log(
          `[planner:${this.name}] assistant text (no tool call, attempt 1) firstChars=${assistantTail.slice(0, 200)}`,
        );
      }

      // Auto-retry once with a directive reminder. The most common
      // no_plan failure (especially with low reasoning_effort) is the
      // model ending its turn with prose instead of calling submitPlan.
      // A short, blunt reminder nudges it into the tool-use path
      // without changing the domain prompt. Bounded to exactly one
      // retry so we can't loop.
      this.recordRuntimeEvent(
        "planner no-tool retry",
        assistantTail
          ? `Model finished without submitPlan. Tail: ${truncate(assistantTail, 120)}`
          : "Model finished without submitPlan.",
      );
      const reminder = buildNoToolReminder(assistantTail);
      const retryResult = await this.saveMessages([
        {
          id: `${INTERNAL_TURN_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: reminder }],
        },
      ]);
      console.log(
        `[planner:${this.name}] retry saveMessages returned status=${retryResult.status} requestId=${retryResult.requestId}`,
      );

      after = this.ensurePlannerState();
      messageCount = this.getMessages().length;
      lastMessage = this.getMessages().at(-1);
      console.log(
        `[planner:${this.name}] post-retry lastCandidate=${
          after.lastCandidate ? after.lastCandidate.valid : "none"
        } messages=${messageCount} lastRole=${lastMessage?.role}`,
      );
      if (after.lastCandidate) {
        return after.lastCandidate;
      }

      // Retry also bailed — capture whatever the model said and give up.
      const retryTail = extractAssistantText(lastMessage);
      if (retryTail) {
        assistantTail = retryTail;
        console.log(
          `[planner:${this.name}] assistant text (no tool call, attempt 2) firstChars=${retryTail.slice(0, 200)}`,
        );
      }

      const fallback: PlannerCandidate = {
        plannerName: this.name,
        seed: args.seed,
        plan: { trips: [], unassignedPalletIds: args.snapshot.pallets.map((p) => p.id) },
        valid: false,
        errors: ["Planner did not submit a plan (retried once)."],
        errorKind: "no_plan",
        submittedAt: Date.now(),
        assistantTail: assistantTail
          ? truncate(assistantTail, MAX_ASSISTANT_TAIL_CHARS)
          : undefined,
      };
      this.setState({ ...after, lastCandidate: fallback });
      return fallback;
    } catch (error) {
      console.error(
        `[planner:${this.name}] proposePlan threw`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    } finally {
      const current = this.ensurePlannerState();
      this.setState({ ...current, plannerThinking: false });
    }
  }

  private ensurePlannerState(): PlannerState {
    if (this.state.plannerId === this.name && this.state.runtimeEvents) {
      return this.state;
    }
    const next: PlannerState = {
      ...this.state,
      plannerId: this.name,
      plannerThinking: this.state.plannerThinking ?? false,
      runtimeEvents: this.state.runtimeEvents ?? [],
    };
    this.setState(next);
    return next;
  }

  // ======== Think harness config ========

  getModel() {
    const state = this.ensurePlannerState();
    const lastDigit = state.plannerId.match(/(\d+)$/);
    const seed = lastDigit ? lastDigit[1] : state.plannerId;
    const persona = plannerPersonaForName(state.plannerId);
    return createCruiseModel(this.env, seed, {
      reasoningEffort: persona.reasoningEffort,
    });
  }

  getSystemPrompt() {
    return `You are a fleet planner sub-agent for Cruise, a refrigerated trucking dispatch prototype.

You never speak in character. You plan trips.

When given a planner turn prompt, call inspectSnapshot if you need the raw state again, then call submitPlan exactly once with a complete plan that covers every pallet in the order book (including any new order mentioned in the prompt). If submitPlan returns ok:false, read the errors and try again — you have a limited number of steps.

Never claim a plan was accepted unless submitPlan returns ok:true.`;
  }

  getTools(): ToolSet {
    return {
      inspectSnapshot: tool({
        description:
          "Read-only: return the current dispatch snapshot (fleet, pallets, committed plan, travel matrix, new order).",
        inputSchema: z.object({}),
        execute: async () => {
          const state = this.ensurePlannerState();
          return {
            ok: true,
            data: {
              snapshot: state.snapshot,
              newOrder: state.newOrder,
            },
          };
        },
      }),
      submitPlan: tool({
        description:
          "Submit a complete plan for tomorrow. The plan is validated via cruise.ts; if invalid, the errors are returned and you may try again.",
        inputSchema: submitPlanInputSchema,
        execute: async ({ plan }) => {
          const state = this.ensurePlannerState();
          const snapshot = state.snapshot;
          if (!snapshot) {
            this.recordRuntimeEvent(
              "submitPlan aborted",
              "No snapshot available",
            );
            return {
              ok: false,
              errors: ["No snapshot available — proposePlan was not called."],
            };
          }

          const result = validatePlan(plan as Plan, snapshot.fleet, snapshot.pallets);
          const candidate = makeCandidate(
            this.name,
            seedFromName(this.name),
            plan as Plan,
            result,
            snapshot.pallets,
          );
          this.setState({ ...state, lastCandidate: candidate });

          if (result.ok) {
            this.recordRuntimeEvent(
              "submitPlan accepted",
              `€${candidate.cost} · ${result.view.trucksUsed} truck(s) · ${(plan as Plan).trips.length} trip(s)`,
            );
            return {
              ok: true,
              data: {
                cost: candidate.cost,
                trucksUsed: result.view.trucksUsed,
                totalDrivingHours: result.view.totalDrivingHours,
              },
            };
          }

          this.recordRuntimeEvent(
            "submitPlan rejected",
            `${result.errors.length} error(s): ${result.errors.slice(0, 2).join("; ")}`,
          );
          return { ok: false, errors: result.errors };
        },
      }),
    };
  }

  // ======== Think lifecycle hooks (runtime timeline) ========

  beforeTurn(ctx: TurnContext) {
    this.recordRuntimeEvent(
      "planner beforeTurn",
      ctx.continuation ? "continuation" : "new turn",
    );
  }

  beforeToolCall(ctx: ToolCallContext) {
    this.recordRuntimeEvent(`planner tool: ${ctx.toolName}`, "started");
  }

  afterToolCall(ctx: ToolCallResultContext) {
    this.recordRuntimeEvent(
      `planner tool result: ${ctx.toolName}`,
      ctx.success
        ? `ok in ${Math.round(ctx.durationMs)}ms`
        : `error in ${Math.round(ctx.durationMs)}ms`,
    );
  }

  onStepFinish(ctx: StepContext) {
    this.recordRuntimeEvent("planner onStepFinish", `finish: ${ctx.finishReason}`);
  }

  onChatResponse(_result: ChatResponseResult) {
    this.recordRuntimeEvent("planner onChatResponse", "completed");
  }

  onChatError(error: unknown) {
    this.recordRuntimeEvent(
      "planner onChatError",
      error instanceof Error ? error.message : "Unknown error",
    );
    return super.onChatError(error);
  }

  private recordRuntimeEvent(label: string, detail?: string) {
    const state = this.ensurePlannerState();
    const runtimeEvents = [
      ...state.runtimeEvents,
      { id: crypto.randomUUID(), at: Date.now(), label, detail },
    ].slice(-MAX_RUNTIME_EVENTS);
    this.setState({ ...state, runtimeEvents });
  }
}

function seedFromName(name: string): number {
  const match = name.match(/-(\d+)$/);
  return match ? Number(match[1]) : 1;
}

/**
 * Prompt we inject if the model ends its first turn without calling
 * `submitPlan`. Short and directive — the model has already seen the full
 * planner prompt, so repeating it doesn't help; what helps is an
 * unambiguous instruction to stop producing prose and invoke the tool.
 *
 * If we captured the model's own prose, we quote a snippet back at it so
 * it's obvious *what* it just did wrong, which consistently outperforms a
 * content-free reminder in small-model evals.
 */
function buildNoToolReminder(previousText: string | undefined): string {
  const base = [
    "Your previous response did not call `submitPlan`. That is a hard requirement.",
    "Do not produce prose, analysis, or JSON in chat. Call the `submitPlan` tool exactly once, with a complete plan that assigns every pallet in the order book to exactly one trip.",
    "If you need to re-read the snapshot, call `inspectSnapshot` first. Then call `submitPlan`. Do not reply with text.",
  ];
  if (previousText && previousText.trim().length > 0) {
    const snippet = truncate(previousText.trim(), 200);
    base.unshift(
      `You just replied with: "${snippet}"${previousText.length > 200 ? "…" : ""}`,
    );
  }
  return base.join("\n\n");
}

function extractAssistantText(
  message: ReturnType<TripPlannerAgent["getMessages"]>[number] | undefined,
): string | undefined {
  if (!message || message.role !== "assistant") return undefined;
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => ("text" in p ? p.text : ""))
    .join("");
  return text.trim().length > 0 ? text : undefined;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
