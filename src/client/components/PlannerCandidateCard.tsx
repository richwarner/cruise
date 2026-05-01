import type { PlannerCandidate } from "../../shared/types";

type PlannerCandidateCardProps = {
  candidate: PlannerCandidate;
  isWinner: boolean;
};

export function PlannerCandidateCard({
  candidate,
  isWinner,
}: PlannerCandidateCardProps) {
  const className = [
    "planner-card",
    candidate.valid ? "planner-card--valid" : "planner-card--invalid",
    isWinner ? "planner-card--winner" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={className}>
      <header className="planner-card-header">
        <span className="planner-card-name">{candidate.plannerName}</span>
        <span className="planner-card-seed">seed {candidate.seed}</span>
      </header>

      <dl className="planner-card-stats">
        <div>
          <dt>Status</dt>
          <dd>{candidate.valid ? "valid" : "invalid"}</dd>
        </div>
        <div>
          <dt>Trips</dt>
          <dd>{candidate.plan.trips.length}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            {typeof candidate.cost === "number"
              ? `€${candidate.cost.toFixed(0)}`
              : "—"}
          </dd>
        </div>
      </dl>

      {candidate.errors && candidate.errors.length > 0 ? (
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
