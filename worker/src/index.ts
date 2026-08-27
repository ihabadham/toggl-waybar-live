import type { WorkerEnv } from "./env.js";
import { handleWebhook } from "./webhook.js";

export { RelayObject } from "./relay-object.js";

const relayObjectName = "primary";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, version: 1 });
    }

    if (url.pathname === "/webhooks/toggl") {
      const relay = env.RELAY.get(env.RELAY.idFromName(relayObjectName));
      return handleWebhook(request, env, (event) => relay.applyEvent(event));
    }

    if (request.method === "GET" && url.pathname === "/ws") {
      if (request.headers.get("authorization") !== `Bearer ${env.RELAY_TOKEN}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const relay = env.RELAY.get(env.RELAY.idFromName(relayObjectName));
      return relay.fetch(request);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;
