import type { DispatchState } from "../../shared/types";
import { computePlanCost, pickCheapestFeasible } from "../../shared/cruise";
import { PlannerCandidateCard } from "./PlannerCandidateCard";
import { SessionTrendsPanel } from "./SessionTrendsPanel";

type DispatchControlRoomProps = {
  dispatch: DispatchState;
};

export function DispatchControlRoom({ dispatch }: DispatchControlRoomProps) {
  const cost = computePlanCost(dispatch.currentPlan, dispatch.pallets);

  return (
    <div className="control-room">
      <section className="control-room-section">
        <h3>Current plan</h3>
        <dl className="control-room-kv">
          <div>
            <dt>Trips</dt>
            <dd>{dispatch.currentPlan.trips.length}</dd>
          </div>
          <div>
            <dt>Pallets</dt>
            <dd>
              {dispatch.pallets.length -
                dispatch.currentPlan.unassignedPalletIds.length}{" "}
              / {dispatch.pallets.length}
            </dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>€{cost.toFixed(0)}</dd>
          </div>
        </dl>
      </section>

      <SessionTrendsPanel dispatch={dispatch} />

      <section className="control-room-section">
        <h3>Last planner round</h3>
        {dispatch.lastRound.length === 0 ? (
          <div className="control-room-empty">Awaiting planner results...</div>
        ) : (
          <div className="control-room-candidates">
            {dispatch.lastRound.map((c) => (
              <PlannerCandidateCard
                key={c.plannerName}
                candidate={c}
                isWinner={isWinningCandidate(c, dispatch.lastRound)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="control-room-section">
        <h3>Runtime action log</h3>
        {dispatch.recentDirectorActions.length === 0 ? (
          <div className="control-room-empty">No director actions yet.</div>
        ) : (
          <ul className="control-room-log">
            {[...dispatch.recentDirectorActions]
              .slice(-12)
              .reverse()
              .map((e) => (
                <li key={e.id}>
                  <span className="control-room-log-time">
                    {new Date(e.at).toLocaleTimeString()}
                  </span>
                  <span className="control-room-log-label">{e.label}</span>
                  {e.detail ? (
                    <span className="control-room-log-detail">{e.detail}</span>
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Winner = what the Director would commit. Delegates to `pickCheapestFeasible`
 * so the "WINNER" chip always matches the Director's actual tiebreak order
 * (cost → trip count → seed → plannerName). Without this the UI could
 * highlight a different candidate than the one that actually got committed,
 * which is very confusing when diagnosing cost or tie-break bugs.
 */
function isWinningCandidate(
  candidate: DispatchState["lastRound"][number],
  round: DispatchState["lastRound"],
): boolean {
  if (!candidate.valid) return false;
  const winner = pickCheapestFeasible(round);
  return winner !== null && winner.plannerName === candidate.plannerName;
}
