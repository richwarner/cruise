import {
  Think,
  type ChatResponseResult,
  type StepContext,
  type ToolCallContext,
  type ToolCallResultContext,
  type TurnContext,
} from "@cloudflare/think";
import { callable } from "agents";
import { type ToolSet } from "ai";

import {
  DEFAULT_FLEET_SIZE,
  createInitialDispatchState,
} from "../shared/dispatch";
import type { DirectorAction, DispatchState } from "../shared/types";
import { createCruiseModel } from "./cruiseAgentCore";

const MAX_DIRECTOR_ACTIONS = 40;

/**
 * Phase 3 stub: the Director owns dispatch state and broadcasts it to connected
 * clients via Think's WebSocket. It does NOT yet spawn planners or expose
 * chat tools — those arrive in Phase 4 (parallel spawn) and Phase 5 (chat UX).
 *
 * The RPC surface is intentionally narrow so the Control Room UI has a stable
 * contract to render against:
 *   - getDispatch(): one-shot read
 *   - resetDispatch(): re-seed
 *   - resizeFleet(n): re-seed with a new fleet size (forces infeasibility demos)
 */
export class DispatchDirectorAgent extends Think<Env, DispatchState> {
  initialState = createInitialDispatchState("default");

  @callable()
  async getDispatch(): Promise<DispatchState> {
    return this.ensureDispatchState();
  }

  @callable()
  async resetDispatch(): Promise<DispatchState> {
    const base = createInitialDispatchState(this.name);
    const state = this.withAction(base, "Reset dispatch", `systemId=${this.name}`);
    this.setState(state);
    this.clearMessages();
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
    return state;
  }

  private ensureDispatchState(): DispatchState {
    if (this.state.systemId === this.name) {
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

  // ======== Think harness config (placeholder; Phase 5 fills in chat) ========

  getModel() {
    return createCruiseModel(this.env, this.sessionAffinity);
  }

  getSystemPrompt() {
    return `You are the dispatch director for Cruise, a refrigerated trucking prototype.

This is a Phase 3 placeholder. You currently have no tools and do not delegate to Planner sub-agents. Phase 4 will add addOrder/askPlanners tools; Phase 5 will teach you the dispatcher's order-entry grammar. For now, acknowledge dispatcher messages politely and note that the system is in read-only Control Room mode.`;
  }

  getTools(): ToolSet {
    return {};
  }

  // ======== Think lifecycle hooks — action log ========

  beforeTurn(ctx: TurnContext) {
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

  private recordDirectorAction(label: string, detail?: string) {
    const state = this.ensureDispatchState();
    this.setState(this.withAction(state, label, detail));
  }
}

export { DEFAULT_FLEET_SIZE };
