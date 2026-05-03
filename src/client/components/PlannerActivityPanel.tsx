import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { BrainIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { tripCarriedPalletIds } from "../../shared/cruise";
import { plannerPersonaForSeed } from "../../shared/personas";
import type {
  DispatchState,
  PlannerCandidate,
  PlannerErrorKind,
  PlannerState,
  RuntimeEvent,
  Trip,
} from "../../shared/types";

type PlannerActivityPanelProps = {
  dispatch: DispatchState | undefined;
  plannerStates: PlannerState[];
  isSubmittingOrder: boolean;
};

const RECENT_EVENT_PREVIEW = 4;

/**
 * Read-only side panel showing per-planner live activity. Merges two sources:
 *   - `dispatch.lastRound` broadcast by the Director (final candidate per
 *     planner, with cost/errors),
 *   - `plannerStates` polled 1x/s via the Director's `getAllPlannerStates`
 *     RPC (runtime events + `plannerThinking` flag for live traces).
 *
 * Each card surfaces a "stage" derived from the runtime event log (so the
 * operator can tell at a glance whether a planner is reading the snapshot,
 * drafting, or retrying after a rejected plan), a live elapsed-time counter
 * while thinking, the number of `submitPlan` attempts, a collapsible plan
 * preview once a candidate exists, and a collapsible full runtime log.
 */
export function PlannerActivityPanel({
  dispatch,
  plannerStates,
  isSubmittingOrder,
}: PlannerActivityPanelProps) {
  const plannerNames = dispatch?.plannerAgentNames ?? [];
  const lastRound = dispatch?.lastRound ?? [];
  const anyThinking = plannerStates.some((s) => s.plannerThinking);

  const hasAnyActivity =
    lastRound.length > 0 ||
    plannerStates.some(
      (s) => s.plannerThinking || (s.runtimeEvents?.length ?? 0) > 0,
    );

  // Drive a 500ms tick whenever a planner is thinking so the elapsed-time
  // counters re-render without requiring websocket traffic. Stops when all
  // planners are idle to avoid pointless re-renders.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!anyThinking) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, [anyThinking]);

  const status = isSubmittingOrder
    ? "Planners running…"
    : dispatch?.directorThinking
      ? "Director thinking…"
      : "Idle";

  return (
    <LayerCard className="panel side-panel agent-chat-shell">
      <header className="agent-chat-header">
        <div>
          <Text variant="heading2">Planner Activity</Text>
          <Text variant="secondary">
            Live trace of the three parallel Planner sub-agents. The Director
            picks the cheapest valid candidate.
          </Text>
        </div>
        <div className="agent-chat-header-actions">
          <div
            className="agent-chat-status"
            data-active={isSubmittingOrder ? "true" : "false"}
          >
            {status}
          </div>
        </div>
      </header>

      <div className="planner-activity-body">
        {!hasAnyActivity ? (
          <div className="agent-chat-empty">
            <BrainIcon size={28} />
            <Text bold>No rounds yet.</Text>
            <Text variant="secondary">
              Hit “Submit test order” in the header to fan three Planners out in
              parallel.
            </Text>
          </div>
        ) : (
          <div className="planner-activity-cards">
            {plannerNames.map((name, idx) => {
              const candidate = lastRound.find((c) => c.plannerName === name);
              const plannerState = plannerStates.find(
                (s) => s.plannerId === name,
              );
              return (
                <PlannerRow
                  key={name}
                  plannerName={name}
                  seed={idx + 1}
                  candidate={candidate}
                  plannerState={plannerState}
                  isWinner={
                    candidate ? isWinningCandidate(candidate, lastRound) : false
                  }
                  snapshotPalletCount={dispatch?.pallets.length ?? 0}
                />
              );
            })}
          </div>
        )}
      </div>
    </LayerCard>
  );
}

type PlannerRowProps = {
  plannerName: string;
  seed: number;
  candidate: PlannerCandidate | undefined;
  plannerState: PlannerState | undefined;
  isWinner: boolean;
  snapshotPalletCount: number;
};

function PlannerRow({
  plannerName,
  seed,
  candidate,
  plannerState,
  isWinner,
  snapshotPalletCount,
}: PlannerRowProps) {
  const thinking = plannerState?.plannerThinking ?? false;
  const runtimeEvents = plannerState?.runtimeEvents ?? [];
  const recentEvents = runtimeEvents.slice(-RECENT_EVENT_PREVIEW);

  const attempts = countSubmitAttempts(runtimeEvents);
  const stage = derivePlannerStage({ thinking, candidate, runtimeEvents });
  const elapsed = computeElapsedMs({ plannerState, candidate, thinking });

  const className = [
    "planner-card",
    candidate?.valid ? "planner-card--valid" : "",
    candidate && !candidate.valid ? "planner-card--invalid" : "",
    thinking ? "planner-card--thinking" : "",
    isWinner ? "planner-card--winner" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const persona = plannerPersonaForSeed(seed);
  const personaTitle = `${persona.label} · reasoning=${persona.reasoningEffort}${persona.useSessionTrends ? " · uses session trends" : ""}`;

  return (
    <article className={className}>
      <header className="planner-card-header">
        <span className="planner-card-name">{plannerName}</span>
        <span
          className="planner-card-persona"
          data-persona={persona.keyword}
          title={personaTitle}
        >
          {persona.label}
        </span>
        <span className="planner-card-seed">seed {seed}</span>
      </header>

      <div className="planner-card-meta">
        <span
          className="planner-card-effort"
          title={`Workers AI reasoning_effort = ${persona.reasoningEffort}`}
        >
          effort · {persona.reasoningEffort}
        </span>
        {persona.useSessionTrends ? (
          <span
            className="planner-card-effort"
            title="This persona is given a session-trends summary in its prompt."
          >
            + session trends
          </span>
        ) : null}
        {candidate && !candidate.valid && candidate.errorKind ? (
          <span
            className="planner-card-errorkind"
            data-kind={candidate.errorKind}
            title={errorKindTooltip(candidate.errorKind)}
          >
            {errorKindLabel(candidate.errorKind)}
          </span>
        ) : null}
      </div>

      <div
        className="planner-card-stage"
        data-kind={stage.kind}
        title={stage.tooltip}
      >
        <span className="planner-card-stage-dot" aria-hidden="true" />
        <span className="planner-card-stage-label">{stage.label}</span>
        {elapsed !== null ? (
          <span
            className="planner-card-stage-timer"
            title={
              thinking
                ? "Time since Director dispatched this planner."
                : "Wall-clock time between dispatch and submitted candidate."
            }
          >
            {formatDuration(elapsed)}
          </span>
        ) : null}
        {attempts > 0 ? (
          <span
            className="planner-card-stage-attempts"
            title="submitPlan tool calls this round (accepted + rejected)."
          >
            attempt {attempts}
          </span>
        ) : null}
      </div>

      <dl className="planner-card-stats">
        <div>
          <dt>Trips</dt>
          <dd>{candidate ? candidate.plan.trips.length : "—"}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            {candidate && typeof candidate.cost === "number"
              ? `€${candidate.cost.toFixed(0)}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Pallets</dt>
          <dd>
            {candidate
              ? `${countCarriedPallets(candidate.plan.trips)}/${snapshotPalletCount}`
              : "—"}
          </dd>
        </div>
      </dl>

      {candidate && candidate.plan.trips.length > 0 ? (
        <details className="planner-card-plan">
          <summary>
            Plan preview ({candidate.plan.trips.length} trip
            {candidate.plan.trips.length === 1 ? "" : "s"})
          </summary>
          <ul>
            {candidate.plan.trips.map((trip) => (
              <li key={trip.id}>
                <span className="planner-card-plan-truck">
                  {trip.truckId.replace(/^TRK-/, "T")}
                </span>
                <span className="planner-card-plan-route">
                  {formatTripRoute(trip)}
                </span>
                <span className="planner-card-plan-pallets">
                  {tripCarriedPalletIds(trip).length}p
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {recentEvents.length > 0 ? (
        <ol className="planner-card-events">
          {recentEvents.map((ev) => (
            <li key={ev.id}>
              <time>{formatEventTime(ev.at)}</time>
              <span>{ev.label}</span>
              {ev.detail ? <em>{truncateDetail(ev.detail)}</em> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {runtimeEvents.length > RECENT_EVENT_PREVIEW ? (
        <details className="planner-card-fulllog">
          <summary>Full runtime log ({runtimeEvents.length} events)</summary>
          <ol>
            {runtimeEvents.map((ev) => (
              <li key={ev.id}>
                <time>{formatEventTime(ev.at)}</time>
                <span>{ev.label}</span>
                {ev.detail ? <em>{ev.detail}</em> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {candidate?.errors && candidate.errors.length > 0 ? (
        <details className="planner-card-errors">
          <summary>{candidate.errors.length} validation error(s)</summary>
          <ul>
            {candidate.errors.slice(0, 5).map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
            {candidate.errors.length > 5 ? (
              <li>…and {candidate.errors.length - 5} more</li>
            ) : null}
          </ul>
        </details>
      ) : null}

      {candidate?.errorKind === "no_plan" && candidate.assistantTail ? (
        <details className="planner-card-assistant-tail" open>
          <summary>What the model said instead</summary>
          <blockquote>{candidate.assistantTail}</blockquote>
          <p className="planner-card-assistant-tail-note">
            The planner returned prose instead of calling <code>submitPlan</code>,
            even after a directive retry. Usually means the model got confused
            about the task or decided the plan was infeasible and said so in
            chat.
          </p>
        </details>
      ) : null}

      {isWinner ? <div className="planner-card-winner-tag">WINNER</div> : null}
    </article>
  );
}

// =============================================================================
// Stage derivation
// =============================================================================

type PlannerStageKind =
  | "idle"
  | "waiting"
  | "reasoning"
  | "reading"
  | "validating"
  | "retrying"
  | "accepted"
  | "rejected"
  | "error"
  | "infeasible"
  | "timeout";

type StageInfo = {
  kind: PlannerStageKind;
  label: string;
  tooltip: string;
};

/**
 * Map the tail of the runtime event log into a human-readable "what is this
 * planner doing right now?" label. We lean on event labels (see
 * `TripPlannerAgent.recordRuntimeEvent`) so we don't need to invent a new
 * transport channel.
 */
function derivePlannerStage({
  thinking,
  candidate,
  runtimeEvents,
}: {
  thinking: boolean;
  candidate: PlannerCandidate | undefined;
  runtimeEvents: RuntimeEvent[];
}): StageInfo {
  if (!thinking && !candidate && runtimeEvents.length === 0) {
    return {
      kind: "idle",
      label: "Idle",
      tooltip: "Planner has not been dispatched this session.",
    };
  }
  if (!thinking && candidate) {
    if (candidate.valid) {
      return {
        kind: "accepted",
        label: "Plan accepted",
        tooltip: "submitPlan returned ok:true and the candidate is feasible.",
      };
    }
    const kind = candidate.errorKind;
    if (kind === "timeout") {
      return {
        kind: "timeout",
        label: "Timed out",
        tooltip:
          "Director gave up waiting for this planner after PLANNER_TIMEOUT_MS.",
      };
    }
    if (kind === "ai_unreachable") {
      return {
        kind: "error",
        label: "AI unreachable",
        tooltip:
          "Workers AI binding returned an auth / gateway error — planner never got to reason.",
      };
    }
    if (kind === "no_plan") {
      return {
        kind: "error",
        label: "No plan",
        tooltip:
          "Model ran to step budget without ever calling submitPlan. Usually means it refused or got confused.",
      };
    }
    return {
      kind: "infeasible",
      label: "Infeasible",
      tooltip:
        "Planner returned a plan that failed validator constraints (capacity, hours, etc.).",
    };
  }

  const lastEvent = runtimeEvents.at(-1);
  if (lastEvent) {
    if (lastEvent.label === "submitPlan accepted") {
      return {
        kind: "accepted",
        label: "Plan accepted",
        tooltip: "Last action: submitPlan returned ok:true.",
      };
    }
    if (lastEvent.label === "submitPlan rejected") {
      return {
        kind: "retrying",
        label: "Rejected — retrying",
        tooltip: `Validator rejected the last submitPlan: ${lastEvent.detail ?? "(no detail)"}`,
      };
    }
    if (lastEvent.label === "planner tool: inspectSnapshot") {
      return {
        kind: "reading",
        label: "Reading snapshot",
        tooltip: "Planner is pulling the current dispatch snapshot via inspectSnapshot.",
      };
    }
    if (lastEvent.label === "planner tool: submitPlan") {
      return {
        kind: "validating",
        label: "Validating plan",
        tooltip: "Planner is running submitPlan — cruise.ts is validating.",
      };
    }
    if (lastEvent.label === "planner onChatError") {
      return {
        kind: "error",
        label: "Model error",
        tooltip: `Chat error: ${lastEvent.detail ?? "(no detail)"}`,
      };
    }
  }

  if (thinking) {
    return {
      kind: "reasoning",
      label: "Reasoning",
      tooltip: "Model is producing tokens — no tool call in flight.",
    };
  }
  return {
    kind: "waiting",
    label: "Waiting",
    tooltip: "Planner has not been dispatched yet this round.",
  };
}

function countSubmitAttempts(events: RuntimeEvent[]): number {
  let n = 0;
  for (const ev of events) {
    if (
      ev.label === "submitPlan accepted" ||
      ev.label === "submitPlan rejected"
    ) {
      n++;
    }
  }
  return n;
}

function computeElapsedMs({
  plannerState,
  candidate,
  thinking,
}: {
  plannerState: PlannerState | undefined;
  candidate: PlannerCandidate | undefined;
  thinking: boolean;
}): number | null {
  const start = plannerState?.lastPromptAt;
  if (start === undefined) return null;
  if (thinking) return Date.now() - start;
  if (candidate) {
    const end = candidate.submittedAt;
    if (typeof end === "number" && end >= start) return end - start;
  }
  return null;
}

function countCarriedPallets(trips: Trip[]): number {
  let total = 0;
  for (const trip of trips) total += tripCarriedPalletIds(trip).length;
  return total;
}

function formatTripRoute(trip: Trip): string {
  const cities: string[] = [];
  let prev: string | null = null;
  for (const stop of trip.stops) {
    if (stop.city !== prev) {
      cities.push(stop.city);
      prev = stop.city;
    }
  }
  return cities.length === 0 ? "—" : cities.join(" → ");
}

function errorKindLabel(kind: PlannerErrorKind): string {
  switch (kind) {
    case "infeasible":
      return "infeasible";
    case "no_plan":
      return "no plan";
    case "timeout":
      return "timeout";
    case "ai_unreachable":
      return "AI down";
  }
}

function errorKindTooltip(kind: PlannerErrorKind): string {
  switch (kind) {
    case "infeasible":
      return "Plan violated validator constraints (capacity, hours, coverage).";
    case "no_plan":
      return "Planner exhausted its step budget without calling submitPlan.";
    case "timeout":
      return "Director gave up waiting for this planner after PLANNER_TIMEOUT_MS.";
    case "ai_unreachable":
      return "Workers AI binding returned an auth / gateway error.";
  }
}

function isWinningCandidate(
  candidate: PlannerCandidate,
  round: PlannerCandidate[],
): boolean {
  if (!candidate.valid) return false;
  const valid = round.filter(
    (c) => c.valid && typeof c.cost === "number",
  ) as Array<PlannerCandidate & { valid: true; cost: number }>;
  if (valid.length === 0) return false;
  const best = valid.reduce((a, b) => (a.cost <= b.cost ? a : b));
  return best.plannerName === candidate.plannerName;
}

function formatEventTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function truncateDetail(detail: string, max = 100): string {
  if (detail.length <= max) return detail;
  return `${detail.slice(0, max)}…`;
}
