import { routeAgentRequest } from "agents";
import { Hono } from "hono";

import { DispatchDirectorAgent } from "../agents/DispatchDirectorAgent";
import { TripPlannerAgent } from "../agents/TripPlannerAgent";

// Re-export the Durable Object classes so Wrangler can find them.
export { DispatchDirectorAgent, TripPlannerAgent };

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true, service: "cruise" }));

/**
 * Diagnostic: probes the Workers AI binding directly, bypassing the
 * `workers-ai-provider` -> `streamText` stack. If this fails with 1031/4006,
 * the issue is the AI binding / account / gateway. If this succeeds while
 * planner rounds still fail, the issue is in our prompt / tool schema.
 */
app.get("/api/ai-probe", async (c) => {
  const model = c.req.query("model") ?? "@cf/meta/llama-3.1-8b-instruct";
  const start = Date.now();
  try {
    const result = await c.env.AI.run(model as Parameters<typeof c.env.AI.run>[0], {
      messages: [
        { role: "system", content: "Reply with exactly one short sentence." },
        { role: "user", content: "Say hello from the AI probe." },
      ],
    } as Parameters<typeof c.env.AI.run>[1]);
    return c.json({
      ok: true,
      model,
      ms: Date.now() - start,
      result,
    });
  } catch (error) {
    return c.json(
      {
        ok: false,
        model,
        ms: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      },
      { status: 500 },
    );
  }
});

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
