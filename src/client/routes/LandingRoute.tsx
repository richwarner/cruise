import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";

import { RouteNav } from "./RouteNav";

export function LandingRoute() {
  return (
    <main className="app-shell landing-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Prototype</p>
          <h1>Cruise — AI-powered shipment orchestration</h1>
          <p>
            A refrigerated trucking dispatch demo. A Director agent coordinates
            three parallel Planner workers to re-plan tomorrow's trips whenever
            a new order arrives.
          </p>
        </div>
        <RouteNav active="landing" />
      </header>

      <LayerCard className="panel narrative-panel">
        <Text variant="heading2">What this is</Text>
        <p>
          Cruise is a Cloudflare Workers prototype. The browser talks to a{" "}
          <code>DispatchDirectorAgent</code> over a WebSocket; that agent spawns{" "}
          three <code>TripPlannerAgent</code> sub-agents in parallel, validates
          each candidate plan through a pure <code>cruise.ts</code> rules
          module, and commits the lowest-cost feasible plan.
        </p>
        <p>
          Phase 2 currently ships a single planner in direct-chat mode. The
          Director, Control Room, and parallel-spawn orchestration arrive in
          Phases 3 and 4.
        </p>
        <p>
          <a href="/cruise">Open the Cruise app →</a>
        </p>
      </LayerCard>
    </main>
  );
}
