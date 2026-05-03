import { computeSessionTrends } from "../../shared/cruise";
import type { DispatchState } from "../../shared/types";

type SessionTrendsPanelProps = {
  dispatch: DispatchState;
};

/**
 * Read-only summary of what's happened this session. Purely derived from
 * `dispatch.recentRounds` + `currentPlan` + `pallets` via
 * `computeSessionTrends` — no extra state is stored or polled. Slots into
 * the Control Room between "Current plan" and "Last planner round".
 */
export function SessionTrendsPanel({ dispatch }: SessionTrendsPanelProps) {
  const trends = computeSessionTrends(dispatch);
  const hasRounds = trends.totalRounds > 0;

  return (
    <section className="control-room-section">
      <h3>Session Trends</h3>

      {!hasRounds && trends.busiestLanes.length === 0 ? (
        <div className="control-room-empty">
          No rounds yet — submit an order to populate trends.
        </div>
      ) : (
        <div className="session-trends">
          {hasRounds ? (
            <>
              <div className="session-trends-row">
                <div className="session-trends-label">Planner wins</div>
                <div className="session-trends-bars">
                  {trends.plannerWins.map((w) => (
                    <div
                      key={w.planner}
                      className="session-trends-bar"
                      title={`${w.planner}: ${w.wins} win(s) of ${trends.totalRounds}`}
                    >
                      <span className="session-trends-bar-name">
                        {shortPlanner(w.planner)}
                      </span>
                      <span
                        className="session-trends-bar-fill"
                        style={{ width: `${Math.max(6, w.pctOfRounds * 100)}%` }}
                      />
                      <span className="session-trends-bar-count">
                        {w.wins} ({Math.round(w.pctOfRounds * 100)}%)
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="session-trends-row">
                <div className="session-trends-label">Cost trend</div>
                <div className="session-trends-chips">
                  <span
                    className="session-trends-chip"
                    data-trend={trends.costTrend.direction}
                    title={`First committed round: €${trends.costTrend.first.toFixed(0)}, latest: €${trends.costTrend.last.toFixed(0)}`}
                  >
                    €{trends.costTrend.first.toFixed(0)} → €
                    {trends.costTrend.last.toFixed(0)}
                    <span className="session-trends-chip-delta">
                      {formatDelta(trends.costTrend.delta)}
                    </span>
                  </span>
                  <span
                    className="session-trends-chip"
                    data-trend={avgTrendDirection(trends.avgDeltaPerRound)}
                    title="Average per-round delta (cost after commit minus cost before)."
                  >
                    avg Δ/round {formatDelta(trends.avgDeltaPerRound)}
                  </span>
                  <span
                    className="session-trends-chip"
                    data-trend="muted"
                    title="Total rounds committed this session."
                  >
                    {trends.totalRounds} round(s)
                  </span>
                </div>
              </div>
            </>
          ) : null}

          {trends.busiestLanes.length > 0 ? (
            <div className="session-trends-row">
              <div className="session-trends-label">Busiest lanes</div>
              <div className="session-trends-chips">
                {trends.busiestLanes.map((l) => (
                  <span
                    key={l.lane}
                    className="session-trends-chip"
                    data-trend="muted"
                    title={`${l.count} pallet(s) on ${l.lane}`}
                  >
                    {l.lane}
                    <span className="session-trends-chip-delta">×{l.count}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function shortPlanner(name: string): string {
  return name.replace(/^.*planner-/, "p");
}

function formatDelta(delta: number): string {
  if (delta === 0) return "±€0";
  const sign = delta > 0 ? "+" : "−";
  return `${sign}€${Math.abs(delta).toFixed(0)}`;
}

function avgTrendDirection(avgDelta: number): "up" | "down" | "flat" {
  if (avgDelta < 0) return "down";
  if (avgDelta > 0) return "up";
  return "flat";
}
