import { routeAgentRequest } from "agents";
import { Hono } from "hono";

import { DispatchDirectorAgent } from "../agents/DispatchDirectorAgent";
import { TripPlannerAgent } from "../agents/TripPlannerAgent";

// Re-export the Durable Object classes so Wrangler can find them.
export { DispatchDirectorAgent, TripPlannerAgent };

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true, service: "cruise" }));

export default {
  async fetch(request, env, ctx) {
    // Cloudflare Agents handle their own WebSocket and HTTP routes under
    // /agents/<agent-name>/<instance>. Chat and RPC both flow through
    // that connection. Everything else falls through to Hono, then to the SPA.
    const agentResponse = await routeAgentRequest(request, env);

    if (agentResponse) {
      return agentResponse;
    }

    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
