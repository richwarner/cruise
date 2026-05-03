import type { useAgentChat } from "@cloudflare/ai-chat/react";

import { pickCheapestFeasible } from "../../shared/cruise";
import type {
  DirectorAction,
  DispatchState,
  RoundResult,
} from "../../shared/types";
import { AgentPanel } from "./AgentPanel";

type DirectorChatPanelProps = {
  /**
   * Director DO connection from `useAgent`. Sharing the stub means chat
   * rides the same WebSocket as state sync — no extra sub-subscription —
   * which is what keeps Phase 5 clear of the planner-starvation + render-
   * loop problems we hit in Phase 4.
   */
  agent: Parameters<typeof useAgentChat>[0]["agent"];
  dispatch: DispatchState | undefined;
  directorActions: DirectorAction[];
  onResponseComplete?: () => void;
};

export function DirectorChatPanel({
  agent,
  dispatch,
  directorActions,
  onResponseComplete,
}: DirectorChatPanelProps) {
  const roundSummary = buildRoundChip(dispatch);
  const history = dispatch?.recentRounds ?? [];

  return (
    <AgentPanel
      agent={agent}
      title="Dispatch Director"
      description={
        "Chat with the Director. Describe new orders in plain English (e.g. " +
        "“New order: 3 pallets Porto → Faro”); it will call submitOrder and report the winner."
      }
      placeholder="New order: 2 pallets Lisbon to Braga…"
      showRuntimeTimeline={true}
      runtimeEvents={directorActions}
      runtimeEmptyDescription="Submit an order to watch the Director reason and call tools."
      emptyTitle="Ask the Director."
      emptyDescription={
        "Describe a new order in plain English, or click one of the quick prompts below."
      }
      suggestedPrompts={DIRECTOR_SUGGESTED_PROMPTS}
      headerAccessory={
        roundSummary ? (
          <div
            className="director-round-chip"
            data-variant={roundSummary.variant}
            title={roundSummary.tooltip}
          >
            {roundSummary.text}
          </div>
        ) : undefined
      }
      afterHeader={
        history.length > 0 ? (
          <section
            className="director-round-history"
            aria-label="Committed rounds this session"
          >
            <div className="director-round-history-label">
              <span>Committed rounds</span>
              {history.length >= 2 ? (
                <CostSparkline rounds={history} />
              ) : null}
            </div>
            <ol className="director-round-history-list">
              {history.slice(-MAX_HISTORY_PILLS).map((round) => (
                // Compose the key from orderId + committedAt: roundId alone
                // can collide when a Durable Object evicts and its in-memory
                // `currentRoundId` counter restarts at 0 (recentRounds is
                // persisted across evictions; the counter is not).
                <RoundHistoryPill
                  key={`${round.orderId}-${round.committedAt}`}
                  round={round}
                />
              ))}
            </ol>
          </section>
        ) : undefined
      }
      onResponseComplete={onResponseComplete}
    />
  );
}

const MAX_HISTORY_PILLS = 6;

/**
 * Tiny inline SVG sparkline of `cost` over the last ~10 committed rounds.
 * Shows whether the Director is converging on a cheaper plan over the
 * session or drifting upward as orders pile on. Read-only — no tooltips,
 * clicks, or axes (the pills below carry the detail).
 */
function CostSparkline({ rounds }: { rounds: RoundResult[] }) {
  const width = 90;
  const height = 16;
  const padX = 2;
  const padY = 2;

  const costs = rounds.map((r) => r.cost);
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  const range = max - min || 1;

  const stepX = rounds.length > 1 ? (width - padX * 2) / (rounds.length - 1) : 0;
  const points = costs
    .map((cost, i) => {
      const x = padX + i * stepX;
      // Invert y so lower cost is higher on the chart.
      const y = padY + (1 - (cost - min) / range) * (height - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const last = costs[costs.length - 1];
  const first = costs[0];
  const overall = last - first;
  const overallClass =
    overall < 0 ? "cruise-down" : overall > 0 ? "cruise-up" : "cruise-flat";

  return (
    <svg
      className={`director-round-sparkline ${overallClass}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={`Session cost trend: first €${first.toFixed(0)}, latest €${last.toFixed(0)}`}
      role="img"
    >
      <polyline points={points} fill="none" strokeWidth={1.25} />
      {costs.map((cost, i) => {
        const x = padX + i * stepX;
        const y = padY + (1 - (cost - min) / range) * (height - padY * 2);
        const isLast = i === costs.length - 1;
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={isLast ? 1.8 : 1.1}
            className={isLast ? "spark-last" : undefined}
          />
        );
      })}
    </svg>
  );
}

function RoundHistoryPill({ round }: { round: RoundResult }) {
  const delta = round.cost - round.priorCost;
  const deltaSign = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const deltaText =
    delta === 0 ? "±€0" : `${delta > 0 ? "+" : "−"}€${Math.abs(delta).toFixed(0)}`;
  const shortPlanner = round.winnerPlanner.replace(/^.*planner-/, "p");

  return (
    <li
      className="director-round-pill"
      data-delta={deltaSign}
      title={
        `${round.orderId} · ${round.winnerPlanner} seed ${round.winnerSeed} · ` +
        `€${round.cost.toFixed(0)} (${deltaText}) · ${round.tripCount} trip(s)`
      }
    >
      <span className="director-round-pill-order">{round.orderId}</span>
      <span className="director-round-pill-cost">€{round.cost.toFixed(0)}</span>
      <span className="director-round-pill-delta" data-delta={deltaSign}>
        {deltaText}
      </span>
      <span className="director-round-pill-planner">{shortPlanner}</span>
    </li>
  );
}

const DIRECTOR_SUGGESTED_PROMPTS: Array<{ label: string; text: string }> = [
  {
    label: "Order: 3 pallets Porto → Faro",
    text: "New order: 3 pallets Porto → Faro",
  },
  {
    label: "Order: 2 pallets Lisbon → Braga",
    text: "New order: 2 pallets Lisbon → Braga",
  },
  {
    label: "Inspect current plan",
    text: "Inspect the current dispatch state and summarize tomorrow's plan in 2–3 sentences.",
  },
];

type RoundChip = {
  text: string;
  tooltip: string;
  variant: "winner" | "failure" | "ai_unreachable";
};

function buildRoundChip(dispatch: DispatchState | undefined): RoundChip | null {
  if (!dispatch || dispatch.lastRound.length === 0) return null;

  const winner = pickCheapestFeasible(dispatch.lastRound);
  if (winner) {
    const orderId = dispatch.pendingOrder?.orderId;
    const shortName = winner.plannerName.replace(/^.*planner-/, "planner-");
    return {
      text: `${shortName} · €${winner.cost.toFixed(0)}${orderId ? ` · ${orderId}` : ""}`,
      tooltip: `Most recent round committed by ${winner.plannerName} at €${winner.cost.toFixed(0)}${orderId ? ` for ${orderId}` : ""}.`,
      variant: "winner",
    };
  }

  const pendingId = dispatch.pendingOrder?.orderId;
  const allAiUnreachable = dispatch.lastRound.every(
    (c) => c.errorKind === "ai_unreachable",
  );
  if (allAiUnreachable) {
    return {
      text: `AI binding unreachable${pendingId ? ` · ${pendingId}` : ""}`,
      tooltip:
        "Workers AI rejected the planner calls (probe also failed). " +
        "Usually a stale auth token — restart `npm run dev` or run " +
        "`npx wrangler login` and try again.",
      variant: "ai_unreachable",
    };
  }

  const failed = dispatch.lastRound
    .map((c) => c.plannerName.replace(/^.*planner-/, "planner-"))
    .join(", ");
  return {
    text: `Round failed${pendingId ? ` · ${pendingId}` : ""}`,
    tooltip: `All planners returned invalid candidates: ${failed}.`,
    variant: "failure",
  };
}
