import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { BrainIcon } from "@phosphor-icons/react";

import { plannerPersonaForSeed } from "../../shared/personas";
import type {
  DispatchState,
  PlannerCandidate,
  PlannerState,
} from "../../shared/types";

type PlannerActivityPanelProps = {
  dispatch: DispatchState | undefined;
  plannerStates: PlannerState[];
  isSubmittingOrder: boolean;
};

const RECENT_EVENT_COUNT = 4;

/**
 * Read-only side panel showing per-planner live activity. Merges two sources:
 *   - `dispatch.lastRound` broadcast by the Director (final candidate per
 *     planner, with cost/errors),
 *   - `plannerStates` polled 1x/s via the Director's `getAllPlannerStates`
 *     RPC (runtime events + `plannerThinking` flag for live traces).
 * Renders "thinking" mode while a planner is still working, swaps to final
 * candidate stats once it completes. Phase 5 replaces this with the Director
 * chat.
 */
export function PlannerActivityPanel({
  dispatch,
  plannerStates,
  isSubmittingOrder,
}: PlannerActivityPanelProps) {
  const plannerNames = dispatch?.plannerAgentNames ?? [];
  const lastRound = dispatch?.lastRound ?? [];
  const hasAnyActivity =
    lastRound.length > 0 ||
    plannerStates.some(
      (s) => s.plannerThinking || (s.runtimeEvents?.length ?? 0) > 0,
    );

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
            picks the cheapest valid candidate. Replaced by Director chat in
            Phase 5.
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
              Hit “Submit test order” in the header to fan three Planners out
              in parallel.
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
};

function PlannerRow({
  plannerName,
  seed,
  candidate,
  plannerState,
  isWinner,
}: PlannerRowProps) {
  const thinking = plannerState?.plannerThinking ?? false;
  const recentEvents = (plannerState?.runtimeEvents ?? []).slice(
    -RECENT_EVENT_COUNT,
  );

  const statusLabel = thinking
    ? "thinking"
    : candidate
      ? candidate.valid
        ? "valid"
        : "invalid"
      : "waiting";

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

  return (
    <article className={className}>
      <header className="planner-card-header">
        <span className="planner-card-name">{plannerName}</span>
        <span
          className="planner-card-persona"
          data-persona={persona.keyword}
          title={`${persona.label} · reasoning=${persona.reasoningEffort}${persona.useSessionTrends ? " · uses session trends" : ""}`}
        >
          {persona.label}
        </span>
        <span className="planner-card-seed">seed {seed}</span>
      </header>

      <dl className="planner-card-stats">
        <div>
          <dt>Status</dt>
          <dd>{statusLabel}</dd>
        </div>
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
      </dl>

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

      {isWinner ? <div className="planner-card-winner-tag">WINNER</div> : null}
    </article>
  );
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

function truncateDetail(detail: string, max = 100): string {
  if (detail.length <= max) return detail;
  return `${detail.slice(0, max)}…`;
}
